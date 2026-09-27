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
import { BAKED_IN_CONTRACT, type ContractResult } from "./contract.ts";
import { DEFAULT_CONFIG, loadConfig, readCache, saveConfig, writeCache, type ClinefreeConfig, type Credential } from "./state.ts";
import { toProviderModel, type ProviderModel } from "./mapping.ts";
import { diffModels } from "./registry.ts";
import { createClinefreeStream, resetConversation } from "./stream.ts";
import { createClineSource, type ClineSource } from "./sources/cline.ts";
import type { LineupEntry } from "./sources/types.ts";

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
	source: ClineSource | (Pick<ClineSource, "fetchLineup" | "resolveCapabilities"> & { warnings: string[] });
	getContract(): ContractResult;
	streamSimple: (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	notify(message: string): void;
	config: ClinefreeConfig;
	/** Mutated in place — the caller's record of what is registered. */
	registeredIds: string[];
	/** True when `id` is pi's currently selected model. */
	isCurrentModel(id: string): boolean;
}

/**
 * One sync pass: lineup → capabilities → map → diff → re-register.
 * Never throws: a failing source keeps the previous registration.
 */
export async function syncOnce(deps: SyncDeps): Promise<{ added: string[]; removed: string[] }> {
	if (!deps.config.auth) return { added: [], removed: [] };

	let lineup: LineupEntry[];
	try {
		lineup = await deps.source.fetchLineup();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		deps.notify(`clinefree: sync failed (${reason}) — keeping previous models`);
		return { added: [], removed: [] };
	}

	// Surface collected warnings once per sync, then clear them.
	for (const warning of [...deps.source.warnings]) deps.notify(warning);
	deps.source.warnings.length = 0;

	const desired = lineup.map((entry) => entry.id);
	const { added, removed } = diffModels(deps.registeredIds, desired);

	if (desired.length === 0) {
		if (deps.registeredIds.length > 0) {
			try {
				deps.pi.unregisterProvider(PROVIDER_ID);
			} catch {
				// already gone
			}
			deps.registeredIds.length = 0;
			deps.notify("clinefree: free lineup is empty — provider unregistered");
		}
		return { added, removed };
	}

	const models: ProviderModel[] = lineup.map((entry) =>
		toProviderModel(entry.id, deps.source.resolveCapabilities(entry.id), entry.name),
	);
	const contract = deps.getContract();
	deps.pi.registerProvider(PROVIDER_ID, {
		name: PROVIDER_NAME,
		baseUrl: "https://api.cline.bot/api/v1",
		// Real credential injected per-request by the custom streamSimple.
		apiKey: "clinefree-managed",
		api: "openai-completions",
		headers: contract.headers,
		models,
		streamSimple: deps.streamSimple,
	});
	deps.registeredIds.splice(0, deps.registeredIds.length, ...desired);

	if (added.length > 0 || removed.length > 0) {
		if (deps.config.sync.notifyOnChange) {
			const parts: string[] = [];
			if (added.length > 0) parts.push(`+${added.length} new: ${added.join(", ")}`);
			if (removed.length > 0) parts.push(`−${removed.length} delisted: ${removed.join(", ")}`);
			deps.notify(`clinefree: ${parts.join(" · ")}`);
		}
		const delistedActive = removed.find((id) => deps.isCurrentModel(id));
		if (delistedActive) {
			deps.notify(`clinefree: active model ${delistedActive} was delisted — switch models (e.g. /model clinefree/${added[0] ?? desired[0]}) to keep working`);
		}
	}

	return { added, removed };
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
		capabilityTtlMs: config.sync.capabilityTtlMinutes * 60_000,
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

	/** Full sync: contract (TTL-gated) → capabilities (TTL-gated) → lineup+register. */
	const fullSync = async (): Promise<void> => {
		currentContract = await source.refreshContract();
		await source.refreshCapabilities();
		const before = [...source.warnings];
		const result = await syncOnce(deps);
		recordSyncResult(result.added, result.removed, before);
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

	// Refresh entrypoint + shared handles for the /clinefree command (Task 11).
	runtime.refresh = fullSync;
	runtime.deps = deps;
	runtime.notify = notify;
	runtime.getConfig = () => config;
}

/** Handles the factory fills in for the /clinefree command. */
export const runtime: {
	refresh?: () => Promise<void>;
	deps?: SyncDeps;
	notify?: (message: string) => void;
	getConfig?: () => ClinefreeConfig;
} = {};
