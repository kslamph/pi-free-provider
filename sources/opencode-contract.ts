/**
 * The zenfree request contract (spec §zen-3).
 *
 * OpenCode's client contract is client-side constants plus one live version
 * number from the official update service. Unlike clinefree there is no
 * source-file extraction: the version comes from
 * `https://opencode.ai/update/api/latest/cli` (npm registry and GitHub
 * releases do not carry the 2.x line — verified 2026-09-27), with a
 * baked-in, live-verified fallback when the service is unreachable.
 */

import { compareSemver } from "../github.ts";

export const UPDATE_API_URL = "https://opencode.ai/update/api/latest/cli";
export const DEFAULT_ZEN_BASE_URL = "https://opencode.ai/inference/openai/v1";
/** The free tier 426-rejects User-Agent versions below this (observed live 2026-09-17). */
export const MIN_CLI_VERSION = "1.17.0";
const BAKED_CLI_VERSION = "2.0.18";

export interface ZenContractResult {
	baseUrl: string;
	headers: Record<string, string>;
	versions: { cli: string };
	source: "update-api" | "config" | "baked-in";
	warning?: string;
}

export const BAKED_IN_ZEN_CONTRACT: ZenContractResult = {
	baseUrl: DEFAULT_ZEN_BASE_URL,
	headers: {
		"x-opencode-client": "cli",
		"User-Agent": `opencode/latest/${BAKED_CLI_VERSION}/cli`,
	},
	versions: { cli: BAKED_CLI_VERSION },
	source: "baked-in",
};

/**
 * Latest official CLI version from the update service: prefer the npm
 * distribution artifact, else the first active one. Undefined on any
 * failure — the caller falls back to the baked-in version.
 */
export async function resolveLatestCliVersion(fetcher: typeof fetch = fetch): Promise<string | undefined> {
	try {
		const response = await fetcher(UPDATE_API_URL);
		if (!response.ok) return undefined;
		const payload = (await response.json()) as { artifacts?: { distribution?: string; version?: string; active?: boolean }[] };
		const artifacts = Array.isArray(payload?.artifacts) ? payload.artifacts : [];
		const pick =
			artifacts.find((a) => a?.distribution === "npm" && typeof a.version === "string") ??
			artifacts.find((a) => a?.active !== false && typeof a.version === "string");
		return pick?.version;
	} catch {
		return undefined;
	}
}

function isSemver(version: string): boolean {
	return /^\d+\.\d+\.\d+/.test(version);
}

/**
 * Build the contract for a resolved version. The baked-in version wins when
 * the resolved one is missing, malformed, or below the live-verified floor
 * (a stale UA draws HTTP 426 — never send one on purpose).
 */
export function buildZenContract(version: string | undefined, baseUrl?: string): ZenContractResult {
	const usable = version !== undefined && isSemver(version) && compareSemver(version, BAKED_CLI_VERSION) >= 0;
	if (!usable) {
		const warning =
			version === undefined
				? "zenfree: update service unreachable; using baked-in client version"
				: `zenfree: resolved client version "${version}" is malformed or older than the baked-in ${BAKED_CLI_VERSION}; using baked-in`;
		return { ...BAKED_IN_ZEN_CONTRACT, ...(baseUrl !== undefined ? { baseUrl } : {}), warning };
	}
	return {
		baseUrl: baseUrl ?? DEFAULT_ZEN_BASE_URL,
		headers: {
			"x-opencode-client": "cli",
			"User-Agent": `opencode/latest/${version}/cli`,
		},
		versions: { cli: version },
		source: baseUrl !== undefined ? "config" : "update-api",
	};
}
