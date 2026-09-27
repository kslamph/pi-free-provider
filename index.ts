/**
 * pi-oc-cline — Cline's free models as one auto-synced pi provider (`clinefree`).
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
import { DEFAULT_CONFIG, loadConfig, readCache, saveConfig, writeCache, type ClinefreeConfig, type Credential } from "./state.ts";
import { toProviderModel, type ProviderModel } from "./mapping.ts";
import { type MultiSyncDeps, type RegisteredState, diffModels, syncProviders } from "./registry.ts";
import { createClinefreeStream, resetConversation } from "./stream.ts";
import { createClineSource, type ClineSource } from "./sources/cline.ts";
import type { LineupEntry } from "./sources/types.ts";
import { maskKey, registerClinefreeCommand } from "./tui.ts";

export const PROVIDER_ID = "clinefree";
export const PROVIDER_NAME = "Cline Free";

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
		toProviderModel(entry.id, deps.source.resolveCapabilities(entry.id), entry.name),
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

/** Record the sync result into the cache's state.json (history for /clinefree). */
function recordSyncResult(added: string[], removed: string[], warnings: string[]): void {
	try {
		const state = readCache<{ version: 1; lastResult?: { added: string[]; removed: string[]; warnings: string[] }; timestamps?: Record<string, number>; tags?: Record<string, string>; shas?: Record<string, string> }>("state.json") ?? { version: 1, tags: {}, shas: {}, timestamps: {} };
		writeCache("state.json", { ...state, lastResult: { added, removed, warnings } });
	} catch {
		// history is best-effort
	}
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
		recordSyncResult(result.added, result.removed, result.warnings);
	};

	// Register from cached state up front so models exist during startup (no network).
	if (config.auth) {
		const cachedLineup = readCache<LineupEntry[]>("lineup.json");
		if (cachedLineup && cachedLineup.length > 0) {
			try {
				const models = cachedLineup.map((entry) => toProviderModel(entry.id, source.resolveCapabilities(entry.id), entry.name));
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
		resetConversation(event.reason);
		if (!config.auth) {
			notify("clinefree: no credential — run /clinefree to sign in with a Cline account or API key");
			return;
		}
		try {
			await fullSync();
		} catch (error) {
			notify(`clinefree: sync error (${error instanceof Error ? error.message : String(error)}) — models unchanged`);
		}
	});

	// /clinefree command (status · models · auth · refresh · history).
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
