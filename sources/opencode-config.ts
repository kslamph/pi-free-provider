/**
 * OpenCode console `/api/v2/config` parsing + zen lineup composition + zen
 * capability merge (spec §zen-2/§zen-4, amended 2026-10-21).
 *
 * The console response changed on ~2026-10: it now carries only workspace
 * overrides (`models: { [id]: { disabled?: true, package? } }`, headers,
 * no cost/baseURL), while the full catalog with pricing moved to models.dev's
 * `opencode` block (`cost.input == 0` ⇒ free). The free lineup is therefore
 * COMPOSED (composeZenLineup): models.dev zero-cost models, minus disabled
 * ids, plus any config-only entry that still declares free the legacy way
 * (cost array, every tier `input == 0`) — so an old full-catalog payload keeps
 * working unchanged.
 *
 * Parsing is lenient by design: an unknown shape degrades to empty models,
 * never a crash (spec §zen-9).
 */

import type { FeedEntry } from "../feeds.ts";
import { fetchWithTimeout } from "../network.ts";

export const CONSOLE_CONFIG_URL = "https://opencode.ai/console/api/v2/config";

/**
 * The catalog status value that marks a model as retired. models.dev (and
 * opencode's own catalog mirror models.opencode.ai) is the only static source
 * that carries such a verdict — zen's gateway has no deprecation field
 * anywhere (`/zen/v1/models`, `/inference/v1/models` and the console config
 * all list plain ids). opencode's own client hides exactly these models
 * (`packages/core/src/plugin/models-dev.ts`: `model.status !== "deprecated"`),
 * and a live probe of the 45-model free lineup confirmed the flag tracks
 * zen's 410 `ModelDeprecated` closely (35/45 flagged, 33 of them confirmed
 * dead, 2 false positives). It is a filter, not a verdict: it carries no
 * replacement pointer, which only zen's 410 body provides.
 */
export const DEPRECATED_STATUS = "deprecated";

export interface ZenModelEntry {
	/** Gateway base URL for this provider/model. */
	baseUrl?: string;
	name?: string;
	free: boolean;
	limit?: { context?: number; output?: number };
	input?: ("text" | "image")[];
	/** Upstream SDK package. `aisdk:@ai-sdk/openai` ⇒ the model speaks the OpenAI
	 * Responses API (muse-spark); anything else rides chat completions. */
	package?: string;
	/** Workspace override: the entry is turned off for this workspace. */
	disabled?: boolean;
	/** The entry carried a `cost` array — an explicit paid/free verdict that
	 *  outranks models.dev pricing (absent in the 2026-10 overlay-only shape). */
	costed?: boolean;
}

export interface ZenConsoleConfig {
	baseUrl?: string;
	/** Extra headers the console prescribes for gateway requests (e.g. x-opencode-org-id). */
	headers?: Record<string, string>;
	models: Record<string, ZenModelEntry>;
}

/** Zen defaults (spec §zen-4): every current free model reasons. A model with no
 *  advertised reasoning option gets no thinkingLevelMap — pi offers its generic
 *  levels and forwards them verbatim (pi built-in catalog parity). */
export const ZEN_DEFAULTS = {
	contextWindow: 200_000,
	maxTokens: 32_000,
	input: ["text"] as ("text" | "image")[],
	reasoning: true,
	toggle: false,
} as const;

const PI_INPUT = new Set(["text", "image"]);

function piInput(list: unknown): ("text" | "image")[] | undefined {
	if (!Array.isArray(list)) return undefined;
	const filtered = list.filter((m): m is "text" | "image" => typeof m === "string" && PI_INPUT.has(m));
	return filtered.length > 0 ? filtered : undefined;
}

interface RawCostTier {
	input?: unknown;
}

function isFree(cost: unknown): boolean {
	if (!Array.isArray(cost)) return false;
	const tiers = cost.filter((t): t is RawCostTier => !!t && typeof t === "object");
	if (tiers.length === 0) return false;
	return tiers.every((tier) => typeof tier.input === "number" && tier.input === 0);
}

