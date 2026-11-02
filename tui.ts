/**
 * /clinefree — status, models, auth (press r in the status panel to refresh).
 *
 * Pure helpers (formatStatus/formatModels/maskKey/fmtTokens) are the tested
 * surface; the menu loop follows pi-multikey's better-custom-style panels
 * (ctx.ui.custom + @earendil-works/pi-tui keys).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

export interface StatusSnapshot {
	tags: Record<string, string>;
	timestamps: { tags?: number; lineup?: number; contract?: number };
	contractSource: "github" | "baked-in" | "none";
	authMode?: "apiKey" | "oauth";
	apiKeyMasked?: string;
	accountEmail?: string;
	minIntervalMinutes: number;
	/** Ids in the current lineup already covered by a capability fetch. */
	capabilitiesCoveredCount: number;
	/** Total ids in the current lineup. */
	capabilitiesLineupCount: number;
}

export interface ModelRow {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	source: "openrouter" | "vercel" | "opencode" | "modelsdev" | "default";
}

export interface TuiDeps {
	refresh(): Promise<void>;
	snapshot(): StatusSnapshot;
	modelRows(): ModelRow[];
	history(): { added: string[]; removed: string[]; warnings: string[] } | undefined;
	setApiKey(key: string): Promise<{ ok: boolean; detail: string }>;
	deviceFlow(onStatus: (message: string) => void): Promise<{ ok: boolean; detail: string }>;
	clearCredential(): void;
	notify(message: string): void;
}

export function maskKey(key: string): string {
	if (key.length <= 10) return "…";
	return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function fmtTokens(n: number): string {
	if (n >= 1_048_576 && n % 1_048_576 === 0) return `${n / 1_048_576}M`;
	return `${Math.round(n / 1024)}K`;
}

function minutesAgo(ts: number | undefined, now: number): string {
	if (ts === undefined) return "never";
	const delta = Math.max(0, Math.round((now - ts) / 60_000));
	if (delta === 0) return "just now";
	return `${delta}m ago`;
}

function minutesIn(ts: number | undefined, now: number, intervalMs: number): string {
	if (ts === undefined) return "now (never checked)";
	const delta = Math.round((ts + intervalMs - now) / 60_000);
	return delta <= 0 ? "now (due)" : `in ${delta}m`;
}

export function formatStatus(s: StatusSnapshot, now = Date.now()): string {
	const lines: string[] = [];
	lines.push("clinefree status");
	if (s.contractSource === "baked-in") {
		lines.push("  contract: baked-in ⚠ using baked-in snapshot (extraction failed — headers may be stale)");
	} else if (s.contractSource === "none") {
		lines.push("  contract: none yet (never synced)");
	} else {
		lines.push(`  contract: github (${s.tags.cli ?? "?"} · core ${s.tags.core ?? "?"} · ${s.tags.llms ?? "?"}) · next check ${minutesIn(s.timestamps.tags, now, s.minIntervalMinutes * 60_000)}`);
	}
	lines.push(
		`  capabilities: ${s.capabilitiesCoveredCount}/${s.capabilitiesLineupCount} models covered (fetched once per model — press r to force a refresh)`,
	);
	lines.push(`  lineup: synced ${minutesAgo(s.timestamps.lineup, now)}`);
	if (s.authMode) {
		const who = [s.apiKeyMasked, s.accountEmail].filter(Boolean).join(" · ");
		lines.push(`  auth: ${s.authMode}${who ? ` (${who})` : ""}`);
	} else {
		lines.push("  auth: none — choose Auth to sign in");
	}
	return lines.join("\n");
}

export function formatModels(rows: ModelRow[]): string {
	if (rows.length === 0) return "no models registered (run Refresh, or set a credential via Auth)";
	return rows
		.map((row) => `${row.id}  ${row.name}  ctx ${fmtTokens(row.contextWindow)} / out ${fmtTokens(row.maxTokens)}  [${row.source}]`)
		.join("\n");
}

export interface ZenStatusSnapshot {
	contractSource: "update-api" | "config" | "baked-in" | "none";
	timestamps: { version?: number; lineup?: number; capabilities?: number };
	cliVersion?: string;
	baseUrl?: string;
	authMode?: "apiKey";
	apiKeyMasked?: string;
	minIntervalMinutes: number;
	capabilitiesCoveredCount: number;
	capabilitiesLineupCount: number;
	freeCount: number;
}

export function formatZenStatus(s: ZenStatusSnapshot, now = Date.now()): string {
	const lines: string[] = [];
	lines.push("zenfree status");
	if (s.contractSource === "baked-in") {
		lines.push(`  client: baked-in ⚠ ${s.cliVersion ? `opencode/latest/${s.cliVersion}/cli` : "version unknown"} (update service unreachable — UA may be stale)`);
	} else if (s.contractSource === "none") {
		lines.push("  client: none yet (never synced)");
	} else {
		lines.push(`  client: opencode/latest/${s.cliVersion ?? "?"}/cli (${s.contractSource}) · next check ${minutesIn(s.timestamps.version, now, s.minIntervalMinutes * 60_000)}`);
	}
	lines.push(
		`  capabilities: ${s.capabilitiesCoveredCount}/${s.capabilitiesLineupCount} models covered (fetched once per model — press r to force a refresh)`,
	);
	lines.push(`  lineup: synced ${minutesAgo(s.timestamps.lineup, now)} · ${s.freeCount} free models`);
	if (s.baseUrl) lines.push(`  gateway: ${s.baseUrl}`);
	if (s.authMode) {
		lines.push(`  auth: ${s.authMode} (${s.apiKeyMasked ?? "key"})`);
	} else {
		lines.push("  auth: none — choose Auth to add a workspace key");
	}
	return lines.join("\n");
}

/** Compact searchable single-select in the better-custom style. */
function selectOne(ctx: CommandContext, title: string, items: { value: string; label: string }[]): Promise<string | null> {
	if (items.length === 0) return Promise.resolve(null);
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		let cursor = 0;
		return {
			render(width: number) {
				const w = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, w));
				add(theme.fg("accent", "─".repeat(w)));
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add();
				items.forEach((item, i) => {
					const pointer = i === cursor ? theme.fg("accent", "❯ ") : "  ";
					add(` ${pointer}${item.label}`);
				});
				add();
				add(` ${theme.fg("text", "↑/↓ move · enter select · esc cancel")}`);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
				else if (matchesKey(data, Key.down)) cursor = Math.min(items.length - 1, cursor + 1);
				else if (matchesKey(data, Key.return)) done(items[cursor]?.value ?? null);
				else if (matchesKey(data, Key.escape)) done(null);
				tui.requestRender();
			},
		};
	});
}

