/**
 * Live smoke test for clinefree (never run in CI). Exercises the real path:
 * credential validation, contract extraction from GitHub, the live lineup,
 * both capability feeds, per-model resolution, and one tiny chat request.
 *
 * Usage: CLINEFREE_SMOKE_KEY=sk-… node --experimental-strip-types smoke.ts
 * Exits 2 without the env var, 1 on any failed step.
 */

import { validateCredential } from "./auth.ts";
import { DEFAULT_CAPABILITIES, resolveCapabilities } from "./capabilities.ts";
import { fetchModelsDevOpenRouter, fetchVercelGateway } from "./feeds.ts";
import { createClineSource } from "./sources/cline.ts";
import { fmtTokens } from "./tui.ts";

const key = process.env.CLINEFREE_SMOKE_KEY;
if (!key) {
	console.error("refusing to run: set CLINEFREE_SMOKE_KEY (never commit the key)");
	process.exit(2);
}

let failures = 0;
function report(name: string, ok: boolean, detail: string): void {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const source = createClineSource();

// 1. Credential
let account = "";
try {
	const result = await validateCredential({ mode: "apiKey", apiKey: key }, (await source.refreshContract(true)).headers);
	account = result.ok ? (result.account.email ?? "unknown email") : "";
	report("validateCredential (users/me)", result.ok, result.ok ? account : `HTTP ${result.status}`);
} catch (error) {
	report("validateCredential (users/me)", false, error instanceof Error ? error.message : String(error));
}

// 2. Contract from GitHub
const contract = await source.refreshContract(true);
report("contract extraction", contract.source === "github", `${contract.source} · cli ${contract.cliVersion} · core ${contract.coreVersion}${contract.warning ? ` · ${contract.warning}` : ""}`);

// 3. Live lineup
const lineup = await source.fetchLineup();
report("lineup (recommended-models free[])", lineup.length > 0, lineup.map((e) => e.id).join(", "));

// 4. Capability feeds + resolution
const [openrouter, vercel] = await Promise.all([fetchModelsDevOpenRouter(), fetchVercelGateway()]);
report("models.dev openrouter feed", Object.keys(openrouter).length > 0, `${Object.keys(openrouter).length} models`);
report("vercel gateway feed", Object.keys(vercel).length > 0, `${Object.keys(vercel).length} models`);
console.log("\nmodel capabilities:");
for (const entry of lineup) {
	const caps = resolveCapabilities(entry.id, openrouter, vercel);
	const marker = caps.source === "default" ? "  ← DEFAULTS (no feed hit)" : "";
	console.log(
		`  ${entry.id.padEnd(42)} ${caps.source.padEnd(10)} ctx ${fmtTokens(caps.source === "default" ? DEFAULT_CAPABILITIES.contextWindow : caps.contextWindow)} / out ${fmtTokens(caps.source === "default" ? DEFAULT_CAPABILITIES.maxTokens : caps.maxTokens)} · ${caps.input.join("+")}${marker}`,
	);
}

// 5. One tiny chat through the free route
try {
	const response = await fetch("https://api.cline.bot/api/v1/chat/completions", {
		method: "POST",
		headers: { ...contract.headers, "Content-Type": "application/json", Authorization: `Bearer ${key}` },
		body: JSON.stringify({
			model: "cline-free/mimo-v2.6-flash",
			messages: [{ role: "user", content: "reply with the single word: pong" }],
			max_tokens: 256,
		}),
		signal: AbortSignal.timeout(60_000),
	});
	const payload = (await response.json().catch(() => ({}))) as { data?: { choices?: { message?: { content?: string } }[] } };
	const content = payload.data?.choices?.[0]?.message?.content ?? "";
	report("chat (cline-free/mimo-v2.6-flash)", response.ok && content.length > 0, `HTTP ${response.status} · ${JSON.stringify(content.slice(0, 40))}`);
} catch (error) {
	report("chat (cline-free/mimo-v2.6-flash)", false, error instanceof Error ? error.message : String(error));
}

console.log(`\n${failures === 0 ? "ALL STEPS PASSED" : `${failures} STEP(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
