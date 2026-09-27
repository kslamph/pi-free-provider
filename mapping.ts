/**
 * Map a resolved ModelCapabilities to a pi provider model entry.
 *
 * The thinkingLevelMap always writes every pi level (null = hidden in the UI):
 * pi treats an omitted level as *supported* and forwards its name verbatim,
 * so unsupported levels must be explicitly null (same convention as
 * pi-multikey's levels() helper).
 *
 * Rules (spec §6):
 *  - `off` maps to "none" when the feed reports a toggle or advertises "none"
 *    as an effort value.
 *  - Every advertised effort value maps 1:1 to the same-named pi level.
 *  - A toggle-only model exposes off + high.
 *  - compat.thinkingFormat is "openrouter" iff effort values exist and the
 *    caller did not override the wire format (zen uses flat reasoning_effort).
 *  - compat.maxTokensField is present only when the caller overrides it (zen
 *    pins `max_tokens`, the field the official OpenCode client serializes).
 */

import type { ModelCapabilities } from "./capabilities.ts";

export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Level = (typeof LEVELS)[number];

export const CLINE_BASE_URL = "https://api.cline.bot/api/v1";

export interface ProviderModel {
	id: string;
	name: string;
	api: "openai-completions" | "openai-responses";
	baseUrl: string;
	reasoning: boolean;
	thinkingLevelMap: Record<string, string | null>;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	contextWindow: number;
	maxTokens: number;
	compat?: Record<string, unknown>;
}

/** Build the full thinkingLevelMap (every level present, null = unsupported). */
export function buildThinkingLevelMap(caps: ModelCapabilities): Record<string, string | null> {
	const advertised = new Set(caps.effortValues ?? []);
	// Reasoning with no advertised control (no effort list, no toggle): leave the map
	// empty so pi offers its generic levels and forwards them verbatim. This matches
	// pi's built-in catalog (e.g. opencode big-pickle) and avoids inventing a disable
	// value the gateway may reject.
	if (caps.reasoning && !caps.toggle && advertised.size === 0) return {};
	const supportsOff = caps.toggle || advertised.has("none");
	const map: Record<string, string | null> = {};
	for (const level of LEVELS) {
		if (level === "off") {
			map.off = supportsOff ? "none" : null;
			continue;
		}
		if (advertised.has(level)) {
			map[level] = level;
			continue;
		}
		// Toggle-only model: reasoning on/off with no finer control.
		map[level] = !caps.effortValues && caps.toggle && level === "high" ? "high" : null;
	}
	return map;
}

/** Capability source → display name rule: catalog name, else feed name + " (free)", else id. */
export function displayName(id: string, caps: ModelCapabilities, feedName: string | undefined): string {
	if (caps.name && caps.name.trim().length > 0) return caps.name.trim();
	if (feedName && feedName.trim().length > 0) return `${feedName.trim()} (free)`;
	return id;
}

export function toProviderModel(
	id: string,
	caps: ModelCapabilities,
	feedName?: string,
	over?: {
		api?: ProviderModel["api"];
		baseUrl?: string;
		/** Reasoning wire format. Default "openrouter" (Cline's nested
		 *  `reasoning.effort`); zen's gateway takes the flat OpenAI
		 *  `reasoning_effort`, so it passes "openai" (no compat flag). */
		thinkingFormat?: "openrouter" | "openai";
		/** Output-cap field name. pi-ai defaults to `max_completion_tokens`;
		 *  zen passes "max_tokens" to match the official OpenCode client
		 *  (`@ai-sdk/openai-compatible` only ever serializes `max_tokens`). */
		maxTokensField?: "max_tokens" | "max_completion_tokens";
	},
): ProviderModel {
	const thinkingFormat = over?.thinkingFormat ?? "openrouter";
	const compat: Record<string, unknown> = {};
	if (thinkingFormat === "openrouter" && (caps.effortValues?.length ?? 0) > 0) compat.thinkingFormat = "openrouter";
	if (over?.maxTokensField) compat.maxTokensField = over.maxTokensField;
	return {
		id,
		name: displayName(id, caps, feedName),
		api: over?.api ?? "openai-completions",
		baseUrl: over?.baseUrl ?? CLINE_BASE_URL,
		reasoning: caps.reasoning,
		thinkingLevelMap: buildThinkingLevelMap(caps),
		input: caps.input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: caps.contextWindow,
		maxTokens: caps.maxTokens,
		...((Object.keys(compat).length > 0) ? { compat } : {}),
	};
}
