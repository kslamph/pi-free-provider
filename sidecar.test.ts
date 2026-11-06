import { describe, expect, it, vi } from "vitest";
import { createZenSidecar, bunInstallHint, resolveBunPath, type SidecarProcess } from "./sidecar.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Minimal fake of the spawned sidecar process. */
function fakeSidecarProcess(ready?: string): {
	proc: SidecarProcess;
	emitters: { stdout: (chunk: string) => void; exit: (code: number | null) => void };
	killed: () => boolean;
} {
	let killed = false;
	const listeners = { stdout: [] as ((chunk: string | Buffer) => void)[], exit: [] as ((code: number | null) => void)[] };
	const proc: SidecarProcess = {
		on: (_event: "exit", cb: (code: number | null) => void) => {
			listeners.exit.push(cb);
		},
		kill: () => {
			killed = true;
			for (const cb of listeners.exit) cb(null);
		},
		stdout: { on: (_e: "data", cb: (chunk: string | Buffer) => void) => listeners.stdout.push(cb) },
		stderr: { on: () => {} },
	};
	if (ready !== undefined) queueMicrotask(() => forOf(listeners.stdout, (cb) => cb(ready)));
	const emitters = {
		stdout: (chunk: string) => forOf(listeners.stdout, (cb) => cb(chunk)),
		exit: (code: number | null) => forOf(listeners.exit, (cb) => cb(code)),
	};
	return { proc, emitters, killed: () => killed };
}

function forOf<T>(items: T[], fn: (item: T) => void): void {
	for (const item of [...items]) fn(item);
}

function bunEnv(withBun = true, overrides: Record<string, string> = {}): Record<string, string> {
	const home = mkdtempSync(join(tmpdir(), "zen-sidecar-test-"));
	if (!withBun) return { HOME: home, PATH: "/nonexistent", ...overrides };
	const stub = join(home, "bun");
	writeFileSync(stub, "#!/bin/sh\n");
	return { HOME: home, PATH: "/nonexistent", ZENFREE_BUN: stub, ...overrides };
}

describe("resolveBunPath", () => {
	it("prefers ZENFREE_BUN when the file exists", () => {
		const home = mkdtempSync(join(tmpdir(), "zen-sidecar-bun-"));
		const bun = join(home, "bun");
		writeFileSync(bun, "#!/bin/sh\n");
		expect(resolveBunPath({ ...bunEnv(false), ZENFREE_BUN: bun })).toBe(bun);
	});

	it("falls back to ~/.bun/bin/bun", () => {
		const home = mkdtempSync(join(tmpdir(), "zen-sidecar-home-"));
		mkdirSync(join(home, ".bun/bin"), { recursive: true });
		writeFileSync(join(home, ".bun/bin/bun"), "#!/bin/sh\n");
		expect(resolveBunPath(bunEnv(false, { HOME: home }))).toBe(join(home, ".bun/bin/bun"));
	});

	it("finds extension-qualified Bun and USERPROFILE on Windows", () => {
		const home = mkdtempSync(join(tmpdir(), "zen-sidecar-windows-"));
		mkdirSync(join(home, ".bun/bin"), { recursive: true });
		writeFileSync(join(home, ".bun/bin/bun.exe"), "stub");
		expect(resolveBunPath({ PATH: "/nonexistent", USERPROFILE: home }, "win32")).toBe(join(home, ".bun/bin/bun.exe"));
		expect(resolveBunPath({ PATH: "/nonexistent", HOME: "/wrong-home", USERPROFILE: home }, "win32")).toBe(join(home, ".bun/bin/bun.exe"));

		const pathDir = mkdtempSync(join(tmpdir(), "zen-sidecar-windows-path-"));
		writeFileSync(join(pathDir, "bun.cmd"), "stub");
		expect(resolveBunPath({ PATH: pathDir }, "win32")).toBe(join(pathDir, "bun.cmd"));
	});

	it("returns undefined when bun is nowhere", () => {
		expect(resolveBunPath(bunEnv(false))).toBeUndefined();
	});
});

