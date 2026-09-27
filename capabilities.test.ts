import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CAPABILITIES, resolveCapabilities } from "./capabilities.ts";
import { reduceModelsDev, reduceVercel, type FeedEntry } from "./feeds.ts";

const dir = join(import.meta.dirname, "test-fixtures");
const openrouter = reduceModelsDev(JSON.parse(readFileSync(join(dir, "modelsdev.json"), "utf8")));
const vercel = reduceVercel(JSON.parse(readFileSync(join(dir, "vercel-models.json"), "utf8")));

describe("resolveCapabilities", () => {
	it("prefers openrouter when both feeds have the model (deepseek out=384000, not vercel's 32768)", () => {
		const caps = resolveCapabilities("cline-free/deepseek-v4.1-flash", openrouter, vercel);
		expect(caps.source).toBe("openrouter");
		expect(caps.maxTokens).toBe(384000);
		expect(caps.contextWindow).toBe(1048576);
		expect(caps.input).toEqual(["text", "image"]);
		expect(caps.toggle).toBe(true);
		expect(caps.effortValues).toEqual(["low", "high", "max"]);
		expect(caps.reasoning).toBe(true);
	});

	it("falls back to the vercel gateway for vercel-only ids (pixel-canary)", () => {
		const caps = resolveCapabilities("stealth/pixel-canary", openrouter, vercel);
		expect(caps.source).toBe("vercel");
		expect(caps.contextWindow).toBe(262144);
		expect(caps.maxTokens).toBe(131072);
		expect(caps.input).toEqual(["text", "image"]);
		expect(caps.effortValues).toEqual(["none", "low", "medium", "xhigh"]);
		expect(caps.reasoning).toBe(true);
	});

	it("resolves an exact openrouter id (space-bunny) and drops non-pi modalities", () => {
		const caps = resolveCapabilities("stealth/space-bunny-alpha", openrouter, vercel);
		expect(caps.source).toBe("openrouter");
		expect(caps.input).toEqual(["text", "image"]); // video dropped
		expect(caps.effortValues).toEqual(["low", "medium", "high", "xhigh", "max"]);
	});

	it("resolves via slug when the exact id is absent (gemini)", () => {
		const caps = resolveCapabilities("cline-free/gemini-3.8-flash", openrouter, vercel);
		expect(caps.source).toBe("openrouter");
		expect(caps.contextWindow).toBe(1048576);
		expect(caps.maxTokens).toBe(65536);
	});

	it("returns the fixed defaults for an id in neither feed", () => {
		expect(resolveCapabilities("brand/new-thing", openrouter, vercel)).toEqual(DEFAULT_CAPABILITIES);
		expect(DEFAULT_CAPABILITIES.contextWindow).toBe(256_000);
		expect(DEFAULT_CAPABILITIES.maxTokens).toBe(32_000);
		expect(DEFAULT_CAPABILITIES.input).toEqual(["text"]);
		expect(DEFAULT_CAPABILITIES.reasoning).toBe(false);
		expect(DEFAULT_CAPABILITIES.source).toBe("default");
	});

	it("returns defaults for empty feeds without throwing", () => {
		const empty: Record<string, FeedEntry> = {};
		expect(resolveCapabilities("cline-free/deepseek-v4.1-flash", empty, empty)).toEqual(DEFAULT_CAPABILITIES);
	});
});
