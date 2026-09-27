# zenfree — OpenCode Zen free models as a second FreeModelSource

**Status:** design · **Date:** 2026-09-27 · **Repo:** `pi-oc-cline` (branch `feat/zenfree`)
**Companion spec:** `2026-09-27-clinefree-design.md` (the architecture this extends; § references below are to that document unless prefixed "zen-").

## zen-1. Goal

Expose OpenCode Zen's free-tier models in pi as auto-synced provider(s) under ids
`zenfree` (openai-completions transport) and `zenfree.res` (openai-responses transport),
mirroring clinefree: live lineup with immediate delists, capability feeds with fallback
precedence, a client-contract layer that mimics the official OpenCode CLI, key-based auth,
credential-injecting `streamSimple`, a `/zenfree` TUI command, and a live smoke — all
fail-soft (nothing may block pi startup) and TDD (tests never touch the network).

Non-goals: anonymous `public` mode (per-IP quota 429s from datacenter egress; lineup
discovery needs a key anyway), OAuth device flow (OpenCode's console OAuth token is
unverified against the inference gateway — workspace keys are the proven credential),
multi-key rotation, paid/zen-premium buckets.

## zen-2. Upstream facts this design is built on

All verified from `~/opencode` source + `~/piext/pi-multikey` live probes (2026-09-17/21/22).

- **Endpoints.** Inference gateway `https://opencode.ai/inference/openai/v1` (what console
  `/api/v2/config` prescribes as the `opencode` provider `settings.baseURL`; serves the free
  lineup against *workspace* quota). The open-source `zen/v1` gateway only has anonymous
  per-IP quota (HTTP 429 FreeUsageLimitError from datacenter IPs) — not used.
- **Config = lineup + capabilities + baseURL.** `GET https://opencode.ai/console/api/v2/config`
  with `Authorization: Bearer <workspace key>` returns `providers.opencode` with
  `settings.baseURL` and `models: { [id]: { name?, cost?, limit?{context,output}, capabilities?{input[]}, … } }`.
  **Free = `cost.input == 0` across all cost tiers** (opencode's own rule in
  `packages/core/src/plugin/provider/opencode.ts` keeps only zero-cost models keyless).
- **Identity gates (live-verified).** `User-Agent: opencode/<channel>/<version>/<name>` with
  version < 1.17.0 → HTTP 426; `x-opencode-session` missing or not `ses_` + 12 lowercase-hex
  + 14 base62 → HTTP 403 FreeTierError; non-agentic requests (no stream, no tools) → 403
  FreeTierError even with a good key. `x-opencode-request` is not validated but is sent by
  the official client. `x-opencode-client: cli`. Plus `x-opencode-org-id` from the config's
  `providers.opencode.headers` when present.
- **Credential.** Workspace API key (opencode.ai/auth → workspace Keys). Invalid key → 401.
- **Transport split.** `muse-spark-1.3-contributor-free` (and only it today) speaks the
  OpenAI **Responses** API; the rest are chat-completions. pi dispatches to a provider's
  custom `streamSimple` only when `model.api` matches the registered api → one provider per
  transport, sharing one credential store.
- **Today's free lineup (live 2026-09-27, captured from `/api/v2/config`):** big-pickle, mimo-v2.6-flash-free,
  longcat-2.5-preview-free, space-bunny-free, ling-3.0-flash-fin-free, nemotron-3-ultra-free,
  nemotron-3.5-lightning-free, muse-spark-1.3-contributor-free. (`mimo-v2.5-free` was delisted since
  2026-09-22 — the rotation clinefree was built for, already observed.) The config also prescribes
  `providers.opencode.headers` (e.g. `x-opencode-org-id: wrk_…`) to attach to gateway requests, and a
  model-level `package` field: `aisdk:@ai-sdk/openai` ⇒ Responses API transport, absent/other ⇒
  chat-completions.

## zen-3. Contract layer (replaces cline's GitHub TS extraction)

No source scraping needed — the contract is client-side constants plus one live version number:

