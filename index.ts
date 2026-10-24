/**
 * pi-free-provider — Cline's free models as one auto-synced pi provider (`clinefree`).
 *
 * session_start (and /clinefree refresh) fetches the live free lineup, resolves
 * each model's capabilities (models.dev openrouter → Vercel gateway → defaults),
 * and re-registers the provider on diff. The request contract (headers, endpoint
 * path, versions) comes from the cline/cline GitHub repo at the latest release
 * tags; a baked-in snapshot is the fail-soft fallback. Nothing blocks startup.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext, Api } from "@earendil-works/pi-ai";
import { runDeviceFlow, validateCredential } from "./auth.ts";
import { BAKED_IN_CONTRACT, type ContractResult } from "./contract.ts";
import { DEFAULT_CONFIG, loadConfig, readCache, saveConfig, writeCache, zenfreeState, type ClinefreeConfig, type Credential } from "./state.ts";
import { toProviderModel, type ProviderModel } from "./mapping.ts";
import { type DesiredProvider, type MultiSyncDeps, type RegisteredState, diffModels, syncProviders } from "./registry.ts";
import { createClinefreeStream, createZenfreeStream, resetConversation, resetZenConversation } from "./stream.ts";
import { createZenSidecar } from "./sidecar.ts";
import { createZenSource, type ZenSource } from "./sources/opencode.ts";
import { BAKED_IN_ZEN_CONTRACT, type ZenContractResult } from "./sources/opencode-contract.ts";
import type { ZenCapabilities } from "./sources/opencode-config.ts";
import { validateZenKey } from "./auth.ts";
import { createClineSource, type ClineSource } from "./sources/cline.ts";
import type { LineupEntry } from "./sources/types.ts";
import { maskKey, registerClinefreeCommand, registerZenfreeCommand } from "./tui.ts";
import type { FeedEntry } from "./feeds.ts";

export const PROVIDER_ID = "clinefree";
export const PROVIDER_NAME = "Cline Free";

export const ZEN_PROVIDER_ID = "zenfree";
export const ZEN_RES_PROVIDER_ID = "zenfree.res";
export const ZEN_PROVIDER_NAME = "OpenCode Zen Free";
export const ZEN_RES_PROVIDER_NAME = "OpenCode Zen Free (Responses)";

/** Minimal pi surface syncOnce needs (tests pass a fake). */
export interface PiLike {
	registerProvider(id: string, config: unknown): void;
	unregisterProvider(id: string): void;
}

export interface SyncDeps {
	pi: PiLike;
	/** Free-model source (lineup + capabilities + warnings). */
	source: ClineSource | (Pick<ClineSource, "fetchLineup" | "resolveCapabilities" | "refreshCapabilities"> & { warnings: string[] });
	getContract(): ContractResult;
	streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	notify(message: string): void;
	config: ClinefreeConfig;
	/** Mutated in place — the caller's record of what is registered. */
	registeredIds: string[];
	/** Provider ids currently registered (managed by syncOnce; one entry today). */
	providerIds?: string[];
	/** True when `id` is pi's currently selected model. */
	isCurrentModel(id: string): boolean;
	/** Force a capability re-fetch even for already-covered ids (manual refresh). */
	forceCapabilities?: boolean;
}

/**
 * One sync pass: lineup → capabilities (fetched only for ids never covered
 * before, unless `forceCapabilities`) → map → diff → re-register.
 * Never throws: a failing source keeps the previous registration.
 */
