import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clinefree-import-"));
	process.env.CLINEFREE_CONFIG = join(tmp, "clinefree.json");
	process.env.CLINEFREE_CACHE = join(tmp, "cache");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	delete process.env.CLINEFREE_CONFIG;
	delete process.env.CLINEFREE_CACHE;
});

describe("extension entry", () => {
	it("default-exports the factory function with no import-time side effects", async () => {
		const before = { ...process.env };
		const mod = await import("./index.ts");
		expect(typeof mod.default).toBe("function");
		expect(typeof mod.syncOnce).toBe("function");
		expect(process.env).toEqual(before);
	});
});

import { buildZenTargets } from "./index.ts";
import { BAKED_IN_ZEN_CONTRACT } from "./sources/opencode-contract.ts";

describe("zen bootstrap", () => {
	beforeEach(() => {
		process.env.ZENFREE_CONFIG = join(tmp, "zenfree.json");
		process.env.ZENFREE_CACHE = join(tmp, "zcache");
	});
	afterEach(() => {
		delete process.env.ZENFREE_CONFIG;
		delete process.env.ZENFREE_CACHE;
	});

	const LINEUP = [
		{ id: "big-pickle", name: "Big Pickle" },
		{ id: "mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free" },
		{ id: "muse-spark-1.3-contributor-free", name: "Muse Spark 1.3" },
	];

	function zenPieces() {
		const caps = { contextWindow: 200_000, maxTokens: 32_000, input: ["text"] as ("text" | "image")[], reasoning: true, toggle: false, source: "config" as const };
		const registered: { id: string; config: Record<string, unknown> }[] = [];
		const registerProvider = (id: string, config: unknown) => registered.push({ id, config: config as Record<string, unknown> });
		return { caps, registered, registerProvider };
	}

	it("splits the lineup into zenfree + zenfree.res targets by transport", () => {
		const { caps, registered, registerProvider } = zenPieces();
		const targets = buildZenTargets({
			lineup: LINEUP,
			resolve: () => caps,
			resolveTransport: (id) => (id.startsWith("muse-spark-") ? "openai-responses" : "openai-completions"),
			contract: BAKED_IN_ZEN_CONTRACT,
			streamSimple: (() => ({})) as never,
			registerProvider,
		});
		expect(targets.map((t) => t.providerId)).toEqual(["zenfree", "zenfree.res"]);
		expect(targets[0]!.models.map((m) => m.id)).toEqual(["big-pickle", "mimo-v2.6-flash-free"]);
		expect(targets[1]!.models.map((m) => m.id)).toEqual(["muse-spark-1.3-contributor-free"]);
		targets.forEach((t) => t.register(t.models));
		expect(registered.map((r) => r.id)).toEqual(["zenfree", "zenfree.res"]);
		expect((registered[1]!.config as { api: string }).api).toBe("openai-responses");
		expect((registered[0]!.config as { baseUrl: string }).baseUrl).toBe("https://opencode.ai/inference/openai/v1");
		expect((registered[0]!.config as { models: { id: string; thinkingLevelMap: Record<string, string | null> }[] }).models[0]!.thinkingLevelMap.off).toBeNull();
	});

	it("yields no targets for an empty lineup", () => {
		const { caps, registerProvider } = zenPieces();
		const targets = buildZenTargets({
			lineup: [],
			resolve: () => caps,
			resolveTransport: () => "openai-completions",
			contract: BAKED_IN_ZEN_CONTRACT,
			streamSimple: (() => ({})) as never,
			registerProvider,
		});
		expect(targets).toEqual([]);
	});

	it("registers both commands and the session handler without side effects", async () => {
		const commands: string[] = [];
		const handlers: Record<string, unknown> = {};
		const fakePi = {
			registerProvider: vi.fn(),
			unregisterProvider: vi.fn(),
			registerCommand: (name: string) => commands.push(name),
			on: (event: string, handler: unknown) => {
				handlers[event] = handler;
			},
		};
		const mod = await import("./index.ts");
		(mod.default as (pi: unknown) => void)(fakePi);
		expect(commands).toEqual(expect.arrayContaining(["clinefree", "zenfree"]));
		expect(typeof handlers["session_start"]).toBe("function");
	});
});

