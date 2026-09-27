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
