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
import { createClinefreeStream, resetConversation } from "./stream.ts";
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
});
