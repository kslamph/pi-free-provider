/**
 * clinefree's streamSimple (spec §7): resolve the credential (refreshing a
 * stale OAuth token pre-request and persisting the rotation), then delegate to
 * pi's openai-completions provider with the contract headers, Authorization,
 * and a per-conversation X-Task-ID.
 *
 * On HTTP 401/403 the credential is marked invalid, the user is notified once,
 * and the request fails without retrying (one account, no rotation).
 */

import { randomUUID } from "node:crypto";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Message,
	type Tool,
	type TranscriptContext,
	createAssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { formatAuthorization, isTokenStale, refreshClineToken } from "./auth.ts";
import type { ContractResult } from "./contract.ts";
import type { Credential } from "./state.ts";

let conversationTaskId = randomUUID();

export function currentTaskId(): string {
	return conversationTaskId;
}

/** One X-Task-ID per conversation; /new, resume and fork start a new one. */
export function resetConversation(reason: string): void {
	if (reason === "new" || reason === "resume" || reason === "fork") conversationTaskId = randomUUID();
}

export interface ClinefreeStreamDeps {
	getCredential(): Credential | undefined;
	getContract(): ContractResult;
	/** Persist a rotated OAuth token pair. */
	onCredentialSaved(cred: Credential): void;
	/** The credential was rejected (401/403) — clear it so /clinefree re-auths. */
	onInvalidated(): void;
	notify(message: string): void;
}

function baseMessage(model: Model<Api>, stopReason: "error" | "aborted", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage !== undefined ? { errorMessage } : {}),
	} as AssistantMessage;
}

function emitError(out: AssistantMessageEventStream, model: Model<Api>, message: string): void {
	out.push({ type: "error", reason: "error", error: baseMessage(model, "error", message) });
	out.end();
}

/** Spec §7: automatic credential invalidation is 401-only. A 403 usually means
 * "authenticated but forbidden" (model/region restriction) — evicting a working
 * credential (and its refresh token) over it would force a needless re-auth. */
function isUnauthorized(capturedStatus: number, problem: string): boolean {
	return capturedStatus === 401 || /\b401\b|unauthorized/i.test(problem);
}

export function createClinefreeStream(deps: ClinefreeStreamDeps) {
	const fallback = getApiProvider("openai-completions");
	if (!fallback) throw new Error("clinefree: no openai-completions API provider registered in pi");

	let invalidNotified = false;

	return function clinefreeStreamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();

		void (async () => {
			try {
				let cred = deps.getCredential();
				if (!cred) {
					emitError(out, model, "clinefree: no credential configured — run /clinefree to sign in");
					return;
				}

				if (cred.mode === "oauth" && cred.refreshToken && isTokenStale(cred)) {
					const update = await refreshClineToken(cred.refreshToken, deps.getContract().headers);
					cred = { ...cred, ...update };
					deps.onCredentialSaved(cred);
				}

				const contract = deps.getContract();
				const captured = { status: 0 };
				const impl = getApiProvider(model.api) ?? fallback;
				const bearer = formatAuthorization(cred);
				const attemptOptions: SimpleStreamOptions = {
					...options,
					apiKey: bearer.replace(/^Bearer /, ""),
					headers: {
						...options?.headers,
						...contract.headers,
						Authorization: bearer,
						"X-Task-ID": currentTaskId(),
					},
					onResponse: (response) => {
						captured.status = response.status;
					},
				};

				const sub = impl.streamSimple(model, context, attemptOptions);
				const buffered: AssistantMessageEvent[] = [];
				let relayed = false;

				const invalidate = (): void => {
					deps.onInvalidated();
					if (!invalidNotified) {
						invalidNotified = true;
						notifyInvalid(deps);
					}
				};

				for await (const event of sub) {
					if (event.type === "done") {
						for (const bufferedEvent of buffered) out.push(bufferedEvent);
						buffered.length = 0;
						out.push(event);
						out.end();
						return;
					}

					if (event.type === "error") {
						const problem = (event as { error?: { errorMessage?: string } }).error?.errorMessage ?? "unknown provider error";
						if (!relayed && isUnauthorized(captured.status, problem)) {
							invalidate();
							emitError(out, model, "clinefree: credential rejected (401) — run /clinefree to re-authenticate");
							return;
						}
						for (const bufferedEvent of buffered) out.push(bufferedEvent);
						buffered.length = 0;
						out.push(event);
						out.end();
						return;
					}

					if (!relayed) {
						if (captured.status === 0) {
							buffered.push(event);
							continue;
						}
						if (isUnauthorized(captured.status, "")) {
							invalidate();
							emitError(out, model, "clinefree: credential rejected (401) — run /clinefree to re-authenticate");
							return;
						}
						for (const bufferedEvent of buffered) out.push(bufferedEvent);
						buffered.length = 0;
						out.push(event);
						relayed = true;
						continue;
					}

					out.push(event);
				}

				if (!relayed && buffered.length === 0) {
					emitError(out, model, "clinefree: provider stream ended without events");
					return;
				}
				for (const bufferedEvent of buffered) out.push(bufferedEvent);
				out.end();
			} catch (error) {
				if (options?.signal?.aborted) {
					out.push({ type: "error", reason: "aborted", error: baseMessage(model, "aborted") });
					out.end();
					return;
				}
				emitError(out, model, `clinefree: request error — ${error instanceof Error ? error.message : String(error)}`);
			}
		})();

		return out;
	};
}

