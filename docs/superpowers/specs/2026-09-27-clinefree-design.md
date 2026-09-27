# pi-oc-cline — dynamically discovered Cline *free* models

**Date:** 2026-09-27
**Status:** approved design (rev 2), implementation plan pending
**Author:** brainstorming session (pi)

## 1. Goal

A standalone pi extension that exposes Cline's **free** model lineup as a pi
provider, keeping itself in sync with three independent upstreams that change on
different schedules:

- the **live lineup** (`GET /api/v1/ai/cline/recommended-models`, `free[]`),
  which gains and drops models frequently,
- the **live capability catalogs** (`models.dev` `openrouter` block, then the
  Vercel AI Gateway listing), which supply context/output/modalities/reasoning,
  and
- the **contract** in the `cline/cline` GitHub repo (request headers + version
  strings), which Cline's API gates on.

New models appear and delisted models disappear automatically. "Free" means
zero-billed: the daily per-model quota on a Cline account.

### Non-goals

- No paid / `cline-pass` / `cline-cloud` / `recommended` buckets. Free only.
- No OpenCode source in this iteration (the interface is shaped for it; see §12).
- No multi-key pool, no 429 rotation — one credential, one account.
- No capability probing: context/output/reasoning are *read from published
  catalogs*, never measured by sending test requests.

## 2. Evidence this design rests on (verified 2026-09-27)

| Fact | Evidence |
|---|---|
| `recommended-models` is public, no auth | `GET` returned `HTTP 200` with no headers/token |
| Endpoint returns **only** `id`, `name`, `description`, `tags` | payload inspected; all four buckets have exactly those keys |
| Live `free[]` = `stealth/pixel-canary`, `stealth/space-bunny-alpha`, `cline-free/mimo-v2.6-flash`, `cline-free/deepseek-v4.1-flash`, `cline-free/gemini-3.8-flash`, `cline-free/muse-spark-1.3-contributor` | captured payload |
| `/api/v1/ai/cline/models` is just the OpenRouter dump (458 models) and has no free/stealth ids | fetched, 532 KB, `pixel-canary` absent |
| `pixel-canary` exists **only** in the live Vercel AI Gateway | `context_window 262144`, `max_tokens 131072`, input `text+image`, `reasoning_options [{effort, none/low/medium/xhigh}]` |
| `space-bunny-alpha` exists **only** in OpenRouter | 1M ctx / 524288 out / text+image+video / effort low…max |
| Sources disagree on the same slug | `deepseek-v4.1-flash`: OpenRouter out **384000** vs Vercel **32768**; `gemini-3.8-flash`: 1048576/65536 vs 1000000/65535 |
| models.dev carries both blocks with structured `reasoning_options` | `openrouter` and `vercel` provider entries |
| Cline itself merges both | `buildClineModels()` = `generatedModels("openrouter")` + `generatedModels("vercel-ai-gateway")`; the extension refreshes both (`refreshOpenRouterModels`, `refreshVercelAiGatewayModels`) |
| Cline runtime fetches the catalog live | `getLiveModelsCatalog()` → `fetchLiveProviderModels(models.dev)` with a 10-minute TTL |
| The generated `catalog.generated.ts` lags structurally | no `pixel-canary` in `main` or `sdk/llms/v0.0.86`; no `cline-free/*` capability entries beyond 4 models |
| API-key auth is `Authorization: Bearer sk_…` | bearer ⇒ 200; `x-api-key` ⇒ 401; invalid bearer ⇒ 401 |
| `GET /api/v1/users/me` needs auth | no auth ⇒ 401; bearer ⇒ 200 `{data:{id,email}}` |
| Non-stream chat responses are wrapped | `{"data":{"choices":[…]},"usage":…}` |
| Tags are per-artifact | `sdk/llms/v0.0.86`, `sdk/core/v0.0.86`, `cli-v3.0.65`, `v4.1.21`, `desktop-v0.0.37` |
| `git/matching-refs/tags/<prefix>` enumerates them with SHAs | returns ref+sha; ordering is **lexicographic**, so sort semantically |
| Raw fetch works at an arbitrary commit SHA | `raw.githubusercontent.com/cline/cline/<sha>/<path>` ⇒ 200 |

