import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cacheDir, configPath, loadConfig, readCache, saveConfig, writeCache, clinefreeState, createStateStore, zenfreeState } from "./state.ts";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clinefree-state-"));
	process.env.CLINEFREE_CONFIG = join(tmp, "config", "clinefree.json");
	process.env.CLINEFREE_CACHE = join(tmp, "cache");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	delete process.env.CLINEFREE_CONFIG;
	delete process.env.CLINEFREE_CACHE;
});

describe("state", () => {
	it("loadConfig creates 0600 config with defaults when absent", () => {
		const cfg = loadConfig();
		expect(cfg).toEqual({
			auth: undefined,
			sync: { minIntervalMinutes: 30, notifyOnChange: true },
		});
		expect(existsSync(configPath())).toBe(true);
		const mode = (statSync(configPath()).mode & 0o777).toString(8);
		expect(mode).toBe("600");
	});

	it("saveConfig → loadConfig roundtrips and leaves no temp files behind", () => {
		const cfg = loadConfig();
		cfg.auth = { mode: "apiKey", apiKey: "sk-test" };
		cfg.sync.minIntervalMinutes = 5;
		saveConfig(cfg);
		const again = loadConfig();
		expect(again.auth).toEqual({ mode: "apiKey", apiKey: "sk-test" });
		expect(again.sync.minIntervalMinutes).toBe(5);
		const dir = join(configPath(), "..");
		const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
		// config stays 0600 after rewrite
		const mode = (statSync(configPath()).mode & 0o777).toString(8);
		expect(mode).toBe("600");
	});

	it("readCache returns undefined for missing; writeCache→readCache roundtrips", () => {
		expect(readCache("nope.json")).toBeUndefined();
		writeCache("lineup.json", { free: [{ id: "a" }] });
		expect(readCache<{ free: { id: string }[] }>("lineup.json")).toEqual({ free: [{ id: "a" }] });
		const leftovers = readdirSync(cacheDir()).filter((f) => f.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});

	it("writeCache replaces an existing file atomically", () => {
		writeCache("x.json", { v: 1 });
		writeCache("x.json", { v: 2 });
		expect(readCache<{ v: number }>("x.json")).toEqual({ v: 2 });
	});
});

describe("createStateStore", () => {
	it("zenfree store uses its own paths and env overrides", () => {
		process.env.ZENFREE_CONFIG = join(tmp, "config", "zenfree.json");
		process.env.ZENFREE_CACHE = join(tmp, "zcache");
		const zen = createStateStore({
			configEnv: "ZENFREE_CONFIG",
			cacheEnv: "ZENFREE_CACHE",
			configDefault: join(homedir(), ".pi", "agent", "zenfree.json"),
			cacheDefault: join(homedir(), ".pi", "agent", "zenfree", "cache"),
		});
		expect(zen.configPath()).toBe(join(tmp, "config", "zenfree.json"));
		expect(zen.cacheDir()).toBe(join(tmp, "zcache"));
		const cfg = zen.loadConfig();
		expect(cfg.auth).toBeUndefined();
		cfg.auth = { mode: "apiKey", apiKey: "oc-test" };
		zen.saveConfig(cfg);
		expect(zen.loadConfig().auth).toEqual({ mode: "apiKey", apiKey: "oc-test" });
		zen.writeCache("x.json", { a: 1 });
		expect(zen.readCache<{ a: number }>("x.json")).toEqual({ a: 1 });
		delete process.env.ZENFREE_CONFIG;
		delete process.env.ZENFREE_CACHE;
	});

	it("stores are isolated from each other", () => {
		const zen = zenfreeState;
		const cline = clinefreeState;
		cline.writeCache("shared.json", { who: "cline" });
		zen.writeCache("shared.json", { who: "zen" });
		expect(cline.readCache<{ who: string }>("shared.json")).toEqual({ who: "cline" });
		expect(zen.readCache<{ who: string }>("shared.json")).toEqual({ who: "zen" });
	});

	it("clinefree store keeps CLINEFREE_* env and default paths", () => {
		expect(clinefreeState.configPath()).toBe(process.env.CLINEFREE_CONFIG);
		expect(clinefreeState.cacheDir()).toBe(process.env.CLINEFREE_CACHE);
	});
});
