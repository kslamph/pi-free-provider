/**
 * Live smoke test (never run in CI). Exercises the real path per source:
 * clinefree — credential validation, GitHub contract extraction, live lineup,
 * both capability feeds, per-model resolution, one tiny chat request.
 * zenfree — key validation, update-api contract, console-config lineup,
 * capability merge, transport split, one streaming agentic chat probe
 * (the free tier 403-rejects bare pings) and an optional Responses probe.
 *
 * Usage: CLINEFREE_SMOKE_KEY=sk-… ZENFREE_SMOKE_KEY=oc_sk_… node --experimental-strip-types smoke.ts
 * Exits 2 without either env var, 1 on any failed step.
 */

import { validateCredential, validateZenKey } from "./auth.ts";
import { DEFAULT_CAPABILITIES, resolveCapabilities } from "./capabilities.ts";
import { fetchModelsDevOpenRouter, fetchVercelGateway } from "./feeds.ts";
import { createClineSource } from "./sources/cline.ts";
import { createZenSource } from "./sources/opencode.ts";
import { createMessageId, createSessionId, zenProjectId } from "./sources/opencode-identity.ts";
import { createZenSidecar } from "./sidecar.ts";
import { fmtTokens } from "./tui.ts";

const key = process.env.CLINEFREE_SMOKE_KEY;
const zenKey = process.env.ZENFREE_SMOKE_KEY;
if (!key && !zenKey) {
	console.error("refusing to run: set CLINEFREE_SMOKE_KEY and/or ZENFREE_SMOKE_KEY (never commit keys)");
	process.exit(2);
}