function notifyInvalid(deps: ClinefreeStreamDeps): void {
	deps.notify("clinefree: credential rejected (401) — re-authenticate via /clinefree");
}

// ── zenfree stream (spec §zen-6) ─────────────────────────────────────────────

import { createConversationIdentity } from "./sources/opencode-identity.ts";
import { ZEN_OFFICIAL_SYSTEM_PROMPT } from "./sources/opencode-system-prompt.ts";
import { turnKeyOf, zenProjectId } from "./sources/opencode-identity.ts";
import type { ZenContractResult } from "./sources/opencode-contract.ts";

const zenIdentity = createConversationIdentity();

/** One zen session id per conversation; /new, resume and fork start a new one. */
export function resetZenConversation(reason: string): void {
	if (reason === "new" || reason === "resume" || reason === "fork") zenIdentity.reset();
}

export interface ZenStreamDeps {
	getCredential(): Credential | undefined;
	getContract(): ZenContractResult;
	/** The credential was rejected (401) — clear it so /zenfree re-auths. */
	onInvalidated(): void;
	/** The gateway 426'd our client version — force a contract re-check. */
	onVersionStale(): void;
	/** Resolve the local Bun sidecar base URL (zen TLS-fingerprint gate; see sidecar.ts).
	 * Undefined = no sidecar — send directly from Node. */
	ensureSidecar(): Promise<string | undefined>;
	notify(message: string): void;
}

function isUpgradeRequired(capturedStatus: number, problem: string): boolean {
	return capturedStatus === 426 || /\b426\b|upgrade required/i.test(problem);
}

// ── agentic-shape padding ────────────────────────────────────────────────────
//
// OpenCode's free tier only serves agentic-shaped requests: `stream: true` plus
// a tool set that declares **read** and at least one of **shell**/**bash**.
// Live-bisected 2026-10-13 on /chat/completions and /responses alike: the tool
// count is irrelevant (four tools without read → 403), the schemas and
// descriptions are irrelevant, and near-miss names (sh, zsh, exec, run,
// command, terminal) are all rejected. Without `stream: true` even the correct
// pair draws 403. pi's /compact and title-generation requests declare no tools
// at all, which is why the same model works for the agent loop and dies on
// /compact. Detection is local — replay the transcript's tool state — and the
// padding is two inert declarations whose calls get unwrapped afterwards.

/** The reader role the free tier insists on. */
export const ZEN_PAD_READ_TOOL = "read";

/** Exec roles the free tier accepts; the first one that is missing gets declared. */
export const ZEN_PAD_EXEC_TOOLS = ["shell", "bash"] as const;

const PAD_TOOL: Tool = {
	name: ZEN_PAD_READ_TOOL,
	description: "Placeholder that exists only to satisfy the OpenCode Zen free-tier request shape. Never call this tool.",
	parameters: {
		type: "object",
		properties: { text: { type: "string", description: "Your complete response, in full." } },
		required: ["text"],
		additionalProperties: false,
	},
};

/** Tool names the transcript declares once every addition/removal is replayed. */
function declaredToolNames(messages: Message[]): Set<string> {
	const tools = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
	}
	return tools;
}

export interface ZenPad {
	context: TranscriptContext;
	/** The placeholder tool names this request declared — their calls get unwrapped. */
	names: string[];
	/** True when the request had no tools of its own, i.e. it is a pure text call. */
	toolless: boolean;
}

/**
 * Declare the tools the free tier insists on and the request is missing.
 * Returns undefined when the request is already agentic — it is then forwarded
 * untouched, so its prompt cache stays warm.
 */
