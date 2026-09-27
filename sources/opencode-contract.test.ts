import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	BAKED_IN_ZEN_CONTRACT,
	MIN_CLI_VERSION,
	UPDATE_API_URL,
	buildZenContract,
	resolveLatestCliVersion,
} from "./opencode-contract.ts";

const dir = join(import.meta.dirname, "..", "test-fixtures");
const updateApi = JSON.parse(readFileSync(join(dir, "update-api.json"), "utf-8"));

describe("resolveLatestCliVersion", () => {
	it("picks the npm artifact from the live update-api payload", async () => {
		const fetcher = (async (url: string) => {
			expect(url).toBe(UPDATE_API_URL);
			return new Response(JSON.stringify(updateApi), { status: 200 });
		}) as typeof fetch;
		expect(await resolveLatestCliVersion(fetcher)).toBe("2.0.18");
	});

	it("falls back to the first active artifact when npm is absent", async () => {
		const payload = { artifacts: [{ distribution: "homebrew", version: "2.0.19", active: true }] };
		const fetcher = (async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
		expect(await resolveLatestCliVersion(fetcher)).toBe("2.0.19");
	});

	it("returns undefined on non-2xx, throw, or empty artifacts", async () => {
		const notOk = (async () => new Response("nope", { status: 503 })) as typeof fetch;
		expect(await resolveLatestCliVersion(notOk)).toBeUndefined();
		const throws = (async () => {
			throw new Error("network down");
		}) as typeof fetch;
		expect(await resolveLatestCliVersion(throws)).toBeUndefined();
		const empty = (async () => new Response(JSON.stringify({ artifacts: [] }), { status: 200 })) as typeof fetch;
		expect(await resolveLatestCliVersion(empty)).toBeUndefined();
	});
});

describe("buildZenContract", () => {
	it("uses the resolved version when it is at or above the floor", () => {
		const c = buildZenContract("2.0.18");
		expect(c.headers["User-Agent"]).toBe("opencode/latest/2.0.18/cli");
		expect(c.headers["x-opencode-client"]).toBe("cli");
		expect(c.source).toBe("update-api");
		expect(c.baseUrl).toBe("https://opencode.ai/inference/openai/v1");
		expect(c.warning).toBeUndefined();
	});

	it("keeps the baked-in version when the resolved one is older or malformed", () => {
		const older = buildZenContract("1.17.5");
		expect(older.headers["User-Agent"]).toBe(BAKED_IN_ZEN_CONTRACT.headers["User-Agent"]);
		expect(older.source).toBe("baked-in");
		expect(older.warning).toBeDefined();
		const garbage = buildZenContract("not-semver");
		expect(garbage.headers["User-Agent"]).toBe(BAKED_IN_ZEN_CONTRACT.headers["User-Agent"]);
		expect(garbage.source).toBe("baked-in");
	});

	it("prefers a provided baseUrl (live config value)", () => {
		const c = buildZenContract("2.0.18", "https://opencode.ai/inference/openai/v2");
		expect(c.baseUrl).toBe("https://opencode.ai/inference/openai/v2");
		expect(c.source).toBe("config");
	});
});

describe("BAKED_IN_ZEN_CONTRACT", () => {
	it("pins the live-verified UA and gateway url", () => {
		expect(BAKED_IN_ZEN_CONTRACT.headers["User-Agent"]).toBe("opencode/latest/2.0.18/cli");
		expect(BAKED_IN_ZEN_CONTRACT.baseUrl).toBe("https://opencode.ai/inference/openai/v1");
		expect(BAKED_IN_ZEN_CONTRACT.source).toBe("baked-in");
		expect(MIN_CLI_VERSION).toBe("1.17.0");
	});
});