let failures = 0;
function report(name: string, ok: boolean, detail: string): void {
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
/** Upstream outage (not a client error): the reasoning value wasn't exercised, so
 *  a wire-format probe should skip rather than fail. 400 invalid_request stays a failure. */
function isUpstreamUnavailable(status: number, text: string): boolean {
	return status >= 500 || /Endpoint is unavailable|"type":"server_error"/i.test(text);
}

const source = createClineSource();

if (key) {
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
}

// ── zenfree (OpenCode Zen) ────────────────────────────────────────────────────

if (zenKey) {
	const zenSource = createZenSource();

	// z1. Key validation
	try {
		const verdict = await validateZenKey(zenKey);
		report("validateZenKey (console config)", verdict === "ok", verdict);
	} catch (error) {
		report("validateZenKey (console config)", false, error instanceof Error ? error.message : String(error));
	}

	// z2. Contract via the official update service
	const zenContract = await zenSource.refreshContract(true);
	report(
		"zen contract (update api)",
		zenContract.source === "update-api" || zenContract.source === "config",
		`${zenContract.source} · ${zenContract.headers["User-Agent"]}${zenContract.warning ? ` · ${zenContract.warning}` : ""}`,
	);

	// z3. Live lineup + gateway facts from the console config
	const zenCred = { mode: "apiKey" as const, apiKey: zenKey };
	const zenLineup = await zenSource.fetchLineup(zenCred);
	const zenIds = zenLineup.map((e) => e.id);
	report(
		"zen lineup (config cost.input == 0)",
		zenIds.length > 0,
		`${zenIds.length} free · ${zenIds.join(", ")}`,
	);
	const gatewayBase = zenSource.configBaseUrl() ?? zenContract.baseUrl;
	report("zen gateway url", !!gatewayBase, `${gatewayBase}${zenSource.configBaseUrl() ? "" : " (from contract)"}`);
	const orgHeaders = zenSource.configHeaders();
	if (orgHeaders && Object.keys(orgHeaders).length > 0) {
		report("zen prescribed headers", true, Object.keys(orgHeaders).join(", "));
	}

	// z4. Capability merge per model + transport split
	await zenSource.refreshCapabilities(zenIds);
	console.log("\nzen model capabilities:");
	const responsesIds: string[] = [];
	for (const entry of zenLineup) {
		const caps = zenSource.resolveCapabilities(entry.id);
		const transport = zenSource.resolveTransport(entry.id);
		if (transport === "openai-responses") responsesIds.push(entry.id);
		console.log(
			`  ${entry.id.padEnd(38)} ${caps.source.padEnd(9)} ctx ${fmtTokens(caps.contextWindow)} / out ${fmtTokens(caps.maxTokens)} · ${caps.input.join("+")} · ${transport}${caps.source === "default" ? "  ← DEFAULTS" : ""}`,
		);
	}
	report("zen transport split", zenIds.length > 0, `${responsesIds.length} responses-transport: ${responsesIds.join(", ") || "none"}`);

	const keylessHeaders = (session: string) => ({
		"Content-Type": "application/json",
		Authorization: "Bearer public",
		...zenContract.headers,
		"x-opencode-session": session,
		"x-opencode-session-id": session,
		"x-session-affinity": session,
		"X-Session-Id": session,
		"x-opencode-project": zenProjectId(),
		"x-opencode-request": createMessageId(),
	});
	const keylessBody = (session: string) => ({
		stream: true,
		max_tokens: 256,
		stream_options: { include_usage: true },
		prompt_cache_key: session,
	});
	// z5b. Sidecar e2e — the same keyless shape through the Bun sidecar. Zen's
	//      gateway admits only Bun-shaped TLS clients (see sidecar.ts), so this
	//      is the transport the extension itself uses; the direct z5 probe above
	//      documents the 429 the TLS gate serves everything else.
	{
		const zenSidecar = createZenSidecar({ notify: (m) => console.log(`  [sidecar] ${m}`) });
		const sidecarBase = await zenSidecar.ensureSidecar();
		if (!sidecarBase) {
			report("zen chat (sidecar)", false, "sidecar unavailable (bun missing?) — the extension will fall back to direct requests");
		} else {
			// Free quota is metered per model, so probe up to three lineup models and
			// pass when any one streams; per-model 429s are reported, not hidden.
			const candidates = zenIds.filter((id) => !id.startsWith("muse-spark-")).slice(0, 3);
			const outcomes: string[] = [];
			let passed = false;
			for (const modelId of candidates) {
				if (passed) break;
				try {
					const session = createSessionId();
					const response = await fetch(`${sidecarBase}/v1/chat/completions`, {
						method: "POST",
						headers: keylessHeaders(session),
						body: JSON.stringify({
							model: modelId,
							messages: [{ role: "user", content: "reply with the single word: pong" }],
							...keylessBody(session),
							tools: ["read", "shell", "edit", "write"].map((name) => ({
								type: "function",
								function: { name, description: name, parameters: { type: "object", properties: {} } },
							})),
						}),
						signal: AbortSignal.timeout(60_000),
					});
					const text = await response.text();
					const ok = response.ok && text.includes("data:");
					outcomes.push(`${modelId}: HTTP ${response.status}`);
					if (ok) passed = true;
				} catch (error) {
					outcomes.push(`${modelId}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			report("zen chat (sidecar)", passed, outcomes.join(" · "));
		}
		zenSidecar.stop();
	}

	// z4b. Control — the pre-2026-10-24 keyed shape (workspace key + org-id, no
	//      v2.1 identity headers). Expected to draw the 429 FreeUsageLimitError
	//      that motivated the keyless switch; if it ever passes again, the
	//      workspace free allowance has recovered and the switch can be revisited.
	const completionsModel = zenIds.find((id) => !id.startsWith("muse-spark-"));
	if (completionsModel && zenSource.configBaseUrl()) {
		try {
			const response = await fetch(`${gatewayBase}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${zenKey}`,
					...zenContract.headers,
					...zenSource.configHeaders(),
					"x-opencode-session": createSessionId(),
					"x-opencode-request": createMessageId(),
				},
				body: JSON.stringify({
					model: completionsModel,
					messages: [{ role: "user", content: "reply with the single word: pong" }],
					stream: true,
					max_tokens: 256,
					tools: ["read", "shell", "edit", "write"].map((name) => ({
						type: "function",
						function: { name, description: name, parameters: { type: "object", properties: {} } },
					})),
				}),
				signal: AbortSignal.timeout(60_000),
			});
			const text = await response.text();
			const expected = response.status === 429 && /FreeUsageLimit/i.test(text);
			report(`zen control (keyed shape, expect 429)`, expected, `HTTP ${response.status} · ${text.slice(0, 90).replace(/\n/g, " ")}`);
		} catch (error) {
			report(`zen control (keyed shape, expect 429)`, false, error instanceof Error ? error.message : String(error));
		}
	}

	// z5. One tiny streaming chat with the keyless v2.1.4 shape (Bearer public,
	//     session-identity headers, prompt_cache_key) + agentic body.
	// Shared keyless identity for the z7 reasoning probes.
	const reasoningSession = createSessionId();
	const reasoningHeaders = keylessHeaders(reasoningSession);
	if (completionsModel) {
		try {
			const session = createSessionId();
			const response = await fetch(`${gatewayBase}/chat/completions`, {
				method: "POST",
				headers: keylessHeaders(session),
				body: JSON.stringify({
					model: completionsModel,
					messages: [{ role: "user", content: "reply with the single word: pong" }],
					...keylessBody(session),
					tools: ["read", "shell", "edit", "write"].map((name) => ({
						type: "function",
						function: { name, description: name, parameters: { type: "object", properties: {} } },
					})),
				}),
				signal: AbortSignal.timeout(60_000),
			});
			const text = await response.text();
			const ok = response.ok && text.includes("data:");
			report(`zen chat (keyless shape, ${completionsModel})`, ok, `HTTP ${response.status} · ${text.slice(0, 80).replace(/\n/g, " ")}`);
		} catch (error) {
			report(`zen chat (keyless shape, ${completionsModel})`, false, error instanceof Error ? error.message : String(error));
		}
	}

	// z6. Responses-API probe for the zenfree.res transport (keyless shape; the
	//    agentic body is required — bare /responses pings are 403-gated).
	const responsesModel = responsesIds[0];
	if (responsesModel) {
		try {
			const session = createSessionId();
			const response = await fetch(`${gatewayBase}/responses`, {
				method: "POST",
				headers: keylessHeaders(session),
				body: JSON.stringify({
					model: responsesModel,
					input: "reply with the single word: pong",
					stream: true,
					prompt_cache_key: session,
					tools: ["read", "shell", "edit", "write"].map((name) => ({
						type: "function",
						name,
						description: name,
						parameters: { type: "object", properties: {} },
					})),
				}),
				signal: AbortSignal.timeout(60_000),
			});
			const text = await response.text();
			const ok = response.ok && text.includes("response.created");
			report(`zen responses probe (${responsesModel})`, ok, `HTTP ${response.status} · ${text.slice(0, 80).replace(/\n/g, " ")}`);
		} catch (error) {
			report(`zen responses probe (${responsesModel})`, false, error instanceof Error ? error.message : String(error));
		}
	}
	// z7. Reasoning wire-format probes: the gateway must accept every value our
	//     zen thinkingLevelMap can emit — generic levels forwarded verbatim (empty
	//     map), an advertised toggle's none/high, advertised effort values, and
	//     the nested `reasoning.effort` for the Responses transport. Off for an
	//     empty map sends no parameter, which z5 already exercises.
	if (completionsModel) {
		const chatTools = ["read", "shell", "edit", "write"].map((name) => ({
			type: "function",
			function: { name, description: name, parameters: { type: "object", properties: {} } },
		}));
		const findCompletions = (predicate: (c: ReturnType<typeof zenSource.resolveCapabilities>) => boolean) =>
			zenLineup.find((e) => zenSource.resolveTransport(e.id) === "openai-completions" && predicate(zenSource.resolveCapabilities(e.id)))?.id;
		const effortModel = findCompletions((c) => (c.effortValues?.length ?? 0) > 0);
		const toggleModel = findCompletions((c) => c.toggle);
		const genericModel = findCompletions((c) => c.reasoning && !c.toggle && (c.effortValues?.length ?? 0) === 0);
		const chatProbes: { label: string; id: string; effort: string }[] = [];
		if (genericModel) chatProbes.push({ label: `${genericModel} reasoning_effort=minimal`, id: genericModel, effort: "minimal" });
		if (toggleModel) {
			chatProbes.push({ label: `${toggleModel} reasoning_effort=none (off)`, id: toggleModel, effort: "none" });
			chatProbes.push({ label: `${toggleModel} reasoning_effort=high`, id: toggleModel, effort: "high" });
		}
		if (effortModel) {
			const top = zenSource.resolveCapabilities(effortModel).effortValues?.at(-1) ?? "high";
			chatProbes.push({ label: `${effortModel} reasoning_effort=${top}`, id: effortModel, effort: top });
		}
		for (const probe of chatProbes) {
			try {
				const response = await fetch(`${gatewayBase}/chat/completions`, {
					method: "POST",
					headers: { ...reasoningHeaders, "x-opencode-session": createSessionId(), "x-opencode-request": createMessageId() },
					body: JSON.stringify({
						model: probe.id,
						...keylessBody(reasoningSession),
						reasoning_effort: probe.effort,
						tools: chatTools,
					}),
					signal: AbortSignal.timeout(60_000),
				});
				const text = await response.text();
				const down = isUpstreamUnavailable(response.status, text);
				report(
					`zen reasoning chat (${probe.label})`,
					(response.ok && text.includes("data:")) || down,
					down ? `HTTP ${response.status} · upstream unavailable — value not exercised (skipped)` : `HTTP ${response.status} · ${text.slice(0, 70).replace(/\n/g, " ")}`,
				);
			} catch (error) {
				report(`zen reasoning chat (${probe.label})`, false, error instanceof Error ? error.message : String(error));
			}
		}
	}
	if (responsesModel) {
		const responsesEffort = zenSource.resolveCapabilities(responsesModel).effortValues?.[0] ?? "high";
		try {
			const response = await fetch(`${gatewayBase}/responses`, {
				method: "POST",
				headers: { ...reasoningHeaders, "x-opencode-session": createSessionId(), "x-opencode-request": createMessageId() },
				body: JSON.stringify({
					model: responsesModel,
					input: "reply with the single word: pong",
					stream: true,
					prompt_cache_key: reasoningSession,
					reasoning: { effort: responsesEffort, summary: "auto" },
					include: ["reasoning.encrypted_content"],
					tools: ["read", "shell", "edit", "write"].map((name) => ({
						type: "function",
						name,
						description: name,
						parameters: { type: "object", properties: {} },
					})),
				}),
				signal: AbortSignal.timeout(60_000),
			});
			const text = await response.text();
			const down = isUpstreamUnavailable(response.status, text);
			report(
				`zen reasoning responses (${responsesModel} reasoning.effort=${responsesEffort})`,
				(response.ok && text.includes("response.created")) || down,
				down ? `HTTP ${response.status} · upstream unavailable — value not exercised (skipped)` : `HTTP ${response.status} · ${text.slice(0, 70).replace(/\n/g, " ")}`,
			);
		} catch (error) {
			report(`zen reasoning responses (${responsesModel})`, false, error instanceof Error ? error.message : String(error));
		}
	}
}

console.log(`\n${failures === 0 ? "ALL STEPS PASSED" : `${failures} STEP(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
