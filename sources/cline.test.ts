import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClineSource } from "./cline.ts";

const fixtures = join(import.meta.dirname, "..", "test-fixtures");
const recFixture = readFileSync(join(fixtures, "recommended-models.json"), "utf8");
const modelsdevFixture = readFileSync(join(fixtures, "modelsdev.json"), "utf8");
const vercelFixture = readFileSync(join(fixtures, "vercel-models.json"), "utf8");
const requestHeadersFixture = readFileSync(join(fixtures, "request-headers.ts"), "utf8");
const clientHeadersFixture = readFileSync(join(fixtures, "cline-client-headers.ts"), "utf8");
const recommendedFixture = readFileSync(join(fixtures, "catalog-cline-recommended.ts"), "utf8");
const cliRefs = readFileSync(join(fixtures, "matching-refs-cli.json"), "utf8");

let tmp: string;
let cache: Record<string, unknown>;
let calls: { url: string; init?: RequestInit }[];
let rawCount: () => number;
let matchingRefsCount: () => number;
let failUrls: Set<string>;
let clockMs: number;

function stubFetcher(): typeof fetch {
	return (async (input, init) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		if (failUrls.has(url)) return new Response("boom", { status: 503 });
		if (url.includes("matching-refs/tags/cli-v")) return new Response(cliRefs, { status: 200 });
		if (url.includes("matching-refs/tags/sdk/llms/v"))
			return new Response(
				JSON.stringify([{ ref: "refs/tags/sdk/llms/v0.0.86", object: { sha: "llms-sha-86", type: "commit" } }]),
				{ status: 200 },
			);
		if (url.includes("matching-refs/tags/sdk/core/v"))
			return new Response(
				JSON.stringify([{ ref: "refs/tags/sdk/core/v0.0.86", object: { sha: "core-sha-86", type: "commit" } }]),
				{ status: 200 },
			);
		if (url.includes("raw.githubusercontent.com")) {
			if (url.endsWith("request-headers.ts")) return new Response(requestHeadersFixture, { status: 200 });
			if (url.endsWith("cline-client-headers.ts")) return new Response(clientHeadersFixture, { status: 200 });
			if (url.endsWith("catalog-cline-recommended.ts")) return new Response(recommendedFixture, { status: 200 });
		}
		if (url.includes("api.cline.bot") && url.includes("recommended-models"))
			return new Response(recFixture, { status: 200 });
		if (url.includes("models.dev")) return new Response(modelsdevFixture, { status: 200 });
		if (url.includes("ai-gateway.vercel.sh")) return new Response(vercelFixture, { status: 200 });
		return new Response("unexpected url", { status: 500 });
	}) as typeof fetch;
}

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clinefree-src-"));
	cache = {};
	calls = [];
	failUrls = new Set();
	clockMs = 1_000_000;
	rawCount = () => calls.filter((c) => c.url.includes("raw.githubusercontent.com")).length;
	matchingRefsCount = () => calls.filter((c) => c.url.includes("matching-refs")).length;
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function makeSource() {
	return createClineSource({
		fetcher: stubFetcher(),
		now: () => clockMs,
		readCache: <T,>(name: string) => cache[name] as T | undefined,
		writeCache: (name: string, data: unknown) => {
			cache[name] = data;
		},
	});
}