export async function syncOnce(deps: SyncDeps): Promise<{ added: string[]; removed: string[]; warnings: string[] }> {
	if (!deps.config.auth) return { added: [], removed: [], warnings: [] };

	let lineup: LineupEntry[];
	try {
		lineup = await deps.source.fetchLineup();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		deps.notify(`clinefree: sync failed (${reason}) — keeping previous models`);
		return { added: [], removed: [], warnings: [] };
	}

	const desiredIds = lineup.map((entry) => entry.id);
	if (desiredIds.length > 0) {
		try {
			await deps.source.refreshCapabilities(desiredIds, deps.forceCapabilities ?? false);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			deps.notify(`clinefree: capability fetch failed (${reason}) — using cached/default capabilities`);
		}
	}

	// Surface collected warnings once per sync, then clear them.
	const warnings = [...deps.source.warnings];
	for (const warning of warnings) deps.notify(warning);
	deps.source.warnings.length = 0;

	const models: ProviderModel[] = lineup.map((entry) =>
		toProviderModel(entry.id, deps.source.resolveCapabilities(entry.id), entry.name, { maxTokensField: "max_tokens" }),
	);
	const contract = deps.getContract();
	const providerIds = (deps.providerIds ??= []);
	const engine: MultiSyncDeps = {
		pi: deps.pi,
		label: "clinefree",
		notify: deps.notify,
		notifyOnChange: deps.config.sync.notifyOnChange,
		isCurrentModel: deps.isCurrentModel,
		registered: { providerIds, modelIds: deps.registeredIds },
	};
	if (models.length === 0) {
		const result = syncProviders(engine, []);
		return { ...result, warnings };
	}
	const result = syncProviders(engine, [
		{
			providerId: PROVIDER_ID,
			models,
			register: (toRegister) => {
				deps.pi.registerProvider(PROVIDER_ID, {
					name: PROVIDER_NAME,
					baseUrl: "https://api.cline.bot/api/v1",
					// Real credential injected per-request by the custom streamSimple.
					apiKey: "clinefree-managed",
					api: "openai-completions",
					headers: contract.headers,
					models: toRegister as ProviderModel[],
					streamSimple: deps.streamSimple,
				});
			},
		},
	]);
	return { ...result, warnings };
}

/** Record the sync result into a store's state.json (history for the /command). */
function recordSyncResultIn(
	store: Pick<typeof clinefreeStore, "readCache" | "writeCache">,
	added: string[],
	removed: string[],
	warnings: string[],
): void {
	try {
		const state = store.readCache<{ version: 1; lastResult?: { added: string[]; removed: string[]; warnings: string[] }; timestamps?: Record<string, number>; tags?: Record<string, string>; shas?: Record<string, string> }>("state.json") ?? { version: 1, tags: {}, shas: {}, timestamps: {} };
		store.writeCache("state.json", { ...state, lastResult: { added, removed, warnings } });
	} catch {
		// history is best-effort
	}
}

const clinefreeStore = { readCache, writeCache };

/** Zen history lives in the zenfree store, not the clinefree one. */
function recordZenSyncResult(added: string[], removed: string[], warnings: string[]): void {
	recordSyncResultIn(zenfreeState, added, removed, warnings);
}

export interface ZenTargetOpts {
	lineup: { id: string; name?: string }[];
	resolve(id: string): ZenCapabilities;
	resolveTransport(id: string): "openai-completions" | "openai-responses";
	contract: ZenContractResult;
	streamSimple: (model: never, context: never, options?: never) => unknown;
	registerProvider(id: string, config: unknown): void;
}

/**
 * Split the zen lineup by transport into syncProviders targets: chat
 * completions under `zenfree`, OpenAI Responses under `zenfree.res`
 * (pi only dispatches a custom streamSimple on an api match).
 */
export function buildZenTargets(opts: ZenTargetOpts): DesiredProvider[] {
	type Group = { providerId: string; api: "openai-completions" | "openai-responses"; models: ProviderModel[] };
	const groups = new Map<string, Group>();
	for (const entry of opts.lineup) {
		const api = opts.resolveTransport(entry.id);
		const caps = opts.resolve(entry.id);
		const model = toProviderModel(entry.id, caps, entry.name, { api, baseUrl: opts.contract.baseUrl, thinkingFormat: "openai", maxTokensField: "max_tokens" });
		const providerId = api === "openai-responses" ? ZEN_RES_PROVIDER_ID : ZEN_PROVIDER_ID;
		const group = groups.get(providerId) ?? { providerId, api, models: [] };
		group.models.push(model);
		groups.set(providerId, group);
	}
	return Array.from(groups.values()).map((group) => ({
		providerId: group.providerId,
		models: group.models,
		register: (models: { id: string }[]) => {
			opts.registerProvider(group.providerId, {
				name: group.providerId === ZEN_RES_PROVIDER_ID ? ZEN_RES_PROVIDER_NAME : ZEN_PROVIDER_NAME,
				baseUrl: opts.contract.baseUrl,
				// Real credential injected per-request by the custom streamSimple.
				apiKey: "zenfree-managed",
				api: group.api,
				headers: { ...opts.contract.headers },
				models: models as ProviderModel[],
				streamSimple: opts.streamSimple,
			});
		},
	}));
}

