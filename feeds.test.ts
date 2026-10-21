import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	MODELS_DEV_URL,
	fetchModelsDevModels,
	fetchModelsDevOpenRouter,
	fetchVercelGateway,
	reduceModelsDev,
	reduceModelsDevProvider,
	reduceVercel,
} from "./feeds.ts";

const dir = join(import.meta.dirname, "test-fixtures");
const modelsdev = readFileSync(join(dir, "modelsdev.json"), "utf8");
const vercel = readFileSync(join(dir, "vercel-models.json"), "utf8");

describe("reduceModelsDev", () => {
	it("reduces the openrouter block keyed by full id, preserving limits and reasoning options", () => {
		const entries = reduceModelsDev(JSON.parse(modelsdev));
		expect(Object.keys(entries).sort()).toEqual([
			"deepseek/deepseek-v4.1-flash",
			"google/gemini-3.8-flash",
			"meta/muse-spark-1.3-contributor",
			"stealth/space-bunny-alpha",
			"xiaomi/mimo-v2.6-flash",
		]);
		expect(entries["deepseek/deepseek-v4.1-flash"]).toEqual({
			id: "deepseek/deepseek-v4.1-flash",
			name: "DeepSeek: V4.1 Flash",
			contextWindow: 1048576,
			maxTokens: 384000,
			inputModalities: ["text", "image"],
			effortValues: ["low", "high", "max"],
			toggle: true,
		});
		expect(entries["stealth/space-bunny-alpha"]?.toggle).toBeUndefined();
		expect(entries["stealth/space-bunny-alpha"]?.effortValues).toEqual(["low", "medium", "high", "xhigh", "max"]);
		expect(entries["xiaomi/mimo-v2.6-flash"]?.toggle).toBe(true);
		expect(entries["xiaomi/mimo-v2.6-flash"]?.effortValues).toBeUndefined();
	});

	it("returns {} for malformed payloads without throwing", () => {
		expect(reduceModelsDev({})).toEqual({});
		expect(reduceModelsDev({ providers: { openrouter: null } })).toEqual({});
		expect(reduceModelsDev(null)).toEqual({});
	});
});

describe("reduceVercel", () => {
	it("reduces the gateway listing, including the Vercel-only stealth model", () => {
		const entries = reduceVercel(JSON.parse(vercel));
		expect(entries["stealth/pixel-canary"]).toEqual({
			id: "stealth/pixel-canary",
			name: "Pixel Canary",
			contextWindow: 262144,
			maxTokens: 131072,
			inputModalities: ["text", "image"],
			effortValues: ["none", "low", "medium", "xhigh"],
			toggle: undefined,
		});
		// Vercel's disagreeing deepseek numbers survive verbatim — precedence is Task 5's job.
		expect(entries["deepseek/deepseek-v4.1-flash"]?.maxTokens).toBe(32768);
	});

	it("returns {} for malformed payloads without throwing", () => {
		expect(reduceVercel({ data: null })).toEqual({});
		expect(reduceVercel({})).toEqual({});
		expect(reduceVercel("nope")).toEqual({});
	});
});

describe("feed fetchers", () => {
	it("fetches the fixed URLs and reduces the payload", async () => {
		const calls: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			calls.push(url);
			const body = url.includes("models.dev") ? modelsdev : vercel;
			return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
		};
		const openrouter = await fetchModelsDevOpenRouter(fetcher);
		const vercelGateway = await fetchVercelGateway(fetcher);
		expect(calls).toEqual(["https://models.dev/api.json", "https://ai-gateway.vercel.sh/v1/models"]);
		expect(openrouter["deepseek/deepseek-v4.1-flash"]?.maxTokens).toBe(384000);
		expect(vercelGateway["stealth/pixel-canary"]?.contextWindow).toBe(262144);
	});

	it("throws with the status on a non-200 response", async () => {
		const fetcher: typeof fetch = async () => new Response("nope", { status: 503 });
		await expect(fetchModelsDevOpenRouter(fetcher)).rejects.toThrow(/503/);
		await expect(fetchVercelGateway(fetcher)).rejects.toThrow(/503/);
	});
});

describe("fetchModelsDevModels", () => {
	const ocPayload = JSON.parse(readFileSync("test-fixtures/modelsdev-opencode.json", "utf-8"));

	it("extracts the opencode block from the wrapper-less payload, capturing cost and package hints", async () => {
		const entries = reduceModelsDevProvider(ocPayload, "opencode");
		expect(Object.keys(entries).sort()).toEqual(
			["big-pickle", "gpt-5.1", "grok-code", "mimo-v2.6-flash-free", "muse-spark-1.3-contributor-free", "nemotron-3-ultra-free"].sort(),
		);
		const bp = entries["big-pickle"]!;
		expect(bp.contextWindow).toBe(200_000);
		expect(bp.maxTokens).toBe(32_000);
		expect(bp.name).toBe("Big Pickle");
		expect(bp.costInput).toBe(0);
		expect(bp.package).toBeUndefined();
		expect(entries["gpt-5.1"]?.costInput).toBe(1.07);
		expect(entries["grok-code"]?.costInput).toBe(0);
		expect(entries["muse-spark-1.3-contributor-free"]?.package).toBe("@ai-sdk/openai");
	});

	it("returns empty for an unknown provider id", () => {
		expect(reduceModelsDevProvider(ocPayload, "does-not-exist")).toEqual({});
	});

	it("openrouter wrapper still extracts the same entries as before", () => {
		const orPayload = JSON.parse(readFileSync("test-fixtures/modelsdev.json", "utf-8"));
		const viaParam = reduceModelsDevProvider(orPayload, "openrouter");
		const viaLegacy = reduceModelsDev(orPayload);
		expect(viaParam).toEqual(viaLegacy);
	});

	it("fetchModelsDevModels requests the feed url and reduces the given provider", async () => {
		const fetcher = (async (url: string) => {
			expect(url).toBe(MODELS_DEV_URL);
			return new Response(JSON.stringify(ocPayload), { status: 200 });
		}) as typeof fetch;
		const entries = await fetchModelsDevModels("opencode", fetcher);
		expect(entries["big-pickle"]).toBeDefined();
	});
});
