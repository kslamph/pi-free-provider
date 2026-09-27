import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "clinefree-import-"));
	process.env.CLINEFREE_CONFIG = join(tmp, "clinefree.json");
	process.env.CLINEFREE_CACHE = join(tmp, "cache");
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
	delete process.env.CLINEFREE_CONFIG;
	delete process.env.CLINEFREE_CACHE;
});

describe("extension entry", () => {
	it("default-exports the factory function with no import-time side effects", async () => {
		const before = { ...process.env };
		const mod = await import("./index.ts");
		expect(typeof mod.default).toBe("function");
		expect(typeof mod.syncOnce).toBe("function");
		expect(process.env).toEqual(before);
	});
});
