# pi-oc-cline — dynamically discovered Cline *free* models

**Date:** 2026-09-27
**Status:** approved design, implementation plan pending
**Author:** brainstorming session (pi)

## 1. Goal

A standalone pi extension that exposes Cline's **free** model lineup as a pi
provider, keeping itself in sync with two independent upstreams that change on
different schedules:

- the **live lineup** (`GET /api/v1/ai/cline/recommended-models`, `free[]`),
  which gains and drops models frequently, and
- the **contract + capability catalog** in the `cline/cline` GitHub repo,
  which supplies request headers and per-model capabilities.

New models appear and delisted models disappear automatically. "Free" means
zero-billed: the daily per-model quota on a Cline account.

### Non-goals

- No paid / `cline-pass` / `cline-cloud` / `recommended` buckets. Free only.
- No OpenCode source in this iteration (the interface is shaped for it; see §12).
- No multi-key pool, no 429 rotation — one credential, one account.
- No live capability probing of any kind (see §5 decisions).

## 2. Evidence this design rests on (verified 2026-09-27)

| Fact | Evidence |
|---|---|
| `recommended-models` is public, no auth | `GET` returned `HTTP 200` with no headers/token |
| Endpoint returns **only** `id`, `name`, `description`, `tags` | payload inspected; all four buckets have exactly those keys |
| Live `free[]` = `stealth/pixel-canary`, `stealth/space-bunny-alpha`, `cline-free/mimo-v2.6-flash`, `cline-free/deepseek-v4.1-flash`, `cline-free/gemini-3.8-flash`, `cline-free/muse-spark-1.3-contributor` | captured payload |
| Capabilities live only in the generated catalog | `catalog.generated.ts`; `catalog-cline-recommended.ts` resolves via `openrouter` exact id → slug → defaults |
| Catalog is incomplete/lagging | `pixel-canary` absent entirely (⇒ defaults); `deepseek-v4.1-flash` catalog says 131072 out, live route accepted 384000 |
| Catalog size | exactly 4,263,417 bytes |
| API-key auth is `Authorization: Bearer sk_…` | bearer ⇒ 200; `x-api-key` ⇒ 401; invalid bearer ⇒ 401 |
| `GET /api/v1/users/me` needs auth | no auth ⇒ 401; bearer ⇒ 200 `{data:{id,email}}` |
| Non-stream chat responses are wrapped | `{"data":{"choices":[…]},"usage":…}` |
| Tags are per-artifact | `sdk/llms/v0.0.86`, `sdk/core/v0.0.86`, `cli-v3.0.65`, `v4.1.21`, `desktop-v0.0.37` |
| `git/matching-refs/tags/<prefix>` enumerates them with SHAs | returns ref+sha; ordering is **lexicographic**, so sort semantically |
| Raw fetch works at an arbitrary commit SHA | `raw.githubusercontent.com/cline/cline/<sha>/<path>` ⇒ 200 |

## 3. Decisions

1. **Lineup** = live endpoint at runtime, `free[]` only.
2. **Contract + catalog** = GitHub, **tracking the latest release tag per
   artifact** (not `main`), cached locally and kept in sync with remote.
3. **Standalone extension**, own pi provider (`clinefree`), own credential
   store; auth = OAuth device flow **or** a pasted API key.
4. **Capabilities = catalog only.** Unknown model ⇒ defaults
   **256_000 ctx / 32_000 out / text-only**. Delisted ⇒ **drop immediately**.
5. If the **contract** cannot be extracted from GitHub, fall back to a
   **baked-in snapshot** and **warn the user**, but never block startup.

## 4. Architecture

Provider id **`clinefree`**. Package dir `~/piext/pi-oc-cline`.

```
index.ts            factory: auth, provider registration, /clinefree, session_start sync
sources/types.ts    FreeModelSource interface
sources/cline.ts    Cline implementation: tags, contract, catalog, lineup, capabilities
github.ts           matching-refs tag resolution + raw fetch at SHA + fail-soft cache
catalog.ts          object-literal extraction → tolerant parse → reduce → capability resolver
contract.ts         header-set extraction + version resolution + baked-in fallback
mapping.ts          catalog ModelInfo → pi model definition (+ defaults)
registry.ts         desired-vs-registered diff; add/remove models; notifications
auth.ts             device flow + API-key mode; refresh with rotation persistence
state.ts            config + cache file I/O (atomic writes)
tui.ts              /clinefree screens
```

`FreeModelSource` is the seam for a future OpenCode source:

