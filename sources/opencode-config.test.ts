import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { FeedEntry } from "../feeds.ts";
import { toProviderModel } from "../mapping.ts";
import {
	CONSOLE_CONFIG_URL,
	ZEN_DEFAULTS,
	composeZenLineup,
	fetchConsoleConfig,
	mergeZenCapabilities,
	parseConsoleConfig,
	type ZenConsoleConfig,
	type ZenModelEntry,
} from "./opencode-config.ts";
import { reduceModelsDevProvider } from "../feeds.ts";

const dir = join(import.meta.dirname, "..", "test-fixtures");
const configPayload = JSON.parse(readFileSync(join(dir, "console-config.json"), "utf-8"));
const overlayPayload = JSON.parse(readFileSync(join(dir, "console-config-overlay.json"), "utf-8"));

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

	it("captures disabled flags and whether the entry carried a cost array", () => {
		const old = parseConsoleConfig(configPayload);
		expect(old.models["claude-sonnet-5"]!.costed).toBe(true);
		expect(old.models["claude-sonnet-5"]!.disabled).toBe(true);
		expect(old.models["big-pickle"]!.costed).toBe(true);
		expect(old.models["big-pickle"]!.disabled).toBeUndefined();
		// The 2026-10 workspace-overlay shape: entries carry only overrides,
		// no cost array and usually just `disabled`.
		const overlay = parseConsoleConfig(overlayPayload);
		expect(overlay.models["claude-sonnet-5"]!).toEqual({ free: false, disabled: true });
		expect(overlay.models["grok-build-0.1"]!).toEqual({ free: false, package: "aisdk:@ai-sdk/openai-compatible" });
		expect(overlay.models["claude-sonnet-5"]!.costed).toBeUndefined();
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

describe("composeZenLineup", () => {
	const dev = reduceModelsDevProvider(JSON.parse(readFileSync(join(dir, "modelsdev-opencode.json"), "utf-8")), "opencode");
	const legacyFreeIds = [
		"big-pickle",
		"ling-3.0-flash-fin-free",
		"longcat-2.5-preview-free",
		"mimo-v2.6-flash-free",
		"muse-spark-1.3-contributor-free",
		"nemotron-3-ultra-free",
		"nemotron-3.5-lightning-free",
		"space-bunny-free",
	];

	it("config-only composition keeps the legacy full-catalog behavior", () => {
		const composed = composeZenLineup(parseConsoleConfig(configPayload), {});
		expect(Object.keys(composed.models).sort()).toEqual(legacyFreeIds.slice().sort());
		expect(composed.baseUrl).toBe("https://opencode.ai/inference/openai/v1");
	});

	it("workspace-overlay config: free = models.dev zero-cost minus disabled, paid skipped", () => {
		const composed = composeZenLineup(parseConsoleConfig(overlayPayload), dev);
		// muse is disabled by the overlay, gpt-5.1 is paid, grok-code is dev-only free
		expect(Object.keys(composed.models).sort()).toEqual(
			["big-pickle", "grok-code", "mimo-v2.6-flash-free", "nemotron-3-ultra-free"].sort(),
		);
		expect(composed.baseUrl).toBeUndefined();
		expect(composed.headers).toEqual({ "x-opencode-org-id": "org_01SYNTHETICOVERLAYTEST00A" });
	});

	it("dev-only entries carry name/limits/input; config overlay overrides the fields it has", () => {
		const composed = composeZenLineup(parseConsoleConfig(configPayload), dev);
		expect(composed.models["grok-code"]!).toMatchObject({
			free: true,
			name: "Grok Code",
			limit: { context: 256_000, output: 32_768 },
			input: ["text"],
		});
		// config limit fields win over dev for overlapping ids
		expect(composed.models["big-pickle"]!.limit).toEqual({ context: 200_000, output: 32_000 });
		expect(composed.models["longcat-2.5-preview-free"]!.limit).toEqual({ context: 1_000_000, output: 131_072 });
	});

	it("dev npm package maps to the responses transport package vocabulary", () => {
		const composed = composeZenLineup(undefined, dev);
		expect(composed.models["muse-spark-1.3-contributor-free"]!.package).toBe("aisdk:@ai-sdk/openai");
		expect(composed.models["big-pickle"]!.package).toBeUndefined();
	});

	it("a console entry with a cost array is an explicit verdict overriding models.dev", () => {
		// dev says free, config declares paid → excluded
		const paidOverlay: ZenConsoleConfig = { models: { "big-pickle": { free: false, costed: true } } };
		expect(composeZenLineup(paidOverlay, dev).models["big-pickle"]).toBeUndefined();
		// dev says paid, config declares free → included
		const freeOverlay: ZenConsoleConfig = { models: { "gpt-5.1": { free: true, costed: true } } };
		expect(composeZenLineup(freeOverlay, dev).models["gpt-5.1"]?.free).toBe(true);
	});

	it("a disabled console entry vetoes models.dev freeness even without cost info", () => {
		const overlay: ZenConsoleConfig = { models: { "grok-code": { free: false, disabled: true } } };
		expect(composeZenLineup(overlay, dev).models["grok-code"]).toBeUndefined();
	});

	it("drops models.dev models the catalog flags status deprecated", () => {
		const composed = composeZenLineup(undefined, dev);
		expect(composed.models["space-bunny-free"]).toBeUndefined();
		expect(composed.models["fledge-alpha-free"]).toBeUndefined();
		// non-deprecated entries survive
		expect(composed.models["big-pickle"]).toBeDefined();
		expect(composed.models["grok-code"]).toBeDefined();
	});

	it("a deprecated catalog verdict vetoes a legacy console free declaration", () => {
		// the console config still lists space-bunny-free as free (stale legacy shape)
		const composed = composeZenLineup(parseConsoleConfig(configPayload), dev);
		expect(composed.models["space-bunny-free"]).toBeUndefined();
		// …and without a catalog verdict the same console entry is kept
		expect(composeZenLineup(parseConsoleConfig(configPayload), {}).models["space-bunny-free"]).toBeDefined();
	});

	it("keeps models whose status is anything other than deprecated", () => {
		const dev2: Record<string, FeedEntry> = { "beta-model": { id: "beta-model", costInput: 0, status: "beta" } };
		expect(composeZenLineup(undefined, dev2).models["beta-model"]).toBeDefined();
	});

	it("empty config + empty dev → empty lineup (no invention)", () => {
		expect(composeZenLineup({ models: {} }, {}).models).toEqual({});
		expect(composeZenLineup(undefined, {}).models).toEqual({});
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
			source: "opencode",
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
		expect(configWins.source).toBe("opencode");
	});

	it("neither: zen defaults, reasoning on, source default", () => {
		const merged = mergeZenCapabilities(undefined, undefined);
		expect(merged).toEqual({ ...ZEN_DEFAULTS, source: "default" });

	});

	it("adopts models.dev effort values (no toggle): muse-spark exposes minimal…xhigh", () => {
		const devWithEffort = devEntry({ effortValues: ["minimal", "low", "medium", "high", "xhigh"] });
		const merged = mergeZenCapabilities(undefined, devWithEffort);
		expect(merged.reasoning).toBe(true);
		expect(merged.toggle).toBe(false);
		expect(merged.effortValues).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
	});

	it("adopts a models.dev toggle: ling/longcat expose off + high", () => {
		const merged = mergeZenCapabilities(undefined, devEntry({ toggle: true }));
		expect(merged.toggle).toBe(true);
		expect(merged.effortValues).toBeUndefined();
	});

	it("no advertised options ⇒ no toggle and no effort list (pi supplies the generic levels)", () => {
		for (const merged of [
			mergeZenCapabilities(configEntry(), undefined),
			mergeZenCapabilities(undefined, devEntry({ toggle: undefined, effortValues: undefined })),
			mergeZenCapabilities(undefined, undefined),
		]) {
			expect(merged.toggle).toBe(false);
			expect(merged.effortValues).toBeUndefined();
		}
	});

	it("an advertised toggle keeps off + high (ling/longcat accept the disable value)", () => {
		const model = toProviderModel("ling-3.0-flash-fin-free", mergeZenCapabilities(undefined, devEntry({ toggle: true })), undefined, { thinkingFormat: "openai" });
		expect(getSupportedThinkingLevels(model as never)).toEqual(["off", "high"]);
	});

	it("regression: zen models expose pi thinking levels instead of an all-null map", () => {
		const noOptions = toProviderModel("big-pickle", mergeZenCapabilities(configEntry(), undefined), undefined, { thinkingFormat: "openai" });
		expect(noOptions.thinkingLevelMap).toEqual({});
		expect(getSupportedThinkingLevels(noOptions as never)).toEqual(["off", "minimal", "low", "medium", "high"]);
		const effort = toProviderModel("muse-spark-1.3-contributor-free", mergeZenCapabilities(undefined, devEntry({ effortValues: ["minimal", "low", "medium", "high", "xhigh"] })), undefined, { thinkingFormat: "openai" });
		expect(getSupportedThinkingLevels(effort as never)).toEqual(["minimal", "low", "medium", "high", "xhigh"]);
	});

	it("non text/image modalities are dropped; empty falls back to text", () => {
		const merged = mergeZenCapabilities(configEntry({ input: ["audio", "video"] as unknown as ("text" | "image")[] }), undefined);
		expect(merged.input).toEqual(["text"]);
		const audioOnly = mergeZenCapabilities(configEntry({ input: ["audio"] as unknown as ("text" | "image")[] }), undefined);
		expect(audioOnly.input).toEqual(["text"]);
	});
});
