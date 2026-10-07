/**
 * The Cline FreeModelSource (spec §4–§6):
 *  - contract: GitHub at the latest per-artifact release tags, TTL-gated by a
 *    min interval; baked-in fallback with a warning when unreachable.
 *  - lineup: live recommended-models `free[]` (unauthenticated), contract
 *    headers attached; last-known-good cache on failure.
 *  - capabilities: models.dev openrouter + Vercel AI Gateway feeds, fetched
 *    once per model id — an id already covered by a prior successful fetch
 *    is never re-fetched automatically, only on a manual `force` refresh.
 *
 * Every network path is fail-soft: nothing here throws outward.
 */

import { BAKED_IN_CONTRACT, extractContract, type ContractResult } from "../contract.ts";
import { resolveCapabilities } from "../capabilities.ts";
import { fetchModelsDevOpenRouter, fetchVercelGateway, type FeedEntry } from "../feeds.ts";
import { fetchRawAtSha, resolveLatestTag, TAG_PREFIXES } from "../github.ts";
import { readCache as defaultReadCache, writeCache as defaultWriteCache } from "../state.ts";
import type { FreeModelSource, LineupEntry } from "./types.ts";

const CLINE_API_BASE = "https://api.cline.bot";
const DEFAULT_MIN_INTERVAL_MS = 30 * 60_000;

const CONTRACT_FILES = {
	requestHeaders: "sdk/packages/llms/src/providers/request-headers.ts",
	clientHeaders: "sdk/packages/llms/src/providers/cline-client-headers.ts",
	recommended: "sdk/packages/llms/src/catalog/catalog-cline-recommended.ts",
} as const;

export interface SyncState {
	version: 1;
	tags: { llms?: string; core?: string; cli?: string };
	shas: { llms?: string; core?: string; cli?: string };
	timestamps: { tags?: number; contract?: number; capabilities?: number; lineup?: number };
	lastResult?: { added: string[]; removed: string[]; warnings: string[] };
}

export interface ClineSourceDeps {
	fetcher?: typeof fetch;
	now?: () => number;
	readCache?: <T>(name: string) => T | undefined;
	writeCache?: (name: string, data: unknown) => void;
	minIntervalMs?: number;
}

export interface ClineSource extends FreeModelSource {
	/** Warnings collected by the most recent refresh calls (surfaced once per sync). */
	warnings: string[];
	/** Status snapshot for /clinefree. */
	status(): {
		tags: SyncState["tags"];
		timestamps: SyncState["timestamps"];
		contractSource: "github" | "baked-in" | "none";
		/** Ids already covered by a successful capability fetch (survives restarts). */
		capabilitiesCoveredIds: string[];
	};
}

const EMPTY_STATE: SyncState = { version: 1, tags: {}, shas: {}, timestamps: {} };

interface CachedCapabilities {
	openrouter: Record<string, FeedEntry>;
	vercel: Record<string, FeedEntry>;
	updatedAt: number;
	/** Ids already covered by a successful (or confirmed-absent) capability fetch. */
	coveredIds: string[];
}

interface ModelsCatalogCache {
	ids: string[];
	entries: Record<string, { name?: string; description?: string; tags?: string[] }>;
}

/** `cli-v3.0.65` → `3.0.65`; `sdk/llms/v0.0.86` → `0.0.86`. */
function versionOfTag(tag: string): string {
	const idx = tag.lastIndexOf("v");
	return idx >= 0 ? tag.slice(idx + 1) : tag;
}

function dedupeLineup(a: LineupEntry[], b: LineupEntry[]): LineupEntry[] {
	const seen = new Set<string>();
	const out: LineupEntry[] = [];
	for (const entry of a.concat(b)) {
		if (!seen.has(entry.id)) {
			seen.add(entry.id);
			out.push(entry);
		}
	}
	return out;
}