```ts
interface FreeModelSource {
  id: string;                                  // "cline"
  refreshContract(): Promise<ContractResult>;  // headers + versions
  refreshCatalog(): Promise<CatalogResult>;    // reduced ModelInfo map
  fetchLineup(): Promise<LineupEntry[]>;       // free models only
  resolveCapabilities(id: string): ModelCapabilities;
}
```

### Data flow (`session_start`, and `/clinefree refresh`)

```
1. resolve tags (3 × matching-refs)          ─┐
2. tag changed?  → download + parse contract  ├─ contract.json / catalog.json (cache)
                 → download + parse catalog  ─┘
3. GET recommended-models (always)           → free[] lineup
4. per id: resolve capabilities              → ModelInfo | defaults
5. map → pi model definitions
6. diff vs registered → add/remove → notify
```

Steps 1–2 are cheap when nothing changed (three small `matching-refs` calls).
Step 3 is one unauthenticated GET per sync.

## 5. GitHub contract & catalog

### Tag streams (each resolved independently, semver-max wins)

| Stream | Prefix | Supplies |
|---|---|---|
| catalog | `tags/sdk/llms/v*` | `catalog.generated.ts`, `catalog-cline-recommended.ts` |
| core | `tags/sdk/core/v*` | `X-CORE-VERSION` |
| CLI | `tags/cli-v*` | `User-Agent`, `X-CLIENT-VERSION` |

Resolution: `GET /repos/cline/cline/git/matching-refs/<prefix>`; the API returns
refs **lexicographically** (`cli-v3.0.7` after `cli-v3.0.65`), so parse and
compare semver ourselves. All files are then fetched **at the tag's commit SHA**.

### Files fetched

```
<sha>/sdk/packages/llms/src/catalog/catalog.generated.ts
<sha>/sdk/packages/llms/src/catalog/catalog-cline-recommended.ts
<sha>/sdk/packages/llms/src/providers/request-headers.ts
<sha>/sdk/packages/llms/src/providers/cline-client-headers.ts
```

### Change detection

Compare the cached tag name per stream with the freshly resolved tag. Equal ⇒
skip the download. (Tags are immutable, so no ETag is needed.)

### Cache layout (`~/.pi/agent/clinefree/cache/`)

| File | Contents |
|---|---|
| `catalog.json` | reduced catalog: only the `cline`, `cline-pass`, `openrouter` provider blocks |
| `contract.json` | resolved header map + version strings + source tags |
| `lineup.json` | last successful `free[]` payload |
| `state.json` | resolved tags, per-file timestamps, last sync result |

Reduced rather than verbatim: the full 4.2 MB file is only needed transiently to
extract those three blocks; the 325-model `openrouter` block plus the two cline
blocks is what capability resolution actually reads.

### Parsing

`catalog.generated.ts` is a JS object literal, not JSON (unquoted top-level
`version`/`providers` keys, possible trailing commas). Strategy: locate the
root object literal, extract the balanced-brace substring, then tolerant-parse
(bare-key quoting + trailing-comma removal, or a JSON5 parser) and validate
against the expected top-level shape. Any failure is soft (see §9).

## 6. Capability resolution & model mapping

Per free-model id:

```
exact id in openrouter block            → its ModelInfo
else slug match (id.split("/").pop())   → its ModelInfo
else                                    → DEFAULTS
```

`DEFAULTS = { contextWindow: 256_000, maxTokens: 32_000, input: ["text"],
reasoning: false }`.

| pi field | source |
|---|---|
| `id` | exact feed id, slashes preserved (the wire needs it) |
| `name` | catalog `name`, else feed `name` + ` (free)` |
| `contextWindow` | catalog `contextWindow` ?? 256_000 |
| `maxTokens` | catalog `maxTokens` ?? 32_000 |
| `input` | `modalities.input ∩ {text,image}`; if `modalities` absent but capability `images` → `["text","image"]`; otherwise `["text"]` |
| `reasoning` | true iff `reasoningOptions` present |
| `thinkingLevelMap` | from `reasoningOptions`; see below |
| `compat.thinkingFormat` | `"openrouter"` iff an `effort` option exists |
| `cost` | zeros |
| `api` | `openai-completions` |
| `baseUrl` | `https://api.cline.bot/api/v1` |

Note: non-streamed responses are wrapped as `{"data":{…}}`. pi's
`openai-completions` path streams, which is what the existing `pi-multikey`
cline pool already uses successfully, so the wrapper is not handled specially;
it is recorded here only as a known upstream quirk.

`thinkingLevelMap` derivation (Cline's effort vocabulary is identical to pi's:
`none·minimal·low·medium·high·xhigh·max`):

- `effort` option present → map each advertised value to itself.
- `toggle` present → `off: "none"` in addition; if there is *no* effort option,
  expose `off: "none"` and `high: "high"`.
