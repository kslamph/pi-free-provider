/**
 * The request contract with api.cline.bot: the header set the official Cline
 * CLI sends, the lineup endpoint path, and the version strings that go into
 * the versioned headers.
 *
 * The contract is normally extracted at runtime from the cline/cline GitHub
 * repo (pinned at the latest release tags). When extraction fails — upstream
 * reshaped the source — the baked-in snapshot below is used and the caller is
 * warned, per the spec (§3 decision 5, §9).
 */

export interface ContractResult {
	/** Full header set for api.cline.bot requests (incl. User-Agent/version headers). */
	headers: Record<string, string>;
	/** Path of the lineup endpoint relative to https://api.cline.bot. */
	endpointPath: string;
	cliVersion: string;
	coreVersion: string;
	source: "github" | "baked-in";
	/** Set iff source is "baked-in" — surfaced to the user once per sync. */
	warning?: string;
}

export const CLINE_CLIENT_TYPE = "cline-cli";
export const CLINE_PLATFORM = "cli";

/** Header set captured from the official Cline CLI (verified live 2026-09-27). */
export const BAKED_IN_CONTRACT: ContractResult = {
	headers: {
		"HTTP-Referer": "https://cline.bot",
		"X-Title": "Cline",
		"X-IS-MULTIROOT": "false",
		"X-CLIENT-TYPE": CLINE_CLIENT_TYPE,
		"User-Agent": "Cline/3.0.65",
		"X-CLIENT-VERSION": "3.0.65",
		"X-PLATFORM": CLINE_PLATFORM,
		"X-PLATFORM-VERSION": "3.0.65",
		"X-CORE-VERSION": "0.0.86",
	},
	endpointPath: "/api/v1/ai/cline/recommended-models",
	cliVersion: "3.0.65",
	coreVersion: "0.0.86",
	source: "baked-in",
};

/** Client identity headers derived from the resolved version strings. */
function derivedHeaders(cli: string, core: string): Record<string, string> {
	return {
		"User-Agent": `Cline/${cli}`,
		"X-CLIENT-TYPE": CLINE_CLIENT_TYPE,
		"X-CLIENT-VERSION": cli,
		"X-PLATFORM": CLINE_PLATFORM,
		"X-PLATFORM-VERSION": cli,
		"X-CORE-VERSION": core,
	};
}

/**
 * Extract the `DEFAULT_CLINE_REQUEST_HEADERS` object literal from
 * request-headers.ts source text. Tolerant of bare keys and trailing commas;
 * throws when the literal cannot be found or parsed.
 */
export function extractDefaultHeaders(source: string): Record<string, string> {
	const marker = source.indexOf("DEFAULT_CLINE_REQUEST_HEADERS");
	if (marker < 0) throw new Error("DEFAULT_CLINE_REQUEST_HEADERS not found");
	const start = source.indexOf("{", marker);
	if (start < 0) throw new Error("header literal has no object body");
	let depth = 0;
	let end = -1;
	for (let i = start; i < source.length; i++) {
		const c = source[i];
		if (c === "{") depth++;
		else if (c === "}") {
			depth--;
			if (depth === 0) {
				end = i + 1;
				break;
			}
		}
	}
	if (end < 0) throw new Error("header literal is unbalanced");
	let body = source.slice(start, end);
	// Tolerant parse: quote bare identifier keys, strip trailing commas.
	body = body
		.replace(/^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/gm, '$1"$2":')
		.replace(/,(\s*[}\]])/g, "$1");
	const parsed = JSON.parse(body) as unknown;
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("header literal parsed to a non-object");
	}
	const headers: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === "string") headers[key] = value;
	}
	if (Object.keys(headers).length === 0) throw new Error("header literal is empty");
	return headers;
}

/** Extract the recommended-models endpoint path from catalog-cline-recommended.ts source text. */
export function extractEndpointPath(source: string): string {
	const match = /\/api\/v[0-9]+\/ai\/cline\/recommended-models/.exec(source);
	if (!match) throw new Error("recommended-models endpoint path not found");
	return match[0];
}

/**
 * Build the contract from downloaded upstream source. Any failure falls back
 * to the baked-in snapshot with a warning — never throws.
 */
export function extractContract(
	files: { requestHeaders?: string; clientHeaders?: string; recommended?: string },
	versions: { cli: string; core: string },
): ContractResult {
	try {
		const base = extractDefaultHeaders(files.requestHeaders ?? "");
		const endpointPath = extractEndpointPath(files.recommended ?? "");
		return {
			headers: { ...base, ...derivedHeaders(versions.cli, versions.core) },
			endpointPath,
			cliVersion: versions.cli,
			coreVersion: versions.core,
			source: "github",
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		return {
			...BAKED_IN_CONTRACT,
			warning: `clinefree: contract extraction failed (${reason}); using baked-in snapshot`,
		};
	}
}