export function createClineSource(deps: ClineSourceDeps = {}): ClineSource {
	const fetcher = deps.fetcher ?? fetch;
	const now = deps.now ?? Date.now;
	const readCache = deps.readCache ?? defaultReadCache;
	const writeCache = deps.writeCache ?? defaultWriteCache;
	const minIntervalMs = deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;

	const warnings: string[] = [];
	let feeds: { openrouter: Record<string, FeedEntry>; vercel: Record<string, FeedEntry> } | undefined;

	const readState = (): SyncState => readCache<SyncState>("state.json") ?? { ...EMPTY_STATE, tags: {}, shas: {}, timestamps: {} };
	const writeState = (state: SyncState) => writeCache("state.json", state);

	const cachedContract = (): ContractResult | undefined => readCache<ContractResult>("contract.json");

	async function refreshContract(force = false): Promise<ContractResult> {
		const state = readState();
		const lastCheck = state.timestamps.tags ?? 0;
		if (!force && lastCheck > 0 && now() - lastCheck < minIntervalMs) {
			return cachedContract() ?? BAKED_IN_CONTRACT;
		}

		let tags: SyncState["tags"];
		let shas: SyncState["shas"];
		try {
			const [llms, core, cli] = await Promise.all([
				resolveLatestTag(TAG_PREFIXES.llms, fetcher),
				resolveLatestTag(TAG_PREFIXES.core, fetcher),
				resolveLatestTag(TAG_PREFIXES.cli, fetcher),
			]);
			tags = { llms: llms.tag, core: core.tag, cli: cli.tag };
			shas = { llms: llms.sha, core: core.sha, cli: cli.sha };
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			warnings.push(`clinefree: tag resolution failed (${reason})`);
			const cached = cachedContract();
			return cached ?? { ...BAKED_IN_CONTRACT, warning: `clinefree: tag resolution failed (${reason}); using baked-in snapshot` };
		}

		const unchanged =
			tags.llms === state.tags.llms && tags.core === state.tags.core && tags.cli === state.tags.cli;
		let contract = cachedContract();
		if (!unchanged || !contract) {
			try {
				const [requestHeaders, clientHeaders, recommended] = await Promise.all([
					fetchRawAtSha(shas.llms!, CONTRACT_FILES.requestHeaders, fetcher),
					fetchRawAtSha(shas.llms!, CONTRACT_FILES.clientHeaders, fetcher),
					fetchRawAtSha(shas.llms!, CONTRACT_FILES.recommended, fetcher),
				]);
				contract = extractContract(
					{ requestHeaders, clientHeaders, recommended },
					{ cli: versionOfTag(tags.cli!), core: versionOfTag(tags.core!) },
				);
				writeCache("contract.json", contract);
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				warnings.push(`clinefree: contract download failed (${reason})`);
				contract =
					contract ??
					extractContract({}, { cli: versionOfTag(tags.cli!), core: versionOfTag(tags.core!) });
			}
		}

		writeState({ ...state, tags, shas, timestamps: { ...state.timestamps, tags: now(), ...(contract && contract.source === "github" ? { contract: now() } : {}) } });
		if (contract?.warning) warnings.push(contract.warning);
		return contract ?? BAKED_IN_CONTRACT;
	}

	async function fetchFreeModelsFromModelsCatalog(): Promise<LineupEntry[]> {
		const url = `${CLINE_API_BASE}/api/v1/ai/cline/models`;
		const cached = readCache<ModelsCatalogCache>("models.json");
		if (cached?.ids.length) return cached.ids.map((id) => ({ id, name: cached.entries[id]?.name }));
		try {
			const response = await fetcher(url);
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const payload = (await response.json()) as { data?: Array<{ id: string; name?: string; pricing?: { prompt: string } }> };
			const free: LineupEntry[] = [];
			for (const entry of payload.data ?? []) {
				if (!entry || typeof entry.id !== "string" || entry.id.length === 0) continue;
				const isFree =
					entry.pricing?.prompt === "0" || /:free$/i.test(entry.id) || / \(free\)$/i.test(entry.name ?? "");
				if (isFree) free.push({ id: entry.id, name: entry.name });
			}
			writeCache("models.json", { ids: free.map((e) => e.id), entries: free.reduce((acc, e) => { acc[e.id] = { name: e.name }; return acc; }, {} as ModelsCatalogCache["entries"]) });
			return free;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			warnings.push(`clinefree: models catalog fetch failed (${reason})`);
			return [];
		}
	}

async function fetchLineup(): Promise<LineupEntry[]> {
	const contract = cachedContract() ?? BAKED_IN_CONTRACT;
	const baseUrl = `${CLINE_API_BASE}${contract.endpointPath}`;
	const state = readState();
	const lineupCache = readCache<LineupEntry[]>("lineup.json");

	const baseFree: LineupEntry[] = [];
	let recommendedFailed = false;
	try {
		const response = await fetcher(baseUrl, { headers: contract.headers });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const payload = (await response.json()) as { free?: LineupEntry[] };
		baseFree.push(...(Array.isArray(payload.free) ? payload.free.filter((e) => e && typeof e.id === "string" && e.id.length > 0) : []));
	} catch (error) {
		recommendedFailed = true;
		const reason = error instanceof Error ? error.message : String(error);
		warnings.push(`clinefree: recommended-models fetch failed (${reason}) — using cached lineup`);
	}

	// Merge models with pricing.prompt == "0" from the /models catalog.
	const modelsFree = await fetchFreeModelsFromModelsCatalog();
	const merged = dedupeLineup(baseFree, modelsFree);
	writeCache("lineup.json", merged);
	writeState({ ...state, timestamps: { ...state.timestamps, lineup: now() } });

	// When both sources failed, fall back to the last-known-good cached lineup.
	if (recommendedFailed && modelsFree.length === 0) return lineupCache ?? [];
	return merged;
}
	async function refreshCapabilities(ids: string[], force = false): Promise<{ openrouter: Record<string, FeedEntry>; vercel: Record<string, FeedEntry> }> {
		const cached = readCache<CachedCapabilities>("capabilities.json");
		const coveredIds = new Set(cached?.coveredIds ?? []);
		const hasUncovered = ids.some((id) => !coveredIds.has(id));
		if (!force && !hasUncovered) {
			if (feeds) return feeds;
			if (cached) {
				feeds = { openrouter: cached.openrouter, vercel: cached.vercel };
				return feeds;
			}
			return { openrouter: {}, vercel: {} };
		}

		const current: CachedCapabilities = cached ?? { openrouter: {}, vercel: {}, updatedAt: 0, coveredIds: [] };
		const [or, vc] = await Promise.allSettled([fetchModelsDevOpenRouter(fetcher), fetchVercelGateway(fetcher)]);
		if (or.status === "fulfilled") current.openrouter = or.value;
		else warnings.push(`clinefree: models.dev fetch failed (${or.reason instanceof Error ? or.reason.message : String(or.reason)})`);
		if (vc.status === "fulfilled") current.vercel = vc.value;
		else warnings.push(`clinefree: vercel gateway fetch failed (${vc.reason instanceof Error ? vc.reason.message : String(vc.reason)})`);

		const bothFetched = or.status === "fulfilled" && vc.status === "fulfilled";
		for (const id of ids) {
			const caps = resolveCapabilities(id, current.openrouter, current.vercel);
			if (caps.source !== "default" || bothFetched) coveredIds.add(id);
		}

		current.updatedAt = now();
		current.coveredIds = [...coveredIds];
		writeCache("capabilities.json", current);
		feeds = { openrouter: current.openrouter, vercel: current.vercel };

		const state = readState();
		writeState({ ...state, timestamps: { ...state.timestamps, capabilities: now() } });

		return feeds;
	}

	function resolve(id: string) {
		const active = feeds ?? readCache<CachedCapabilities>("capabilities.json");
		return resolveCapabilities(id, active?.openrouter ?? {}, active?.vercel ?? {});
	}

	return {
		id: "cline",
		warnings,
		refreshContract,
		fetchLineup,
		refreshCapabilities,
		resolveCapabilities: resolve,
		status() {
			const state = readState();
			return {
				tags: state.tags,
				timestamps: state.timestamps,
				contractSource: cachedContract()?.source ?? "none",
				capabilitiesCoveredIds: readCache<CachedCapabilities>("capabilities.json")?.coveredIds ?? [],
			};
		},
	};
}