describe("zenfree session_start wiring", () => {
	let consolePayload: unknown;
	let routerCalls: string[];

	function fakeCtx(model?: { id: string }) {
		return { ui: { notify: vi.fn() }, model } as never;
	}

	function stubNetwork() {
		const consoleConfig = JSON.parse(readFileSync(join(import.meta.dirname, "test-fixtures", "console-config.json"), "utf-8"));
		consoleConfig.providers.opencode.settings.baseURL = "https://opencode.ai/inference/openai/v9";
		const updateApi = JSON.parse(readFileSync(join(import.meta.dirname, "test-fixtures", "update-api.json"), "utf-8"));
		const modelsdev = JSON.parse(readFileSync(join(import.meta.dirname, "test-fixtures", "modelsdev-opencode.json"), "utf-8"));
		const fetcher = (async (url: string) => {
			routerCalls.push(String(url));
			if (String(url).includes("/api/v2/config")) return new Response(JSON.stringify(consolePayload ?? consoleConfig), { status: 200 });
			if (String(url).includes("update/api")) return new Response(JSON.stringify(updateApi), { status: 200 });
			if (String(url).includes("models.dev")) return new Response(JSON.stringify(modelsdev), { status: 200 });
			return new Response("nope", { status: 404 });
		}) as typeof fetch;
		vi.stubGlobal("fetch", fetcher);
	}

	beforeEach(() => {
		routerCalls = [];
		consolePayload = undefined;
		process.env.ZENFREE_CONFIG = join(tmp, "zenfree.json");
		process.env.ZENFREE_CACHE = join(tmp, "zcache");
		writeFileSync(process.env.ZENFREE_CONFIG, JSON.stringify({
			auth: { mode: "apiKey", apiKey: "oc_sk_test" },
			sync: { minIntervalMinutes: 30, notifyOnChange: true },
		}));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	async function boot() {
		const commands: string[] = [];
		const handlers: Record<string, unknown> = {};
		const registered: { id: string; config: Record<string, unknown> }[] = [];
		const unregistered: string[] = [];
		const fakePi = {
			registerProvider: (id: string, config: unknown) => registered.push({ id, config: config as Record<string, unknown> }),
			unregisterProvider: (id: string) => unregistered.push(id),
			registerCommand: (name: string) => commands.push(name),
			on: (event: string, handler: unknown) => {
				handlers[event] = handler;
			},
		};
		const mod = await import("./index.ts");
		(mod.default as (pi: unknown) => void)(fakePi);
		return { handlers, registered, unregistered };
	}

	it("syncs zen at session start even without a clinefree credential, registering under the live gateway url", async () => {
		stubNetwork();
		const { handlers, registered } = await boot();
		const handler = handlers["session_start"] as (event: { reason: string }, ctx: never) => Promise<void>;
		await handler({ reason: "new" }, fakeCtx());
		const zen = registered.find((r) => r.id === "zenfree");
		expect(zen).toBeDefined();
		expect((zen!.config as { baseUrl: string }).baseUrl).toBe("https://opencode.ai/inference/openai/v9");
		const modelIds = (zen!.config as { models: { id: string }[] }).models.map((m) => m.id);
		expect(modelIds).toContain("big-pickle");
		const zenRes = registered.find((r) => r.id === "zenfree.res");
		expect(zenRes).toBeDefined();
		expect((zenRes!.config as { api: string }).api).toBe("openai-responses");
		expect((zenRes!.config as { models: { id: string }[] }).models.map((m) => m.id)).toEqual(["muse-spark-1.3-contributor-free"]);
	});

	it("unregisters the zen provider and prompts a switch when the free lineup empties", async () => {
		stubNetwork();
		const { handlers, unregistered } = await boot();
		const handler = handlers["session_start"] as (event: { reason: string }, ctx: never) => Promise<void>;
		const ctx = { ui: { notify: vi.fn() }, model: { id: "big-pickle" } } as never;
		await handler({ reason: "new" }, ctx);
		consolePayload = { providers: { opencode: { models: { paid: { cost: [{ input: 3, output: 1 }] } } } } };
		await handler({ reason: "new" }, ctx);
		expect(unregistered).toContain("zenfree");
		const calls = (ctx as { ui: { notify: ReturnType<typeof vi.fn> } }).ui.notify.mock.calls.map((c) => String(c[0]));
		expect(calls.some((m) => m.includes("free lineup is empty"))).toBe(true);
		expect(calls.some((m) => /big-pickle.*switch|switch.*big-pickle/i.test(m))).toBe(true);
	});
});
