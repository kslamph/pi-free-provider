import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FeedEntry } from "../feeds.ts";
import {
	CONSOLE_CONFIG_URL,
	ZEN_DEFAULTS,
	fetchConsoleConfig,
	mergeZenCapabilities,
	parseConsoleConfig,
	type ZenModelEntry,
} from "./opencode-config.ts";

const dir = join(import.meta.dirname, "..", "test-fixtures");
const configPayload = JSON.parse(readFileSync(join(dir, "console-config.json"), "utf-8"));

describe("parseConsoleConfig", () => {
	it("captures baseUrl, provider headers, and the free lineup from the live payload", () => {
		const cfg = parseConsoleConfig(configPayload);
		expect(cfg.baseUrl).toBe("https://opencode.ai/inference/openai/v1");
		expect(cfg.headers).toEqual({ "x-opencode-org-id": "wrk_01SYNTHETICTESTVALUE0000" });
		const free = Object.keys(cfg.models).filter((id) => cfg.models[id]!.free).sort();
		expect(free).toEqual(
			[
				"big-pickle",
				"ling-3.0-flash-fin-free",
				"longcat-2.5-preview-free",
				"mimo-v2.6-flash-free",
				"muse-spark-1.3-contributor-free",
				"nemotron-3-ultra-free",
				"nemotron-3.5-lightning-free",
				"space-bunny-free",
			].sort(),
		);
	});

	it("paid models are marked not free; missing cost means not free", () => {
		const cfg = parseConsoleConfig(configPayload);
		expect(cfg.models["claude-sonnet-5"]!.free).toBe(false);
		expect(cfg.models["gpt-5.4-mini"]!.free).toBe(false);
		const handMade = parseConsoleConfig({
			providers: { opencode: { models: { "zero-cost": { cost: [{ input: 0, output: 0 }] }, "no-cost-field": {} } } },
		});
		expect(handMade.models["zero-cost"]!.free).toBe(true);
		expect(handMade.models["no-cost-field"]!.free).toBe(false);
	});

	it("maps limits, input modalities, and names", () => {
		const cfg = parseConsoleConfig(configPayload);
		const mimo = cfg.models["mimo-v2.6-flash-free"]!;
		expect(mimo.limit).toEqual({ context: 200_000, output: 32_000 });
		expect(mimo.input).toEqual(["text", "image"]);
		expect(mimo.name).toBe("MiMo-V2.6-Flash Free");
		expect(mimo.package).toBeUndefined();
		const muse = cfg.models["muse-spark-1.3-contributor-free"]!;
		expect(muse.input).toEqual(["text", "image"]);
		expect(muse.package).toBe("aisdk:@ai-sdk/openai");
	});

	it("is lenient on unknown shapes: empty models, no crash", () => {
		expect(parseConsoleConfig(undefined)).toEqual({ models: {} });
		expect(parseConsoleConfig({ providers: {} })).toEqual({ models: {} });
		expect(parseConsoleConfig({ providers: { opencode: { models: "not-a-map" } } })).toEqual({ models: {} });
	});
});

describe("fetchConsoleConfig", () => {
	it("sends the bearer key and returns the parsed config", async () => {
		let seenAuth = "";
		const fetcher = (async (_url: string, init?: RequestInit) => {
			const headers = init?.headers as Record<string, string> | undefined;
			seenAuth = String(headers?.["Authorization"] ?? "");
			return new Response(JSON.stringify(configPayload), { status: 200 });
		}) as typeof fetch;
		const cfg = await fetchConsoleConfig("oc_sk_test", fetcher);
		expect(seenAuth).toBe("Bearer oc_sk_test");
		expect(cfg?.baseUrl).toBe("https://opencode.ai/inference/openai/v1");
	});

	it("throws HTTP 401 on 401 and returns undefined on network errors", async () => {
		const unauthorized = (async () => new Response('{"_tag":"Unauthorized"}', { status: 401 })) as typeof fetch;
		await expect(fetchConsoleConfig("bad", unauthorized)).rejects.toThrow("HTTP 401");
		const broken = (async () => {
			throw new Error("network down");
		}) as typeof fetch;
		expect(await fetchConsoleConfig("k", broken)).toBeUndefined();
	});
});

describe("mergeZenCapabilities", () => {
	const configEntry = (over: Partial<ZenModelEntry> = {}): ZenModelEntry => ({
		free: true,
		name: "From Config",
		limit: { context: 123_456, output: 65_432 },
		input: ["text"],
		...over,
	});
	const devEntry = (over: Partial<FeedEntry> = {}): FeedEntry => ({
		id: "x",
		name: "From Dev",
		contextWindow: 111_111,
		maxTokens: 11_111,
		inputModalities: ["text", "image"],
		...over,
	});

	it("config alone: config limits win, reasoning defaults on, source config", () => {
		const merged = mergeZenCapabilities(configEntry(), undefined);
		expect(merged).toEqual({
			contextWindow: 123_456,
			maxTokens: 65_432,
			input: ["text"],
			reasoning: true,
			toggle: false,
			name: "From Config",
			source: "config",
		});
	});

	it("models.dev alone fills every field, source modelsdev", () => {
		const merged = mergeZenCapabilities(undefined, devEntry());
		expect(merged.contextWindow).toBe(111_111);
		expect(merged.maxTokens).toBe(11_111);
		expect(merged.input).toEqual(["text", "image"]);
		expect(merged.name).toBe("From Dev");
		expect(merged.source).toBe("modelsdev");
	});

	it("both: config wins the fields it has; dev fills only the gaps", () => {
		const merged = mergeZenCapabilities(configEntry({ limit: undefined, name: undefined, input: undefined }), devEntry());
		expect(merged.contextWindow).toBe(111_111);
		expect(merged.input).toEqual(["text", "image"]);
		expect(merged.name).toBe("From Dev");
		expect(merged.source).toBe("modelsdev");
		const configWins = mergeZenCapabilities(configEntry(), devEntry());
		expect(configWins.contextWindow).toBe(123_456);
		expect(configWins.maxTokens).toBe(65_432);
		expect(configWins.input).toEqual(["text"]);
		expect(configWins.name).toBe("From Config");
		expect(configWins.source).toBe("config");
	});

	it("neither: zen defaults, reasoning on, source default", () => {
		const merged = mergeZenCapabilities(undefined, undefined);
		expect(merged).toEqual({ ...ZEN_DEFAULTS, source: "default" });

	});

	it("zen policy: dev effort options are ignored — reasoning always on, no toggle", () => {
		const devWithEffort = devEntry({ effortValues: ["minimal", "low", "medium", "high", "xhigh"], toggle: true });
		const merged = mergeZenCapabilities(undefined, devWithEffort);
		expect(merged.reasoning).toBe(true);
		expect(merged.toggle).toBe(false);
	});

	it("non text/image modalities are dropped; empty falls back to text", () => {
		const merged = mergeZenCapabilities(configEntry({ input: ["audio", "video"] as unknown as ("text" | "image")[] }), undefined);
		expect(merged.input).toEqual(["text"]);
		const audioOnly = mergeZenCapabilities(configEntry({ input: ["audio"] as unknown as ("text" | "image")[] }), undefined);
		expect(audioOnly.input).toEqual(["text"]);
	});
});