The revision from "capabilities = generated catalog" to "capabilities = live
models.dev → live Vercel gateway" came directly from the `pixel-canary`
observation: the generated catalog cannot carry Vercel-only stealth ids, and
the 256 K you saw in Cline is the Vercel gateway's `context_window`.

## 3. Decisions

1. **Lineup** = live endpoint at runtime, `free[]` only.
2. **Contract** = GitHub, **tracking the latest release tag per artifact**
   (not `main`), cached locally and kept in sync with remote.
3. **Standalone extension**, own pi provider (`clinefree`), own credential
   store; auth = OAuth device flow **or** a pasted API key.
4. **Capabilities = models.dev `openrouter` (exact id → slug), else live Vercel
   AI Gateway (exact → slug), else fixed defaults `256_000` ctx / `32_000` out /
   text-only / no reasoning.** Delisted ⇒ **drop immediately**.
5. If the **contract** cannot be extracted from GitHub, fall back to a
   **baked-in snapshot** and **warn the user**, but never block startup.

## 4. Architecture

Provider id **`clinefree`**. Package dir `~/piext/pi-oc-cline`.

```
index.ts            factory: auth, provider registration, /clinefree, session_start sync
sources/types.ts    FreeModelSource interface
sources/cline.ts    Cline implementation: contract + lineup + capability resolution
github.ts           matching-refs tag resolution + raw fetch at SHA + fail-soft cache
contract.ts         header-set + endpoint-path extraction; versions; baked-in fallback
feeds.ts            live models.dev and Vercel AI Gateway clients (TTL-cached, reduced)
capabilities.ts     resolution: openrouter → vercel → defaults; returns ModelCapabilities
mapping.ts          ModelCapabilities → pi model definition
registry.ts         desired-vs-registered diff; add/remove models; notifications
auth.ts             device flow + API-key mode; refresh with rotation persistence
state.ts            config + cache file I/O (atomic writes)
tui.ts              /clinefree screens
```

`FreeModelSource` is the seam for a future OpenCode source:

```ts
interface FreeModelSource {
  id: string;                                  // "cline"
  refreshContract(): Promise<ContractResult>;  // headers + endpoint path + versions
  fetchLineup(): Promise<LineupEntry[]>;       // free models only
  refreshCapabilities(): Promise<void>;        // pull + cache the capability feeds
  resolveCapabilities(id: string): ModelCapabilities | undefined;
}
```

### Data flow (`session_start`, and `/clinefree refresh`)

```
1. GET recommended-models              → free[] lineup            (every start)
2. capability feeds older than TTL?    → models.dev + Vercel feeds  (TTL 10 min)
3. tag check due?                      → matching-refs × 3         (min interval 30 min)
   tag changed?                        → download + extract contract
4. per id: resolve capabilities        → openrouter → vercel → defaults
5. map → pi model definitions
6. diff vs registered → add/remove → notify
```

Step 1 is one unauthenticated GET. Step 2 is two GETs on a TTL. Step 3 is three
tiny `matching-refs` calls, and only downloads on tag change.

## 5. GitHub contract

### Tag streams (each resolved independently, semver-max wins)

| Stream | Prefix | Supplies |
|---|---|---|
| catalog/contract | `tags/sdk/llms/v*` | contract revision id, and the SHA the contract files are fetched at |
| core | `tags/sdk/core/v*` | `X-CORE-VERSION` |
| CLI | `tags/cli-v*` | `User-Agent`, `X-CLIENT-VERSION` |

