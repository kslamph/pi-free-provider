/**
 * Config + cache state for the clinefree extension.
 *
 * Config lives at ~/.pi/agent/clinefree.json (env CLINEFREE_CONFIG) with mode
 * 0600 — it holds the credential. Cache lives under ~/.pi/agent/clinefree/cache/
 * (env CLINEFREE_CACHE) and holds the synced contract / lineup / capabilities.
 * All writes are atomic: write a temp file in the same directory, then rename.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Credential for api.cline.bot: either a pasted API key or an OAuth token pair. */
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

export function configPath(): string {
	return process.env.CLINEFREE_CONFIG ?? join(homedir(), ".pi", "agent", "clinefree.json");
}

export function cacheDir(): string {
	return process.env.CLINEFREE_CACHE ?? join(homedir(), ".pi", "agent", "clinefree", "cache");
}

/** Write `data` as JSON at `path` atomically (temp file + rename in the same dir). */
function writeJsonAtomic(path: string, data: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, "\t")}\n`);
	renameSync(tmp, path);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Load the config, creating it with defaults (mode 0600) when absent.
 * A corrupt file never breaks startup: defaults are returned instead.
 */
export function loadConfig(): ClinefreeConfig {
	const path = configPath();
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

export function saveConfig(cfg: ClinefreeConfig): void {
	const path = configPath();
	writeJsonAtomic(path, cfg);
	chmodSync(path, 0o600);
}

/** Read a cached JSON file; undefined when missing or corrupt. */
export function readCache<T>(name: string): T | undefined {
	return readJson(join(cacheDir(), name)) as T | undefined;
}

/** Atomically write a JSON file into the cache directory. */
export function writeCache(name: string, data: unknown): void {
	writeJsonAtomic(join(cacheDir(), name), data);
}
