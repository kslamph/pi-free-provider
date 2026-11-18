import type { FeedEntry } from "../feeds.ts";

export interface ZenModelEntry {
	name?: string;
	limit?: { context?: number; output?: number };
	input?: ("text" | "image")[];
	package?: string;
}

export interface ZenCapabilities {
	contextWindow: number;
	maxTokens: number;
	input: ("text" | "image")[];
	reasoning: boolean;
	effortValues?: string[];
	toggle: boolean;
	name?: string;
	source: "modelsdev" | "default";
}

function modelInput(list: string[] | undefined): ("text" | "image")[] | undefined {
	const input = list?.filter((item): item is "text" | "image" => item === "text" || item === "image");
	return input?.length ? input : undefined;
}

export function selectZenModels(catalog: Record<string, FeedEntry>): Record<string, ZenModelEntry> {
	return Object.fromEntries(Object.entries(catalog)
		.filter(([, entry]) => entry.costInput === 0 && entry.status !== "deprecated")
		.map(([id, entry]) => [id, {
			name: entry.name,
			limit: { context: entry.contextWindow, output: entry.maxTokens },
			input: modelInput(entry.inputModalities),
			package: entry.package,
		}]));
}

export function resolveZenCapabilities(model: ZenModelEntry | undefined, feed: FeedEntry | undefined): ZenCapabilities {
	const context = model?.limit?.context ?? feed?.contextWindow;
	return {
		contextWindow: context ?? 200_000,
		maxTokens: model?.limit?.output ?? feed?.maxTokens ?? 32_000,
		input: model?.input ?? modelInput(feed?.inputModalities) ?? ["text"],
		reasoning: true,
		effortValues: feed?.effortValues?.length ? feed.effortValues : undefined,
		toggle: feed?.toggle === true,
		name: model?.name ?? feed?.name,
		source: context === undefined ? "default" : "modelsdev",
	};
}
