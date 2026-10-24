import { describe, expect, it, vi, type Mock } from "vitest";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";

vi.mock("@earendil-works/pi-ai/compat", () => {
	return { getApiProvider: vi.fn() };
});
vi.mock("@earendil-works/pi-ai", () => {
	return {
		getApiProvider: vi.fn(),
		createAssistantMessageEventStream: vi.fn(() => {
			const queue: AssistantMessageEvent[] = [];
			let ended = false;
			let wake: (() => void) | undefined;
			return {
				push: (event: AssistantMessageEvent) => {
					queue.push(event);
					wake?.();
				},
				end: () => {
					ended = true;
					wake?.();
				},
				[Symbol.asyncIterator]() {
					let index = 0;
					return {
						async next(): Promise<IteratorResult<AssistantMessageEvent>> {
							for (;;) {
								if (index < queue.length) return { value: queue[index++]!, done: false };
								if (ended) return { value: undefined as never, done: true };
								await new Promise<void>((resolve) => {
									wake = resolve;
								});
							}
						},
					};
				},
			};
		}),
	};
});

vi.mock("./auth.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./auth.ts")>();
	return {
		...actual,
		refreshClineToken: vi.fn(),
	};
});

import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { refreshClineToken } from "./auth.ts";
import { createClinefreeStream, createZenfreeStream, resetConversation, resetZenConversation, ZEN_PAD_EXEC_TOOLS, ZEN_PAD_READ_TOOL, type ZenStreamDeps } from "./stream.ts";
import { BAKED_IN_ZEN_CONTRACT, type ZenContractResult } from "./sources/opencode-contract.ts";
import { ZEN_OFFICIAL_SYSTEM_PROMPT } from "./sources/opencode-system-prompt.ts";
import type { ContractResult } from "./contract.ts";
import type { Credential } from "./state.ts";

const contract: ContractResult = {
	headers: { "X-CLIENT-TYPE": "cline-cli", "User-Agent": "Cline/3.0.65", "X-CORE-VERSION": "0.0.86" },
	endpointPath: "/api/v1/ai/cline/recommended-models",
	cliVersion: "3.0.65",
	coreVersion: "0.0.86",
	source: "github",
};

/** Fake impl whose streamSimple records options and yields start→done (or an error). */
function fakeImpl(events: AssistantMessageEvent[] = [{ type: "start" } as AssistantMessageEvent, { type: "done" } as AssistantMessageEvent]) {
	const calls: { model: unknown; context: unknown; options: Record<string, unknown> }[] = [];
	return {
		calls,
		streamSimple: (_model: unknown, _context: unknown, options: Record<string, unknown> = {}) => {
			calls.push({ model: _model, context: _context, options });
			return (async function* () {
				for (const event of events) yield event;
			})();
		},
	};
}

function collect(stream: { [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> }) {
	const out: AssistantMessageEvent[] = [];
	return (async () => {
		for await (const event of stream) out.push(event);
		return out;
	})();
}

const model = { id: "cline-free/x", api: "openai-completions" } as never;
const context = { messages: [] } as never;

function makeDeps(cred: Credential | undefined) {
	return {
		getCredential: () => cred,
		getContract: () => contract,
		onCredentialSaved: vi.fn(),
		onInvalidated: vi.fn(),
		notify: vi.fn(),
	};
}

describe("createClinefreeStream", () => {
	it("injects Authorization, contract headers, and a stable X-Task-ID", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const stream = createClinefreeStream(makeDeps({ mode: "apiKey", apiKey: "sk-x" }));
		const events = await collect(stream(model, context));
		expect(events.map((e) => e.type)).toEqual(["start", "done"]);
		const headers = impl.calls[0]!.options.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer sk-x");
		expect(headers["X-CLIENT-TYPE"]).toBe("cline-cli");
		expect(headers["X-CORE-VERSION"]).toBe("0.0.86");
		expect(headers["X-Task-ID"]).toMatch(/^[0-9a-f-]{36}$/);

		// stable across calls, reset by new/resume/fork
		await collect(stream(model, context));
		const second = (impl.calls[1]!.options.headers as Record<string, string>)["X-Task-ID"];
		expect(second).toBe(headers["X-Task-ID"]);
		resetConversation("startup");
		await collect(stream(model, context));
		expect((impl.calls[2]!.options.headers as Record<string, string>)["X-Task-ID"]).toBe(second);
		resetConversation("new");
		await collect(stream(model, context));
		expect((impl.calls[3]!.options.headers as Record<string, string>)["X-Task-ID"]).not.toBe(second);
	});

	it("refreshes a stale oauth credential pre-request and persists the rotation", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		(refreshClineToken as unknown as Mock).mockResolvedValue({
			accessToken: "fresh-a",
			refreshToken: "fresh-r",
			expiresAt: 123,
		});
		const deps = makeDeps({ mode: "oauth", accessToken: "old", refreshToken: "old-r", expiresAt: Date.now() - 1000 });
		await collect(createClinefreeStream(deps)(model, context));
		expect(refreshClineToken).toHaveBeenCalledTimes(1);
		expect(deps.onCredentialSaved).toHaveBeenCalledWith(
			expect.objectContaining({ accessToken: "fresh-a", refreshToken: "fresh-r" }),
		);
		const headers = impl.calls[0]!.options.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer workos:fresh-a");
	});

	it("marks the credential invalid on HTTP 401 without retrying", async () => {
		const impl = fakeImpl([{ type: "error", error: { errorMessage: "Unauthorized" } } as never]);
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const deps = makeDeps({ mode: "apiKey", apiKey: "sk-x" });
		const events = await collect(
			createClinefreeStream({
				...deps,
				getCredential: () => deps.getCredential()!,
			})(model, context),
		);
		expect(impl.calls.length).toBe(1);
		expect(deps.onInvalidated).toHaveBeenCalled();
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("401"));
		expect(events.map((e) => e.type)).toContain("error");
	});
});

