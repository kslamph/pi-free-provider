/**
 * Capability resolution for a free-model id (spec §6):
 *
 *   models.dev/openrouter  exact id → slug
 *   live Vercel gateway    exact id → slug
 *   else                   fixed defaults (256K ctx / 32K out / text-only)
 *
 * OpenRouter-first is deliberate: it preserves the live-verified numbers
 * (deepseek out = 384000, not Vercel's 32768) and matches Cline's runtime
 * catalog path. The Vercel fallback is what resolves Vercel-only stealth ids
 * such as stealth/pixel-canary.
 */

import type { FeedEntry } from "./feeds.ts";

export interface ModelCapabilities {
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	reasoning: boolean;
	effortValues?: string[];
	toggle: boolean;
	name?: string;
	source: "openrouter" | "vercel" | "opencode" | "modelsdev" | "default";
}

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
	contextWindow: 256_000,
	maxTokens: 32_000,
	input: ["text"],
	reasoning: false,
	toggle: false,
	source: "default",
};

/** pi supports text and image inputs; everything else is dropped. */
const PI_INPUT = new Set(["text", "image"]);

function fromEntry(entry: FeedEntry, source: "openrouter" | "vercel"): ModelCapabilities {
	const input = (entry.inputModalities ?? ["text"]).filter((m): m is "text" | "image" => PI_INPUT.has(m));
	return {
		contextWindow: entry.contextWindow ?? DEFAULT_CAPABILITIES.contextWindow,
		maxTokens: entry.maxTokens ?? DEFAULT_CAPABILITIES.maxTokens,
		input: input.length > 0 ? input : ["text"],
		reasoning: entry.toggle === true || (entry.effortValues?.length ?? 0) > 0,
		...(entry.effortValues !== undefined ? { effortValues: entry.effortValues } : {}),
		toggle: entry.toggle === true,
		...(entry.name !== undefined ? { name: entry.name } : {}),
		source,
	};
}

/** First matching entry by exact id, then by slug (last path segment). */
function lookup(id: string, feed: Record<string, FeedEntry>): FeedEntry | undefined {
	const exact = feed[id];
	if (exact) return exact;
	const slug = id.split("/").at(-1) ?? id;
	if (slug === id) return undefined;
	for (const entry of Object.values(feed)) {
		if ((entry.id.split("/").at(-1) ?? entry.id) === slug) return entry;
	}
	return undefined;
}

export function resolveCapabilities(
	id: string,
	openrouter: Record<string, FeedEntry>,
	vercel: Record<string, FeedEntry>,
): ModelCapabilities {
	const or = lookup(id, openrouter);
	if (or) return fromEntry(or, "openrouter");
	const vc = lookup(id, vercel);
	if (vc) return fromEntry(vc, "vercel");
	return DEFAULT_CAPABILITIES;
}
