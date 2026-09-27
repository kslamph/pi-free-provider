/**
 * The OpenCode Zen FreeModelSource (spec §zen-3–§zen-4, adapted to the
 * once-per-id capability model of cbfeb03):
 *
 *  - contract: the client version comes from the official update service
 *    (min-interval gated; `force` bypasses), baked-in fallback on failure.
 *  - lineup: console /api/v2/config with the workspace key — the same
 *    response carries the capabilities (limit/input/package), the gateway
 *    baseUrl, and any prescribed provider headers. Last-known-good on failure.
 *  - capabilities: config-derived caps ride the lineup fetch; the models.dev
 *    `opencode` block fills gaps, fetched once per uncovered id (`force`
 *    bypasses the coverage gate — same pattern as clinefree's cbfeb03).
 *
 * Every network path is fail-soft: nothing here throws outward.
 */

import type { FeedEntry } from "../feeds.ts";
import { fetchModelsDevModels } from "../feeds.ts";
import { zenfreeState, type Credential } from "../state.ts";
import {
	buildZenContract,
	resolveLatestCliVersion,
	type ZenContractResult,
} from "./opencode-contract.ts";
import {
	fetchConsoleConfig,
	mergeZenCapabilities,
	type ZenCapabilities,
	type ZenModelEntry,
} from "./opencode-config.ts";
import { readCache as defaultReadCache, writeCache as defaultWriteCache } from "../state.ts";

const DEFAULT_MIN_INTERVAL_MS = 30 * 60_000;

/** Config `package` value marking the OpenAI Responses API transport. */
const RESPONSES_PACKAGE = "aisdk:@ai-sdk/openai";
/**
 * Id prefixes that speak the Responses API when the config carries no
 * package hint. Live-verified 2026-09-27: muse-spark's /responses answers
 * 200 once the request carries agentic tools — the earlier 403 was the
 * agentic-shape gate ("can only be used from within OpenCode"), not a tier
 * gate. The same gate applies to bare /chat/completions pings.
 */
const RESPONSES_API_PREFIXES = ["muse-spark-"];

interface ZenSyncState {
	version: 1;
	timestamps: { version?: number; contract?: number; lineup?: number; capabilities?: number };
}

interface CachedLineup {
	baseUrl?: string;
	headers?: Record<string, string>;
	/** Free models only, keyed by id. */
	models: Record<string, ZenModelEntry>;
	updatedAt: number;
}

interface CachedCapabilities {
	modelsdev: Record<string, FeedEntry>;
	/** Ids already covered by a successful models.dev fetch (or confirmed absent). */
	coveredIds: string[];
	updatedAt: number;
}

export interface ZenSourceDeps {
	fetcher?: typeof fetch;
	now?: () => number;
	readCache?: <T>(name: string) => T | undefined;
	writeCache?: (name: string, data: unknown) => void;
	minIntervalMs?: number;
}

export interface ZenSource {
	id: string;
	/** Warnings collected by the most recent refresh calls (surfaced once per sync). */
	warnings: string[];
	refreshContract(force?: boolean): Promise<ZenContractResult>;
	fetchLineup(credential?: Credential): Promise<{ id: string; name?: string }[]>;
	refreshCapabilities(ids: string[], force?: boolean): Promise<Record<string, Record<string, FeedEntry>>>;
	resolveCapabilities(id: string): ZenCapabilities;
	resolveTransport(id: string): "openai-completions" | "openai-responses";
	/** Live gateway url from the last successful config fetch, when known. */
	configBaseUrl(): string | undefined;
	/** Headers the console prescribes for gateway requests (e.g. x-opencode-org-id). */
	configHeaders(): Record<string, string> | undefined;
	status(): {
		timestamps: ZenSyncState["timestamps"];
		contractSource: ZenContractResult["source"] | "none";
	};
}

const EMPTY_STATE: ZenSyncState = { version: 1, timestamps: {} };