export default function clinefree(pi: ExtensionAPI): void {
	let config: ClinefreeConfig;
	try {
		config = loadConfig();
	} catch (error) {
		console.error(`[clinefree] config load failed: ${error instanceof Error ? error.message : String(error)}`);
		config = { ...DEFAULT_CONFIG, sync: { ...DEFAULT_CONFIG.sync } };
	}

	const source = createClineSource({
		minIntervalMs: config.sync.minIntervalMinutes * 60_000,
	});
	let currentContract: ContractResult = readCache<ContractResult>("contract.json") ?? BAKED_IN_CONTRACT;

	let ui: { notify(message: string, level?: string): void } | undefined;
	const notify = (message: string): void => {
		try {
			ui?.notify(message, "info");
		} catch {
			// UI may be gone (reload/shutdown); notifications are best-effort.
		}
	};

	const streamSimple = createClinefreeStream({
		getCredential: () => config.auth,
		getContract: () => currentContract,
		onCredentialSaved: (cred: Credential) => {
			config.auth = cred;
			try {
				saveConfig(config);
			} catch {
				// best-effort persistence
			}
		},
		onInvalidated: () => {
			config.auth = undefined;
			try {
				saveConfig(config);
			} catch {
				// best-effort
			}
		},
		notify,
	});

	const registeredIds: string[] = [];
	let getModel: (() => { id?: string } | undefined) | undefined;
	const deps: SyncDeps = {
		pi: pi as unknown as PiLike,
		source,
		getContract: () => currentContract,
		streamSimple,
		notify,
		config,
		registeredIds,
		isCurrentModel: (id) => {
			try {
				return getModel?.()?.id === id;
			} catch {
				return false;
			}
		},
	};

	/** Full sync: contract (TTL-gated) → lineup+capabilities+register. `force` bypasses the tag-interval and re-fetches capabilities even for already-covered ids. */
	const fullSync = async (force = false): Promise<void> => {
		currentContract = await source.refreshContract(force);
		const result = await syncOnce({ ...deps, forceCapabilities: force });
		recordSyncResultIn(clinefreeStore, result.added, result.removed, result.warnings);
	};

	// Register from cached state up front so models exist during startup (no network).
	if (config.auth) {
		const cachedLineup = readCache<LineupEntry[]>("lineup.json");
		if (cachedLineup && cachedLineup.length > 0) {
			try {
				const models = cachedLineup.map((entry) =>
					toProviderModel(entry.id, source.resolveCapabilities(entry.id), entry.name, { maxTokensField: "max_tokens" }),
				);
				pi.registerProvider(PROVIDER_ID, {
					name: PROVIDER_NAME,
					baseUrl: "https://api.cline.bot/api/v1",
					apiKey: "clinefree-managed",
					api: "openai-completions",
					headers: currentContract.headers,
					models,
					streamSimple,
				});
				registeredIds.push(...cachedLineup.map((e) => e.id));
			} catch (error) {
				console.error(`[clinefree] cached registration failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	pi.on("session_start", async (event, ctx) => {
		ui = ctx.ui;
		getModel = () => ctx.model;

		// clinefree — independent of zenfree; a missing cline credential must not
		// short-circuit the other source's sync.
		resetConversation(event.reason);
		if (!config.auth) {
			notify("clinefree: no credential — run /clinefree to sign in with a Cline account or API key");
		} else {
			try {
				await fullSync();
			} catch (error) {
				notify(`clinefree: sync error (${error instanceof Error ? error.message : String(error)}) — models unchanged`);
			}
		}

		// zenfree — independent of clinefree (own guard, own try/catch).
		resetZenConversation(event.reason);
		if (!zenConfig.auth) {
			notify("zenfree: no workspace key — run /zenfree to add one");
			return;
		}
		try {
			await zenSync();
		} catch (error) {
			notify(`zenfree: sync error (${error instanceof Error ? error.message : String(error)}) — models unchanged`);
		}
	});

	// /clinefree command (status · models · auth; r in the status panel refreshes).
	let lastLineup: LineupEntry[] = readCache<LineupEntry[]>("lineup.json") ?? [];
	const patchLineup = (entries: LineupEntry[]): void => {
		lastLineup = entries;
	};
	const originalFetchLineup = source.fetchLineup.bind(source);
	source.fetchLineup = async () => {
		const entries = await originalFetchLineup();
		patchLineup(entries);
		return entries;
	};

	// ── zenfree (OpenCode Zen) — second source, fully independent failures ──

	let zenConfig: ClinefreeConfig;
	try {
		zenConfig = zenfreeState.loadConfig();
	} catch (error) {
		console.error(`[zenfree] config load failed: ${error instanceof Error ? error.message : String(error)}`);
		zenConfig = { ...DEFAULT_CONFIG, sync: { ...DEFAULT_CONFIG.sync } };
	}

	const zenSource: ZenSource = createZenSource({
		minIntervalMs: zenConfig.sync.minIntervalMinutes * 60_000,
	});
	let zenCurrentContract: ZenContractResult =
		zenfreeState.readCache<ZenContractResult>("contract.json") ?? BAKED_IN_ZEN_CONTRACT;

	const zenSidecar = createZenSidecar({ notify });
	const zenStream = createZenfreeStream({
		getCredential: () => zenConfig.auth,
		getContract: () => zenCurrentContract,
		ensureSidecar: () => zenSidecar.ensureSidecar(),
		onInvalidated: () => {
			zenConfig.auth = undefined;
			try {
				zenfreeState.saveConfig(zenConfig);
			} catch {
				// best-effort
			}
		},
		onVersionStale: () => {
			void zenSource
				.refreshContract(true)
				.then((contract) => {
					zenCurrentContract = contract;
				})
				.catch(() => {
					// fail-soft: the baked-in contract stays
				});
		},
		notify,
	});

	const zenRegistered: RegisteredState = { providerIds: [], modelIds: [] };
	const zenEngine: MultiSyncDeps = {
		pi: pi as unknown as PiLike,
		label: "zenfree",
		notify,
		notifyOnChange: zenConfig.sync.notifyOnChange,
		isCurrentModel: (id) => {
			try {
				return getModel?.()?.id === id;
			} catch {
				return false;
			}
		},
		registered: zenRegistered,
	};

	/**
	 * Full zen sync: lineup first (it carries the authoritative gateway url),
	 * then the contract — so a first registration uses the live config
	 * baseURL, not the baked-in fallback — then caps, then registration.
	 */
	const zenSync = async (force = false): Promise<void> => {
		const lineup = await zenSource.fetchLineup(zenConfig.auth);
		zenCurrentContract = await zenSource.refreshContract(force);
		const ids = lineup.map((entry) => entry.id);
		const feeds = await zenSource.refreshCapabilities(ids, force);
		void feeds;
		const warnings = [...zenSource.warnings];
		for (const warning of warnings) notify(warning);
		zenSource.warnings.length = 0;
		const targets = buildZenTargets({
			lineup,
			resolve: (id) => zenSource.resolveCapabilities(id),
			resolveTransport: (id) => zenSource.resolveTransport(id),
			contract: zenCurrentContract,
			streamSimple: zenStream as never,
			registerProvider: (id, config) => (pi as unknown as PiLike).registerProvider(id, config),
		});
		const result = syncProviders(zenEngine, targets);
		recordZenSyncResult(result.added, result.removed, warnings);
	};

	// Cached fast-path: register from the zenfree cache before any network.
	if (zenConfig.auth) {
		const cachedZenLineup = zenfreeState.readCache<{ models: Record<string, { name?: string }> }>("lineup.json");
		if (cachedZenLineup && Object.keys(cachedZenLineup.models).length > 0) {
			try {
				const entries = Object.keys(cachedZenLineup.models).sort().map((id) => ({ id, name: cachedZenLineup.models[id]?.name }));
				const targets = buildZenTargets({
					lineup: entries,
					resolve: (id) => zenSource.resolveCapabilities(id),
					resolveTransport: (id) => zenSource.resolveTransport(id),
					contract: zenCurrentContract,
					streamSimple: zenStream as never,
					registerProvider: (id, config) => (pi as unknown as PiLike).registerProvider(id, config),
				});
				for (const target of targets) target.register(target.models);
				zenRegistered.providerIds = targets.map((t) => t.providerId);
				zenRegistered.modelIds = entries.map((e) => e.id);
			} catch (error) {
				console.error(`[zenfree] cached registration failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	let lastZenLineup: { id: string; name?: string }[] =
		Object.entries(zenfreeState.readCache<{ models: Record<string, { name?: string }> }>("lineup.json")?.models ?? {})
			.map(([id, m]) => ({ id, name: m?.name }))
			.sort((a, b) => a.id.localeCompare(b.id));
	const originalZenFetchLineup = zenSource.fetchLineup.bind(zenSource);
	zenSource.fetchLineup = async (credential) => {
		const entries = await originalZenFetchLineup(credential);
		lastZenLineup = entries;
		return entries;
	};

	registerZenfreeCommand(pi, {
		refresh: () => zenSync(true),
		snapshot: () => {
			const status = zenSource.status();
			const lineupIds = lastZenLineup.map((e) => e.id);
			return {
				contractSource: status.contractSource,
				timestamps: status.timestamps,
				cliVersion: zenCurrentContract.versions?.cli,
				baseUrl: zenCurrentContract.baseUrl,
				authMode: zenConfig.auth?.mode as "apiKey" | undefined,
				apiKeyMasked: zenConfig.auth?.apiKey ? maskKey(zenConfig.auth.apiKey) : undefined,
				minIntervalMinutes: zenConfig.sync.minIntervalMinutes,
				capabilitiesCoveredCount: (zenfreeState.readCache<{ coveredIds: string[] }>("capabilities.json")?.coveredIds ?? []).filter((id) => lineupIds.includes(id)).length,
				capabilitiesLineupCount: lineupIds.length,
				freeCount: lineupIds.length,
			};
		},
		modelRows: () =>
			lastZenLineup.map((entry) => {
				const caps = zenSource.resolveCapabilities(entry.id);
				return { id: entry.id, name: toProviderModel(entry.id, caps, entry.name).name, contextWindow: caps.contextWindow, maxTokens: caps.maxTokens, source: caps.source };
			}),
		history: () => zenfreeState.readCache<{ lastResult?: { added: string[]; removed: string[]; warnings: string[] } }>("state.json")?.lastResult,
		setApiKey: async (key: string) => {
			const verdict = await validateZenKey(key);
			if (verdict !== "ok") {
				return { ok: false, detail: verdict === "rejected" ? "rejected by opencode.ai (401/403)" : "network error — try again" };
			}
			zenConfig.auth = { mode: "apiKey", apiKey: key };
			zenfreeState.saveConfig(zenConfig);
			void zenSync(true);
			return { ok: true, detail: "workspace key accepted" };
		},
		clearCredential: () => {
			zenConfig.auth = undefined;
			zenfreeState.saveConfig(zenConfig);
		},
		notify,
	});

	registerClinefreeCommand(pi, {
		refresh: () => fullSync(true),
		snapshot: () => {
			const status = source.status();
			return {
				tags: status.tags,
				timestamps: status.timestamps,
				contractSource: currentContract.source,
				authMode: config.auth?.mode,
				apiKeyMasked: config.auth?.apiKey ? maskKey(config.auth.apiKey) : undefined,
				accountEmail: config.auth?.account?.email,
				minIntervalMinutes: config.sync.minIntervalMinutes,
				capabilitiesCoveredCount: status.capabilitiesCoveredIds.length,
				capabilitiesLineupCount: lastLineup.length,
			};
		},
		modelRows: () =>
			lastLineup.map((entry) => {
				const caps = source.resolveCapabilities(entry.id);
				return { id: entry.id, name: toProviderModel(entry.id, caps, entry.name).name, contextWindow: caps.contextWindow, maxTokens: caps.maxTokens, source: caps.source };
			}),
		history: () => readCache<{ lastResult?: { added: string[]; removed: string[]; warnings: string[] } }>("state.json")?.lastResult,
		setApiKey: async (key: string) => {
			const cred: Credential = { mode: "apiKey", apiKey: key };
			const result = await validateCredential(cred, currentContract.headers);
			if (!result.ok) return { ok: false, detail: `HTTP ${result.status}` };
			config.auth = { ...cred, account: result.account };
			saveConfig(config);
			void fullSync();
			return { ok: true, detail: result.account.email ?? "accepted" };
		},
		deviceFlow: async (onStatus: (message: string) => void) => {
			try {
				const cred = await runDeviceFlow(currentContract.headers, { onStatus });
				const result = await validateCredential(cred, currentContract.headers);
				if (!result.ok) return { ok: false, detail: `rejected after sign-in (HTTP ${result.status})` };
				config.auth = { ...cred, account: result.account };
				saveConfig(config);
				void fullSync();
				return { ok: true, detail: result.account.email ?? "signed in" };
			} catch (error) {
				return { ok: false, detail: error instanceof Error ? error.message : String(error) };
			}
		},
		clearCredential: () => {
			config.auth = undefined;
			saveConfig(config);
		},
		notify,
	});
}
