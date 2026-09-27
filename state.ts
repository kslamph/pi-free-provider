/**
 * Config + cache state for the clinefree/zenfree extension family.
 *
 * Each source owns a namespaced store (see `clinefreeState` / `zenfreeState`):
 * config lives at `~/.pi/agent/<name>.json` (env override per store) with mode
 * 0600 — it holds the credential. Cache lives under `~/.pi/agent/<name>/cache/`
 * and holds the synced contract / lineup / capabilities. All writes are atomic:
 * write a temp file in the same directory, then rename.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Credential for a free-model source: either a pasted API key or an OAuth token pair. */
export interface Credential {
	mode: "apiKey" | "oauth";
	apiKey?: string;
	accessToken?: string;
	refreshToken?: string;
	/** Access token expiry in epoch ms, when the server reports one. */
	expiresAt?: number;
	account?: { id?: string; email?: string };
}

export interface ClinefreeConfig {
	auth?: Credential;
	sync: {
		/** Minimum gap between full tag/contract syncs, in minutes. */
		minIntervalMinutes: number;
		/** How long the capability feeds stay fresh, in minutes. */
		capabilityTtlMinutes: number;
		notifyOnChange: boolean;
	};
}

export const DEFAULT_CONFIG: ClinefreeConfig = {
	auth: undefined,
	sync: { minIntervalMinutes: 30, capabilityTtlMinutes: 10, notifyOnChange: true },
};

/** A namespace-scoped config + cache store: one instance per source (clinefree, zenfree). */
export interface StateStore {
	configPath(): string;
	cacheDir(): string;
	loadConfig(): ClinefreeConfig;
	saveConfig(cfg: ClinefreeConfig): void;
	readCache<T>(name: string): T | undefined;
	writeCache(name: string, data: unknown): void;
}

export interface StateNamespace {
	configEnv: string;
	cacheEnv: string;
	configDefault: string;
	cacheDefault: string;
}

export function createStateStore(ns: StateNamespace): StateStore {
	return {
		configPath: () => process.env[ns.configEnv] ?? ns.configDefault,
		cacheDir: () => process.env[ns.cacheEnv] ?? ns.cacheDefault,
		loadConfig: () => loadConfigAt(process.env[ns.configEnv] ?? ns.configDefault),
		saveConfig: (cfg) => saveConfigAt(process.env[ns.configEnv] ?? ns.configDefault, cfg),
		readCache: <T>(name: string) => readJson(join(process.env[ns.cacheEnv] ?? ns.cacheDefault, name)) as T | undefined,
		writeCache: (name, data) => writeJsonAtomic(join(process.env[ns.cacheEnv] ?? ns.cacheDefault, name), data),
	};
}

export const clinefreeState = createStateStore({
	configEnv: "CLINEFREE_CONFIG",
	cacheEnv: "CLINEFREE_CACHE",
	configDefault: join(homedir(), ".pi", "agent", "clinefree.json"),
	cacheDefault: join(homedir(), ".pi", "agent", "clinefree", "cache"),
});

export const zenfreeState = createStateStore({
	configEnv: "ZENFREE_CONFIG",
	cacheEnv: "ZENFREE_CACHE",
	configDefault: join(homedir(), ".pi", "agent", "zenfree.json"),
	cacheDefault: join(homedir(), ".pi", "agent", "zenfree", "cache"),
});

/** Write `data` as JSON at `path` atomically (temp file + rename in the same dir). */
function writeJsonAtomic(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`);
	renameSync(tmp, path);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return undefined;
	}
}

/**
 * Load the config at `path`, creating it with defaults (mode 0600) when absent.
 * A corrupt file never breaks startup: defaults are returned instead.
 */
function loadConfigAt(path: string): ClinefreeConfig {
	let created = false;
	try {
		statSync(path);
	} catch {
		writeJsonAtomic(path, DEFAULT_CONFIG);
		chmodSync(path, 0o600);
		created = true;
	}
	const parsed = created ? DEFAULT_CONFIG : readJson(path);
	if (!parsed || typeof parsed !== "object") return { ...DEFAULT_CONFIG };
	const cfg = parsed as Partial<ClinefreeConfig>;
	return {
		auth: cfg.auth,
		sync: { ...DEFAULT_CONFIG.sync, ...cfg.sync },
	};
}

function saveConfigAt(path: string, cfg: ClinefreeConfig): void {
	writeJsonAtomic(path, cfg);
	chmodSync(path, 0o600);
}

// ── clinefree-compatible top-level API (paths, env, behavior unchanged) ──────

export function configPath(): string {
	return clinefreeState.configPath();
}

export function cacheDir(): string {
	return clinefreeState.cacheDir();
}

export function loadConfig(): ClinefreeConfig {
	return clinefreeState.loadConfig();
}

export function saveConfig(cfg: ClinefreeConfig): void {
	clinefreeState.saveConfig(cfg);
}

/** Read a cached JSON file from the clinefree cache; undefined when missing or corrupt. */
export function readCache<T>(name: string): T | undefined {
	return clinefreeState.readCache<T>(name);
}

/** Atomically write a JSON file into the clinefree cache directory. */
export function writeCache(name: string, data: unknown): void {
	clinefreeState.writeCache(name, data);
}