Resolution: `GET /repos/cline/cline/git/matching-refs/<prefix>`; the API returns
refs **lexicographically** (`cli-v3.0.7` after `cli-v3.0.65`), so parse and
compare semver ourselves. Files are then fetched **at the tag's commit SHA**.

The `sdk/llms/v*` stream is resolved to pin the contract revision and the
commit SHA the files are fetched at, but the 4.2 MB generated catalog is
**no longer fetched** — capabilities come from the live feeds (§6).

### Files fetched (at the `sdk/llms` commit SHA)

```
<sha>/sdk/packages/llms/src/providers/request-headers.ts
<sha>/sdk/packages/llms/src/providers/cline-client-headers.ts
<sha>/sdk/packages/llms/src/catalog/catalog-cline-recommended.ts
```

`catalog-cline-recommended.ts` is included because it defines the
`/api/v1/ai/cline/recommended-models` path and the free-bucket semantics, so an
upstream change to either propagates without an extension release.

### Change detection

Compare the cached tag name per stream with the freshly resolved tag. Equal ⇒
skip the download. (Tags are immutable, so no ETag is needed.)

### Cache layout (`~/.pi/agent/clinefree/cache/`)

| File | Contents |
|---|---|
| `contract.json` | resolved header map + endpoint path + version strings + source tags |
| `lineup.json` | last successful `free[]` payload |
| `capabilities.json` | reduced feeds: the `openrouter` block + the Vercel gateway listing |
| `state.json` | resolved tags, timestamps, last sync result |

`capabilities.json` is a **reduction**, not a verbatim mirror: only the
`openrouter` provider block from models.dev and the Vercel listing are kept.

### Parsing

`request-headers.ts` is TypeScript. Strategy: locate the
`DEFAULT_CLINE_REQUEST_HEADERS` object literal, extract the balanced-brace
substring, tolerant-parse it (bare-key quoting / trailing commas), and read the
derived-header template (`buildClineClientHeaders` / `buildClineRequestHeaders`)
for the version-bearing headers. Any failure is soft (§9).

## 6. Capability sources & model mapping

### Sources, in resolution order

1. **models.dev live** — `https://models.dev/api.json`, reduced to the
   `openrouter` provider block. Fields: `limit.context`, `limit.output`,
   `modalities.input`, `reasoning_options`, `name`.
2. **Live Vercel AI Gateway** — `https://ai-gateway.vercel.sh/v1/models`
   (391 models). Fields: `context_window`, `max_tokens`, `modalities.input`,
   `reasoning_options`, `tags`, `name`, `description`.
3. **Defaults** — `256_000` ctx / `32_000` out / `["text"]` / `reasoning:false`.

Both live feeds are fetched on a **10-minute TTL** (mirroring Cline's
`DEFAULT_MODELS_CATALOG_CACHE_TTL_MS`) and cached in `capabilities.json`. The
last-known-good copy is retained on outage (§9).

Resolution per free-model id:

```
models.dev/openrouter   exact id → else slug (id.split("/").pop())
live Vercel gateway     exact id → else slug
else                    DEFAULTS
```