/**
 * Read-only info panel. `getBody` is re-evaluated on every render, so the panel
 * shows fresh state once `actions.onRefresh` (bound to the `r` key) has run.
 */
function infoPanel(
	ctx: CommandContext,
	title: string,
	getBody: () => string,
	actions?: { onRefresh?: () => Promise<void> },
): Promise<void> {
	return ctx.ui.custom<void>((tui, theme, _kb, done) => {
		let refreshing = false;
		return {
			render(width: number) {
				const w = Math.max(10, width);
				const lines: string[] = [];
				const add = (line = "") => lines.push(truncateToWidth(line, w));
				add(theme.fg("accent", "─".repeat(w)));
				add(` ${theme.fg("accent", theme.bold(title))}`);
				add();
				for (const line of getBody().split("\n")) add(` ${line}`);
				add();
				if (refreshing) add(` ${theme.fg("text", "refreshing…")}`);
				else add(` ${theme.fg("text", actions?.onRefresh ? "enter/esc close · r refresh now" : "enter/esc close")}`);
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (matchesKey(data, Key.return) || matchesKey(data, Key.escape)) {
					done();
					return;
				}
				if (actions?.onRefresh && (data === "r" || data === "R") && !refreshing) {
					refreshing = true;
					tui.requestRender();
					void actions
						.onRefresh()
						.catch(() => undefined)
						.finally(() => {
							refreshing = false;
							tui.requestRender();
						});
					return;
				}
				tui.requestRender();
			},
		};
	});
}