describe("fetchLineup", () => {
	it("returns the free bucket ids in feed order, sending contract headers", async () => {
		const source = makeSource();
		const lineup = await source.fetchLineup();
		expect(lineup.map((e) => e.id)).toEqual([
			"stealth/pixel-canary",
			"stealth/space-bunny-alpha",
			"cline-free/mimo-v2.6-flash",
			"cline-free/deepseek-v4.1-flash",
			"cline-free/gemini-3.8-flash",
			"cline-free/muse-spark-1.3-contributor",
		]);
		const lineupCall = calls.find((c) => c.url.includes("api.cline.bot"));
		expect(lineupCall?.url).toBe("https://api.cline.bot/api/v1/ai/cline/recommended-models");
		const headers = lineupCall?.init?.headers as Record<string, string>;
		expect(headers["X-CLIENT-TYPE"]).toBe("cline-cli");
		expect(headers["User-Agent"]).toMatch(/^Cline\//);
	});

	it("handles a payload with an empty free bucket", async () => {
		cache["__override__"] = true; // marker; actual override below
		const source = createClineSource({
			fetcher: (async (input, init) => {
				const url = input.toString();
				calls.push({ url, init });
				if (url.includes("api.cline.bot")) return new Response(JSON.stringify({ free: [], recommended: [] }), { status: 200 });
				return new Response("{}", { status: 200 });
			}) as typeof fetch,
			now: () => clockMs,
			readCache: <T,>(name: string) => cache[name] as T | undefined,
			writeCache: (name: string, data: unknown) => {
				cache[name] = data;
			},
		});
		expect(await source.fetchLineup()).toEqual([]);
	});

	it("falls back to the cached lineup when the fetch fails", async () => {
		const source = makeSource();
		await source.fetchLineup();
		failUrls.add("https://api.cline.bot/api/v1/ai/cline/recommended-models");
		const cached = await source.fetchLineup();
		expect(cached.map((e) => e.id)).toEqual(["stealth/pixel-canary", "stealth/space-bunny-alpha", "cline-free/mimo-v2.6-flash", "cline-free/deepseek-v4.1-flash", "cline-free/gemini-3.8-flash", "cline-free/muse-spark-1.3-contributor"]);
	});
});

describe("refreshContract", () => {
	it("resolves three tags, downloads the contract files, and caches the result", async () => {
		const source = makeSource();
		const contract = await source.refreshContract(true);
		expect(contract.source).toBe("github");
		expect(contract.cliVersion).toBe("3.0.65");
		expect(contract.coreVersion).toBe("0.0.86");
		expect(matchingRefsCount()).toBe(3);
		expect(rawCount()).toBe(3);
		expect(cache["contract.json"]).toBeDefined();
	});

	it("skips tag resolution inside the min interval, and raw downloads when tags are unchanged", async () => {
		const source = makeSource();
		await source.refreshContract(true);
		const rawsAfterFirst = rawCount();
		const refsAfterFirst = matchingRefsCount();
		// not forced and inside the interval: nothing at all
		await source.refreshContract();
		expect(matchingRefsCount()).toBe(refsAfterFirst);
		// forced with unchanged tags: matching-refs yes, raw no
		await source.refreshContract(true);
		expect(matchingRefsCount()).toBe(refsAfterFirst + 3);
		expect(rawCount()).toBe(rawsAfterFirst);
	});

	it("records tags/shas/timestamps in state.json", async () => {
		const source = makeSource();
		await source.refreshContract(true);
		const state = cache["state.json"] as {
			tags: Record<string, string>;
			shas: Record<string, string>;
			timestamps: Record<string, number>;
		};
		expect(state.tags).toEqual({ llms: "sdk/llms/v0.0.86", core: "sdk/core/v0.0.86", cli: "cli-v3.0.65" });
		expect(state.shas.llms).toBe("llms-sha-86");
		expect(state.timestamps.contract).toBe(clockMs);
	});

	it("falls back to the baked-in contract when GitHub is unreachable, with a warning", async () => {
		const source = createClineSource({
			fetcher: (async () => new Response("down", { status: 503 })) as typeof fetch,
			now: () => clockMs,
			readCache: <T,>(name: string) => cache[name] as T | undefined,
			writeCache: (name: string, data: unknown) => {
				cache[name] = data;
			},
		});
		const contract = await source.refreshContract(true);
		expect(contract.source).toBe("baked-in");
		expect(contract.warning).toBeTruthy();
	});
});

describe("refreshCapabilities + resolveCapabilities", () => {
	const IDS = [
		"stealth/pixel-canary",
		"stealth/space-bunny-alpha",
		"cline-free/mimo-v2.6-flash",
		"cline-free/deepseek-v4.1-flash",
		"cline-free/gemini-3.8-flash",
		"cline-free/muse-spark-1.3-contributor",
	];

	it("caches both feeds and resolves pixel-canary through the vercel fallback", async () => {
		const source = makeSource();
		const feeds = await source.refreshCapabilities(IDS);
		expect(Object.keys(feeds.openrouter)).toContain("deepseek/deepseek-v4.1-flash");
		expect(Object.keys(feeds.vercel)).toContain("stealth/pixel-canary");
		const caps = source.resolveCapabilities("stealth/pixel-canary");
		expect(caps.contextWindow).toBe(262144);
		expect(caps.maxTokens).toBe(131072);
		expect(caps.source).toBe("vercel");
		expect(cache["capabilities.json"]).toBeDefined();
	});

	it("reuses the cache when the feeds are unreachable (last-known-good)", async () => {
		const source = makeSource();
		await source.refreshCapabilities(IDS);
		failUrls.add("https://models.dev/api.json");
		failUrls.add("https://ai-gateway.vercel.sh/v1/models");
		clockMs += 20 * 60_000;
		// force bypasses id-coverage gating so the (failing) fetch is retried
		const feeds = await source.refreshCapabilities(IDS, true);
		expect(feeds.openrouter["deepseek/deepseek-v4.1-flash"]?.maxTokens).toBe(384000);
		expect(feeds.vercel["stealth/pixel-canary"]?.contextWindow).toBe(262144);
	});

	it("skips fetching once every requested id is covered, without force", async () => {
		const source = makeSource();
		await source.refreshCapabilities(IDS);
		const before = calls.length;
		await source.refreshCapabilities(IDS);
		expect(calls.length).toBe(before);
	});

	it("fetches when a new id in the lineup was never covered before", async () => {
		const source = makeSource();
		await source.refreshCapabilities(["stealth/pixel-canary"]);
		const before = calls.length;
		await source.refreshCapabilities(["stealth/pixel-canary", "brand/new-thing"]);
		expect(calls.length).toBeGreaterThan(before);
	});

	it("force re-fetches even when every id is already covered", async () => {
		const source = makeSource();
		await source.refreshCapabilities(IDS);
		const before = calls.length;
		await source.refreshCapabilities(IDS, true);
		expect(calls.length).toBeGreaterThan(before);
	});

	it("records covered ids in the cache and via status()", async () => {
		const source = makeSource();
		await source.refreshCapabilities(["stealth/pixel-canary", "brand/new-thing"]);
		const cached = cache["capabilities.json"] as { coveredIds: string[] };
		expect(cached.coveredIds).toEqual(expect.arrayContaining(["stealth/pixel-canary", "brand/new-thing"]));
		expect(source.status().capabilitiesCoveredIds).toEqual(expect.arrayContaining(["stealth/pixel-canary", "brand/new-thing"]));
	});
});
