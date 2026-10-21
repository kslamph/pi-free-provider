import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UPDATE_API_URL } from "./opencode-contract.ts";
import { CONSOLE_CONFIG_URL } from "./opencode-config.ts";
import { MODELS_DEV_URL } from "../feeds.ts";
import { createZenSource, type ZenSourceDeps } from "./opencode.ts";

const dir = join(import.meta.dirname, "..", "test-fixtures");
const consoleConfigPayload = JSON.parse(readFileSync(join(dir, "console-config.json"), "utf-8"));
const consoleOverlayPayload = JSON.parse(readFileSync(join(dir, "console-config-overlay.json"), "utf-8"));
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
			if (url === CONSOLE_CONFIG_URL) return new Response(JSON.stringify(consoleConfigPayload), { status: 200 });
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

const CRED = { mode: "apiKey" as const, apiKey: "oc_sk_test" };

describe("zen source contract", () => {
	it("resolves the client version from the update api and caches the contract", async () => {
		const { deps, cache, fetched } = makeDeps();
		const contract = await createZenSource(deps).refreshContract();
		expect(contract.headers["User-Agent"]).toBe("opencode/latest/2.0.18/cli");
		expect(cache.get("contract.json")).toBeDefined();
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
	it("fetches the free lineup with the credential, sorted, with names; caches entries", async () => {
		const { deps, cache, fetched } = makeDeps();
		const source = createZenSource(deps);
		const lineup = await source.fetchLineup(CRED);
		expect(fetched).toContain(CONSOLE_CONFIG_URL);
		expect(lineup.map((e) => e.id)).toEqual([
			"big-pickle",
			"grok-code",
			"ling-3.0-flash-fin-free",
			"longcat-2.5-preview-free",
			"mimo-v2.6-flash-free",
			"muse-spark-1.3-contributor-free",
			"nemotron-3-ultra-free",
			"nemotron-3.5-lightning-free",
			"space-bunny-free",
		]);
		expect(lineup.find((e) => e.id === "mimo-v2.6-flash-free")?.name).toBe("MiMo-V2.6-Flash Free");
		expect(cache.get("lineup.json")).toBeDefined();
		expect(source.configBaseUrl()).toBe("https://opencode.ai/inference/openai/v1");
		expect(source.configHeaders()).toEqual({ "x-opencode-org-id": "wrk_01SYNTHETICTESTVALUE0000" });
	});

	it("serves the cached lineup with a warning when the config fetch fails", async () => {
		const { deps } = makeDeps();
		const source = createZenSource(deps);
		await source.fetchLineup(CRED);
		const broken = createZenSource({ ...deps, fetcher: (async () => {
			throw new Error("network down");
		}) as typeof fetch });
		const lineup = await broken.fetchLineup(CRED);
		expect(lineup.map((e) => e.id)).toContain("big-pickle");
		expect(broken.warnings.join(" ")).toContain("config fetch failed");
	});

	it("composes the lineup from models.dev when the config carries only workspace overrides", async () => {
		const { deps, cache } = makeDeps({
			fetcher: (async (url: string) => {
				if (url === UPDATE_API_URL) return new Response(JSON.stringify(updateApiPayload), { status: 200 });
				if (url === CONSOLE_CONFIG_URL) return new Response(JSON.stringify(consoleOverlayPayload), { status: 200 });
				if (url === MODELS_DEV_URL) return new Response(JSON.stringify(modelsdevPayload), { status: 200 });
				return new Response("not found", { status: 404 });
			}) as typeof fetch,
		});
		const source = createZenSource(deps);
		const lineup = await source.fetchLineup(CRED);
		// muse disabled by the workspace overlay, gpt-5.1 paid, grok-code dev-only
		expect(lineup.map((e) => e.id)).toEqual(["big-pickle", "grok-code", "mimo-v2.6-flash-free", "nemotron-3-ultra-free"]);
		expect(lineup.find((e) => e.id === "grok-code")?.name).toBe("Grok Code");
		expect(source.configHeaders()).toEqual({ "x-opencode-org-id": "org_01SYNTHETICOVERLAYTEST00A" });
		const cachedLineup = cache.get("lineup.json") as { models: Record<string, { name?: string }> };
		expect(cachedLineup.models["grok-code"]?.name).toBe("Grok Code");
	});

	it("keeps the cached lineup when models.dev fails and the config declares no free models", async () => {
		const { deps, cache } = makeDeps({
			fetcher: (async (url: string) => {
				if (url === CONSOLE_CONFIG_URL) return new Response(JSON.stringify(consoleOverlayPayload), { status: 200 });
				return new Response("nope", { status: 503 });
			}) as typeof fetch,
		});
		cache.set("lineup.json", { models: { "cached-free": { free: true, name: "Cached Free" } }, updatedAt: 1 });
		const source = createZenSource(deps);
		const lineup = await source.fetchLineup(CRED);
		expect(lineup.map((e) => e.id)).toEqual(["cached-free"]);
		expect(source.warnings.join(" ")).toContain("models.dev");
		const stillCached = cache.get("lineup.json") as { models: Record<string, unknown> };
		expect(stillCached.models["cached-free"]).toBeDefined();
	});

	it("still builds a config-only lineup when models.dev fails but the config lists free models", async () => {
		const { deps } = makeDeps({
			fetcher: (async (url: string) => {
				if (url === CONSOLE_CONFIG_URL) return new Response(JSON.stringify(consoleConfigPayload), { status: 200 });
				return new Response("nope", { status: 503 });
			}) as typeof fetch,
		});
		const source = createZenSource(deps);
		const lineup = await source.fetchLineup(CRED);
		expect(lineup.map((e) => e.id)).toContain("big-pickle");
		expect(lineup).toHaveLength(8);
		expect(source.warnings.join(" ")).toContain("models.dev");
	});

	it("returns [] when the config lists zero free models and models.dev has none either", async () => {
		const { deps } = makeDeps({
			fetcher: (async (url: string) => {
				if (url === CONSOLE_CONFIG_URL)
					return new Response(
						JSON.stringify({ providers: { opencode: { models: { paid: { cost: [{ input: 3, output: 1 }] } } } } }),
						{ status: 200 },
					);
				if (url === MODELS_DEV_URL) return new Response("{}", { status: 200 });
				return new Response("not found", { status: 404 });
			}) as typeof fetch,
		});
		const lineup = await createZenSource(deps).fetchLineup(CRED);
		expect(lineup).toEqual([]);
	});
});

describe("zen source capabilities", () => {
	it("resolves a config-only model with zen defaults for unspecified fields", async () => {
		const { deps } = makeDeps();
		const source = createZenSource(deps);
		const lineup = await source.fetchLineup(CRED);
		await source.refreshCapabilities(lineup.map((e) => e.id));
		// longcat exists in config but not in the trimmed modelsdev fixture
		const caps = source.resolveCapabilities("longcat-2.5-preview-free");
		expect(caps.source).toBe("opencode");
		expect(caps.reasoning).toBe(true);
		expect(caps.contextWindow).toBe(1_000_000);
		expect(caps.input).toEqual(["text", "image"]);
	});

	it("fills gaps from models.dev when the config entry lacks limits", async () => {
		const { deps } = makeDeps();
		const source = createZenSource(deps);
		const lineup = await source.fetchLineup(CRED);
		await source.refreshCapabilities(lineup.map((e) => e.id));
		const caps = source.resolveCapabilities("big-pickle");
		expect(caps.source).toBe("opencode");
		const muse = source.resolveCapabilities("muse-spark-1.3-contributor-free");
		expect(muse.source).toBe("opencode");
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
		await source.fetchLineup(CRED);
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
		await source.fetchLineup(CRED);
		// live 2026-09-27: muse's /responses answers 200 once the request carries
		// agentic tools (the earlier 403 was the agentic-shape gate, not a tier gate)
		expect(source.resolveTransport("muse-spark-1.3-contributor-free")).toBe("openai-responses");
		expect(source.resolveTransport("big-pickle")).toBe("openai-completions");
		expect(source.resolveTransport("space-bunny-free")).toBe("openai-completions");
	});

	it("falls back to the muse-spark prefix when the config carries no package", async () => {
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
