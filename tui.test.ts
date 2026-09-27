import { describe, expect, it } from "vitest";
import { fmtTokens, formatModels, formatStatus, maskKey, type ModelRow, type StatusSnapshot } from "./tui.ts";

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