export function registerClinefreeCommand(pi: ExtensionAPI, deps: TuiDeps): void {
	pi.registerCommand("clinefree", {
		description: "Cline free models: status, models, auth",
		handler: async (_args, ctx) => {
			const refreshNow = async (): Promise<void> => {
				try {
					await deps.refresh();
					const h = deps.history();
					deps.notify(
						`clinefree: refreshed — ${h ? `+${h.added.length}/−${h.removed.length}` : "sync complete"}`,
					);
				} catch (error) {
					deps.notify(`clinefree: refresh failed — ${error instanceof Error ? error.message : String(error)}`);
				}
			};
			for (;;) {
				const choice = await selectOne(ctx, "clinefree", [
					{ value: "status", label: "Status" },
					{ value: "models", label: "Models" },
					{ value: "auth", label: "Auth" },
				]);
				if (choice === null) return;

				if (choice === "status") {
					await infoPanel(ctx, "status", () => formatStatus(deps.snapshot()), { onRefresh: refreshNow });
					continue;
				}
				if (choice === "models") {
					await infoPanel(ctx, "models", () => formatModels(deps.modelRows()));
					continue;
				}
				if (choice === "auth") {
					const authChoice = await selectOne(ctx, "auth", [
						{ value: "apikey", label: "Paste API key" },
						{ value: "device", label: "Sign in with Cline (device flow)" },
						{ value: "clear", label: "Clear credential" },
					]);
					if (authChoice === "apikey") {
						const key = (await ctx.ui.input("Cline API key", "sk-…"))?.trim();
						if (!key) continue;
						const result = await deps.setApiKey(key);
						deps.notify(result.ok ? `clinefree: API key accepted (${result.detail})` : `clinefree: API key rejected — ${result.detail}`);
					} else if (authChoice === "device") {
						const result = await deps.deviceFlow((m) => deps.notify(`clinefree: ${m}`));
						deps.notify(result.ok ? `clinefree: signed in (${result.detail})` : `clinefree: sign-in failed — ${result.detail}`);
					} else if (authChoice === "clear") {
						if (await ctx.ui.confirm("Clear credential", "Clear the stored Cline credential?")) {
							deps.clearCredential();
							deps.notify("clinefree: credential cleared");
						}
					}
					continue;
				}
			}
		},
	});
}

export interface ZenTuiDeps {
	refresh(): Promise<void>;
	snapshot(): ZenStatusSnapshot;
	modelRows(): ModelRow[];
	history(): { added: string[]; removed: string[]; warnings: string[] } | undefined;
	setApiKey(key: string): Promise<{ ok: boolean; detail: string }>;
	deviceFlow(onStatus: (message: string) => void): Promise<{ ok: boolean; detail: string }>;
	clearCredential(): void;
	notify(message: string): void;
}

/** /zenfree — status, models, auth; press r in status to refresh. */
export function registerZenfreeCommand(pi: ExtensionAPI, deps: ZenTuiDeps): void {
	pi.registerCommand("zenfree", {
		description: "OpenCode Zen free models: status, models, auth",
		handler: async (_args, ctx) => {
			const refreshNow = async (): Promise<void> => {
				try {
					await deps.refresh();
					const h = deps.history();
					deps.notify(
						`zenfree: refreshed — ${h ? `+${h.added.length}/−${h.removed.length}` : "sync complete"}`,
					);
				} catch (error) {
					deps.notify(`zenfree: refresh failed — ${error instanceof Error ? error.message : String(error)}`);
				}
			};
			for (;;) {
				const choice = await selectOne(ctx, "zenfree", [
					{ value: "status", label: "Status" },
					{ value: "models", label: "Models" },
					{ value: "auth", label: "Auth" },
				]);
				if (choice === null) return;

				if (choice === "status") {
					await infoPanel(ctx, "status", () => formatZenStatus(deps.snapshot()), { onRefresh: refreshNow });
					continue;
				}
				if (choice === "models") {
					await infoPanel(ctx, "models", () => formatModels(deps.modelRows()));
					continue;
				}
				if (choice === "auth") {
					const authChoice = await selectOne(ctx, "auth", [
						{ value: "apikey", label: "Paste workspace key" },
						{ value: "oauth", label: "Sign in with OpenCode" },
						{ value: "clear", label: "Clear credential" },
					]);
					if (authChoice === "apikey") {
						const key = (await ctx.ui.input("OpenCode workspace key", "oc_sk_…"))?.trim();
						if (!key) continue;
						const result = await deps.setApiKey(key);
						deps.notify(result.ok ? `zenfree: key accepted (${result.detail})` : `zenfree: key rejected — ${result.detail}`);
					} else if (authChoice === "oauth") {
						const result = await deps.deviceFlow((message) => deps.notify(`zenfree: ${message}`));
						deps.notify(result.ok ? `zenfree: signed in (${result.detail})` : `zenfree: sign-in failed — ${result.detail}`);
					} else if (authChoice === "clear") {
						if (await ctx.ui.confirm("Clear credential", "Forget the stored OpenCode credential?")) {
							deps.clearCredential();
							deps.notify("zenfree: credential cleared");
						}
					}
					continue;
				}
			}
		},
	});
}