| Piece | Live source | Baked-in fallback |
|---|---|---|
| `x-opencode-client` | constant `cli` | — |
| `User-Agent` | `opencode/latest/<ver>/cli`, `<ver>` = official update service `https://opencode.ai/update/api/latest/cli` → `artifacts[]` (prefer distribution `npm`) → `version`; semver-guarded ≥ 1.17.0. (npm registry and GitHub releases do **not** carry the 2.x line — verified 2026-09-27.) | `opencode/latest/2.0.18/cli` (live-verified value) |
| baseUrl | `providers.opencode.settings.baseURL` from `/api/v2/config` | `https://opencode.ai/inference/openai/v1` |
| session/request ids | minted locally (zen-6) | — |

`ZenContractResult` = `{ baseUrl, headers: { "x-opencode-client", "User-Agent" }, versions: { cli }, source: "registry" | "config" | "baked-in", warning? }`.
Version check is TTL-gated by the same `sync.minIntervalMinutes` (30 min) as cline's tag check;
an HTTP 426 from the gateway **forces** a re-check (stale-version escape hatch). Parse failure
or unreachable registry → baked-in UA + warning; nothing blocks.

## zen-4. Lineup + capabilities

- **Lineup** (`fetchLineup`, needs the credential): GET `/api/v2/config` → `providers.opencode.models`,
  keep entries whose every cost tier has `input == 0` (missing `cost` = not free, matching
  opencode's `cost.some(c => c.input > 0)` disable rule), sorted by key. Cache last-known-good;
  on fetch failure serve cache and warn (empty only when never synced).
- **Capability precedence** per model id:
  1. **console config entry** (authoritative): `limit.context` → contextWindow,
     `limit.output` → maxTokens, `capabilities.input` ∩ {text,image}, `name`.
  2. **models.dev `opencode` block** fills any missing limits/modalities/name. Same
     no-`providers`-wrapper payload shape as the openrouter block. It deliberately does NOT
     contribute reasoning/toggle/effort: the zen policy is **always-on reasoning with no effort
     control** (`reasoning: true`, `toggle: false`, all thinking levels null) regardless of what
     any feed advertises — matching pi's built-in opencode catalog treatment of these models.
  3. **zen defaults**: 200K ctx / 32K out / text-only / reasoning **on** (every current free
     model reasons), no effort control → `thinkingLevelMap: null` (levels hidden, reasoning
     sent verbatim — matches pi's built-in opencode catalog treatment).
  Cost is always `{ input: 0, output: 0 }` (free). Source recorded as
  `"config" | "modelsdev" | "default"` for status display.
- **Transport assignment** (live-verified 2026-09-27): `package === "aisdk:@ai-sdk/openai"` ⇒
  `openai-responses` under **zenfree.res** (muse-spark), anything else ⇒ `openai-completions`;
  the `muse-spark-*` prefix is the fallback when the config carries no package. Both transports
  require the **agentic shape** (streaming + tools) or the gateway answers 403 FreeTierError
  ("can only be used from within OpenCode") — an earlier reading mistook that shape gate for a
  free-tier block of `/responses`; with agentic tools, muse's `/responses` answers 200.

## zen-5. Auth (key-required)

Single mode: pasted workspace key. Stored as `Credential{ mode: "apiKey", apiKey }` in
`~/.pi/agent/zenfree.json` (0600, atomic writes — the generalized state store, zen-7).
Validation: GET `/api/v2/config` with `Bearer <key>` → 200 = ok, 401/403 = rejected,
network error = error. Invalidated at runtime only on HTTP 401 (same policy as clinefree §7).

## zen-6. Request identity (per conversation/turn)

Port of pi-multikey's verified `identity.ts`: opencode's `Identifier.create` (first 12 chars =
hex of `ts*0x1000 + counter`, bitwise-NOT for descending; last 14 = random base62).
- `x-opencode-session`: `ses_` + descending id, minted on first use per conversation, reset on
  `session_start` (new/resume/fork).
- `x-opencode-request`: `msg_` + ascending id, keyed to the last user message
  (timestamp + content digest) so one turn — retries included — reuses one id.
All identity headers are merged per-request inside `streamSimple` (providers apply
`options.headers` last), never baked into the registration.

## zen-7. Module map (what changes vs. clinefree)

| Module | Change |
|---|---|
| `state.ts` | generalize to a factory `createStateStore(namespace, env)` → `{configPath, cacheDir, loadConfig, saveConfig, readCache, writeCache}`; existing exports become the `clinefree` instance (paths/env unchanged — backward compatible). `zenfree` instance: `ZENFREE_CONFIG`/`ZENFREE_CACHE` → `~/.pi/agent/zenfree.json`, `~/.pi/agent/zenfree/cache/`. |
| `feeds.ts` | generalize `fetchModelsDevOpenRouter` → `fetchModelsDevModels(providerId, fetcher)`; keep the old export as `providerId="openrouter"`. |
| `github.ts` | export the semver comparator for reuse (npm version vs baked-in). |
| `sources/types.ts` | `fetchLineup(credential?)`; `refreshCapabilities(): Promise<Record<string, Record<string, FeedEntry>>>` (feeds keyed by name — cline keeps returning `{openrouter, vercel}`, zen returns `{modelsdev}`). |
| `sources/opencode-identity.ts` | new — the id minting + turn keying (zen-6). |
| `sources/opencode.ts` | new — the Zen `FreeModelSource`: contract (zen-3), lineup (zen-4), capability merge, warnings, `status()`. |
| `registry.ts` | generalize `syncOnce` to **multi-provider desired state**: `providers: [{ id, api, models }]` — per-provider diff, aggregate `+N/−M` notification, delisted-active-model switch prompt across the union, empty-lineup unregister of every provider. clinefree calls it with one provider. |
| `stream.ts` | add `createZenfreeStream(deps)`: key injection, static + identity headers, per-request `getApiProvider(model.api)` resolution, 401 → invalidate+notify, 426 → notify + force version re-check, 403/429 relayed with quota/gate hints. No refresh-token flow. |
| `auth.ts` | add `validateZenKey` (there is no WorkOS here; keep cline's device flow untouched). |
| `index.ts` | second bootstrap: zenfree providers (2), `session_start` sync (both sources), `/zenfree` command. |
| `tui.ts` | parametrize labels/formatters; add the zenfree menu (status / models / auth / refresh / history). |
| `smoke.ts` | zen section gated on `ZENFREE_SMOKE_KEY`: config+key validation, lineup, capability table, live chat probe **with stub tools + stream + identity headers** (bare pings draw 403 FreeTierError), optional responses-api probe for muse-spark. |
| `README.md` | document both sources. |

## zen-8. Sync + UX

Same cadence as clinefree §8: lineup+caps on `session_start` (and `/zenfree → Refresh`),
capability feeds TTL 10 min, contract/version TTL 30 min, `minIntervalMinutes` floor between
full syncs. Notifications: `zenfree: +N new … −M delisted …`; delisted-active-model → switch
prompt (naming the model; no fallback suggestion if the whole lineup is gone); 426 →
"client version stale — re-checking" then auto-refresh. `/zenfree` mirrors `/clinefree`
(Status / Models / Auth / Refresh / History). Both commands coexist; neither source's failure
affects the other (separate try/catch per bootstrap, per session handler).

## zen-9. Failure modes (fail-soft table)

| Failure | Behavior |
|---|---|
| npm registry unreachable / payload reshaped | baked-in UA + warning; requests continue |
| `/api/v2/config` 401 | provider stays registered; auth cleared with a re-auth prompt (only on live 401 from the gateway too — config 401 during sync just warns) |
| `/api/v2/config` network error | cached lineup + warning; provider keeps last-known models |
| config lists zero free models | unregister `zenfree` + `zenfree.res`, notify; switch prompt if the active model was delisted |
| model missing from every capability source | zen defaults (zen-4) — never crash, never `undefined` |
| HTTP 426 at runtime | relay error + notify + force version re-check (next sync uses fresh UA) |
| HTTP 403 FreeTierError | relay with hint ("free tier requires an agentic request shape — this usually means a non-streaming/non-tool caller") |
| HTTP 429 | relay quota message; no credential invalidation |
| corrupt `zenfree.json` / cache files | defaults / empty cache, silent self-heal on next sync |
| any exception in zenfree bootstrap/sync | caught, notified; clinefree and pi unaffected |

## zen-10. Testing

Fixture-pinned unit tests per module (RED→GREEN, one commit per task): npm registry payload,
console config payload (real captured shape), models.dev `opencode` block, identifier format
`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$` and turn-key stability, capability merge matrix
(config-only / modelsdev-only / neither / disagreements), multi-provider sync (split, delist,
empty lineup, active-model prompt), stream error mapping (401/426/403/429), auth validation.
All fetchers injected; no test touches the network. Live smoke (dev key via
`ZENFREE_SMOKE_KEY`, run manually, key rotated after) is the only networked artifact.