OpenRouter-first reproduces the live-verified numbers (`deepseek-v4.1-flash`
out = 384000, not Vercel's 32768); the Vercel fallback is what resolves
`stealth/pixel-canary` (262144 / 131072).

### Mapping to a pi model

| pi field | source |
|---|---|
| `id` | exact feed id, slashes preserved (the wire needs it) |
| `name` | catalog `name`, else feed `name` + ` (free)` |
| `contextWindow` | `limit.context` / `context_window` ?? 256_000 |
| `maxTokens` | `limit.output` / `max_tokens` ?? 32_000 |
| `input` | `modalities.input ∩ {text,image}`; **otherwise `["text"]`** |
| `reasoning` | true iff `reasoning_options` present |
| `thinkingLevelMap` | from `reasoning_options`; see below |
| `compat.thinkingFormat` | `"openrouter"` iff an `effort` option exists |
| `cost` | zeros |
| `api` | `openai-completions` |
| `baseUrl` | `https://api.cline.bot/api/v1` |

`modalities.input` is intersected with pi's supported set: text and image only
(video/audio/pdf are dropped).

Note: non-streamed responses are wrapped as `{"data":{…}}`. pi's
`openai-completions` path streams, which is what the existing `pi-multikey`
cline pool already uses successfully, so the wrapper is not handled specially;
it is recorded here only as a known upstream quirk.

`thinkingLevelMap` derivation (both feeds use Cline's effort vocabulary, which
is identical to pi's: `none·minimal·low·medium·high·xhigh·max`):

- `effort` option present → map each advertised value to itself.
- `toggle` present → `off: "none"` in addition; if there is *no* effort option,
  expose `off: "none"` and `high: "high"`.
- `reasoning_options` absent → `reasoning: false`, no map.

Note: pi treats an omitted level as *supported* and forwards the level name
verbatim, so unsupported levels must be explicitly `null`/omitted from the map
per the pi model conventions already used in `pi-multikey`.

## 7. Auth

Config `~/.pi/agent/clinefree.json`, mode `0600`:

```jsonc
{
  "auth": { "mode": "apiKey", "apiKey": "sk-…" },   // or
  // "auth": { "mode": "oauth", "accessToken": "…", "refreshToken": "…",
  //           "expiresAt": 1790000000000,
  //           "account": { "id": "usr-…", "email": "…" } },
  "sync": { "minIntervalMinutes": 30, "capabilityTtlMinutes": 10, "notifyOnChange": true }
}
```

- **OAuth**: `POST api.workos.com/user_management/authorize/device` → poll
  `…/authenticate` → `POST api.cline.bot/api/v1/auth/register`; refresh via
  `POST /api/v1/auth/refresh`. Refresh tokens rotate on every call, so the new
  token is always persisted; refresh is single-flight with a 5-minute expiry
  buffer. OAuth access tokens are sent with the `workos:` prefix (idempotent).
- **API key**: sent verbatim as `Authorization: Bearer <key>` (verified;
  `x-api-key` is rejected).
- **Validation**: `GET /api/v1/users/me` — 401 ⇒ reject, 200 ⇒ store `account`.
  No model quota is consumed.
- **Runtime 401**: mark the credential invalid, notify, offer re-auth; do not
  silently retry.
- **Request headers**: from the extracted contract (§5) plus resolved versions.
  If the contract parse failed, use the baked-in snapshot (§9).

## 8. Sync, command & UX

- **`session_start`**:
  - always re-fetch the live lineup (one cheap GET) and re-register on diff;
  - refresh the capability feeds when their cache is older than
    `sync.capabilityTtlMinutes` (default 10);
  - resolve tags when `sync.minIntervalMinutes` (default 30) has elapsed, and
    download the contract only if a tag changed.
- **`/clinefree refresh`** forces all three steps.
- **`/clinefree`**: status (tags, last sync, auth mode/account), model list
  (annotating each model's capability source: `openrouter` / `vercel` /
  `default`), auth, *refresh now*, and the add/remove history.
- **Change notification**: e.g.
  `+1 new: stealth/pixel-canary · −3 delisted: poolside/laguna-s-2.1:free, z-ai/glm-5.3-flash, cline-free/solar-pro4`.
- **Delisting**: removed immediately. If a delisted id was pi's *active* model,
  notify and prompt to switch rather than leaving a broken selection silently.

## 9. Failure modes (never block startup)

| Failure | Behaviour |
|---|---|
| tag resolution (GitHub API) fails | keep cached tags; continue |
| contract download/parse fails | use **baked-in contract snapshot** and **warn the user** |
| models.dev fetch fails | reuse cached `capabilities.json`; then Vercel; then defaults |
| Vercel gateway fetch fails | reuse cached copy; then defaults for ids OpenRouter lacks |
| `capabilities.json` absent/corrupt | resolve everything to **defaults** and warn |
| lineup fetch fails | use cached `lineup.json`; if absent, register nothing and warn |
| config/cache write fails | log; keep in-memory state for the session |
| no credential | skip provider registration; `/clinefree` explains how to add one |

**Baked-in contract snapshot** (`contract.ts`) is a checked-in copy of the
header literal, endpoint path, and derived-header template captured from a
known-good Cline tag, plus fallback version strings and client type
(`cline-cli`). It is used only when extraction fails, is always paired with a
user-visible warning, and is refreshed deliberately when the upstream header
shape changes.

Warnings are surfaced once per sync, not per model. Any thrown error in the sync
path is caught at the top level and downgraded to a warning.

## 10. State schemas

`state.json` (cache version 1):

```jsonc
{
  "version": 1,
  "tags": { "llms": "sdk/llms/v0.0.86", "core": "sdk/core/v0.0.86", "cli": "cli-v3.0.65" },
  "shas": { "llms": "a4a4b308…", "core": "ec22b97a…", "cli": "8668e030…" },
  "timestamps": { "contract": 1790000000000, "capabilities": 1790000000000, "lineup": 1790000000000 },
  "lastResult": { "added": ["…"], "removed": ["…"], "warnings": ["…"] }
}
```

All writes are atomic (temp file + rename).

## 11. Testing

- **TDD.** Unit tests with no network:
  - semver sorting of the lexicographic tag streams,
  - header-literal extraction and tolerant parse (incl. trailing commas),
  - capability resolution precedence:
    - `deepseek-v4.1-flash` ⇒ OpenRouter values (out 384000) even though Vercel
      also has it,
    - `pixel-canary` ⇒ Vercel values (262144 / 131072 / text+image /
      effort none,low,medium,xhigh),
    - an id in neither ⇒ 256K / 32K / text / no reasoning,
  - `thinkingLevelMap` derivation for effort / toggle / absent,
  - modalities ∩ {text,image},
  - header builder from a contract fixture + version streams,
  - desired-vs-registered diff (add/remove),
  - fail-soft: corrupt cache, malformed contract ⇒ baked-in snapshot + warning.
- **Fixtures** committed: a reduced `openrouter` block, a reduced Vercel
  gateway listing, and a real `recommended-models` payload.
- **Integration** tests with a mocked `fetch` for GitHub + models.dev + Vercel +
  the lineup endpoint.
- **Live smoke** (`smoke.ts`, never in CI): `users/me`, `recommended-models`,
  both capability feeds, and one 1-token chat through the pasted-key path. The
  development API key is used only here, read from an env var, and never written
  to the repo.

## 12. Future work

- **OpenCode free models** as a second `FreeModelSource` (the original
  motivation for the package name `pi-oc-cline`).
- Optional per-model capability overrides, if feed gaps prove painful.
- Optional multi-account rotation, if the free quota becomes limiting.

## 13. Risks

- **Source disagreement is inherent** (deepseek: 384000 vs 32768). The
  OpenRouter-first rule is deliberate and matches Cline's runtime path; any
  future conflict is resolved by the same rule, not ad hoc.
- **models.dev api.json is ~4.9 MB.** Mitigated by the 10-minute TTL and by
  reducing the payload to the `openrouter` block before caching.
- **Feed lag** (models.dev lacks some Vercel-only stealth ids) is handled by the
  Vercel fallback; a model missing from both gets defaults and is visibly
  annotated as such in `/clinefree` and the warning path.
- **Upstream file restructuring** could break contract extraction; mitigated by
  the baked-in snapshot, cached last-known-good, and a warning.
- **Dropping the active model** mid-session breaks the next turn; mitigated by
  detection + a switch prompt.
- **GitHub API rate limits** (60/h unauthenticated): three `matching-refs`
  calls per sync is well within budget; failures reuse cached tags.
