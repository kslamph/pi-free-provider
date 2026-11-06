/**
 * The seam a future OpenCode source will implement (spec §4): one interface
 * behind the clinefree sync flow, so a second source is an implementation,
 * not a rewrite.
 */

import type { ContractResult } from "../contract.ts";
import type { ModelCapabilities } from "../capabilities.ts";
import type { FeedEntry } from "../feeds.ts";

export interface LineupEntry {
	id: string;
	name?: string;
	description?: string;
	tags?: string[];
}

export interface FreeModelSource {
	id: string;
	/** Resolve tags and (re)extract the request contract; `force` bypasses the min interval. */
	refreshContract(force?: boolean, signal?: AbortSignal): Promise<ContractResult>;
	/** Fetch the current free-model lineup (with cache fallback). */
	fetchLineup(signal?: AbortSignal): Promise<LineupEntry[]>;
	/**
	 * Pull and cache the capability feeds, gated by id coverage: skipped when
	 * every id in `ids` was already covered by a prior successful fetch, unless
	 * `force` (manual refresh) bypasses that check.
	 */
	refreshCapabilities(ids: string[], force?: boolean, signal?: AbortSignal): Promise<{ openrouter: Record<string, FeedEntry>; vercel: Record<string, FeedEntry> }>;
	/** Resolve one model id's capabilities using the current feeds. */
	resolveCapabilities(id: string): ModelCapabilities;
}
