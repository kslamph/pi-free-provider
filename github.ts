/**
 * GitHub access for the clinefree contract: resolve the newest release tag per
 * artifact stream and fetch raw files at the tag's commit SHA (immutable).
 *
 * The `git/matching-refs` API returns refs in lexicographic order — where
 * `cli-v3.0.8` sorts after `cli-v3.0.65` — so tags are compared semver-style.
 */

export const GITHUB_API_BASE = "https://api.github.com/repos/cline/cline/git/matching-refs";
export const RAW_BASE = "https://raw.githubusercontent.com/cline/cline";

export const TAG_PREFIXES = {
	llms: "tags/sdk/llms/v",
	core: "tags/sdk/core/v",
	cli: "tags/cli-v",
} as const;

export interface ResolvedTag {
	/** Tag name without the `refs/tags/` prefix, e.g. `cli-v3.0.65`. */
	tag: string;
	/** Commit SHA the tag points at (used for immutable raw fetches). */
	sha: string;
}

interface MatchingRef {
	ref?: string;
	object?: { sha?: string };
}

/** Compare two dotted version strings numerically; returns >0 when a > b. */
export function compareSemver(a: string, b: string): number {
	const pa = a.split(/[./]/).map((p) => Number.parseInt(p, 10) || 0);
	const pb = b.split(/[./]/).map((p) => Number.parseInt(p, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Extract the version suffix after the last `v` in a tag, e.g. `cli-v3.0.65` → `3.0.65`. */
function versionOf(tag: string): string {
	const idx = tag.lastIndexOf("v");
	return idx >= 0 ? tag.slice(idx + 1) : tag;
}

/**
 * Resolve the semver-newest tag under a ref prefix.
 * `prefix` is the matching-refs path segment, e.g. `tags/cli-v`.
 */
export async function resolveLatestTag(prefix: string, fetcher: typeof fetch = fetch): Promise<ResolvedTag> {
	const response = await fetcher(`${GITHUB_API_BASE}/${prefix}`);
	if (!response.ok) {
		throw new Error(`tag resolution failed for ${prefix}: HTTP ${response.status}`);
	}
	const refs = (await response.json().catch(() => [])) as MatchingRef[];
	const tags = refs
		.filter((r) => typeof r.ref === "string" && r.ref.startsWith("refs/tags/") && typeof r.object?.sha === "string")
		.map((r) => ({ tag: r.ref!.slice("refs/tags/".length), sha: r.object!.sha! }));
	if (tags.length === 0) {
		throw new Error(`no tags found under ${prefix}`);
	}
	tags.sort((a, b) => compareSemver(versionOf(a.tag), versionOf(b.tag)));
	return tags[tags.length - 1]!;
}

/** Fetch a raw file content at an immutable commit SHA. */
export async function fetchRawAtSha(sha: string, path: string, fetcher: typeof fetch = fetch): Promise<string> {
	const response = await fetcher(`${RAW_BASE}/${sha}/${path}`);
	if (!response.ok) {
		throw new Error(`raw fetch failed for ${path}@${sha.slice(0, 7)}: HTTP ${response.status}`);
	}
	return response.text();
}
