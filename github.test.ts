import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fetchRawAtSha, resolveLatestTag, TAG_PREFIXES } from "./github.ts";

const fixture = readFileSync(join(import.meta.dirname, "test-fixtures", "matching-refs-cli.json"), "utf8");

function stubFetcher(body: string, status = 200) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const url = typeof input === "string" ? input : input.toString();
		calls.push({ url, init });
		return new Response(body, { status, headers: { "content-type": "application/json" } });
	};
	return { fetcher, calls };
}

describe("resolveLatestTag", () => {
	it("picks the semver-max tag, not the lexicographic max (cli-v3.0.65 beats cli-v3.0.8)", async () => {
		const { fetcher, calls } = stubFetcher(fixture);
		const result = await resolveLatestTag(TAG_PREFIXES.cli, fetcher);
		expect(result).toEqual({ tag: "cli-v3.0.65", sha: "8668e030c11fbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
		expect(calls[0]?.url).toBe("https://api.github.com/repos/cline/cline/git/matching-refs/tags/cli-v");
	});

	it("resolves the sdk/llms stream against its own prefix", async () => {
		const { fetcher, calls } = stubFetcher(
			JSON.stringify([
				{ ref: "refs/tags/sdk/llms/v0.0.9", object: { sha: "a", type: "commit" } },
				{ ref: "refs/tags/sdk/llms/v0.0.86", object: { sha: "b", type: "commit" } },
			]),
		);
		const result = await resolveLatestTag(TAG_PREFIXES.llms, fetcher);
		expect(result.tag).toBe("sdk/llms/v0.0.86");
		expect(calls[0]?.url).toContain("matching-refs/tags/sdk/llms/v");
	});

	it("throws on an empty ref list", async () => {
		const { fetcher } = stubFetcher("[]");
		await expect(resolveLatestTag(TAG_PREFIXES.cli, fetcher)).rejects.toThrow(/no tags/i);
	});

	it("throws on a non-200 response", async () => {
		const { fetcher } = stubFetcher("{}", 403);
		await expect(resolveLatestTag(TAG_PREFIXES.cli, fetcher)).rejects.toThrow(/403/);
	});

	it("dereferences annotated tags to their commit SHA", async () => {
		const bodies = new Map<string, string>([
			[
				"https://api.github.com/repos/cline/cline/git/matching-refs/tags/sdk/llms/v",
				JSON.stringify([
					// annotated tag: object points at the TAG object, not the commit
					{ ref: "refs/tags/sdk/llms/v0.0.86", object: { sha: "tag-object-sha", type: "tag" } },
				]),
			],
			[
				"https://api.github.com/repos/cline/cline/git/tags/tag-object-sha",
				JSON.stringify({ object: { sha: "real-commit-sha", type: "commit" } }),
			],
		]);
		const fetcher: typeof fetch = async (input) => {
			const url = typeof input === "string" ? input : input.toString();
			return new Response(bodies.get(url) ?? "{}", { status: 200, headers: { "content-type": "application/json" } });
		};
		const result = await resolveLatestTag(TAG_PREFIXES.llms, fetcher);
		expect(result).toEqual({ tag: "sdk/llms/v0.0.86", sha: "real-commit-sha" });
	});
});

describe("fetchRawAtSha", () => {
	it("fetches raw.githubusercontent at the SHA and returns the body", async () => {
		const { fetcher, calls } = stubFetcher("export const X = 1;");
		const body = await fetchRawAtSha("deadbeef", "sdk/packages/llms/src/providers/request-headers.ts", fetcher);
		expect(body).toBe("export const X = 1;");
		expect(calls[0]?.url).toBe(
			"https://raw.githubusercontent.com/cline/cline/deadbeef/sdk/packages/llms/src/providers/request-headers.ts",
		);
	});

	it("throws with the status on a non-200 response", async () => {
		const { fetcher } = stubFetcher("not found", 404);
		await expect(fetchRawAtSha("x", "p", fetcher)).rejects.toThrow(/404/);
	});
});
