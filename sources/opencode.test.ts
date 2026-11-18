import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UPDATE_API_URL } from "./opencode-contract.ts";
import { MODELS_DEV_URL } from "../feeds.ts";
import { createZenSource, ZEN_LINEUP_CACHE, type ZenSourceDeps } from "./opencode.ts";

const dir = join(import.meta.dirname, "..", "test-fixtures");
const updateApiPayload = JSON.parse(readFileSync(join(dir, "update-api.json"), "utf-8"));
const modelsdevPayload = JSON.parse(readFileSync(join(dir, "modelsdev-opencode.json"), "utf-8"));

function makeDeps(over: Partial<ZenSourceDeps> = {}) {
	const cache = new Map<string, unknown>();
	const fetched: string[] = [];
	let clockMs = 1_000_000;
	const deps: ZenSourceDeps = {
		fetcher: (async (url: string) => {
			fetched.push(url);
			if (url === UPDATE_API_URL) return new Response(JSON.stringify(updateApiPayload), { status: 200 });
			if (url === MODELS_DEV_URL) return new Response(JSON.stringify(modelsdevPayload), { status: 200 });
			return new Response("not found", { status: 404 });
		}) as typeof fetch,
		now: () => clockMs,
		readCache: <T>(name: string) => cache.get(name) as T | undefined,
		writeCache: (name, data) => cache.set(name, data),
		...over,
	};
	return { deps, cache, fetched, get clockMs() { return clockMs; }, set clockMs(v: number) { clockMs = v; } };
}


describe("zen source contract", () => {
	it("resolves the client version from the update api and caches the contract", async () => {
		const { deps, cache, fetched } = makeDeps();
		const contract = await createZenSource(deps).refreshContract();
		expect(contract.headers["User-Agent"]).toBe("opencode/latest/2.0.18/cli");
		expect(cache.get("client-version.json")).toEqual({ version: "2.0.18" });
		expect(fetched.filter((u) => u === UPDATE_API_URL)).toHaveLength(1);
	});

	it("is TTL-gated: no re-fetch within the min interval, force bypasses", async () => {
		const state = makeDeps();
		const { deps, fetched } = state;
		const source = createZenSource(deps);
		await source.refreshContract();
		await source.refreshContract();
		expect(fetched.filter((u) => u === UPDATE_API_URL)).toHaveLength(1);
		state.clockMs += 31 * 60_000;
		await source.refreshContract();
		expect(fetched.filter((u) => u === UPDATE_API_URL)).toHaveLength(2);
		await source.refreshContract(true);
		expect(fetched.filter((u) => u === UPDATE_API_URL)).toHaveLength(3);
	});

	it("does not reuse the former workspace contract cache", async () => {
		const { deps, cache, fetched, clockMs } = makeDeps();
		cache.set("contract.json", {
			source: "config", versions: { cli: "2.0.18" },
			baseUrl: "https://unused.example/v1", headers: { authorization: "Bearer legacy" },
		});
		cache.set("state.json", { version: 1, timestamps: { version: clockMs } });
		const contract = await createZenSource(deps).refreshContract();
		expect(contract.source).toBe("update-api");
		expect(contract).not.toHaveProperty("baseUrl");
		expect(contract.headers).not.toHaveProperty("authorization");
		expect(fetched).toEqual([UPDATE_API_URL]);
	});

	it("falls back to the baked-in contract with a warning when the service is unreachable", async () => {
		const { deps } = makeDeps({ fetcher: (async () => {
			throw new Error("network down");
		}) as typeof fetch });
		const source = createZenSource(deps);
		const contract = await source.refreshContract(true);
		expect(contract.source).toBe("baked-in");
		expect(contract.warning).toContain("update service");
		expect(source.warnings.length).toBeGreaterThan(0);
	});
});

