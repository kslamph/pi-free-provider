/**
 * Cline account authentication (spec §7): a pasted API key or the WorkOS
 * device flow, both sent as `Authorization: Bearer …` (verified live:
 * `x-api-key` is rejected). OAuth access tokens get the `workos:` prefix,
 * idempotently. Refresh tokens rotate on every refresh and must be persisted.
 *
 * Endpoint semantics ported from pi-multikey/cline-auth.ts (itself ported from
 * cline core auth, production environment).
 */

import type { Credential } from "./state.ts";

const WORKOS_API_BASE_URL = "https://api.workos.com";
const WORKOS_DEVICE_AUTHORIZATION_PATH = "/user_management/authorize/device";
const WORKOS_AUTHENTICATE_PATH = "/user_management/authenticate";
/** WorkOS client id of the official Cline CLI (production environment). */
export const WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

const CLINE_API_BASE_URL = "https://api.cline.bot";
const CLINE_REGISTER_PATH = "/api/v1/auth/register";
const CLINE_REFRESH_PATH = "/api/v1/auth/refresh";
const CLINE_USERS_ME_PATH = "/api/v1/users/me";

const REQUEST_TIMEOUT_MS = 30_000;
const DEVICE_AUTH_EXPIRES_IN_SECONDS = 300;
const DEVICE_AUTH_INTERVAL_SECONDS = 5;
/** Refresh this long before expiry so requests never race the clock. */
export const REFRESH_BUFFER_MS = 5 * 60_000;

const WORKOS_PREFIX = "workos:";

function clineAuthHeaders(contractHeaders: Record<string, string>): Record<string, string> {
	return { ...contractHeaders, "Content-Type": "application/json" };
}

/** Authorization header value for the credential (never includes unrelated headers). */
export function formatAuthorization(cred: Credential): string {
	if (cred.mode === "apiKey") return `Bearer ${cred.apiKey ?? ""}`;
	const token = (cred.accessToken ?? "").trim();
	const prefixed = token.toLowerCase().startsWith(WORKOS_PREFIX) ? token : `${WORKOS_PREFIX}${token}`;
	return `Bearer ${prefixed}`;
}

/** True when the stored access token is missing, expired, or inside the refresh buffer. */
export function isTokenStale(cred: Credential, bufferMs = REFRESH_BUFFER_MS): boolean {
	if (!cred.accessToken) return true;
	if (cred.expiresAt === undefined) return false;
	return cred.expiresAt - Date.now() <= bufferMs;
}

export type ValidationResult =
	| { ok: true; account: { id?: string; email?: string } }
	| { ok: false; status: number };