- `reasoningOptions` absent → `reasoning: false`, no map.

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
  "sync": { "minIntervalMinutes": 30, "notifyOnChange": true }
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

- **`session_start`**: if the last full sync is older than
  `sync.minIntervalMinutes`, resolve tags, refresh catalog/contract only on tag
  change, re-fetch the live lineup, and re-register on diff. Within the
  interval the cached state is reused, so rapid restarts do not hammer GitHub;
  `/clinefree refresh` forces a sync regardless.
- **`sync.minIntervalMinutes`** (default 30) is the minimum wall-clock gap
  between full syncs. It is the *only* TTL in the design; tag immutability
  (§5) is what keeps the catalog check cheap when a sync does run.
- **`/clinefree`**: status (tags, last sync, auth mode/account), model list
  (annotating whether each model's caps came from catalog or defaults), auth,
  *refresh now*, and the add/remove history.
- **Change notification**: e.g.
  `+1 new: stealth/pixel-canary · −3 delisted: poolside/laguna-s-2.1:free, z-ai/glm-5.3-flash, cline-free/solar-pro4`.
- **Delisting**: removed immediately. If a delisted id was pi's *active* model,
  notify and prompt to switch rather than leaving a broken selection silently.

## 9. Failure modes (never block startup)

| Failure | Behaviour |
|---|---|
| tag resolution (GitHub API) fails | keep cached tags; continue |
| contract download/parse fails | use **baked-in contract snapshot** and **warn the user** |
| catalog download/parse fails | use cached `catalog.json`; if absent, every model gets **defaults** and warn |
| lineup fetch fails | use cached `lineup.json`; if absent, register nothing and warn |
| config/cache write fails | log; keep in-memory state for the session |
| no credential | skip provider registration; `/clinefree` explains how to add one |

**Baked-in contract snapshot** (`contract.ts`) is a checked-in copy of the
header literal and derived-header template captured from a known-good Cline
tag, plus fallback version strings and client type (`cline-cli`). It is used
only when extraction fails, is always paired with a user-visible warning, and
is refreshed deliberately when the upstream header shape changes.

Warnings are surfaced once per sync, not per model. Any thrown error in the sync
path is caught at the top level and downgraded to a warning.

## 10. State schemas

`state.json` (cache version 1):

```jsonc
{
  "version": 1,
  "tags": { "llms": "sdk/llms/v0.0.86", "core": "sdk/core/v0.0.86", "cli": "cli-v3.0.65" },
  "shas": { "llms": "a4a4b308…", "core": "ec22b97a…", "cli": "8668e030…" },
  "timestamps": { "contract": 1790000000000, "catalog": 1790000000000, "lineup": 1790000000000 },
  "lastResult": { "added": ["…"], "removed": ["…"], "warnings": ["…"] }
}
```

All writes are atomic (temp file + rename).

## 11. Testing

- **TDD.** Unit tests with no network:
  - semver sorting of the three lexicographic tag streams,
  - object-literal extraction and tolerant parse (incl. trailing commas),
  - capability resolution: exact id → slug → defaults, with `pixel-canary`
    asserted to produce 256K/32K/text,
  - catalog→pi mapping table (incl. `thinkingLevelMap` derivation),
  - header builder from a contract fixture + version streams,
  - desired-vs-registered diff (add/remove),
  - fail-soft: corrupt cache, malformed contract ⇒ baked-in snapshot + warning.
- **Fixtures** committed: a reduced catalog snapshot and a real
  `recommended-models` payload.
- **Integration** tests with a mocked `fetch` for GitHub + the live endpoint.
- **Live smoke** (`smoke.ts`, never in CI): `users/me`, `recommended-models`,
  and one 1-token chat through the pasted-key path. The development API key is
  used only here, read from an env var, and never written to the repo.

## 12. Future work

- **OpenCode free models** as a second `FreeModelSource` (the original
  motivation for the package name `pi-oc-cline`).
- Optional per-model capability overrides, if catalog gaps prove painful.
- Optional multi-account rotation, if the free quota becomes limiting.

## 13. Risks

- **Upstream file restructuring** could break the extractor; mitigated by the
  baked-in snapshot, cached last-known-good, and a warning.
- **Catalog under-reporting** (observed: deepseek out 131072 vs live 384000) is
  accepted — decision 4 is catalog-only.
- **Dropping the active model** mid-session breaks the next turn; mitigated by
  detection + a switch prompt.
- **GitHub API rate limits** (60/h unauthenticated): three `matching-refs`
  calls per sync is well within budget; failures reuse cached tags.
