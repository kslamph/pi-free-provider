import { describe, expect, it, vi } from "vitest";
import {
	formatAuthorization,
	isTokenStale,
	refreshClineToken,
	runDeviceFlow,
	validateCredential,
} from "./auth.ts";
import type { Credential } from "./state.ts";

const HEADERS = { "X-CLIENT-TYPE": "cline-cli", "User-Agent": "Cline/3.0.65" };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("formatAuthorization", () => {
	it("sends an API key verbatim as bearer", () => {
		expect(formatAuthorization({ mode: "apiKey", apiKey: "sk-x" })).toBe("Bearer sk-x");
	});

	it("prefixes a raw oauth access token with workos: exactly once", () => {
		expect(formatAuthorization({ mode: "oauth", accessToken: "jwt-abc" })).toBe("Bearer workos:jwt-abc");
		expect(formatAuthorization({ mode: "oauth", accessToken: "workos:jwt-abc" })).toBe("Bearer workos:jwt-abc");
	});
});

describe("isTokenStale", () => {
	it("treats a missing access token as stale", () => {
		expect(isTokenStale({ mode: "oauth", refreshToken: "r" })).toBe(true);
	});

	it("refreshes inside the 5-minute buffer, keeps tokens with more headroom, and ignores unknown expiry", () => {
		const now = Date.now();
		expect(isTokenStale({ mode: "oauth", accessToken: "a", expiresAt: now + 4 * 60_000 })).toBe(true);
		expect(isTokenStale({ mode: "oauth", accessToken: "a", expiresAt: now + 10 * 60_000 })).toBe(false);
		expect(isTokenStale({ mode: "oauth", accessToken: "a" })).toBe(false);
	});
});

describe("validateCredential", () => {
	it("rejects a 401 with the status", async () => {
		const fetcher: typeof fetch = async () => jsonResponse({ error: "Unauthorized" }, 401);
		const result = await validateCredential({ mode: "apiKey", apiKey: "sk-x" }, HEADERS, fetcher);
		expect(result).toEqual({ ok: false, status: 401 });
	});

	it("accepts a 200 and stores the account", async () => {
		const fetcher: typeof fetch = async () =>
			jsonResponse({ data: { id: "usr-1", email: "a@b.c" } }, 200);
		const result = await validateCredential({ mode: "apiKey", apiKey: "sk-x" }, HEADERS, fetcher);
		expect(result).toEqual({ ok: true, account: { id: "usr-1", email: "a@b.c" } });
	});
});

describe("refreshClineToken", () => {
	it("returns the rotated token pair", async () => {
		const fetcher: typeof fetch = async () =>
			jsonResponse({ success: true, data: { accessToken: "new-a", refreshToken: "new-r", expiresAt: "2026-09-27T12:00:00Z" } });
		const update = await refreshClineToken("old-r", HEADERS, fetcher);
		expect(update).toEqual({
			accessToken: "new-a",
			refreshToken: "new-r",
			expiresAt: Date.parse("2026-09-27T12:00:00Z"),
		});
	});

	it("rejects a response without tokens", async () => {
		const fetcher: typeof fetch = async () => jsonResponse({ success: true, data: {} });
		await expect(refreshClineToken("r", HEADERS, fetcher)).rejects.toThrow(/refresh/i);
	});

	it("is single-flight per refresh token", async () => {
		let calls = 0;
		const fetcher: typeof fetch = async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 20));
			return jsonResponse({ success: true, data: { accessToken: "a", refreshToken: "r2" } });
		};
		const [one, two] = await Promise.all([
			refreshClineToken("shared", HEADERS, fetcher),
			refreshClineToken("shared", HEADERS, fetcher),
		]);
		expect(calls).toBe(1);
		expect(one).toEqual(two);
	});
});

describe("runDeviceFlow", () => {
	it("walks authorize → poll(pending → ok) → register and returns an oauth credential", async () => {
		const statuses: string[] = [];
		let poll = 0;
		const fetcher: typeof fetch = async (input, init) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/user_management/authorize/device")) {
				expect(String(init?.body)).toContain("client_01K3A541FN8TA3EPPHTD2325AR");
				return jsonResponse({
					device_code: "dc-1",
					user_code: "ABCD-EFGH",
					verification_uri: "https://auth.workos.com/activate",
					verification_uri_complete: "https://auth.workos.com/activate?user_code=ABCD-EFGH",
					expires_in: 300,
					interval: 1,
				});
			}
			if (url.includes("/user_management/authenticate")) {
				poll++;
				if (poll === 1) return jsonResponse({ error: "authorization_pending" }, 400);
				return jsonResponse({ access_token: "wo-a", refresh_token: "wo-r" });
			}
			if (url.includes("/api/v1/auth/register")) {
				return jsonResponse({ success: true, data: { accessToken: "cl-a", refreshToken: "cl-r", expiresAt: "2026-09-27T13:00:00Z" } });
			}
			return jsonResponse({ error: "unexpected" }, 500);
		};
		const sleep = vi.fn().mockResolvedValue(undefined);
		const cred = await runDeviceFlow(HEADERS, { fetcher, onStatus: (m) => statuses.push(m), sleepFn: sleep });
		expect(cred.mode).toBe("oauth");
		expect(cred.accessToken).toBe("cl-a");
		expect(cred.refreshToken).toBe("cl-r");
		expect(cred.expiresAt).toBe(Date.parse("2026-09-27T13:00:00Z"));
		expect(statuses.some((m) => m.includes("ABCD-EFGH"))).toBe(true);
		expect(sleep).toHaveBeenCalled();
	});

	it("throws on access_denied", async () => {
		const fetcher: typeof fetch = async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("authorize/device"))
				return jsonResponse({ device_code: "dc", user_code: "U", verification_uri: "https://x", interval: 1, expires_in: 60 });
			if (url.includes("authenticate")) return jsonResponse({ error: "access_denied" }, 400);
			return jsonResponse({}, 500);
		};
		await expect(
			runDeviceFlow(HEADERS, { fetcher, sleepFn: vi.fn().mockResolvedValue(undefined), now: () => 1_000 }),
		).rejects.toThrow(/access_denied|denied/i);
	});
});
