import { describe, expect, it, vi } from "vitest";
import { diffModels } from "./registry.ts";
import { syncOnce, type PiLike, type SyncDeps } from "./index.ts";
import { syncProviders } from "./registry.ts";
import { BAKED_IN_CONTRACT } from "./contract.ts";
import { DEFAULT_CAPABILITIES } from "./capabilities.ts";
import type { LineupEntry } from "./sources/types.ts";

describe("diffModels", () => {
	it("computes added and removed", () => {
		expect(diffModels(["a", "b"], ["b", "c"])).toEqual({ added: ["c"], removed: ["a"] });
	});

	it("is a no-op for identical lists and for empty/empty", () => {
		expect(diffModels(["a"], ["a"])).toEqual({ added: [], removed: [] });
		expect(diffModels([], [])).toEqual({ added: [], removed: [] });
	});
});

function fakePi() {
	const registered: { id: string; config: Record<string, unknown> }[] = [];
	const unregistered: string[] = [];
	const pi: PiLike = {
		registerProvider: (id, config) => {
			registered.length = 0;
			registered.push({ id, config: config as Record<string, unknown> });
		},
		unregisterProvider: (id) => unregistered.push(id),
	};
	return { pi, registered, unregistered };
}

function fakeSource(lineup: LineupEntry[], warnings: string[] = []) {
	const capsFor = new Map<string, typeof DEFAULT_CAPABILITIES & { source: string }>();
	return {
		warnings,
		fetchLineup: vi.fn(async () => lineup),
		refreshCapabilities: vi.fn(async () => ({ openrouter: {}, vercel: {} })),
		resolveCapabilities: vi.fn((id: string) => capsFor.get(id) ?? DEFAULT_CAPABILITIES),
		setCaps: (id: string, caps: typeof DEFAULT_CAPABILITIES & { source: string }) => capsFor.set(id, caps),
	};
}

function makeDeps(pi: PiLike, source: ReturnType<typeof fakeSource>, extra: Partial<SyncDeps> = {}): SyncDeps {
	return {
		pi,
		source,
		getContract: () => BAKED_IN_CONTRACT,
		streamSimple: (() => ({})) as never,
		notify: vi.fn(),
		config: { auth: { mode: "apiKey", apiKey: "sk-x" }, sync: { minIntervalMinutes: 30, notifyOnChange: true } },
		registeredIds: [],
		isCurrentModel: () => false,
		...extra,
	};
}

const LINEUP: LineupEntry[] = [
	{ id: "stealth/pixel-canary", name: "Pixel Canary" },
	{ id: "cline-free/mimo-v2.6-flash", name: "Mimo V2.6 Flash" },
];

