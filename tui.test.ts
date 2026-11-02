import { describe, expect, it } from "vitest";
import {
	fmtTokens,
	formatModels,
	formatStatus,
	formatZenStatus,
	maskKey,
	type ModelRow,
	type StatusSnapshot,
} from "./tui.ts";

const NOW = 1_000_000_000_000;

const snapshot: StatusSnapshot = {
	tags: { llms: "sdk/llms/v0.0.86", core: "sdk/core/v0.0.86", cli: "cli-v3.0.65" },
	timestamps: { tags: NOW - 13 * 60_000, lineup: NOW - 2 * 60_000, contract: NOW - 13 * 60_000 },
	contractSource: "github",
	authMode: "apiKey",
	apiKeyMasked: "sk-1234…abcd",
	accountEmail: "daniel@example.com",
	minIntervalMinutes: 30,
	capabilitiesCoveredCount: 5,
	capabilitiesLineupCount: 6,
};

describe("formatStatus", () => {
	it("renders tags, freshness, auth, and account", () => {
		const text = formatStatus(snapshot, NOW);
		expect(text).toContain("cli-v3.0.65");
		expect(text).toContain("sdk/llms/v0.0.86");
		expect(text).toContain("github");
		expect(text).toContain("2m ago");
		expect(text).toContain("in 17m"); // next tag check: 30 − 13
		expect(text).toContain("apiKey");
		expect(text).toContain("sk-1234…abcd");
		expect(text).toContain("daniel@example.com");
	});

	it("shows capability coverage, not a TTL", () => {
		const text = formatStatus(snapshot, NOW);
		expect(text).toContain("5/6 models covered");
		expect(text).toMatch(/Refresh/i);
		expect(text).not.toMatch(/TTL/i);
	});

	it("warns when the contract is the baked-in fallback", () => {
		const text = formatStatus({ ...snapshot, contractSource: "baked-in" }, NOW);
		expect(text).toContain("baked-in");
		expect(text).toMatch(/warn|⚠|snapshot/i);
	});

	it("says so when no credential is configured", () => {
		const text = formatStatus({ ...snapshot, authMode: undefined, apiKeyMasked: undefined, accountEmail: undefined }, NOW);
		expect(text).toMatch(/auth: none/i);
		expect(text).toMatch(/API key/i);
	});

	it("shows OAuth as auto-refreshing with the account identity, not a key", () => {
		const text = formatStatus(
			{ ...snapshot, authMode: "oauth", apiKeyMasked: undefined, accountEmail: "daniel@example.com" },
			NOW,
		);
		expect(text).toContain("auth: oauth (auto-refreshing · daniel@example.com)");
		expect(text).not.toContain("sk-");
	});
});

describe("formatModels", () => {
	it("renders one line per model with sizes and capability source", () => {
		const rows: ModelRow[] = [
			{ id: "stealth/pixel-canary", name: "Pixel Canary (free)", contextWindow: 262144, maxTokens: 131072, source: "vercel" },
			{ id: "cline-free/deepseek-v4.1-flash", name: "DeepSeek: V4.1 Flash", contextWindow: 1048576, maxTokens: 384000, source: "openrouter" },
			{ id: "brand/new-thing", name: "brand/new-thing", contextWindow: 256000, maxTokens: 32000, source: "default" },
		];
		const text = formatModels(rows);
		const lines = text.split("\n").filter((l) => l.trim().length > 0);
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("stealth/pixel-canary");
		expect(lines[0]).toContain("256K");
		expect(lines[0]).toContain("128K");
		expect(lines[0]).toContain("vercel");
		expect(lines[1]).toContain("1M");
		expect(lines[1]).toContain("375K");
		expect(lines[1]).toContain("openrouter");
		expect(lines[2]).toContain("250K");
		expect(lines[2]).toContain("31K");
		expect(lines[2]).toContain("default");
	});
});

describe("helpers", () => {
	it("masks keys for display", () => {
		expect(maskKey("sk-1234567890abcd")).toBe("sk-123…abcd");
		expect(maskKey("short")).toBe("…");
	});

	it("formats token counts", () => {
		expect(fmtTokens(1048576)).toBe("1M");
		expect(fmtTokens(262144)).toBe("256K");
		expect(fmtTokens(32000)).toBe("31K");
	});
});

describe("formatZenStatus", () => {
	it("renders client version, coverage, lineup, gateway, and auth lines", () => {
		const now = 1_000_000_000_000;
		const text = formatZenStatus({
			contractSource: "update-api",
			timestamps: { version: now - 3 * 60_000, lineup: now - 2 * 60_000 },
			cliVersion: "2.0.18",
			baseUrl: "https://opencode.ai/inference/openai/v1",
			authMode: "apiKey",
			apiKeyMasked: "oc_sk_…abcd",
			minIntervalMinutes: 30,
			capabilitiesCoveredCount: 8,
			capabilitiesLineupCount: 8,
			freeCount: 8,
		}, now);
		expect(text).toContain("zenfree status");
		expect(text).toContain("opencode/latest/2.0.18/cli (update-api)");
		expect(text).toContain("next check in 27m");
		expect(text).toContain("8/8 models covered");
		expect(text).toContain("lineup: synced 2m ago");
		expect(text).toContain("gateway: https://opencode.ai/inference/openai/v1");
		expect(text).toContain("auth: apiKey (oc_sk_…abcd)");
	});

	it("falls back to the baked-in marker and no-auth line", () => {
		const text = formatZenStatus({
			contractSource: "baked-in",
			timestamps: {},
			minIntervalMinutes: 30,
			capabilitiesCoveredCount: 0,
			capabilitiesLineupCount: 0,
			freeCount: 0,
		});
		expect(text).toContain("baked-in");
		expect(text).toContain("auth: none");
		// Both auth methods must be discoverable from the empty state.
		expect(text).toMatch(/workspace key/i);
		expect(text).toMatch(/sign in/i);
	});

	it("renders an OAuth credential as auto-refreshing, with its expiry", () => {
		const now = 1_000_000_000_000;
		const text = formatZenStatus({
			contractSource: "config",
			timestamps: { lineup: now - 60_000 },
			cliVersion: "2.0.18",
			authMode: "oauth",
			tokenExpiresAt: now + 58 * 60_000,
			minIntervalMinutes: 30,
			capabilitiesCoveredCount: 1,
			capabilitiesLineupCount: 1,
			freeCount: 1,
		}, now);
		expect(text).toContain("auth: oauth (auto-refreshing · expires in 58m)");
		expect(text).not.toContain("key");
	});

	it("marks an expired OAuth token rather than pretending it is fresh", () => {
		const now = 1_000_000_000_000;
		const text = formatZenStatus({
			contractSource: "config",
			timestamps: {},
			authMode: "oauth",
			tokenExpiresAt: now - 60_000,
			minIntervalMinutes: 30,
			capabilitiesCoveredCount: 0,
			capabilitiesLineupCount: 0,
			freeCount: 0,
		}, now);
		expect(text).toContain("auth: oauth (auto-refreshing · expired)");
	});
});