// Wire the 401 status through onResponse so the impl's captured status is seen.
describe("401 via onResponse", () => {
	it("invalidates when the captured status is 401", async () => {
		const impl = {
			calls: [] as { options: Record<string, unknown> }[],
			streamSimple: (_m: unknown, _c: unknown, options: Record<string, unknown> = {}) => {
				impl.calls.push({ options });
				const onResponse = options.onResponse as ((r: { status: number }) => void) | undefined;
				return (async function* () {
					onResponse?.({ status: 401 });
					yield { type: "start" } as AssistantMessageEvent;
					yield { type: "error", error: { errorMessage: "request failed" } } as never;
				})();
			},
		};
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const deps = makeDeps({ mode: "apiKey", apiKey: "sk-x" });
		const events = await collect(createClinefreeStream(deps)(model, context));
		expect(deps.onInvalidated).toHaveBeenCalled();
		expect(events.map((e) => e.type)).toEqual(["error"]);
	});

	it("relays a 403 without invalidating the credential (spec §7: invalidation is 401-only)", async () => {
		const impl = {
			streamSimple: (_m: unknown, _c: unknown, options: Record<string, unknown> = {}) => {
				const onResponse = options.onResponse as ((r: { status: number }) => void) | undefined;
				return (async function* () {
					onResponse?.({ status: 403 });
					yield { type: "start" } as AssistantMessageEvent;
					yield { type: "error", error: { errorMessage: "forbidden: model access denied" } } as never;
				})();
			},
		};
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const deps = makeDeps({ mode: "oauth", accessToken: "a", refreshToken: "r" });
		const events = await collect(createClinefreeStream(deps)(model, context));
		expect(deps.onInvalidated).not.toHaveBeenCalled();
		expect(deps.notify).not.toHaveBeenCalled();
		expect(events.map((e) => e.type)).toEqual(["start", "error"]); // provider error relayed as-is
	});

	it("relays a 'forbidden' error message without a 401 without invalidating", async () => {
		const impl = fakeImpl([{ type: "error", error: { errorMessage: "403 forbidden for this model" } } as never]);
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const deps = makeDeps({ mode: "apiKey", apiKey: "sk-x" });
		await collect(createClinefreeStream(deps)(model, context));
		expect(deps.onInvalidated).not.toHaveBeenCalled();
	});
});


// ── zenfree stream ────────────────────────────────────────────────────────────

const zenContract: ZenContractResult = BAKED_IN_ZEN_CONTRACT;
const zenModelCompletions = { id: "zenfree/big-pickle", api: "openai-completions" } as never;
const zenModelResponses = { id: "zenfree.res/muse-spark-1.3-contributor-free", api: "openai-responses" } as never;
const zenContext = {
	messages: [{ role: "user", timestamp: 42, content: "hello there" }],
} as never;

function zenDeps(cred: Credential | undefined) {
	return {
		getCredential: () => cred,
		getContract: () => zenContract,
		onInvalidated: vi.fn(),
		onVersionStale: vi.fn(),
		ensureSidecar: () => Promise.resolve(undefined),
		notify: vi.fn(),
	};
}

