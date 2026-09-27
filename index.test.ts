import { mkdtempSync, rmSync } from "node:fs";
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
