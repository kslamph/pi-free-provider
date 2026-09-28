/**
 * Wire-shape tests (spec §zen-4, §6): the serialized request body must match what the
 * official client sends.
 *
 * The official OpenCode client routes the zen free chat models through
 * `@ai-sdk/openai-compatible`, whose builder serializes the output cap as
 * `max_tokens` (and `max_completion_tokens` does not appear in that package at
 * all). models.dev assigns that package to the whole provider, so a zenfree
 * request must not fall back to pi-ai's detected `max_completion_tokens`.
 *
 * The official Cline client (~/cline, sdk/packages/llms) uses the same AI SDK
 * package, and `withMaxCompletionTokensForReasoningModels` only renames the cap
 * to `max_completion_tokens` for o-series/gpt-5 model ids — no Cline free id
 * matches, so the real client sends `max_tokens` there too.
 *
 * These tests run the real pi-ai builder against a stub fetch and assert the
 * serialized body, so a regression in the registered model config fails here
 * rather than as a mysterious 400 from the gateway.
 */

import { describe, expect, it } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { buildZenTargets } from "./index.ts";
import { BAKED_IN_ZEN_CONTRACT } from "./sources/opencode-contract.ts";
import type { ZenCapabilities } from "./sources/opencode-config.ts";
import { toProviderModel } from "./mapping.ts";
import type { ModelCapabilities } from "./capabilities.ts";

const caps: ZenCapabilities = {
	contextWindow: 200_000,
	maxTokens: 32_000,
	input: ["text"],
	reasoning: true,
	toggle: false,
	source: "opencode",
};

/** The model a real zenfree chat request is built from (real registration path). */
function zenModel(): Record<string, unknown> {
	const targets = buildZenTargets({
		lineup: [{ id: "big-pickle", name: "Big Pickle" }],
		resolve: () => caps,
		resolveTransport: () => "openai-completions",
		contract: BAKED_IN_ZEN_CONTRACT,
		streamSimple: (() => ({})) as never,
		registerProvider: () => {},
	});
	return { provider: "zenfree", ...(targets[0]!.models[0] as unknown as Record<string, unknown>) };
}

/** Run the real openai-completions builder and return the serialized request body. */
async function bodyFor(model: Record<string, unknown>, options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> | undefined;
	const sse = 'data: {"id":"c1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n';
	const stubFetch = (async () =>
		new Response(new ReadableStream({ start(controller) {
			controller.enqueue(new TextEncoder().encode(sse));
			controller.close();
		}}), { status: 200, headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
	const sub = streamSimple(model as never, { messages: [{ role: "user", content: "hi" }] } as never, {
		apiKey: "k",
		maxRetries: 0,
		fetch: stubFetch,
		onPayload: (payload: Record<string, unknown>) => {
			captured = payload;
		},
		...options,
	} as never);
	for await (const _event of sub) {
		// drain; the stub stream carries no finish_reason, so the payload is the assertion
	}
	expect(captured, "pi-ai did not serialize a payload").toBeDefined();
	return captured as Record<string, unknown>;
}

describe("zenfree wire shape matches the official OpenCode client", () => {	it("sends the output cap as max_tokens, never max_completion_tokens", async () => {
		const body = await bodyFor(zenModel());
		expect(body.max_tokens).toBe(32_000);
		expect(body).not.toHaveProperty("max_completion_tokens");
	});

	it("sends a flat reasoning_effort, not a nested reasoning object", async () => {
		const body = await bodyFor(zenModel(), { reasoning: "high" });
		expect(body.reasoning_effort).toBe("high");
		expect(body).not.toHaveProperty("reasoning");
	});

	it("omits store and keeps the system role (non-standard-endpoint compat)", async () => {
		const body = await bodyFor(zenModel());
		expect(body).not.toHaveProperty("store");
		const messages = body.messages as { role: string }[];
		expect(messages.every((m) => m.role !== "developer")).toBe(true);
	});
});

describe("clinefree wire shape matches the official Cline client", () => {
	const clineCaps: ModelCapabilities = {
		contextWindow: 1_048_576,
		maxTokens: 384_000,
		input: ["text", "image"],
		reasoning: true,
		toggle: true,
		effortValues: ["low", "high", "max"],
		source: "openrouter",
	};

	/** The model a real clinefree request is built from (the registered path). */
	function clineModel(): Record<string, unknown> {
		return {
			provider: "clinefree",
			...toProviderModel("cline-free/deepseek-v4.1-flash", clineCaps, "DeepSeek V4.1 Flash", {
				maxTokensField: "max_tokens",
			}),
		};
	}

	it("sends the output cap as max_tokens, never max_completion_tokens", async () => {
		const body = await bodyFor(clineModel());
		expect(body.max_tokens).toBe(384_000);
		expect(body).not.toHaveProperty("max_completion_tokens");
	});

	it("keeps the nested reasoning.effort object the Cline endpoint is verified to accept", async () => {
		const body = await bodyFor(clineModel(), { reasoning: "high" });
		expect(body.reasoning).toEqual({ effort: "high" });
		expect(body).not.toHaveProperty("reasoning_effort");
	});
});