function implsFor(completions: ReturnType<typeof fakeImpl>, responses: ReturnType<typeof fakeImpl>) {
	return (api: string) => (api === "openai-responses" ? responses : completions);
}

describe("createZenfreeStream", () => {
	it("sends the keyless v2.1.4 shape: public bearer, affinity headers, project id", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const stream = createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }));
		const events = await collect(stream(zenModelCompletions, zenContext));
		expect(events.map((e) => e.type)).toEqual(["start", "done"]);
		const options = impl.calls[0]!.options as { apiKey?: string; headers: Record<string, string> };
		const headers = options.headers;
		// Keyless: the workspace key never reaches the gateway (its free quota is
		// exhausted server-side); `Bearer public` is the official keyless sentinel.
		expect(headers.Authorization).toBe("Bearer public");
		expect(options.apiKey).toBe("public");
		expect(headers["x-opencode-client"]).toBe("cli");
		expect(headers["User-Agent"]).toBe("opencode/latest/2.0.18/cli");
		expect(headers["x-opencode-session"]).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		expect(headers["x-opencode-request"]).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
		// v2.1 identity set: session id + affinity pair + project, all sharing the
		// conversation session id (affinity = session id for an un-parented client).
		expect(headers["x-opencode-session-id"]).toBe(headers["x-opencode-session"]);
		expect(headers["x-session-affinity"]).toBe(headers["x-opencode-session"]);
		expect(headers["X-Session-Id"]).toBe(headers["x-opencode-session"]);
		expect(headers["x-opencode-project"]).toMatch(/^[0-9a-f]{40}$/);

		// session stable across calls; request id stable for the same turn
		await collect(stream(zenModelCompletions, zenContext));
		const second = impl.calls[1]!.options.headers as Record<string, string>;
		expect(second["x-opencode-session"]).toBe(headers["x-opencode-session"]);
		expect(second["x-opencode-request"]).toBe(headers["x-opencode-request"]);
		resetZenConversation("new");
		await collect(stream(zenModelCompletions, zenContext));
		const third = impl.calls[2]!.options.headers as Record<string, string>;
		expect(third["x-opencode-session"]).not.toBe(headers["x-opencode-session"]);
		// a different turn mints a fresh request id
		const newTurnContext = { messages: [{ role: "user", timestamp: 43, content: "next question" }] } as never;
		await collect(stream(zenModelCompletions, newTurnContext));
		const fourth = impl.calls[3]!.options.headers as Record<string, string>;
		expect(fourth["x-opencode-request"]).not.toBe(third["x-opencode-request"]);
	});

	it("routes through the bun sidecar by swapping the model baseUrl", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const deps: ZenStreamDeps = {
			...zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }),
			ensureSidecar: () => Promise.resolve("http://127.0.0.1:9911"),
		};
		const directModel = { id: "zenfree/big-pickle", api: "openai-completions", baseUrl: "https://opencode.ai/inference/openai/v1" } as never;
		await collect(createZenfreeStream(deps)(directModel, zenContext));
		expect((impl.calls[0]!.model as { baseUrl: string }).baseUrl).toBe("http://127.0.0.1:9911");
		// No sidecar: the model's own baseUrl is used unchanged.
		await collect(createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }))(directModel, zenContext));
		expect((impl.calls[1]!.model as { baseUrl: string }).baseUrl).toBe("https://opencode.ai/inference/openai/v1");
	});

	it("routes a responses-api model through the responses impl with identity headers", async () => {
		const completions = fakeImpl();
		const responses = fakeImpl();
		(getApiProvider as unknown as Mock).mockImplementation(implsFor(completions, responses));
		const stream = createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }));
		await collect(stream(zenModelResponses, zenContext));
		expect(responses.calls).toHaveLength(1);
		expect(completions.calls).toHaveLength(0);
		const headers = responses.calls[0]!.options.headers as Record<string, string>;
		expect(headers["x-opencode-session"]).toMatch(/^ses_/);
		expect(headers["x-opencode-request"]).toMatch(/^msg_/);
	});

	it("marks the credential invalid on 401 without retrying", async () => {
		const impl = fakeImpl([
			{ type: "start" } as AssistantMessageEvent,
			{ type: "error", error: { errorMessage: "Unauthorized" } } as never,
		]);
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const deps = zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" });
		const events = await collect(createZenfreeStream(deps)(zenModelCompletions, zenContext));
		expect(impl.calls).toHaveLength(1);
		expect(deps.onInvalidated).toHaveBeenCalled();
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("401"));
		expect(events.map((e) => e.type)).toEqual(["error"]);
	});

	it("notifies and forces a version re-check on 426", async () => {
		const impl = fakeImpl([
			{ type: "start" } as AssistantMessageEvent,
			{ type: "error", error: { errorMessage: "426 Upgrade Required: OpenCode 1.17.0 or newer is required" } } as never,
		]);
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const deps = zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" });
		const events = await collect(createZenfreeStream(deps)(zenModelCompletions, zenContext));
		expect(deps.onVersionStale).toHaveBeenCalled();
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("version"));
		expect(deps.onInvalidated).not.toHaveBeenCalled();
		expect(events.map((e) => e.type)).toEqual(["error"]);
	});

	it("relays a 403 FreeTierError with the agentic-shape hint, no invalidation", async () => {
		const impl = fakeImpl([
			{ type: "start" } as AssistantMessageEvent,
			{ type: "error", error: { errorMessage: "403 FreeTierError: can only be used from within OpenCode" } } as never,
		]);
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const deps = zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" });
		const events = await collect(createZenfreeStream(deps)(zenModelCompletions, zenContext));
		expect(deps.onInvalidated).not.toHaveBeenCalled();
		expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/agentic|tools/i));
		expect(events.map((e) => e.type)).toEqual(["error"]);
	});

	it("relays a 429 quota error without invalidating", async () => {
		const impl = fakeImpl([
			{ type: "start" } as AssistantMessageEvent,
			{ type: "error", error: { errorMessage: "429 FreeUsageLimitError: IP quota exhausted" } } as never,
		]);
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const deps = zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" });
		await collect(createZenfreeStream(deps)(zenModelCompletions, zenContext));
		expect(deps.onInvalidated).not.toHaveBeenCalled();
		expect(deps.onVersionStale).not.toHaveBeenCalled();
	});

	it("errors immediately without a credential", async () => {
		const deps = zenDeps(undefined);
		const events = await collect(createZenfreeStream(deps)(zenModelCompletions, zenContext));
		expect(events.map((e) => e.type)).toEqual(["error"]);
	});
});
// The free tier serves only agentic-shaped requests: streaming plus a tool set
// that declares `read` and one of `shell`/`bash`. pi's /compact declares none,
// so the gate has to be padded here.
describe("zenfree agentic-shape padding", () => {
	const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} } });
	const toolless = { messages: [{ role: "system", content: "summarize this", timestamp: 0 }, { role: "user", content: "hi", timestamp: 1 }] } as never;
	const oneTool = {
		messages: [
			{ role: "system", content: "you are pi", timestamp: 0, toolsAdded: [tool("todowrite")] },
			{ role: "user", content: "hi", timestamp: 1 },
		],
	} as never;
	const agentic = {
		messages: [
			{ role: "system", content: "you are pi", timestamp: 0, toolsAdded: ["read", "bash", "edit"].map(tool) },
			{ role: "user", content: "hi", timestamp: 1 },
		],
	} as never;
	/** Real tools, but no reader — the free tier 403s that shape too. */
	const noReader = {
		messages: [
			{ role: "system", content: "you are pi", timestamp: 0, toolsAdded: ["write", "edit"].map(tool) },
			{ role: "user", content: "hi", timestamp: 1 },
		],
	} as never;
	/** A reader, but no exec role. */
	const noExec = {
		messages: [
			{ role: "system", content: "you are pi", timestamp: 0, toolsAdded: ["read", "grep"].map(tool) },
			{ role: "user", content: "hi", timestamp: 1 },
		],
	} as never;

	/** Tool names the forwarded transcript declares, in declaration order. */
	function declaredTools(sent: unknown): string[] {
		const messages = (sent as { messages: { role: string; toolsAdded?: { name: string }[] }[] }).messages;
		const names = new Set<string>();
		for (const message of messages) {
			if (message.role !== "system") continue;
			for (const tool of message.toolsAdded ?? []) names.add(tool.name);
		}
		return [...names];
	}

	it("declares read + shell on a toolless request and forbids calling them (chat transport)", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		await collect(createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }))(zenModelCompletions, toolless));
		expect(declaredTools(impl.calls[0]!.context)).toEqual([ZEN_PAD_READ_TOOL, ZEN_PAD_EXEC_TOOLS[0]]);
		expect(impl.calls[0]!.options.toolChoice).toBe("none");
	});

	it("fills both roles for a one-tool request and leaves the real tool callable", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		await collect(createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }))(zenModelCompletions, oneTool));
		expect(declaredTools(impl.calls[0]!.context)).toEqual([ZEN_PAD_READ_TOOL, ZEN_PAD_EXEC_TOOLS[0], "todowrite"]);
		expect(impl.calls[0]!.options.toolChoice).toBeUndefined();
	});

	it("adds only the missing exec role when read is already declared", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		await collect(createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }))(zenModelCompletions, noExec));
		expect(declaredTools(impl.calls[0]!.context)).toEqual([ZEN_PAD_EXEC_TOOLS[0], "read", "grep"]);
	});

	it("adds both roles when the session's tools are neither reader nor exec", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		await collect(createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }))(zenModelCompletions, noReader));
		expect(declaredTools(impl.calls[0]!.context)).toEqual([ZEN_PAD_READ_TOOL, ZEN_PAD_EXEC_TOOLS[0], "write", "edit"]);
		expect(impl.calls[0]!.options.toolChoice).toBeUndefined();
	});

	it("keeps an already agentic request's tools and adds only the system pad", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		await collect(createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }))(zenModelCompletions, agentic));
		const sent = (impl.calls[0]!.context as { messages: { role: string; content?: unknown }[] }).messages;
		expect(sent[0]!.content).toBe(ZEN_OFFICIAL_SYSTEM_PROMPT);
		expect(sent.slice(1)).toEqual((agentic as { messages: unknown[] }).messages);
		expect(declaredTools(impl.calls[0]!.context)).toEqual(["read", "bash", "edit"]);
		expect(impl.calls[0]!.options.toolChoice).toBeUndefined();
	});

	it("forwards the context untouched when the official prompt already leads", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const official = {
			messages: [
				{ role: "system", content: ZEN_OFFICIAL_SYSTEM_PROMPT, timestamp: 0, toolsAdded: ["read", "bash"].map(tool) },
				{ role: "user", content: "hi", timestamp: 1 },
			],
		} as never;
		await collect(createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }))(zenModelCompletions, official));
		expect(impl.calls[0]!.context).toBe(official);
	});

	it("never forces tool_choice on the responses transport (only \"auto\" is accepted there)", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		await collect(createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }))(zenModelResponses, toolless));
		expect(declaredTools(impl.calls[0]!.context)).toEqual([ZEN_PAD_READ_TOOL, ZEN_PAD_EXEC_TOOLS[0]]);
		expect(impl.calls[0]!.options.toolChoice).toBeUndefined();
	});

	it("prepends the official prompt ahead of the original messages when padding", async () => {
		const impl = fakeImpl();
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		await collect(createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }))(zenModelCompletions, toolless));
		const sent = (impl.calls[0]!.context as { messages: { role: string; content?: unknown }[] }).messages;
		expect(sent.map((m) => m.role)).toEqual(["system", "system", "user"]);
		expect(sent[0]!.content).toBe(ZEN_OFFICIAL_SYSTEM_PROMPT);
		expect(sent[1]!.content).toBe("summarize this");
	});

	it("unwraps a pad call the model made anyway: its text survives, the call does not", async () => {
		const impl = fakeImpl([
			{ type: "start" } as AssistantMessageEvent,
			{
				type: "done",
				reason: "toolUse",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: ZEN_PAD_READ_TOOL, arguments: { text: "## Goal\nship it" } }],
					stopReason: "toolUse",
				},
			} as unknown as AssistantMessageEvent,
		]);
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const events = await collect(createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }))(zenModelCompletions, toolless));
		const done = events.find((e) => e.type === "done") as { reason: string; message: { stopReason: string; content: unknown[] } };
		expect(done.reason).toBe("stop");
		expect(done.message.stopReason).toBe("stop");
		expect(done.message.content).toEqual([{ type: "text", text: "## Goal\nship it" }]);
	});

	it("leaves real tool calls alone", async () => {
		const impl = fakeImpl([
			{ type: "start" } as AssistantMessageEvent,
			{
				type: "done",
				reason: "toolUse",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call_1", name: "todowrite", arguments: { text: "real work" } }],
					stopReason: "toolUse",
				},
			} as unknown as AssistantMessageEvent,
		]);
		(getApiProvider as unknown as Mock).mockReturnValue(impl);
		const events = await collect(createZenfreeStream(zenDeps({ mode: "apiKey", apiKey: "oc_sk-x" }))(zenModelCompletions, oneTool));
		const done = events.find((e) => e.type === "done") as { reason: string; message: { content: { name: string }[] } };
		expect(done.reason).toBe("toolUse");
		expect(done.message.content.map((c) => c.name)).toEqual(["todowrite"]);
	});
});