describe("syncOnce", () => {
	it("registers the clinefree provider with mapped models", async () => {
		const { pi, registered } = fakePi();
		const source = fakeSource(LINEUP);
		source.setCaps("stealth/pixel-canary", {
			...DEFAULT_CAPABILITIES,
			source: "vercel",
			contextWindow: 262144,
			maxTokens: 131072,
			input: ["text", "image"],
		});
		const deps = makeDeps(pi, source);
		const result = await syncOnce(deps);
		expect(result).toEqual({ added: ["stealth/pixel-canary", "cline-free/mimo-v2.6-flash"], removed: [], warnings: [] });
		expect(registered[0]?.id).toBe("clinefree");
		const config = registered[0]?.config as Record<string, unknown>;
		expect(config.api).toBe("openai-completions");
		expect(config.baseUrl).toBe("https://api.cline.bot/api/v1");
		const models = config.models as { id: string; name: string; contextWindow: number }[];
		expect(models[0]?.id).toBe("stealth/pixel-canary");
		expect(models[0]?.contextWindow).toBe(262144);
		expect(models[1]?.name).toBe("Mimo V2.6 Flash (free)"); // feed name + (free)
		expect(deps.registeredIds).toEqual(["stealth/pixel-canary", "cline-free/mimo-v2.6-flash"]);
	});

	it("notifies additions and delistings on a diff and re-registers without delisted models", async () => {
		const { pi, registered } = fakePi();
		const source = fakeSource(LINEUP);
		const deps = makeDeps(pi, source);
		await syncOnce(deps);

		const next = fakeSource([{ id: "stealth/pixel-canary", name: "Pixel Canary" }, { id: "new/model" }]);
		deps.source = next;
		const result = await syncOnce(deps);
		expect(result).toEqual({ added: ["new/model"], removed: ["cline-free/mimo-v2.6-flash"], warnings: [] });
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("+1 new: new/model"));
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("−1 delisted: cline-free/mimo-v2.6-flash"));
		const models = (registered[0]?.config as { models: { id: string }[] }).models;
		expect(models.map((m) => m.id)).toEqual(["stealth/pixel-canary", "new/model"]);
		expect(deps.registeredIds).toEqual(["stealth/pixel-canary", "new/model"]);
	});

	it("prompts a switch when the delisted model is the active one", async () => {
		const { pi } = fakePi();
		const source = fakeSource(LINEUP);
		const deps = makeDeps(pi, source, { isCurrentModel: (id) => id === "cline-free/mimo-v2.6-flash" });
		await syncOnce(deps);
		deps.source = fakeSource([{ id: "stealth/pixel-canary" }]);
		await syncOnce(deps);
		expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/switch|active/i));
	});

	it("keeps the previous registration when the source throws, with a warning", async () => {
		const { pi, registered } = fakePi();
		const source = fakeSource(LINEUP);
		const deps = makeDeps(pi, source);
		await syncOnce(deps);
		const before = registered[0]?.config;
		deps.source = { ...source, fetchLineup: vi.fn(async () => { throw new Error("network down"); }) };
		const result = await syncOnce(deps);
		expect(result).toEqual({ added: [], removed: [], warnings: [] });
		expect(registered[0]?.config).toEqual(before);
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("network down"));
	});

	it("unregisters when the lineup is empty", async () => {
		const { pi, unregistered } = fakePi();
		const source = fakeSource(LINEUP);
		const deps = makeDeps(pi, source);
		await syncOnce(deps);
		deps.source = fakeSource([]);
		await syncOnce(deps);
		expect(unregistered).toEqual(["clinefree"]);
		expect(deps.registeredIds).toEqual([]);
	});

	it("prompts a switch when the active model is delisted along with the whole lineup", async () => {
		const { pi } = fakePi();
		const source = fakeSource(LINEUP);
		const deps = makeDeps(pi, source, { isCurrentModel: (id) => id === "cline-free/mimo-v2.6-flash" });
		await syncOnce(deps);
		deps.source = fakeSource([]);
		await syncOnce(deps);
		expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/switch/i));
	});

	it("surfaces source warnings once per sync", async () => {
		const { pi } = fakePi();
		const source = fakeSource(LINEUP, ["clinefree: models.dev fetch failed (HTTP 503)"]);
		const deps = makeDeps(pi, source);
		await syncOnce(deps);
		expect(deps.notify).toHaveBeenCalledWith("clinefree: models.dev fetch failed (HTTP 503)");
		expect(source.warnings).toEqual([]);
	});

	it("requests capabilities for the lineup ids, force only when asked", async () => {
		const { pi } = fakePi();
		const source = fakeSource(LINEUP);
		const deps = makeDeps(pi, source);
		await syncOnce(deps);
		expect(source.refreshCapabilities).toHaveBeenCalledWith(LINEUP.map((e) => e.id), false);
		await syncOnce({ ...deps, forceCapabilities: true });
		expect(source.refreshCapabilities).toHaveBeenLastCalledWith(LINEUP.map((e) => e.id), true);
	});

	it("keeps registering on cached capabilities when the capability fetch fails", async () => {
		const { pi, registered } = fakePi();
		const source = fakeSource(LINEUP);
		source.refreshCapabilities = vi.fn(async () => { throw new Error("feeds down"); });
		const deps = makeDeps(pi, source);
		const result = await syncOnce(deps);
		expect(result.added).toEqual(LINEUP.map((e) => e.id));
		expect(registered[0]?.id).toBe("clinefree");
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("feeds down"));
	});

	it("skips registration entirely when no credential is configured", async () => {
		const { pi, registered } = fakePi();
		const deps = makeDeps(pi, fakeSource(LINEUP), { config: { auth: undefined, sync: { minIntervalMinutes: 30, notifyOnChange: true } } });
		const result = await syncOnce(deps);
		expect(result).toEqual({ added: [], removed: [], warnings: [] });
		expect(registered).toEqual([]);
	});
});