/** Cheap credential check via GET /users/me — consumes no model quota. */
export async function validateCredential(
	cred: Credential,
	contractHeaders: Record<string, string>,
	fetcher: typeof fetch = fetch,
): Promise<ValidationResult> {
	const response = await fetcher(`${CLINE_API_BASE_URL}${CLINE_USERS_ME_PATH}`, {
		headers: { ...contractHeaders, Authorization: formatAuthorization(cred) },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!response.ok) return { ok: false, status: response.status };
	const payload = (await response.json().catch(() => ({}))) as { data?: { id?: string; email?: string } };
	return { ok: true, account: { id: payload.data?.id, email: payload.data?.email } };
}

export interface ClineTokenUpdate {
	accessToken: string;
	refreshToken: string;
	expiresAt?: number;
}

interface ClineTokenResponse {
	success?: boolean;
	data?: { accessToken?: string; refreshToken?: string; expiresAt?: string };
}

function requireTokens(payload: ClineTokenResponse, message: string): ClineTokenUpdate {
	const data = payload.data;
	const accessToken = data?.accessToken;
	const refreshToken = data?.refreshToken;
	if (!payload.success || !data || !accessToken || !refreshToken) throw new Error(message);
	const expiresAt = data.expiresAt ? Date.parse(data.expiresAt) : undefined;
	return { accessToken, refreshToken, ...(expiresAt !== undefined && Number.isFinite(expiresAt) ? { expiresAt } : {}) };
}

// Single-flight per refresh token: concurrent subagents hitting the same
// account must share one in-flight refresh instead of racing each other.
const inFlight = new Map<string, Promise<ClineTokenUpdate>>();

/** Exchange a refresh token for a fresh access (+ rotated refresh) token. */
export async function refreshClineToken(
	refreshToken: string,
	contractHeaders: Record<string, string>,
	fetcher: typeof fetch = fetch,
): Promise<ClineTokenUpdate> {
	const existing = inFlight.get(refreshToken);
	if (existing) return existing;
	const task = (async () => {
		const response = await fetcher(`${CLINE_API_BASE_URL}${CLINE_REFRESH_PATH}`, {
			method: "POST",
			headers: clineAuthHeaders(contractHeaders),
			body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Cline token refresh failed: HTTP ${response.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
		}
		const payload = (await response.json().catch(() => ({}))) as ClineTokenResponse;
		return requireTokens(payload, "Invalid Cline token refresh response");
	})().finally(() => {
		inFlight.delete(refreshToken);
	});
	inFlight.set(refreshToken, task);
	return task;
}

interface WorkOSDeviceAuthorizationResponse {
	device_code?: string;
	user_code?: string;
	verification_uri?: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
	error?: string;
	error_description?: string;
}

interface WorkOSTokenResponse {
	access_token?: string;
	refresh_token?: string;
	error?: string;
	error_description?: string;
}

export interface DeviceFlowOptions {
	fetcher?: typeof fetch;
	onStatus?: (message: string) => void;
	/** Injectable for tests. */
	sleepFn?: (ms: number) => Promise<void>;
	now?: () => number;
}

const defaultSleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Interactive sign-in: WorkOS device authorization → poll → exchange WorkOS
 * tokens for Cline tokens via /api/v1/auth/register.
 */
export async function runDeviceFlow(
	contractHeaders: Record<string, string>,
	options: DeviceFlowOptions = {},
): Promise<Credential> {
	const fetcher = options.fetcher ?? fetch;
	const onStatus = options.onStatus ?? (() => {});
	const sleep = options.sleepFn ?? defaultSleep;
	const now = options.now ?? Date.now;

	const authorize = await fetcher(`${WORKOS_API_BASE_URL}${WORKOS_DEVICE_AUTHORIZATION_PATH}`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ client_id: WORKOS_CLIENT_ID }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const device = (await authorize.json().catch(() => ({}))) as WorkOSDeviceAuthorizationResponse;
	if (!authorize.ok || !device.device_code || !device.user_code || !device.verification_uri) {
		const detail = device.error_description ?? (authorize.ok ? "invalid WorkOS response" : `HTTP ${authorize.status}`);
		throw new Error(`Cline device authorization failed: ${detail}`);
	}
	onStatus(`Open ${device.verification_uri_complete ?? device.verification_uri} and enter code ${device.user_code}`);

	const deadline = now() + (device.expires_in ?? DEVICE_AUTH_EXPIRES_IN_SECONDS) * 1000;
	let intervalSeconds = Math.max(1, device.interval ?? DEVICE_AUTH_INTERVAL_SECONDS);
	let workosTokens: { access: string; refresh: string } | undefined;

	while (now() <= deadline) {
		const poll = await fetcher(`${WORKOS_API_BASE_URL}${WORKOS_AUTHENTICATE_PATH}`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: device.device_code,
				client_id: WORKOS_CLIENT_ID,
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		const payload = (await poll.json().catch(() => ({}))) as WorkOSTokenResponse;
		if (poll.ok) {
			if (!payload.access_token || !payload.refresh_token) throw new Error("Invalid WorkOS token response");
			workosTokens = { access: payload.access_token, refresh: payload.refresh_token };
			break;
		}
		switch (payload.error) {
			case "authorization_pending":
				onStatus("Waiting for browser authentication confirmation…");
				await sleep(intervalSeconds * 1000);
				break;
			case "slow_down":
				intervalSeconds += 1;
				await sleep(intervalSeconds * 1000);
				break;
			case "access_denied":
			case "expired_token":
			case "invalid_grant":
				throw new Error(`Cline authorization failed: ${payload.error_description ?? payload.error}`);
			default:
				throw new Error(`WorkOS token polling failed: HTTP ${poll.status}${payload.error_description ? ` — ${payload.error_description}` : ""}`);
		}
	}
	if (!workosTokens) throw new Error("WorkOS device authorization timed out");

	const register = await fetcher(`${CLINE_API_BASE_URL}${CLINE_REGISTER_PATH}`, {
		method: "POST",
		headers: clineAuthHeaders(contractHeaders),
		body: JSON.stringify({ accessToken: workosTokens.access, refreshToken: workosTokens.refresh }),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!register.ok) {
		const text = await register.text().catch(() => "");
		throw new Error(`Cline token registration failed: HTTP ${register.status}${text ? ` — ${text.slice(0, 200)}` : ""}`);
	}
	const tokens = requireTokens((await register.json().catch(() => ({}))) as ClineTokenResponse, "Invalid Cline token registration response");
	return {
		mode: "oauth",
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
	};
}