describe("bunInstallHint", () => {
	it("gives two steps with the POSIX install script and a restart, off macOS/Linux", () => {
		const hint = bunInstallHint("linux");
		expect(hint).toContain("curl -fsSL https://bun.sh/install | bash");
		expect(hint).toMatch(/1\) Install Bun/);
		expect(hint).toMatch(/2\) Restart pi/);
		expect(hint).toContain("~/.bun/bin");
		expect(hint).toContain("ZENFREE_BUN");
	});

	it("uses PowerShell and %USERPROFILE% on Windows", () => {
		const hint = bunInstallHint("win32");
		expect(hint).toContain('irm bun.sh/install.ps1 | iex');
		expect(hint).toContain("%USERPROFILE%\\.bun\\bin");
		expect(hint).not.toContain("curl -fsSL");
	});
});

describe("createZenSidecar", () => {
	it("waits for SIDECAR_READY and returns the loopback base URL, cached across calls", async () => {
		const spawns: string[][] = [];
		const sidecar = createZenSidecar({
			env: bunEnv(),
			startTimeoutMs: 2_000,
			spawnImpl: (_cmd, args) => {
				spawns.push(args);
				return fakeSidecarProcess("SIDECAR_READY 9911\n").proc;
			},
		});
		await expect(sidecar.ensureSidecar()).resolves.toBe("http://127.0.0.1:9911");
		await expect(sidecar.ensureSidecar()).resolves.toBe("http://127.0.0.1:9911");
		expect(spawns).toHaveLength(1);
	});

	it("yields undefined and notifies once when bun is missing", async () => {
		const notify = vi.fn();
		const sidecar = createZenSidecar({ env: bunEnv(false), notify });
		await expect(sidecar.ensureSidecar()).resolves.toBeUndefined();
		await expect(sidecar.ensureSidecar()).resolves.toBeUndefined();
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]![0]).toContain("bun not found");
		expect(notify.mock.calls[0]![0]).toMatch(/1\) Install Bun/);
		expect(notify.mock.calls[0]![0]).toMatch(/2\) Restart pi/);
	});

	it("restarts the sidecar after a crash", async () => {
		const spawns: string[][] = [];
		const fakes: ReturnType<typeof fakeSidecarProcess>[] = [];
		const sidecar = createZenSidecar({
			env: bunEnv(),
			startTimeoutMs: 2_000,
			spawnImpl: (_cmd, args) => {
				spawns.push(args);
				const fake = fakeSidecarProcess(`SIDECAR_READY ${9912 + fakes.length}\n`);
				fakes.push(fake);
				return fake.proc;
			},
		});
		await expect(sidecar.ensureSidecar()).resolves.toBe("http://127.0.0.1:9912");
		fakes[0]!.emitters.exit(1);
		await expect(sidecar.ensureSidecar()).resolves.toBe("http://127.0.0.1:9913");
		expect(spawns).toHaveLength(2);
	});

	it("kills a sidecar that never reports ready and cools down before retrying", async () => {
		let spawnCount = 0;
		let current = fakeSidecarProcess();
		const now = vi.fn(() => 1_000);
		const sidecar = createZenSidecar({
			env: bunEnv(),
			now,
			startTimeoutMs: 30,
			retryCooldownMs: 60_000,
			spawnImpl: () => {
				spawnCount++;
				current = fakeSidecarProcess();
				return current.proc;
			},
		});
		await expect(sidecar.ensureSidecar()).resolves.toBeUndefined();
		expect(current.killed()).toBe(true);
		expect(spawnCount).toBe(1);
		// Inside the cooldown: no new spawn.
		await expect(sidecar.ensureSidecar()).resolves.toBeUndefined();
		expect(spawnCount).toBe(1);
		// Past the cooldown: spawn again.
		now.mockReturnValue(61_000);
		await expect(sidecar.ensureSidecar()).resolves.toBeUndefined();
		expect(spawnCount).toBe(2);
	});
});
