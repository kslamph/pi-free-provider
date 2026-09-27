/**
 * Live capability feeds, reduced to the shape clinefree consumes.
 *
 * Two sources (spec §6):
 *  1. models.dev api.json → the `openrouter` provider block (the canonical
 *     source Cline's runtime uses, with structured reasoning_options).
 *  2. the Vercel AI Gateway listing (`ai-gateway.vercel.sh/v1/models`) — the
 *     only place Vercel-only stealth ids (e.g. stealth/pixel-canary) exist.
 *
 * Reducers never throw on malformed payloads — a broken feed degrades to an
 * empty block and the capability resolver falls through to the next source.
 */

export interface FeedEntry {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	inputModalities?: string[];
	/** Advertised reasoning effort values (Cline/pi vocabulary). */
	effortValues?: string[];
	/** True when the feed reports a reasoning toggle for this model. */
	toggle?: boolean;
}

export const MODELS_DEV_URL = "https://models.dev/api.json";
export const VERCEL_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

interface RawReasoningOption {
	type?: string;
	values?: unknown;
}

function reasoningFrom(options: unknown): { effortValues?: string[]; toggle?: boolean } {
	if (!Array.isArray(options)) return {};
	let effortValues: string[] | undefined;
	let toggle: boolean | undefined;
	for (const option of options as RawReasoningOption[]) {
		if (option?.type === "toggle") toggle = true;
		else if (option?.type === "effort" && Array.isArray(option.values)) {
			effortValues = option.values.filter((v): v is string => typeof v === "string");
		}
	}
	return { effortValues, toggle };
}

function toFeedEntry(model: Record<string, unknown>): FeedEntry | undefined {
	const id = model.id;
	if (typeof id !== "string" || id.length === 0) return undefined;
	const limit = (model.limit ?? {}) as Record<string, unknown>;
	const modalities = (model.modalities ?? model.modalities ?? {}) as Record<string, unknown>;
	const contextWindow = typeof limit.context === "number" ? limit.context : undefined;
	const maxTokens = typeof limit.output === "number" ? limit.output : undefined;
	const inputModalities = Array.isArray(modalities.input)
		? modalities.input.filter((m): m is string => typeof m === "string")
		: undefined;
	const { effortValues, toggle } = reasoningFrom(model.reasoning_options);
	const name = typeof model.name === "string" ? model.name : undefined;
	return {
		id,
		...(name !== undefined ? { name } : {}),
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(inputModalities !== undefined && inputModalities.length > 0 ? { inputModalities } : {}),
		...(effortValues !== undefined ? { effortValues } : {}),
		...(toggle !== undefined ? { toggle } : {}),
	};
}

/** Reduce a models.dev api.json payload to its openrouter block. */
export function reduceModelsDev(payload: unknown): Record<string, FeedEntry> {
	if (!payload || typeof payload !== "object") return {};
	const providers = (payload as Record<string, unknown>).providers;
	if (!providers || typeof providers !== "object") return {};
	const openrouter = (providers as Record<string, unknown>).openrouter;
	if (!openrouter || typeof openrouter !== "object") return {};
	const models = (openrouter as Record<string, unknown>).models ?? openrouter;
	if (!models || typeof models !== "object" || Array.isArray(models)) return {};
	const out: Record<string, FeedEntry> = {};
	for (const model of Object.values(models as Record<string, unknown>)) {
		if (!model || typeof model !== "object" || Array.isArray(model)) continue;
		const entry = toFeedEntry(model as Record<string, unknown>);
		if (entry) out[entry.id] = entry;
	}
	return out;
}

/** Reduce a Vercel AI Gateway /v1/models payload. */
export function reduceVercel(payload: unknown): Record<string, FeedEntry> {
	if (!payload || typeof payload !== "object") return {};
	const data = (payload as Record<string, unknown>).data;
	if (!Array.isArray(data)) return {};
	const out: Record<string, FeedEntry> = {};
	for (const model of data) {
		if (!model || typeof model !== "object") continue;
		const raw = model as Record<string, unknown>;
		const id = raw.id;
		if (typeof id !== "string" || id.length === 0) continue;
		const modalities = (raw.modalities ?? {}) as Record<string, unknown>;
		const contextWindow = typeof raw.context_window === "number" ? raw.context_window : undefined;
		const maxTokens = typeof raw.max_tokens === "number" ? raw.max_tokens : undefined;
		const inputModalities = Array.isArray(modalities.input)
			? modalities.input.filter((m): m is string => typeof m === "string")
			: undefined;
		const { effortValues, toggle } = reasoningFrom(raw.reasoning_options);
		const name = typeof raw.name === "string" ? raw.name : undefined;
		out[id] = {
			id,
			...(name !== undefined ? { name } : {}),
			...(contextWindow !== undefined ? { contextWindow } : {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
			...(inputModalities !== undefined && inputModalities.length > 0 ? { inputModalities } : {}),
			...(effortValues !== undefined ? { effortValues } : {}),
			...(toggle !== undefined ? { toggle } : {}),
		};
	}
	return out;
}

/** Fetch and reduce the models.dev openrouter block. Throws on !ok. */
export async function fetchModelsDevOpenRouter(fetcher: typeof fetch = fetch): Promise<Record<string, FeedEntry>> {
	const response = await fetcher(MODELS_DEV_URL);
	if (!response.ok) throw new Error(`models.dev fetch failed: HTTP ${response.status}`);
	return reduceModelsDev(await response.json());
}

/** Fetch and reduce the Vercel AI Gateway listing. Throws on !ok. */
export async function fetchVercelGateway(fetcher: typeof fetch = fetch): Promise<Record<string, FeedEntry>> {
	const response = await fetcher(VERCEL_MODELS_URL);
	if (!response.ok) throw new Error(`vercel gateway fetch failed: HTTP ${response.status}`);
	return reduceVercel(await response.json());
}
