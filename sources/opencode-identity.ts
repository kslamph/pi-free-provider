/**
 * Client identity minting for OpenCode Zen requests (zenfree spec §zen-6).
 *
 * opencode identifies a calling client with:
 *
 *   x-opencode-client   constant "cli"
 *   User-Agent          opencode/<channel>/<version>/<name>  (see opencode-contract.ts)
 *   x-opencode-session  "ses_" + Identifier.create(descending) — one per conversation
 *   x-opencode-request  "msg_" + Identifier.create(ascending) — one per answered
 *                       user message, so retries of one turn share one id
 *
 * Server-side gates observed live (2026-09-17, via pi-multikey probes): a
 * session id that is missing or not `ses_` + 12 lowercase-hex + 14 base62
 * draws HTTP 403 FreeTierError; `x-opencode-request` is not validated.
 *
 * This is a port of pi-multikey's identity.ts, which itself ports opencode's
 * `Identifier.create` (packages/schema/src/identifier.ts): the first 12 chars
 * are the hex of `(timestamp_ms * 0x1000 + counter)` (bitwise NOT'd for
 * descending ids so newer ids sort first); the last 14 are random base62.
 * pi exposes neither session nor message ids to a custom stream function, so
 * ids are minted here and kept alive for the same span opencode would.
 */

import { createHash, randomBytes } from "node:crypto";

/** Alphabet used by opencode's Identifier.create (digits first, like upstream). */
export const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastTs = 0;
let count = 0;

/** Mint one 26-char identifier; `ts`/`bytes` injectable for deterministic tests.
 * Faithful port of packages/schema/src/identifier.ts: top 6 bytes (12 hex)
 * of `(ts * 0x1000 + counter)` — bitwise NOT'd for descending — plus 14 base62. */
export function createIdentifier(descending: boolean, ts: number = Date.now(), bytes: Uint8Array = randomBytes(14)): string {
	if (ts !== lastTs) {
		lastTs = ts;
		count = 0;
	}
	count++;
	const current = BigInt(ts) * 0x1000n + BigInt(count);
	const value = descending ? ~current : current;
	let hex = "";
	for (let index = 0; index < 6; index++) {
		hex += Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0");
	}
	let id = hex;
	for (const byte of bytes) id += ALPHABET[byte % ALPHABET.length];
	return id;
}

/** New session identifier, matching opencode's `SessionID.descending()` ("ses_" + 26). */
export function createSessionId(): string {
	return `ses_${createIdentifier(true)}`;
}

/** New message identifier, matching opencode's `MessageID.ascending()` ("msg_" + 26). */
export function createMessageId(): string {
	return `msg_${createIdentifier(false)}`;
}

/** Stable project identifier for `x-opencode-project` — the v2.1 client sends a
 * 40-hex sha1 of the project directory on every request; mirror that shape
 * (keyless zen recipe, 2026-10-24). Stable for the process lifetime. */
let cachedProjectId: string | undefined;
export function zenProjectId(): string {
	return (cachedProjectId ??= createHash("sha1").update(process.cwd()).digest("hex"));
}

/**
 * Stable key for "the turn we are currently answering" — opencode's `lastUser`.
 * pi rebuilds message objects between requests, so object identity is useless;
 * the last user message's timestamp plus a digest of its content stays equal
 * across every step of the same turn.
 */
export function turnKeyOf(messages: readonly unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; timestamp?: number; content?: unknown } | undefined;
		if (m?.role !== "user") continue;
		const digest = createHash("sha1").update(JSON.stringify(m.content ?? "")).digest("hex");
		return `${m.timestamp ?? 0}:${digest}`;
	}
	return undefined;
}

/** Per-conversation identity state; reset on session_start (new/resume/fork). */
export interface ConversationIdentity {
	sessionId(): string;
	requestId(turnKey: string | undefined): string;
	reset(): void;
}

export function createConversationIdentity(): ConversationIdentity {
	let sessionId: string | undefined;
	let requestId: string | undefined;
	let turnKey: string | undefined;

	return {
		sessionId: () => (sessionId ??= createSessionId()),
		requestId(key: string | undefined): string {
			if (key === undefined) return createMessageId();
			if (!requestId || key !== turnKey) {
				requestId = createMessageId();
				turnKey = key;
			}
			return requestId;
		},
		reset(): void {
			sessionId = undefined;
			requestId = undefined;
			turnKey = undefined;
		},
	};
}
