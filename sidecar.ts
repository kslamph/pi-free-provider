/**
 * Bun sidecar manager for zenfree (2026-10-24).
 *
 * Zen's inference gateway (rollout ~Oct 22-24, 2026) admits free-tier requests
 * only from BoringSSL-shaped TLS clients — the official OpenCode client's
 * runtime — and answers everything else, byte-identical or not, with
 * 429 FreeUsageLimitError ("Free usage limit reached. Subscribe to OpenCode
 * Go…"). Verified live by replaying a captured official request verbatim:
 * Node/undici → 429, curl --http2 → 429, Bun → 200.
 *
 * So the extension forwards zen requests through a tiny Bun process
 * (zen-sidecar.ts) that serves as a loopback HTTP relay; the request
 * headers/body are shaped in stream.ts exactly like the official client and
 * only the transport changes. stream.ts swaps the model's baseUrl for the
 * sidecar's loopback URL before delegating to pi's adapter.
 *
 * Bun resolution: $ZENFREE_BUN → `bun` on PATH → ~/.bun/bin/bun. On Windows,
 * extension-qualified names (`bun.exe`, `bun.cmd`) and `%USERPROFILE%` are
 * checked as well. When Bun is
 * unavailable the manager resolves undefined (stream.ts then sends directly
 * and the user is notified once); a sidecar that crashes or never reports
 * ready is restarted on the next request, throttled by a cooldown so a broken
 * install cannot spawn-loop. The sidecar exits on its own when stdin closes,
 * so it never outlives this process.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Minimal surface of the spawned sidecar the manager relies on (test-injectable). */
export interface SidecarProcess {
	on(event: "exit", cb: (code: number | null) => void): void;
	kill(): void;
	stdout: { on(event: "data", cb: (chunk: string | Buffer) => void): void };
	stderr: { on(event: "data", cb: (chunk: string | Buffer) => void): void };
}

export interface ZenSidecarDeps {
	/** Environment to resolve bun and pass through (default: process.env). */
	env?: Record<string, string | undefined>;
	notify?(message: string): void;
	/** Injectable for tests (default: node:child_process spawn). */
	spawnImpl?(cmd: string, args: string[], env: Record<string, string | undefined>): SidecarProcess;
	/** Injectable for cooldown tests. */
	now?(): number;
	startTimeoutMs?: number;
	retryCooldownMs?: number;
}

const DEFAULT_START_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_COOLDOWN_MS = 60_000;

/** Where the bundled Bun relay script lives, next to this module. */
const SIDECAR_SCRIPT = fileURLToPath(new URL("./zen-sidecar.ts", import.meta.url));

/** Resolve the bun binary: $ZENFREE_BUN → PATH → ~/.bun/bin/bun. */
export function resolveBunPath(env: Record<string, string | undefined>, platform = process.platform): string | undefined {
	const override = env.ZENFREE_BUN?.trim();
	if (override && existsSync(override)) return override;
	const binNames = platform === "win32" ? ["bun.exe", "bun.cmd", "bun"] : ["bun"];
	const pathDelimiter = platform === "win32" ? ";" : delimiter;
	const findBunIn = (dir: string): string | undefined => {
		for (const name of binNames) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
		return undefined;
	};
	for (const dir of (env.PATH ?? env.Path ?? "").split(pathDelimiter)) {
		if (!dir) continue;
		const candidate = findBunIn(dir);
		if (candidate) return candidate;
	}
	for (const home of [env.HOME, env.USERPROFILE]) {
		if (!home) continue;
		const candidate = findBunIn(join(home, ".bun", "bin"));
		if (candidate) return candidate;
	}
	return undefined;
}

export interface ZenSidecar {
	/** Resolve the sidecar's loopback base URL ("http://127.0.0.1:<port>"), starting it if needed.
	 * Undefined = no sidecar available (bun missing, or a recent failed start inside the cooldown). */
	ensureSidecar(): Promise<string | undefined>;
	/** Kill the sidecar (tests, shutdown). */
	stop(): void;
}

export function createZenSidecar(deps: ZenSidecarDeps = {}): ZenSidecar {
	const env = deps.env ?? process.env;
	const notify = deps.notify ?? ((): void => {});
	const doSpawn = deps.spawnImpl ?? ((cmd: string, args: string[], childEnv: Record<string, string | undefined>) =>
		spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: childEnv }) as unknown as SidecarProcess);
	const now = deps.now ?? Date.now;
	const startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
	const retryCooldownMs = deps.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;

	let live: SidecarProcess | undefined;
	let pending: Promise<string | undefined> | undefined;
	let readyUrl: string | undefined;
	let lastFailureAt = -Infinity;
	let missingNotified = false;
	let failedNotified = false;

	const clear = (): void => {
		live = undefined;
		readyUrl = undefined;
		pending = undefined;
	};

	const start = (): Promise<string | undefined> => {
		const bun = resolveBunPath(env);
		if (!bun) {
			if (!missingNotified) {
				missingNotified = true;
				notify(
					"zenfree: bun not found — zen's gateway admits only Bun-shaped TLS clients, so requests go out directly and will likely hit the free-usage wall. Install bun (https://bun.sh) or point ZENFREE_BUN at it.",
				);
			}
			return Promise.resolve(undefined);
		}
		if (now() - lastFailureAt < retryCooldownMs) return Promise.resolve(undefined);

		return new Promise((resolve) => {
			let settled = false;
			let stdoutText = "";
			let child: SidecarProcess;
			try {
				child = doSpawn(bun, [SIDECAR_SCRIPT], env);
			} catch (error) {
				lastFailureAt = now();
				notifyOnceFailed(`zenfree: bun sidecar failed to start (${error instanceof Error ? error.message : String(error)})`);
				resolve(undefined);
				return;
			}
			live = child;
			const finish = (url: string | undefined, failed: boolean): void => {
				if (settled) return;
				settled = true;
				if (failed) {
					lastFailureAt = now();
					if (child) child.kill();
					clear();
					resolve(undefined);
					return;
				}
				readyUrl = url;
				resolve(url);
			};
			child.stdout.on("data", (chunk: string | Buffer) => {
				stdoutText += chunk.toString();
				const match = /SIDECAR_READY (\d+)/.exec(stdoutText);
				if (match) finish(`http://127.0.0.1:${match[1]}`, false);
			});
			child.stderr.on("data", (chunk: string | Buffer) => {
				stdoutText += chunk.toString();
			});
			child.on("exit", () => {
				if (!settled) {
					notifyOnceFailed(`zenfree: bun sidecar exited before listening (${stdoutText.trim().slice(0, 160) || "no output"})`);
					finish(undefined, true);
					return;
				}
				// Crashed after a successful start: the next ensureSidecar restarts it.
				clear();
			});
			const timer = setTimeout(() => {
				if (settled) return;
				notifyOnceFailed(`zenfree: bun sidecar did not report ready in ${startTimeoutMs}ms`);
				finish(undefined, true);
			}, startTimeoutMs);
			// Do not hold the event loop open for the readiness race.
			timer.unref?.();
		});
	};

	const notifyOnceFailed = (message: string): void => {
		if (failedNotified) return;
		failedNotified = true;
		notify(message);
	};

	return {
		ensureSidecar: (): Promise<string | undefined> => {
			if (readyUrl) return Promise.resolve(readyUrl);
			pending ??= start();
			void pending.finally(() => {
				pending = undefined;
			});
			return pending;
		},
		stop: (): void => {
			live?.kill();
			clear();
		},
	};
}
