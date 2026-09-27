import { describe, expect, it } from "vitest";
import { LEVELS, toProviderModel, type ProviderModel } from "./mapping.ts";
import type { ModelCapabilities } from "./capabilities.ts";

function caps(partial: Partial<ModelCapabilities>): ModelCapabilities {
	return {
		contextWindow: 1_000_000,
		maxTokens: 100_000,
		input: ["text"],
		reasoning: true,
		toggle: false,
		source: "openrouter",
		...partial,
	};
}

describe("toProviderModel", () => {
	it("maps every pi level, 1:1 for advertised values, null otherwise (deepseek: toggle + low/high/max)", () => {
		const model = toProviderModel(
			"cline-free/deepseek-v4.1-flash",
			caps({ toggle: true, effortValues: ["low", "high", "max"] }),
		);
		expect(model.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		});
	});

	it("treats an advertised 'none' effort as the off level (pixel-canary)", () => {
		const model = toProviderModel(
			"stealth/pixel-canary",
			caps({ effortValues: ["none", "low", "medium", "xhigh"], source: "vercel" }),
		);
		expect(model.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: "low",
			medium: "medium",
			high: null,
			xhigh: "xhigh",
			max: null,
		});
	});

	it("exposes off + high for a toggle-only model (mimo)", () => {
		const model = toProviderModel("cline-free/mimo-v2.6-flash", caps({ toggle: true }));
		expect(model.thinkingLevelMap).toEqual({
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("leaves off null for an effort model without toggle or 'none' (gemini)", () => {
		const model = toProviderModel("cline-free/gemini-3.8-flash", caps({ effortValues: ["low", "medium", "high"] }));
		expect(model.thinkingLevelMap).toEqual({
			off: null,
			minimal: null,
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		});
	});

	it("no reasoning → no map keys set, reasoning false", () => {
		const model = toProviderModel("brand/new-thing", caps({ reasoning: false, effortValues: undefined, source: "default" }));
		expect(model.reasoning).toBe(false);
		expect(Object.values(model.thinkingLevelMap).every((v) => v === null)).toBe(true);
	});

	it("compat.thinkingFormat=openrouter iff effort values exist", () => {
		const withEffort = toProviderModel("a", caps({ effortValues: ["low"] }));
		const toggleOnly = toProviderModel("b", caps({ toggle: true }));
		expect(withEffort.compat).toEqual({ thinkingFormat: "openrouter" });
		expect(toggleOnly.compat).toBeUndefined();
	});

	it("carries sizes, zero cost, fixed api/baseUrl, and the name rule", () => {
		const named = toProviderModel("cline-free/x", caps({ name: "DeepSeek: V4.1 Flash", contextWindow: 1048576, maxTokens: 384000 }), "Deepseek-v4.1-Flash");
		expect(named.name).toBe("DeepSeek: V4.1 Flash");
		expect(named.contextWindow).toBe(1048576);
		expect(named.maxTokens).toBe(384000);
		expect(named.api).toBe("openai-completions");
		expect(named.baseUrl).toBe("https://api.cline.bot/api/v1");
		expect(named.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		expect(named.id).toBe("cline-free/x");

		const fromFeed = toProviderModel("cline-free/y", caps({ name: undefined }), "Pixel Canary");
		expect(fromFeed.name).toBe("Pixel Canary (free)");

		const bare = toProviderModel("cline-free/z", caps({ name: undefined }), undefined);
		expect(bare.name).toBe("cline-free/z");
	});

	it("LEVELS covers exactly pi's thinking levels in order", () => {
		expect(LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});
});

describe("ProviderModel type shape", () => {
	it("is structurally compatible with pi's provider model config", () => {
		const model: ProviderModel = toProviderModel("x", caps({}));
		const keys = Object.keys(model);
		for (const required of ["id", "name", "api", "baseUrl", "reasoning", "thinkingLevelMap", "input", "cost", "contextWindow", "maxTokens"]) {
			expect(keys).toContain(required);
		}
	});
});

describe("toProviderModel overrides", () => {
	it("honors an api + baseUrl override for the responses transport", () => {
		const caps = { contextWindow: 1000, maxTokens: 500, input: ["text"] as ("text" | "image")[], reasoning: true, toggle: false, source: "default" as const };
		const model = toProviderModel("muse-spark-1.3-contributor-free", caps, undefined, {
			api: "openai-responses",
			baseUrl: "https://opencode.ai/inference/openai/v1",
		});
		expect(model.api).toBe("openai-responses");
		expect(model.baseUrl).toBe("https://opencode.ai/inference/openai/v1");
		expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});
});