export function padZenRequest(context: TranscriptContext): ZenPad {
	const declared = declaredToolNames(context.messages);
	const missing: string[] = [];
	if (!declared.has(ZEN_PAD_READ_TOOL)) missing.push(ZEN_PAD_READ_TOOL);
	if (!ZEN_PAD_EXEC_TOOLS.some((name) => declared.has(name))) missing.push(ZEN_PAD_EXEC_TOOLS[0]);

	// System-prompt pad: the free tier fingerprints the request body for
	// OpenCode's official system prompt (2026-10-24 bisect: truncated 6/12KB,
	// prefixed-without, and same-size synthetic prompts all draw 429
	// FreeUsageLimitError; the intact prompt passes, even as a separate leading
	// system message). pi's own system prompt never matches, so every request
	// carries the official prompt ahead of it — identical bytes every time, so
	// prefix caching absorbs the ~5.2K-token cost.
	const first = context.messages[0];
	const needsSystemPad = !(first?.role === "system" && first.content === ZEN_OFFICIAL_SYSTEM_PROMPT);
	if (missing.length === 0 && !needsSystemPad) {
		return { context, names: [], toolless: declared.size === 0 };
	}

	// The official-prompt message leads; tool placeholders are declared on it
	// (that is where the adapters read the tool list from) so the original
	// transcript stays untouched behind the pad.
	const pads: Tool[] = missing.map((name) => ({ ...PAD_TOOL, name }));
	const head: Message = {
		role: "system",
		content: ZEN_OFFICIAL_SYSTEM_PROMPT,
		...(pads.length > 0 ? { toolsAdded: pads } : {}),
		timestamp: 0,
	};
	const messages: Message[] = [head, ...context.messages];

	return { context: { messages } as TranscriptContext, names: missing, toolless: declared.size === 0 };
}

/**
 * `tool_choice: "none"` keeps a toolless call from reaching for a placeholder.
 * Only the completions transport takes it — the Responses vendors answer 400
 * ("only `"auto"` is supported for `tool_choice`"), so there {@link stripPadCalls}
 * is the only line of defence.
 */
function padToolChoice(model: Model<Api>, pad: ZenPad, options: SimpleStreamOptions | undefined): SimpleStreamOptions["toolChoice"] | undefined {
	if (options?.toolChoice !== undefined) return options.toolChoice;
	return pad.toolless && model.api === "openai-completions" ? "none" : undefined;
}

/**
 * Undo a placeholder call the model made anyway: drop the call and keep its
 * text, so a summarization still has content instead of tripping pi's
 * "Summarization attempted to call a tool" guard.
 */
export function stripPadCalls(event: Extract<AssistantMessageEvent, { type: "done" }>, padNames: string[]): typeof event {
	const content = event.message?.content;
	if (!Array.isArray(content)) return event;
	const names = new Set(padNames);
	const calls = content.filter((block) => block.type === "toolCall" && names.has(block.name));
	if (calls.length === 0) return event;

	const padText = calls
		.map((call) => (call.type === "toolCall" ? call.arguments.text : undefined))
		.filter((text): text is string => typeof text === "string" && text.length > 0)
		.join("\n\n");
	const keptContent = content.filter((block) => block.type !== "toolCall" || !names.has(block.name));
	const kept = padText ? [...keptContent, { type: "text" as const, text: padText }] : keptContent;
	const keptCalls = kept.some((block) => block.type === "toolCall");

	return {
		...event,
		reason: keptCalls ? event.reason : "stop",
		message: { ...event.message, content: kept, stopReason: keptCalls ? event.message.stopReason : "stop" },
	};
}

function isFreeTierGate(capturedStatus: number, problem: string): boolean {
	return (capturedStatus === 403 || /\b403\b/.test(problem)) && /freetier|can only be used from within/i.test(problem);
}