describe("zen source lineup", () => {
	it("builds an anonymous lineup from models.dev without calling the console config", async () => {
		const { deps, cache, fetched } = makeDeps();
		const source = createZenSource(deps);
		const lineup = await source.fetchLineup();
		expect(fetched).toEqual([MODELS_DEV_URL]);
		expect(lineup.map((e) => e.id)).toEqual([
			"big-pickle",
			"grok-code",
			"mimo-v2.6-flash-free",
			"muse-spark-1.3-contributor-free",
			"nemotron-3-ultra-free",
		]);
		expect(lineup.find((e) => e.id === "mimo-v2.6-flash-free")?.name).toBe("MiMo-V2.6-Flash Free");
		expect(cache.get(ZEN_LINEUP_CACHE)).toBeDefined();
		expect(source.warnings.join(" ")).not.toContain("credential");
	});

	it("keeps the cached lineup when models.dev fails", async () => {
		const { deps, cache } = makeDeps({
			fetcher: (async () => new Response("nope", { status: 503 })) as typeof fetch,
		});
		cache.set(ZEN_LINEUP_CACHE, { models: { "cached-free": { name: "Cached Free" } }, updatedAt: 1 });
		const source = createZenSource(deps);
		const lineup = await source.fetchLineup();
		expect(lineup.map((e) => e.id)).toEqual(["cached-free"]);
		expect(source.warnings.join(" ")).toContain("models.dev");
		const stillCached = cache.get(ZEN_LINEUP_CACHE) as { models: Record<string, unknown> };
		expect(stillCached.models["cached-free"]).toBeDefined();
	});

	it("returns [] when models.dev has no free models", async () => {
		const { deps } = makeDeps({
			fetcher: (async () => new Response("{}", { status: 200 })) as typeof fetch,
		});
		const lineup = await createZenSource(deps).fetchLineup();
		expect(lineup).toEqual([]);
	});
});

describe("zen source capabilities", () => {
	it("resolves limits from models.dev", async () => {
		const { deps } = makeDeps();
		const source = createZenSource(deps);
		const lineup = await source.fetchLineup();
		await source.refreshCapabilities(lineup.map((e) => e.id));
		const caps = source.resolveCapabilities("big-pickle");
		expect(caps.source).toBe("modelsdev");
		expect(caps.contextWindow).toBe(200_000);
		expect(caps.maxTokens).toBe(32_000);
		expect(caps.reasoning).toBe(true);
	});

	it("resolves the responses model from models.dev too", async () => {
		const { deps } = makeDeps();
		const source = createZenSource(deps);
		const lineup = await source.fetchLineup();
		await source.refreshCapabilities(lineup.map((e) => e.id));
		const muse = source.resolveCapabilities("muse-spark-1.3-contributor-free");
		expect(muse.source).toBe("modelsdev");
		expect(muse.contextWindow).toBe(1_048_576);
		expect(muse.maxTokens).toBe(131_072);
	});

	it("falls to defaults for an id in neither source", async () => {
		const { deps } = makeDeps();
		const source = createZenSource(deps);
		const caps = source.resolveCapabilities("brand-new-stealth");
		expect(caps.source).toBe("default");
		expect(caps.contextWindow).toBe(200_000);
		expect(caps.reasoning).toBe(true);
	});

	it("fetches the models.dev feed once per uncovered id (coverage gate), force bypasses", async () => {
		const { deps, fetched } = makeDeps();
		const source = createZenSource(deps);
		await source.fetchLineup();
		await source.refreshCapabilities(["big-pickle"]);
		expect(fetched.filter((u) => u === MODELS_DEV_URL)).toHaveLength(2); // 1 lineup + 1 capabilities
		await source.refreshCapabilities(["big-pickle"]);
		expect(fetched.filter((u) => u === MODELS_DEV_URL)).toHaveLength(2);
		await source.refreshCapabilities(["big-pickle", "brand-new-id"]);
		expect(fetched.filter((u) => u === MODELS_DEV_URL)).toHaveLength(3);
		await source.refreshCapabilities(["big-pickle"], true);
		expect(fetched.filter((u) => u === MODELS_DEV_URL)).toHaveLength(4);
	});
});

describe("zen source transport + status", () => {
	it("routes the responses-package model to zenfree.res, everything else to completions", async () => {
		const { deps } = makeDeps();
		const source = createZenSource(deps);
		await source.fetchLineup();
		// live 2026-09-27: muse's /responses answers 200 once the request carries
		// agentic tools (the earlier 403 was the agentic-shape gate, not a tier gate)
		expect(source.resolveTransport("muse-spark-1.3-contributor-free")).toBe("openai-responses");
		expect(source.resolveTransport("big-pickle")).toBe("openai-completions");
		expect(source.resolveTransport("space-bunny-free")).toBe("openai-completions");
	});

	it("falls back to the muse-spark prefix when the catalog carries no package", async () => {
		const source = createZenSource(makeDeps().deps);
		expect(source.resolveTransport("muse-spark-2.0-free")).toBe("openai-responses");
		expect(source.resolveTransport("mimo-v2.6-flash-free")).toBe("openai-completions");
	});

	it("status reports timestamps and the contract source", async () => {
		const { deps } = makeDeps();
		const source = createZenSource(deps);
		await source.refreshContract();
		const status = source.status();
		expect(status.contractSource).toBe("update-api");
		expect(status.timestamps.contract).toBeGreaterThan(0);
	});
});
