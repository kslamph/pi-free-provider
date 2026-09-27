import { describe, expect, it } from "vitest";
import {
	ALPHABET,
	createConversationIdentity,
	createIdentifier,
	createMessageId,
	createSessionId,
	turnKeyOf,
} from "./opencode-identity.ts";

const HEX = /^[0-9a-f]{12}$/;
const B62 = new RegExp(`^[${ALPHABET}]{14}$`);

describe("createIdentifier", () => {
	it("produces 12 lowercase-hex + 14 base62 chars", () => {
		const id = createIdentifier(false, 1_700_000_000_000);
		expect(id).toHaveLength(26);
		expect(id.slice(0, 12)).toMatch(HEX);
		expect(id.slice(12)).toMatch(B62);
	});

	it("increments the counter within the same millisecond", () => {
		const a = createIdentifier(false, 1234);
		const b = createIdentifier(false, 1234);
		const na = BigInt(`0x${a.slice(0, 12)}`);
		const nb = BigInt(`0x${b.slice(0, 12)}`);
		expect(nb - na).toBe(1n);
	});

	it("descending ids for newer timestamps sort first (bitwise NOT flips order)", () => {
		const old1 = createIdentifier(true, 1_700_000_000_000);
		const old2 = createIdentifier(true, 1_700_000_000_000);
		const newer = createIdentifier(true, 1_700_000_000_001);
		expect(newer < old1).toBe(true);
		expect(newer < old2).toBe(true);
		const ascOld = createIdentifier(false, 1_700_000_000_000);
		const ascNew = createIdentifier(false, 1_700_000_000_001);
		expect(ascNew > ascOld).toBe(true);
	});
});

describe("id formats", () => {
	it("session ids are ses_ + descending identifier", () => {
		const ses = createSessionId();
		expect(ses).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	});

	it("message ids are msg_ + ascending identifier", () => {
		const msg = createMessageId();
		expect(msg).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
	});
});

describe("turnKeyOf", () => {
	it("is stable across rebuilt message objects with the same timestamp and content", () => {
		const a = turnKeyOf([{ role: "user", timestamp: 5, content: "hello" }]);
		const b = turnKeyOf([{ role: "assistant", timestamp: 6, content: "hi" }, { role: "user", timestamp: 5, content: "hello" }]);
		expect(a).toBeDefined();
		expect(a).toBe(b);
	});

	it("differs when the last user content differs", () => {
		const a = turnKeyOf([{ role: "user", timestamp: 5, content: "hello" }]);
		const b = turnKeyOf([{ role: "user", timestamp: 5, content: "hellp" }]);
		expect(a).not.toBe(b);
	});

	it("is undefined with no user message", () => {
		expect(turnKeyOf([{ role: "assistant", timestamp: 6, content: "hi" }])).toBeUndefined();
		expect(turnKeyOf([])).toBeUndefined();
	});
});

describe("createConversationIdentity", () => {
	it("reuses one session id, keys request ids to turns, and reset forgets", () => {
		const conv = createConversationIdentity();
		const s1 = conv.sessionId();
		expect(conv.sessionId()).toBe(s1);

		const r1 = conv.requestId("turn-a");
		expect(conv.requestId("turn-a")).toBe(r1);
		const r2 = conv.requestId("turn-b");
		expect(r2).not.toBe(r1);

		conv.reset();
		expect(conv.sessionId()).not.toBe(s1);
		expect(conv.requestId("turn-a")).not.toBe(r1);
	});

	it("a missing turn key mints fresh request ids without disturbing the cached turn", () => {
		const conv = createConversationIdentity();
		const cached = conv.requestId("turn-a");
		const probe = conv.requestId(undefined);
		expect(probe).toMatch(/^msg_/);
		expect(conv.requestId("turn-a")).toBe(cached);
	});
});