function toModelEntry(raw: unknown): ZenModelEntry | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const model = raw as Record<string, unknown>;
	const limitRaw = (model.limit ?? {}) as Record<string, unknown>;
	const limit = {
		...(typeof limitRaw.context === "number" ? { context: limitRaw.context } : {}),
		...(typeof limitRaw.output === "number" ? { output: limitRaw.output } : {}),
	};
	const inputRaw = (model.capabilities as Record<string, unknown> | undefined)?.input;
	const input = Array.isArray(inputRaw)
		? inputRaw.filter((m): m is "text" | "image" => typeof m === "string" && PI_INPUT.has(m))
		: undefined;
	return {
		free: isFree(model.cost),
		...(Array.isArray(model.cost) ? { costed: true } : {}),
		...(typeof model.disabled === "boolean" ? { disabled: model.disabled } : {}),
		...(typeof model.name === "string" ? { name: model.name } : {}),
		...(Object.keys(limit).length > 0 ? { limit } : {}),
		...(input && input.length > 0 ? { input } : {}),
		...(typeof model.package === "string" ? { package: model.package } : {}),
	};
}

/** Lenient reducer for the console config payload. */
export function parseConsoleConfig(payload: unknown, providerId = "opencode"): ZenConsoleConfig {
	if (!payload || typeof payload !== "object") return { models: {} };
	const providers = (payload as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object") return { models: {} };
	const selected = (providers as Record<string, unknown>)[providerId] ?? (providers as Record<string, unknown>).opencode;
	if (!selected || typeof selected !== "object") return { models: {} };
	const provider = selected as Record<string, unknown>;
	const models: Record<string, ZenModelEntry> = {};
	const rawModels = provider.models;
	if (rawModels && typeof rawModels === "object" && !Array.isArray(rawModels)) {
		for (const [id, raw] of Object.entries(rawModels as Record<string, unknown>)) {
			const entry = toModelEntry(raw);
			if (entry) models[id] = entry;
		}
	}
	const settings = (provider.settings ?? {}) as Record<string, unknown>;
	const baseUrl = typeof settings.baseURL === "string" ? settings.baseURL : undefined;
	const headers =
		provider.headers && typeof provider.headers === "object" && !Array.isArray(provider.headers)
			? Object.fromEntries(
					Object.entries(provider.headers as Record<string, unknown>).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: undefined;
	return { ...(baseUrl !== undefined ? { baseUrl } : {}), ...(headers !== undefined ? { headers } : {}), models };
}

/** True when the catalog marks the model as retired. */
export function isDeprecatedModel(entry: FeedEntry | undefined): boolean {
	return entry?.status === DEPRECATED_STATUS;
}

/**
 * Compose the free lineup from the two sources (2026-10-21 contract change):
 * models.dev `opencode` zero-cost models, minus ids the console config
 * disables, UNION config-only entries that still declare free the legacy
 * way. A console entry WITH a cost array is an explicit verdict that wins
 * over models.dev pricing; the overlay-only shape (no cost) never vetoes.
 * Dev `provider.npm` is mapped into the config package vocabulary
 * (`@ai-sdk/openai` → `aisdk:@ai-sdk/openai` ⇒ responses transport).
 *
 * Models the catalog flags `status: "deprecated"` are dropped from both
 * paths: zen's gateway answers them with 410 `ModelDeprecated` (dead, and
 * the 410 body — not the catalog — is the only place a replacement is
 * named). A deprecated flag also vetoes a stale legacy console entry that
 * still declares the model free; models the catalog does not know (no
 * verdict) are kept.
 */
export interface ComposedZenLineup {
	baseUrl?: string;
	headers?: Record<string, string>;
	/** Free models only, keyed by id. */
	models: Record<string, ZenModelEntry>;
}

export function composeZenLineup(
	config: ZenConsoleConfig | undefined,
	dev: Record<string, FeedEntry>,
): ComposedZenLineup {
	const models: Record<string, ZenModelEntry> = {};
	for (const [id, entry] of Object.entries(dev)) {
		const overlay = config?.models[id];
		if (overlay?.disabled) continue;
		if (isDeprecatedModel(entry)) continue;
		const free = overlay?.costed ? overlay.free : entry.costInput === 0;
		if (!free) continue;
		const context = overlay?.limit?.context ?? entry.contextWindow;
		const output = overlay?.limit?.output ?? entry.maxTokens;
		const input = overlay?.input ?? piInput(entry.inputModalities);
		const pkg = overlay?.package ?? (entry.package !== undefined ? `aisdk:${entry.package}` : undefined);
		models[id] = {
			free: true,
			...((overlay?.name ?? entry.name) !== undefined ? { name: overlay?.name ?? entry.name } : {}),
			...(context !== undefined || output !== undefined
				? { limit: { ...(context !== undefined ? { context } : {}), ...(output !== undefined ? { output } : {}) } }
				: {}),
			...(input !== undefined && input.length > 0 ? { input } : {}),
			...(pkg !== undefined ? { package: pkg } : {}),
		};
	}
	for (const [id, entry] of Object.entries(config?.models ?? {})) {
		if (models[id] || !entry.free || entry.disabled) continue;
		if (isDeprecatedModel(dev[id])) continue;
		models[id] = entry;
	}
	return {
		...(config?.baseUrl !== undefined ? { baseUrl: config.baseUrl } : {}),
		...(config?.headers !== undefined ? { headers: config.headers } : {}),
		models,
	};
}

/**
 * Fetch the console config with the workspace key. Throws `HTTP 401` on 401
 * (auth validation needs to distinguish it); undefined on other failures.
 */
export async function fetchConsoleConfig(
	apiKey: string,
	fetcher: typeof fetch = fetch,
	providerId = "opencode",
	signal?: AbortSignal,
): Promise<ZenConsoleConfig | undefined> {
	try {
		const response = await fetchWithTimeout(fetcher, CONSOLE_CONFIG_URL, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		}, signal);
		if (response.status === 401 || response.status === 403) throw new Error(`HTTP ${response.status}`);
		if (!response.ok) return undefined;
		return parseConsoleConfig(await response.json(), providerId);
	} catch (error) {
		if (error instanceof Error && /^HTTP 40[13]$/.test(error.message)) throw error;
		return undefined;
	}
}

export interface ZenCapabilities {
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	reasoning: boolean;
	/** Reasoner effort values advertised by models.dev, when any. */
	effortValues?: string[];
	toggle: boolean;
	name?: string;
	/** Where the limits came from: opencode's console config, models.dev, or built-in defaults. */
	source: "opencode" | "modelsdev" | "default";
}

/**
 * Capability precedence (spec §zen-4): console config entry → models.dev
 * `opencode` entry → zen defaults. Whichever source contributes wins per
 * field; `source` names the highest contributor.
 */
export function mergeZenCapabilities(config: ZenModelEntry | undefined, dev: FeedEntry | undefined): ZenCapabilities {
	const source: ZenCapabilities["source"] =
		config?.limit?.context !== undefined ? "opencode" : dev?.contextWindow !== undefined ? "modelsdev" : "default";
	// Reasoning options come from models.dev (the console config never carries them).
	// No advertised options ⇒ no toggle/effort list, so pi exposes its generic levels.
	const effortValues = (dev?.effortValues?.length ?? 0) > 0 ? dev?.effortValues : undefined;
	const toggle = dev?.toggle === true;
	const merged: ZenCapabilities = {
		contextWindow: config?.limit?.context ?? dev?.contextWindow ?? ZEN_DEFAULTS.contextWindow,
		maxTokens: config?.limit?.output ?? dev?.maxTokens ?? ZEN_DEFAULTS.maxTokens,
		input: piInput(config?.input) ?? piInput(dev?.inputModalities) ?? ZEN_DEFAULTS.input,
		reasoning: ZEN_DEFAULTS.reasoning,
		toggle,
		...(effortValues !== undefined ? { effortValues } : {}),
		...( (config?.name ?? dev?.name) !== undefined ? { name: config?.name ?? dev?.name } : {}),
		source,
	};
	if (merged.input.length === 0) merged.input = ["text"];
	return merged;
}
