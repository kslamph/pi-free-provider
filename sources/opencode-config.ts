/**
 * OpenCode console `/api/v2/config` parsing + zen capability merge
 * (spec §zen-2/§zen-4).
 *
 * The config response is the authoritative lineup AND capability source:
 * `providers.opencode` carries `settings.baseURL`, optional `headers`
 * (e.g. `x-opencode-org-id`), and `models: { [id]: { name?, package?,
 * cost?, limit?{context,output}, capabilities?{input[]} } }`. Free means
 * every cost tier has `input == 0` — opencode's own rule (a model with no
 * `cost` field is never free).
 *
 * Parsing is lenient by design: an unknown shape degrades to empty models,
 * never a crash (spec §zen-9).
 */

import type { FeedEntry } from "../feeds.ts";

export const CONSOLE_CONFIG_URL = "https://opencode.ai/console/api/v2/config";

export interface ZenModelEntry {
	name?: string;
	free: boolean;
	limit?: { context?: number; output?: number };
	input?: ("text" | "image")[];
	/** Upstream SDK package. `aisdk:@ai-sdk/openai` ⇒ the model speaks the OpenAI
	 * Responses API (muse-spark); anything else rides chat completions. */
	package?: string;
}

export interface ZenConsoleConfig {
	baseUrl?: string;
	/** Extra headers the console prescribes for gateway requests (e.g. x-opencode-org-id). */
	headers?: Record<string, string>;
	models: Record<string, ZenModelEntry>;
}

/** Zen defaults (spec §zen-4): every current free model reasons, none exposes effort control. */
export const ZEN_DEFAULTS = {
	contextWindow: 200_000,
	maxTokens: 32_000,
	input: ["text"] as ("text" | "image")[],
	reasoning: true,
	/** Zen free models reason always-on with no effort toggle. */
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
		...(typeof model.name === "string" ? { name: model.name } : {}),
		...(Object.keys(limit).length > 0 ? { limit } : {}),
		...(input && input.length > 0 ? { input } : {}),
		...(typeof model.package === "string" ? { package: model.package } : {}),
	};
}

/** Lenient reducer for the console config payload. */
export function parseConsoleConfig(payload: unknown): ZenConsoleConfig {
	if (!payload || typeof payload !== "object") return { models: {} };
	const providers = (payload as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object") return { models: {} };
	const opencode = (providers as Record<string, unknown>).opencode;
	if (!opencode || typeof opencode !== "object") return { models: {} };
	const provider = opencode as Record<string, unknown>;
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

/**
 * Fetch the console config with the workspace key. Throws `HTTP 401` on 401
 * (auth validation needs to distinguish it); undefined on other failures.
 */
export async function fetchConsoleConfig(apiKey: string, fetcher: typeof fetch = fetch): Promise<ZenConsoleConfig | undefined> {
	try {
		const response = await fetcher(CONSOLE_CONFIG_URL, {
			headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
		});
		if (response.status === 401 || response.status === 403) throw new Error(`HTTP ${response.status}`);
		if (!response.ok) return undefined;
		return parseConsoleConfig(await response.json());
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
	const merged: ZenCapabilities = {
		contextWindow: config?.limit?.context ?? dev?.contextWindow ?? ZEN_DEFAULTS.contextWindow,
		maxTokens: config?.limit?.output ?? dev?.maxTokens ?? ZEN_DEFAULTS.maxTokens,
		input: piInput(config?.input) ?? piInput(dev?.inputModalities) ?? ZEN_DEFAULTS.input,
		reasoning: ZEN_DEFAULTS.reasoning,
		toggle: false,
		...( (config?.name ?? dev?.name) !== undefined ? { name: config?.name ?? dev?.name } : {}),
		source,
	};
	if (merged.input.length === 0) merged.input = ["text"];
	return merged;
}