export function createZenSource(deps: ZenSourceDeps = {}): ZenSource {
	const fetcher = deps.fetcher ?? fetch;
	const now = deps.now ?? Date.now;
	const readCache = deps.readCache ?? ((<T>(name: string) => zenfreeState.readCache<T>(name)) as <T>(name: string) => T | undefined);
	const writeCache = deps.writeCache ?? ((name: string, data: unknown) => zenfreeState.writeCache(name, data));
	const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

	const warnings: string[] = [];
	let modelsdev: Record<string, FeedEntry> | undefined;

	const readState = (): ZenSyncState => readCache<ZenSyncState>("state.json") ?? { ...EMPTY_STATE, timestamps: {} };
	const writeState = (state: ZenSyncState): void => writeCache("state.json", state);
	const cachedContract = (): ZenContractResult | undefined => readCache<ZenContractResult>("contract.json");
	const cachedLineup = (): CachedLineup | undefined => readCache<CachedLineup>("lineup.json");
	const cachedCapabilities = (): CachedCapabilities | undefined =>
		readCache<CachedCapabilities>("capabilities.json");

	async function refreshContract(force = false): Promise<ZenContractResult> {
		const state = readState();
		const lastCheck = state.timestamps.version ?? 0;
		if (!force && lastCheck > 0 && now() - lastCheck < minIntervalMs) {
			const cached = cachedContract();
			if (cached) return cached;
		}

		let version: string | undefined;
		try {
			version = await resolveLatestCliVersion(fetcher);
		} catch {
			version = undefined;
		}
		const baseUrl = cachedLineup()?.baseUrl;
		const contract = buildZenContract(version, baseUrl);
		if (contract.warning) warnings.push(contract.warning);
		writeCache("contract.json", contract);
		writeState({
			...state,
			timestamps: {
				...state.timestamps,
				version: now(),
				...(contract.source !== "baked-in" ? { contract: now() } : {}),
			},
		});
		return contract;
	}

	async function fetchLineup(credential?: Credential): Promise<{ id: string; name?: string }[]> {
		let cached = cachedLineup();
		if (!credential?.apiKey) {
			warnings.push("zenfree: lineup fetch needs a workspace key");
			return Object.keys(cached?.models ?? {}).sort().map((id) => ({ id, name: cached?.models[id]?.name }));
		}

		let config;
		try {
			config = await fetchConsoleConfig(credential.apiKey, fetcher);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			warnings.push(
				/^HTTP 40[13]$/.test(reason)
					? `zenfree: config fetch rejected (${reason}) — the workspace key may be invalid`
					: `zenfree: config fetch failed (${reason}); using cached lineup`,
			);
			cached = cachedLineup();
			return Object.keys(cached?.models ?? {}).sort().map((id) => ({ id, name: cached?.models[id]?.name }));
		}
		if (!config) {
			warnings.push("zenfree: config fetch failed (unexpected payload); using cached lineup");
			cached = cachedLineup();
			return Object.keys(cached?.models ?? {}).sort().map((id) => ({ id, name: cached?.models[id]?.name }));
		}

		const free: Record<string, ZenModelEntry> = {};
		for (const [id, entry] of Object.entries(config.models)) {
			if (entry.free) free[id] = entry;
		}
		const lineup: CachedLineup = {
			...(config.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
			...(config.headers !== undefined ? { headers: config.headers } : {}),
			models: free,
			updatedAt: now(),
		};
		writeCache("lineup.json", lineup);
		const state = readState();
		writeState({ ...state, timestamps: { ...state.timestamps, lineup: now() } });
		return Object.keys(free).sort().map((id) => ({ id, name: free[id]?.name }));
	}

	async function refreshCapabilities(ids: string[], force = false): Promise<Record<string, Record<string, FeedEntry>>> {
		const current: CachedCapabilities = cachedCapabilities() ?? { modelsdev: {}, coveredIds: [], updatedAt: 0 };
		const covered = new Set(current.coveredIds);
		const uncovered = ids.filter((id) => !covered.has(id));
		if (force || uncovered.length > 0) {
			try {
				modelsdev = await fetchModelsDevModels("opencode", fetcher);
				current.modelsdev = modelsdev;
				current.coveredIds = [...covered, ...ids];
				current.updatedAt = now();
				writeCache("capabilities.json", current);
				const state = readState();
				writeState({ ...state, timestamps: { ...state.timestamps, capabilities: now() } });
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				warnings.push(`zenfree: models.dev fetch failed (${reason})`);
				modelsdev = current.modelsdev;
			}
		} else {
			modelsdev = current.modelsdev;
		}
		return { modelsdev };
	}

	function resolve(id: string): ZenCapabilities {
		const configEntry = cachedLineup()?.models[id];
		const devEntry = (modelsdev ?? cachedCapabilities()?.modelsdev ?? {})[id];
		return mergeZenCapabilities(configEntry, devEntry);
	}

	function resolveTransport(id: string): "openai-completions" | "openai-responses" {
		const pkg = cachedLineup()?.models[id]?.package;
		if (pkg === RESPONSES_PACKAGE) return "openai-responses";
		if (pkg === undefined && RESPONSES_API_PREFIXES.some((prefix) => id.startsWith(prefix))) {
			return "openai-responses";
		}
		return "openai-completions";
	}

	return {
		id: "opencode",
		warnings,
		refreshContract,
		fetchLineup,
		refreshCapabilities,
		resolveCapabilities: resolve,
		resolveTransport,
		configBaseUrl: () => cachedLineup()?.baseUrl,
		configHeaders: () => cachedLineup()?.headers,
		status() {
			const state = readState();
			return {
				timestamps: state.timestamps,
				contractSource: cachedContract()?.source ?? "none",
			};
		},
	};
}