describe("syncProviders (multi-provider engine)", () => {
	function multiDeps(extra: Partial<Parameters<typeof syncProviders>[0]> = {}) {
		const registered = { providerIds: [] as string[], modelIds: [] as string[] };
		const pi: PiLike = {
			registerProvider: (id, config) => calls.push({ id, config: config as Record<string, unknown> }),
			unregisterProvider: (id) => unregistered.push(id),
		};
		const calls: { id: string; config: Record<string, unknown> }[] = [];
		const unregistered: string[] = [];
		const deps = {
			pi,
			label: "zenfree",
			notify: vi.fn(),
			notifyOnChange: true,
			isCurrentModel: (_id: string) => false,
			registered,
			...extra,
		};
		const target = (providerId: string, ids: string[]) => ({
			providerId,
			models: ids.map((id) => ({ id })),
			register: (models: { id: string }[]) =>
				pi.registerProvider(providerId, { name: providerId, api: providerId === "zenfree.res" ? "openai-responses" : "openai-completions", models }),
		});
		return { deps, calls, unregistered, registered, target };
	}

	it("splits the desired lineup across two providers by transport", async () => {
		const { deps, calls, registered } = multiDeps();
		const result = await syncProviders(deps, [
			deps === null ? null! : { providerId: "zenfree", models: [{ id: "big-pickle" }, { id: "mimo-v2.6-flash-free" }], register: (m) => deps.pi.registerProvider("zenfree", { api: "openai-completions", models: m }) },
			{ providerId: "zenfree.res", models: [{ id: "muse-spark-1.3-contributor-free" }], register: (m) => deps.pi.registerProvider("zenfree.res", { api: "openai-responses", models: m }) },
		]);
		expect(result).toEqual({ added: ["big-pickle", "mimo-v2.6-flash-free", "muse-spark-1.3-contributor-free"], removed: [] });
		expect(calls.map((c) => c.id)).toEqual(["zenfree", "zenfree.res"]);
		expect((calls[1]!.config as { api: string }).api).toBe("openai-responses");
		expect(registered.providerIds).toEqual(["zenfree", "zenfree.res"]);
		expect(registered.modelIds).toEqual(["big-pickle", "mimo-v2.6-flash-free", "muse-spark-1.3-contributor-free"]);
	});

	it("moves a model between providers and drops the stale provider when it empties", async () => {
		const { deps, calls, unregistered, registered } = multiDeps();
		const register = (providerId: string) => (m: { id: string }[]) => deps.pi.registerProvider(providerId, { models: m });
		await syncProviders(deps, [
			{ providerId: "zenfree", models: [{ id: "muse-spark" }], register: register("zenfree") },
			{ providerId: "zenfree.res", models: [{ id: "other-res" }], register: register("zenfree.res") },
		]);
		const result = await syncProviders(deps, [{ providerId: "zenfree", models: [{ id: "muse-spark" }, { id: "other-res" }], register: register("zenfree") }]);
		expect(result).toEqual({ added: [], removed: [] });
		expect(unregistered).toEqual(["zenfree.res"]);
		expect(registered.providerIds).toEqual(["zenfree"]);
		expect(calls.at(-1)?.id).toBe("zenfree");
	});

	it("unregisters every provider and prompts a switch when the free lineup empties", async () => {
		const { deps, unregistered, registered } = multiDeps({ isCurrentModel: (id) => id === "mimo-v2.6-flash-free" });
		const register = (providerId: string) => (m: { id: string }[]) => deps.pi.registerProvider(providerId, { models: m });
		await syncProviders(deps, [
			{ providerId: "zenfree", models: [{ id: "mimo-v2.6-flash-free" }], register: register("zenfree") },
			{ providerId: "zenfree.res", models: [{ id: "muse-spark" }], register: register("zenfree.res") },
		]);
		vi.mocked(deps.notify).mockClear();
		await syncProviders(deps, []);
		expect(unregistered.sort()).toEqual(["zenfree", "zenfree.res"]);
		expect(registered.providerIds).toEqual([]);
		expect(registered.modelIds).toEqual([]);
		expect(deps.notify).toHaveBeenCalledWith(expect.stringContaining("free lineup is empty"));
		expect(deps.notify).toHaveBeenCalledWith(expect.stringMatching(/mimo-v2\.6-flash-free.*switch|switch.*mimo-v2\.6-flash-free/i));
	});

	it("notifies the aggregate diff across providers once", async () => {
		const { deps } = multiDeps();
		const register = (providerId: string) => (m: { id: string }[]) => deps.pi.registerProvider(providerId, { models: m });
		await syncProviders(deps, [{ providerId: "zenfree", models: [{ id: "big-pickle" }], register: register("zenfree") }]);
		vi.mocked(deps.notify).mockClear();
		await syncProviders(deps, [
			{ providerId: "zenfree", models: [{ id: "big-pickle" }, { id: "space-bunny-free" }], register: register("zenfree") },
			{ providerId: "zenfree.res", models: [{ id: "muse-spark" }], register: register("zenfree.res") },
		]);
		expect(deps.notify).toHaveBeenCalledTimes(1);
		expect(deps.notify).toHaveBeenCalledWith("zenfree: +2 new: space-bunny-free, muse-spark");
	});
});