export function createZenfreeStream(deps: ZenStreamDeps) {
	const fallback = getApiProvider("openai-completions");
	if (!fallback) throw new Error("zenfree: no openai-completions API provider registered in pi");

	let invalidNotified = false;

	return function zenfreeStreamSimple(
		model: Model<Api>,
		context: TranscriptContext,
		options?: SimpleStreamOptions,
	): AssistantMessageEventStream {
		const out = createAssistantMessageEventStream();

		void (async () => {
			try {
				const cred = deps.getCredential();
				if (!cred?.apiKey) {
					emitError(out, model, "zenfree: no workspace key configured — run /zenfree to add one");
					return;
				}

				const contract = deps.getContract();
				const captured = { status: 0 };
				const impl = getApiProvider(model.api) ?? fallback;
				// Zen's gateway admits only Bun-shaped TLS clients (sidecar.ts); route
				// through the local relay when available, else send directly from Node.
				const sidecarBase = await deps.ensureSidecar().catch(() => undefined);
				const target = (
					sidecarBase ? ({ ...model, baseUrl: sidecarBase } as typeof model) : model
				) as Model<Api>;
				const pad = padZenRequest(context);
				const padChoice = pad ? padToolChoice(model, pad, options) : undefined;
				// Keyless v2.1.4 shape (2026-10-24): the workspace-keyed free quota is
				// exhausted server-side (429 FreeUsageLimitError "Subscribe to OpenCode
				// Go"), while the official client with no opencode credential sends
				// `Authorization: Bearer public` and rides the anonymous per-IP bucket
				// (console handler: `rawZenApiKey === "public" → undefined`). Mirror it:
				// public bearer, the v2.1 session-identity headers (session-id +
				// affinity pair + project, sharing the conversation session id), and no
				// org-id (keyless clients send none). The workspace key stays configured
				// for lineup/config sync — it just never reaches the gateway.
				const session = zenIdentity.sessionId();
				const request = zenIdentity.requestId(turnKeyOf(context.messages));
				const attemptOptions: SimpleStreamOptions = {
					...options,
					...(padChoice !== undefined ? { toolChoice: padChoice } : {}),
					apiKey: "public",
					headers: {
						...options?.headers,
						...contract.headers,
						Authorization: "Bearer public",
						"x-opencode-session": session,
						"x-opencode-session-id": session,
						"x-session-affinity": session,
						"X-Session-Id": session,
						"x-opencode-project": zenProjectId(),
						"x-opencode-request": request,
					},
					onResponse: (response) => {
						captured.status = response.status;
					},
				};

				const sub = impl.streamSimple(target, pad?.context ?? context, attemptOptions);
				const buffered: AssistantMessageEvent[] = [];
				let relayed = false;

				const invalidate = (): void => {
					deps.onInvalidated();
					if (!invalidNotified) {
						invalidNotified = true;
						deps.notify("zenfree: credential rejected (401) — re-add your workspace key via /zenfree");
					}
				};

				const handleProblem = (problem: string): boolean => {
					if (!relayed && isUnauthorized(captured.status, problem)) {
						invalidate();
						emitError(out, model, "zenfree: credential rejected (401) — run /zenfree to re-add your key");
						return true;
					}
					if (!relayed && isUpgradeRequired(captured.status, problem)) {
						deps.onVersionStale();
						deps.notify("zenfree: gateway reports a stale client version (426) — re-checking the official CLI version; retry shortly");
						emitError(out, model, `zenfree: client version rejected (426) — ${problem}`);
						return true;
					}
					if (!relayed && isFreeTierGate(captured.status, problem)) {
						deps.notify("zenfree: the free tier only serves agentic requests (streaming + at least two tools) — this call was rejected");
						emitError(out, model, `zenfree: free-tier gate (403) — ${problem}`);
						return true;
					}
					return false;
				};

				for await (const event of sub) {
					if (event.type === "done") {
						for (const bufferedEvent of buffered) out.push(bufferedEvent);
						buffered.length = 0;
						out.push(pad ? stripPadCalls(event, pad.names) : event);
						out.end();
						return;
					}

					if (event.type === "error") {
						const problem = (event as { error?: { errorMessage?: string } }).error?.errorMessage ?? "unknown provider error";
						if (handleProblem(problem)) return;
						for (const bufferedEvent of buffered) out.push(bufferedEvent);
						buffered.length = 0;
						out.push(event);
						out.end();
						return;
					}

					if (!relayed) {
						if (captured.status === 0) {
							buffered.push(event);
							continue;
						}
						if (isUnauthorized(captured.status, "") || isUpgradeRequired(captured.status, "") || isFreeTierGate(captured.status, "")) {
							if (handleProblem(`HTTP ${captured.status}`)) return;
						}
						for (const bufferedEvent of buffered) out.push(bufferedEvent);
						buffered.length = 0;
						out.push(event);
						relayed = true;
						continue;
					}

					out.push(event);
				}

				if (!relayed && buffered.length === 0) {
					emitError(out, model, "zenfree: provider stream ended without events");
					return;
				}
				for (const bufferedEvent of buffered) out.push(bufferedEvent);
				out.end();
			} catch (error) {
				if (options?.signal?.aborted) {
					out.push({ type: "error", reason: "aborted", error: baseMessage(model, "aborted") });
					out.end();
					return;
				}
				emitError(out, model, `zenfree: request error — ${error instanceof Error ? error.message : String(error)}`);
			}
		})();

		return out;
	};
}
