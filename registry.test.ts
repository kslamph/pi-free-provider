import { describe, expect, it, vi } from "vitest";
import { diffModels } from "./registry.ts";
import { syncOnce, type PiLike, type SyncDeps } from "./index.ts";
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
		config: { auth: { mode: "apiKey", apiKey: "sk-x" }, sync: { minIntervalMinutes: 30, capabilityTtlMinutes: 10, notifyOnChange: true } },
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
		expect(result).toEqual({ added: ["stealth/pixel-canary", "cline-free/mimo-v2.6-flash"], removed: [] });
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
		expect(result).toEqual({ added: ["new/model"], removed: ["cline-free/mimo-v2.6-flash"] });
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
		expect(result).toEqual({ added: [], removed: [] });
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

	it("surfaces source warnings once per sync", async () => {
		const { pi } = fakePi();
		const source = fakeSource(LINEUP, ["clinefree: models.dev fetch failed (HTTP 503)"]);
		const deps = makeDeps(pi, source);
		await syncOnce(deps);
		expect(deps.notify).toHaveBeenCalledWith("clinefree: models.dev fetch failed (HTTP 503)");
		expect(source.warnings).toEqual([]);
	});

	it("skips registration entirely when no credential is configured", async () => {
		const { pi, registered } = fakePi();
		const deps = makeDeps(pi, fakeSource(LINEUP), { config: { auth: undefined, sync: { minIntervalMinutes: 30, capabilityTtlMinutes: 10, notifyOnChange: true } } });
		const result = await syncOnce(deps);
		expect(result).toEqual({ added: [], removed: [] });
		expect(registered).toEqual([]);
	});
});
