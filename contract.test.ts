import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BAKED_IN_CONTRACT, extractContract } from "./contract.ts";

const dir = join(import.meta.dirname, "test-fixtures");
const requestHeaders = readFileSync(join(dir, "request-headers.ts"), "utf8");
const recommended = readFileSync(join(dir, "catalog-cline-recommended.ts"), "utf8");
const versions = { cli: "3.0.65", core: "0.0.86" };

describe("extractContract", () => {
	it("extracts the header set and endpoint path from real upstream source", () => {
		const result = extractContract({ requestHeaders, recommended }, versions);
		expect(result.source).toBe("github");
		expect(result.warning).toBeUndefined();
		expect(result.endpointPath).toBe("/api/v1/ai/cline/recommended-models");
		expect(result.cliVersion).toBe("3.0.65");
		expect(result.coreVersion).toBe("0.0.86");
		expect(result.headers).toMatchObject({
			"HTTP-Referer": "https://cline.bot",
			"X-Title": "Cline",
			"X-IS-MULTIROOT": "false",
			// client identity overrides the literal's generic "cline-sdk"
			"X-CLIENT-TYPE": "cline-cli",
			"User-Agent": "Cline/3.0.65",
			"X-CLIENT-VERSION": "3.0.65",
			"X-PLATFORM": "cli",
			"X-PLATFORM-VERSION": "3.0.65",
			"X-CORE-VERSION": "0.0.86",
		});
	});

	it("falls back to the baked-in contract with a warning when extraction cannot parse", () => {
		const result = extractContract({ requestHeaders: "export const X = 1;", recommended }, versions);
		expect(result.source).toBe("baked-in");
		expect(result.warning).toBeTruthy();
		expect(result.headers).toEqual(BAKED_IN_CONTRACT.headers);
		expect(result.endpointPath).toBe(BAKED_IN_CONTRACT.endpointPath);
	});

	it("falls back when no source is provided at all", () => {
		const result = extractContract({}, versions);
		expect(result.source).toBe("baked-in");
		expect(result.warning).toBeTruthy();
	});
});

describe("BAKED_IN_CONTRACT", () => {
	it("carries the verified official-CLI header set", () => {
		expect(BAKED_IN_CONTRACT.source).toBe("baked-in");
		expect(BAKED_IN_CONTRACT.headers).toMatchObject({
			"HTTP-Referer": "https://cline.bot",
			"X-Title": "Cline",
			"X-IS-MULTIROOT": "false",
			"X-CLIENT-TYPE": "cline-cli",
			"X-PLATFORM": "cli",
		});
		expect(BAKED_IN_CONTRACT.headers["User-Agent"]).toMatch(/^Cline\//);
		expect(BAKED_IN_CONTRACT.endpointPath).toBe("/api/v1/ai/cline/recommended-models");
	});
});
