/**
 * The OpenCode Zen FreeModelSource (spec §zen-3–§zen-4, adapted to the
 * once-per-id capability model of cbfeb03):
 *
 *  - contract: the client version comes from the official update service
 *    (min-interval gated; `force` bypasses), baked-in fallback on failure.
 *  - lineup: models.dev `opencode` zero-cost models only. zenfree is
 *    anonymous-only: no credential is read and the console config (workspace
 *    overrides) is never fetched. Last-known-good when models.dev fails.
 *  - capabilities: models.dev fills limits, fetched once per uncovered id
 *    (`force` bypasses the coverage gate — same pattern as clinefree's cbfeb03).
 *
 * Every network path is fail-soft: nothing here throws outward.
 */

import type { FeedEntry } from "../feeds.ts";
import { fetchModelsDevModels } from "../feeds.ts";
import { zenfreeState } from "../state.ts";
import {
	buildZenContract,
	resolveLatestCliVersion,
	type ZenContractResult,
} from "./opencode-contract.ts";
import { selectZenModels, resolveZenCapabilities, type ZenCapabilities, type ZenModelEntry } from "./opencode-catalog.ts";

export const ZEN_CONTRACT_REFRESH_MINUTES = 30;
export const ZEN_LINEUP_CACHE = "public-lineup.json";
const ZEN_CONTRACT_CACHE = "client-version.json";

const RESPONSES_PACKAGE = "@ai-sdk/openai";
/**
 * Id prefixes that speak the Responses API when the public catalog carries no
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
}

export interface ZenSource {
	id: string;
	/** Warnings collected by the most recent refresh calls (surfaced once per sync). */
	warnings: string[];
	cachedContract(): ZenContractResult | undefined;
	refreshContract(force?: boolean, signal?: AbortSignal): Promise<ZenContractResult>;
	fetchLineup(signal?: AbortSignal): Promise<{ id: string; name?: string }[]>;
	refreshCapabilities(ids: string[], force?: boolean, signal?: AbortSignal): Promise<Record<string, Record<string, FeedEntry>>>;
	resolveCapabilities(id: string): ZenCapabilities;
	resolveTransport(id: string): "openai-completions" | "openai-responses";
	status(): {
		timestamps: ZenSyncState["timestamps"];
		contractSource: ZenContractResult["source"] | "none";
	};
}

const EMPTY_STATE: ZenSyncState = { version: 1, timestamps: {} };

export function createZenSource(deps: ZenSourceDeps = {}): ZenSource {
	const fetcher = deps.fetcher ?? fetch;
	const fetchCatalog = (signal?: AbortSignal) => fetchModelsDevModels("opencode", fetcher, signal);
	const now = deps.now ?? Date.now;
	const readCache = deps.readCache ?? ((<T>(name: string) => zenfreeState.readCache<T>(name)) as <T>(name: string) => T | undefined);
	const writeCache = deps.writeCache ?? ((name: string, data: unknown) => zenfreeState.writeCache(name, data));
	const minIntervalMs = ZEN_CONTRACT_REFRESH_MINUTES * 60_000;

	const warnings: string[] = [];
	let modelsdev: Record<string, FeedEntry> | undefined;

	const readState = (): ZenSyncState => readCache<ZenSyncState>("state.json") ?? { ...EMPTY_STATE, timestamps: {} };
	const writeState = (state: ZenSyncState): void => writeCache("state.json", state);
	const cachedContract = (): ZenContractResult | undefined => {
		const cached = readCache<{ version?: string }>(ZEN_CONTRACT_CACHE);
		return cached ? buildZenContract(typeof cached.version === "string" ? cached.version : undefined) : undefined;
	};
	const cachedLineup = (): CachedLineup | undefined => readCache<CachedLineup>(ZEN_LINEUP_CACHE);
	const cachedCapabilities = (): CachedCapabilities | undefined =>
		readCache<CachedCapabilities>("capabilities.json");

	const lineupIds = (lineup: CachedLineup | undefined): { id: string; name?: string }[] =>
		Object.keys(lineup?.models ?? {}).sort().map((id) => ({ id, name: lineup?.models[id]?.name }));

	async function refreshContract(force = false, signal?: AbortSignal): Promise<ZenContractResult> {
		const state = readState();
		const lastCheck = state.timestamps.version ?? 0;
		if (!force && lastCheck > 0 && now() - lastCheck < minIntervalMs) {
			const cached = cachedContract();
			if (cached) return cached;
		}

		let version: string | undefined;
		try {
			version = await resolveLatestCliVersion(fetcher, signal);
		} catch {
			version = undefined;
		}
		const contract = buildZenContract(version);
		if (contract.warning) warnings.push(contract.warning);
		writeCache(ZEN_CONTRACT_CACHE, { version });
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

	async function fetchLineup(signal?: AbortSignal): Promise<{ id: string; name?: string }[]> {
		let devCatalog: Record<string, FeedEntry>;
		try {
			devCatalog = await fetchCatalog(signal);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			warnings.push(`zenfree: models.dev fetch failed (${reason}); using cached lineup`);
			return lineupIds(cachedLineup());
		}
		const lineup: CachedLineup = { models: selectZenModels(devCatalog), updatedAt: now() };
		writeCache(ZEN_LINEUP_CACHE, lineup);
		const state = readState();
		writeState({ ...state, timestamps: { ...state.timestamps, lineup: now() } });
		return lineupIds(lineup);
	}

	async function refreshCapabilities(ids: string[], force = false, signal?: AbortSignal): Promise<Record<string, Record<string, FeedEntry>>> {
		const current: CachedCapabilities = cachedCapabilities() ?? { modelsdev: {}, coveredIds: [], updatedAt: 0 };
		const covered = new Set(current.coveredIds);
		const uncovered = ids.filter((id) => !covered.has(id));
		if (force || uncovered.length > 0) {
			try {
				modelsdev = await fetchCatalog(signal);
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
		const model = cachedLineup()?.models[id];
		const devEntry = (modelsdev ?? cachedCapabilities()?.modelsdev ?? {})[id];
		return resolveZenCapabilities(model, devEntry);
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
		cachedContract,
		refreshContract,
		fetchLineup,
		refreshCapabilities,
		resolveCapabilities: resolve,
		resolveTransport,
		status() {
			const state = readState();
			return {
				timestamps: state.timestamps,
				contractSource: cachedContract()?.source ?? "none",
			};
		},
	};
}
