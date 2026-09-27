# clinefree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone pi extension (`pi-oc-cline`) that registers Cline's *free* model lineup as one provider (`clinefree`), auto-synced from the live lineup feed, live capability feeds (models.dev → Vercel), and a GitHub tag-pinned contract.

**Architecture:** `session_start` (and `/clinefree refresh`) fetches the free lineup, resolves each model's capabilities (OpenRouter first, Vercel gateway fallback, fixed defaults last), maps to pi models, and re-registers the provider on diff. The contract (headers + endpoint path + versions) is extracted from `cline/cline` GitHub at the latest per-artifact release tags. Auth is a pasted API key or OAuth device flow, injected per-request by a wrapping `streamSimple`.

**Tech Stack:** TypeScript, pi extension runtime (jiti), `@earendil-works/pi-ai` + `pi-coding-agent` peer deps, vitest, Node ≥ 22, zero runtime deps.

**Spec:** `docs/superpowers/specs/2026-09-27-clinefree-design.md` (rev 2, commit `8f5bce0`). The plan argues from the spec; executors read both.

## Global Constraints

- Provider id `clinefree`; `baseUrl` `https://api.cline.bot/api/v1`; `api` `openai-completions`; free bucket only.
- Capability precedence: models.dev `openrouter` (exact id → slug) → live Vercel AI Gateway (exact → slug) → defaults.
- Defaults: `contextWindow 256_000`, `maxTokens 32_000`, `input ["text"]`, `reasoning false`.
- Fixed URLs: lineup `https://api.cline.bot/api/v1/ai/cline/recommended-models`; models.dev `https://models.dev/api.json`; Vercel `https://ai-gateway.vercel.sh/v1`; GitHub `https://api.github.com/repos/cline/cline/git/matching-refs/` and `https://raw.githubusercontent.com/cline/cline/<sha>/<path>`.
- Tag prefixes: `tags/sdk/llms/v`, `tags/sdk/core/v`, `tags/cli-v`; API returns refs **lexicographically** — sort semver.
- TTLs: `sync.capabilityTtlMinutes` default **10**; `sync.minIntervalMinutes` default **30**; lineup refreshes every `session_start`.
- Config `~/.pi/agent/clinefree.json` (env `CLINEFREE_CONFIG`), mode `0600`; cache `~/.pi/agent/clinefree/cache/` (env `CLINEFREE_CACHE`); all writes atomic (temp + rename).
- Delisted models are dropped immediately; contract-parse failure falls back to the baked-in snapshot **with a user-visible warning**; nothing may block or crash pi startup — all sync errors downgrade to warnings.
- OAuth access tokens get the `workos:` prefix (idempotent); API keys are sent verbatim; both as `Authorization: Bearer …`.
- Auth validation endpoint: `GET /api/v1/users/me` (401 = reject, 200 = store `account`).
- No secrets in the repo; the live smoke reads its key from env `CLINEFREE_SMOKE_KEY`.
- Tests never touch the network — all external calls take an injectable `fetcher`.

## Review Focus

1. **Lexicographic tag lists** (`cli-v3.0.7` sorts after `cli-v3.0.65` as text) — semver compare must pick `cli-v3.0.65`. Test: Task 2.
2. **Model in neither feed** (a brand-new stealth id) must yield defaults, never a crash or `undefined`. Test: Task 5.
3. **OAuth refresh-token rotation** — a refresh response replaces the stored refresh token; losing it bricks the credential. Tested in Tasks 8–9.
4. **Delisted model that is pi's active model** — must notify and prompt a switch, not fail silently. Test: Task 10.
5. **Contract extraction failure** (upstream TS reshaped) — baked-in snapshot + warning, headers still sent. Test: Task 3.

---

### Task 1: Scaffold + state.ts (config & cache I/O)

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `state.ts`, `state.test.ts`, `.gitignore`

**Interfaces:**
- Produces: `interface ClinefreeConfig { auth?: Credential; sync: { minIntervalMinutes: number; capabilityTtlMinutes: number; notifyOnChange: boolean } }`, `DEFAULT_CONFIG: ClinefreeConfig`, `configPath(): string`, `loadConfig(): ClinefreeConfig` (creates file with mode `0600` if absent), `saveConfig(cfg): void`, `cacheDir(): string`, `readCache<T>(name: string): T | undefined`, `writeCache(name: string, data: unknown): void` (atomic, temp+rename).

- [ ] **Step 1: Write failing tests** — `state.test.ts`:

```ts
// env CLINEFREE_CONFIG / CLINEFREE_CACHE point at a tmp dir (set in beforeEach)
describe("state", () => {
  it("loadConfig creates 0600 config with defaults when absent", /* assert file exists, mode 0o600, sync === { minIntervalMinutes: 30, capabilityTtlMinutes: 10, notifyOnChange: true } */);
  it("saveConfig → loadConfig roundtrips and is atomic (no *.tmp left)", /* */);
  it("readCache returns undefined for missing; writeCache→readCache roundtrips", /* */);
});
```

- [ ] **Step 2: Run** `npx vitest run state.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement `state.ts`** — `node:fs`/`node:path`/`node:os`; `homedir()` defaults; mkdir cache dir recursive; write temp in same dir then `renameSync`; `chmod 0o600` for config only.
- [ ] **Step 4: Scaffold** `package.json` (name `pi-oc-cline`, `type: module`, `pi.extensions: ["./index.ts"]`, peerDeps `@earendil-works/pi-ai`/`pi-coding-agent`/`pi-tui`, devDeps `typescript`/`vitest`/`@types/node`, scripts `test: vitest run`, `typecheck: tsc --noEmit`), `tsconfig.json` (strict, module nodenext, types node), `vitest.config.ts` (include `**/*.test.ts`, testTimeout 10000), `.gitignore` (`node_modules/`, `*.tmp`).
- [ ] **Step 5: Run** `npx vitest run state.test.ts` — PASS. `npm i` then `npm run typecheck` — clean.
- [ ] **Step 6: Commit** `git add -A && git commit -m "feat: scaffold + config/cache state"`

### Task 2: github.ts — tag resolution + raw fetch at SHA

**Files:**
- Create: `github.ts`, `github.test.ts`, `test-fixtures/matching-refs-cli.json` (lexicographic list incl. `cli-v3.0.63`, `cli-v3.0.65`, `cli-v3.0.7`, `cli-v3.0.8`)

**Interfaces:**
- Consumes: none (pure + injectable `fetcher: typeof fetch`).
- Produces: `resolveLatestTag(prefix: string, fetcher?: typeof fetch): Promise<{ tag: string; sha: string }>` (tag = ref minus `refs/tags/`), `fetchRawAtSha(sha: string, path: string, fetcher?: typeof fetch): Promise<string>` (throws on !ok), `TAG_PREFIXES = { llms: "tags/sdk/llms/v", core: "tags/sdk/core/v", cli: "tags/cli-v" } as const`.

- [ ] **Step 1: Failing tests** — parse the fixture payload via a stub `fetcher`; assert `resolveLatestTag(TAG_PREFIXES.cli)` → tag `cli-v3.0.65` (semver, not lexicographic); `fetchRawAtSha("abc123","sdk/x.ts")` calls `raw.githubusercontent.com/cline/cline/abc123/sdk/x.ts` and returns body; non-200 → throws with status.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — GET `https://api.github.com/repos/cline/cline/git/matching-refs/${prefix}`; read `ref`/`object.sha`; `compareSemver(a,b)` on the version suffix after the last `v` (split `.` → numeric compare part-wise).
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat: github tag resolution + raw-at-sha`

### Task 3: contract.ts — header extraction + baked-in fallback

**Files:**
- Create: `contract.ts`, `contract.test.ts`, `test-fixtures/request-headers.ts` (real upstream text), `test-fixtures/cline-client-headers.ts` (real upstream text), `test-fixtures/catalog-cline-recommended.ts` (real upstream text)

**Interfaces:**
- Consumes: raw source strings.
- Produces:
  - `interface ContractResult { headers: Record<string,string>; endpointPath: string; cliVersion: string; coreVersion: string; source: "github" | "baked-in"; warning?: string }`
  - `extractContract(files: { requestHeaders?: string; recommended?: string }, versions: { cli: string; core: string }): ContractResult`
  - `BAKED_IN_CONTRACT: ContractResult` — header set from the verified 2026-09-27 upstream: `HTTP-Referer: https://cline.bot`, `X-Title: Cline`, `X-IS-MULTIROOT: false`, `X-CLIENT-TYPE: cline-cli`, `User-Agent: Cline/<cli>`, `X-CLIENT-VERSION`, `X-PLATFORM: cli`, `X-PLATFORM-VERSION` (all `<cli>`), `X-CORE-VERSION: <core>`, `endpointPath: "/api/v1/ai/cline/recommended-models"`, `source: "baked-in"`.

- [ ] **Step 1: Failing tests**:
  - `extractContract(fixtures, { cli: "3.0.65", core: "0.0.86" })` → `source: "github"`, no warning; `endpointPath` ends `/api/v1/ai/cline/recommended-models` (extracted from the `recommended.ts` fixture's template string, not hardcoded); base headers include `HTTP-Referer`, `X-Title`, `X-IS-MULTIROOT: false`, and `X-CLIENT-TYPE: cline-sdk` from the literal; derived `User-Agent: "Cline/3.0.65"`, `X-CLIENT-VERSION`, `X-PLATFORM: "cli"`, `X-PLATFORM-VERSION`, `X-CORE-VERSION: "0.0.86"`.
  - `extractContract({ requestHeaders: "export const X = 1;" }, versions)` → deep-equals `BAKED_IN_CONTRACT` shape with `source: "baked-in"` and a non-empty `warning`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — locate `DEFAULT_CLINE_REQUEST_HEADERS` object literal by regex, extract balanced-brace substring, tolerant-parse (quote bare keys, strip trailing commas) into `Record<string,string>`; any throw → return `BAKED_IN_CONTRACT` with `warning: "contract extraction failed (<err>); using baked-in snapshot"`. Endpoint path: regex the `recommended.ts` fixture for the `` `${…}/api/v1/ai/cline/recommended-models` `` literal's path segment; fallback to baked-in path.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat: contract extraction with baked-in fallback`

### Task 4: feeds.ts — models.dev + Vercel gateway clients

**Files:**
- Create: `feeds.ts`, `feeds.test.ts`, `test-fixtures/modelsdev.json` (reduced api.json: `providers.openrouter` with `stealth/space-bunny-alpha` (limit 1000000/524288, modalities.input `[text,image,video]`, reasoning_options `[{effort,[low,medium,high,xhigh,max]}]`), `deepseek/deepseek-v4.1-flash` (1048576/384000, `[text,image]`, `[{toggle},{effort,[low,high,max]}]`), `google/gemini-3.8-flash` (1048576/65536, `[text,image,video,audio,pdf]`, `[{effort,[low,medium,high]}]`), `xiaomi/mimo-v2.6-flash` (1048576/131072, `[{toggle}]]`), `meta/muse-spark-1.3-contributor` (1048576/943718, `[{effort,[minimal,low,medium,high,xhigh,max]}]`)), `test-fixtures/vercel-models.json` (`data: [ stealth/pixel-canary (context_window 262144, max_tokens 131072, modalities.input [text,image], reasoning_options `[{effort,[none,low,medium,xhigh]}]`), deepseek/deepseek-v4.1-flash (1048576/**32768**) ]`)

**Interfaces:**
- Consumes: injectable fetcher.
- Produces: `interface FeedEntry { id: string; name?: string; contextWindow?: number; maxTokens?: number; inputModalities?: string[]; effortValues?: string[]; toggle?: boolean }`, `reduceModelsDev(payload: unknown): Record<string, FeedEntry>` (keys = full openrouter ids), `reduceVercel(payload: unknown): Record<string, FeedEntry>`, `fetchModelsDevOpenRouter(fetcher?): Promise<Record<string, FeedEntry>>`, `fetchVercelGateway(fetcher?): Promise<Record<string, FeedEntry>>`.

- [ ] **Step 1: Failing tests**:
  - `reduceModelsDev(fixture)` returns the 5 entries keyed by full id, deepseek `maxTokens 384000`, space-bunny `toggle undefined`, effortValues arrays verbatim.
  - `reduceVercel(fixture)` returns pixel-canary `262144/131072` and deepseek `maxTokens 32768`.
  - `reduceModelsDev({})` / `reduceVercel({ data: null })` → `{}` (no throw).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — models.dev: `payload.providers.openrouter` each model → FeedEntry from `limit.context`, `limit.output`, `modalities.input`, `reasoning_options` (`type==="toggle"` → toggle; `type==="effort"` → values). Vercel: `payload.data[]` → `context_window`, `max_tokens`, `modalities.input`, `reasoning_options` same way. Fetchers GET the fixed URLs and reduce; throw on !ok.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat: capability feed clients`

### Task 5: capabilities.ts — precedence resolution

**Files:**
- Create: `capabilities.ts`, `capabilities.test.ts`

**Interfaces:**
- Consumes: `FeedEntry` from feeds.
- Produces: `interface ModelCapabilities { contextWindow: number; maxTokens: number; input: ("text"|"image")[]; reasoning: boolean; effortValues?: string[]; toggle: boolean; name?: string; source: "openrouter" | "vercel" | "default" }`, `DEFAULT_CAPABILITIES: ModelCapabilities` (`256_000`, `32_000`, `["text"]`, `reasoning false`, `toggle false`, `source "default"`), `resolveCapabilities(id: string, openrouter: Record<string, FeedEntry>, vercel: Record<string, FeedEntry>): ModelCapabilities`.

- [ ] **Step 1: Failing tests** (fixtures from Task 4):
  - `"cline-free/deepseek-v4.1-flash"` → `source "openrouter"`, `maxTokens 384000` (NOT 32768), `input ["text","image"]`, `toggle true`, `effortValues ["low","high","max"]`.
  - `"stealth/pixel-canary"` → `source "vercel"`, `262144/131072`, `effortValues ["none","low","medium","xhigh"]`.
  - `"stealth/space-bunny-alpha"` → `source "openrouter"` (exact id hit), `input ["text","image"]` (video dropped).
  - `"brand/new-thing"` → deep-equal `DEFAULT_CAPABILITIES`.
  - slug rule: `"cline-free/gemini-3.8-flash"` resolves via slug `gemini-3.8-flash` to `google/gemini-3.8-flash` (`1048576/65536`).
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — `const slug = id.split("/").pop()`; try `openrouter[id] ?? openrouter-by-slug` then `vercel[id] ?? vercel-by-slug`; map FeedEntry → ModelCapabilities (`input = (inputModalities ∩ ["text","image"])`, empty → `["text"]`; `reasoning = toggle || effortValues?.length > 0`); else `DEFAULT_CAPABILITIES`. Slug lookup: first matching key whose `.split("/").pop() === slug`.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat: capability precedence openrouter→vercel→defaults`

### Task 6: mapping.ts — capabilities → pi model

**Files:**
- Create: `mapping.ts`, `mapping.test.ts`

**Interfaces:**
- Consumes: `ModelCapabilities`.
- Produces: `interface ProviderModel { id: string; name: string; api: "openai-completions"; baseUrl: string; reasoning: boolean; thinkingLevelMap: Record<string, string | null>; input: ("text"|"image")[]; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number; compat?: Record<string, unknown> }`, `toProviderModel(id: string, caps: ModelCapabilities, feedName?: string): ProviderModel`, `LEVELS = ["off","minimal","low","medium","high","xhigh","max"]`.

- [ ] **Step 1: Failing tests** — `thinkingLevelMap` builds every level key with `null` for unsupported:
  - deepseek (toggle + effort `[low,high,max]`) → `{ off: "none", low: "low", high: "high", max: "max", minimal: null, medium: null, xhigh: null }`.
  - pixel-canary (effort `[none,low,medium,xhigh]`) → `{ off: "none", low: "low", medium: "medium", xhigh: "xhigh", minimal: null, high: null, max: null }`.
  - mimo (toggle only) → `{ off: "none", high: "high", others null }`.
  - gemini (effort `[low,medium,high]`, no toggle) → `{ low, medium, high mapped; off: null; minimal/xhigh/max null }`.
  - `compat` = `{ thinkingFormat: "openrouter" }` iff `effortValues` non-empty; `undefined` for toggle-only/none. `reasoning` mirrors `caps.reasoning`. `cost` all zero. `name` = caps.name ?? feedName ?? id, with ` (free)` appended when taken from the feed name.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — build map over `LEVELS`; `off` ← `"none"` if `toggle` or effortValues includes `"none"`; `minimal…max` ← same-named advertised value or `null`.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat: capabilities→pi model mapping`

### Task 7: sources/ — FreeModelSource (cline)

**Files:**
- Create: `sources/types.ts`, `sources/cline.ts`, `sources/cline.test.ts`, `test-fixtures/recommended-models.json` (real captured payload, 4 buckets, `free` = the 6 live ids)

**Interfaces:**
- Consumes: `github.ts`, `contract.ts`, `feeds.ts`, `capabilities.ts`, `state.ts` cache.
- Produces:
```ts
// sources/types.ts
export interface LineupEntry { id: string; name?: string; description?: string; tags?: string[] }
export interface FreeModelSource {
  id: string;
  refreshContract(force?: boolean): Promise<ContractResult>;
  fetchLineup(): Promise<LineupEntry[]>;
  refreshCapabilities(): Promise<{ openrouter: Record<string, FeedEntry>; vercel: Record<string, FeedEntry> }>;
  resolveCapabilities(id: string): ModelCapabilities;
}
```
  `createClineSource(deps: { fetcher?: typeof fetch; state?: typeof stateModule }): FreeModelSource` — caches tags/contract/capabilities in `contract.json`/`capabilities.json` and consults `state.json` timestamps for the TTL gates (10 min capabilities / 30 min tags).

- [ ] **Step 1: Failing tests** (stub fetcher serving fixtures; tmp cache dir):
  - `fetchLineup()` → exactly the fixture `free[]` ids, order preserved; calls the lineup URL with contract headers (assert stub saw `X-CLIENT-TYPE` and `User-Agent`).
  - `refreshContract()` on empty cache → resolves 3 tags, downloads contract files, result `source "github"`; second call with unchanged tags → no raw downloads (count stub calls).
  - `refreshCapabilities()` → reduces both feeds into cache; `resolveCapabilities("stealth/pixel-canary")` → `262144/131072` even when the fetcher is then made to fail (cache reuse).
  - lineup endpoint returns only `{ free: [] }` (no other buckets) → `[]`, no throw; lineup fetch failing later → last cached `lineup.json` ids returned.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** — wire the modules per spec §4 data flow; record tags, SHAs, per-file timestamps and `lastResult` in `state.json`; every step wrapped so failures either fall back to cache (capabilities/lineup) or `BAKED_IN_CONTRACT` (contract) and collect warnings.
- [ ] **Step 4: Run** — PASS. **Step 5: Commit** `feat: cline FreeModelSource`

### Task 8: auth.ts — API key + OAuth device flow

**Files:**
- Create: `auth.ts`, `auth.test.ts`

**Interfaces:**
- Consumes: `state.ts` (`loadConfig`/`saveConfig`), `ContractResult.headers` for auth request headers.
- Produces: `interface Credential { mode: "apiKey" | "oauth"; apiKey?: string; accessToken?: string; refreshToken?: string; expiresAt?: number; account?: { id?: string; email?: string } }`, `formatAuthorization(cred): string` (`"Bearer sk-…"` verbatim; oauth → `workos:` prefix idempotent), `isTokenStale(cred, bufferMs = 300_000): boolean`, `validateCredential(cred, headers, fetcher?): Promise<{ ok: true; account: { id?: string; email?: string } } | { ok: false; status: number }>` (GET users/me), `refreshClineToken(refreshToken, headers, fetcher?): Promise<{ accessToken: string; refreshToken: string; expiresAt?: number }>`, `runDeviceFlow(headers, fetcher?, onStatus?: (msg: string) => void): Promise<Credential>` (WorkOS `client_01K3A541FN8TA3EPPHTD2325AR` device authorize → poll → `POST api.cline.bot/api/v1/auth/register`).

- [ ] **Step 1: Failing tests** (stub fetcher):
  - `formatAuthorization({mode:"apiKey",apiKey:"sk-x"})` → `"Bearer sk-x"`; oauth raw token → `"Bearer workos:<t>"`; already-prefixed → unchanged.
  - `isTokenStale`: no token → true; `expiresAt` 4 min out → true; 10 min out → false; undefined expiry → false.
  - `validateCredential`: 401 → `{ok:false,status:401}`; 200 `{data:{id,email}}` → account stored.
  - `refreshClineToken` returns rotated pair; rejects `{success:true}` without tokens.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (port endpoint paths from `pi-multikey/cline-auth.ts`; single-flight refresh keyed by refresh token). **Step 4: Run** — PASS. **Step 5: Commit** `feat: auth (api key + device flow)`

### Task 9: stream.ts — credential-injecting streamSimple

**Files:**
- Create: `stream.ts`, `stream.test.ts`

**Interfaces:**
- Consumes: `getApiProvider`, `createAssistantMessageEventStream` from `@earendil-works/pi-ai`; `auth.ts`; `ContractResult`.
- Produces: `createClinefreeStream(deps: { getCredential(): Credential | undefined; getContract(): ContractResult; onCredentialSaved(c: Credential): void; notify(msg: string): void }): streamSimple` — resolves credential (oauth: refresh when stale, persist rotation via `onCredentialSaved`), delegates to `getApiProvider("openai-completions").streamSimple(model, context, { …options, headers: { …options?.headers, Authorization, …contractHeaders, "X-Task-ID": taskId() } })`; on HTTP 401 marks the credential invalid (`onCredentialSaved` with cleared tokens) + notifies once, does not retry; all other behavior passes through. `taskId()` = one `randomUUID()` per conversation, resettable via `resetConversation(reason)` for `new|resume|fork`.

- [ ] **Step 1: Failing tests** (stub the pi-ai provider via module mock):
  - request headers contain `Authorization: Bearer sk-x`, `X-Task-ID` uuid, contract headers; events relayed.
  - stale oauth → refresh stub called once, rotated pair persisted, new Authorization used.
  - 401 from provider → notify called, no second stream call.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement** (mirror `pi-multikey/stream.ts` relay shape, minus key rotation). **Step 4: Run** — PASS. **Step 5: Commit** `feat: credential-injecting streamSimple`

### Task 10: registry.ts + index.ts — registration, sync, notifications

**Files:**
- Create: `registry.ts`, `registry.test.ts`, `index.ts`

**Interfaces:**
- Consumes: everything above; `ExtensionAPI` (`pi.registerProvider(id, { name, baseUrl, apiKey, api, headers, models, streamSimple })`, `pi.unregisterProvider`, `pi.on("session_start")`, `ctx.ui.notify`).
- Produces: `diffModels(current: string[], desired: string[]): { added: string[]; removed: string[] }`; `index.ts` default factory that: at load registers `clinefree` from cached state (fail-soft); on `session_start` runs the sync flow (lineup always; capabilities if older than `capabilityTtlMinutes`; tags if older than `minIntervalMinutes`; contract only on tag change), re-registers on diff, notifies `+N new: … · −M delisted: …` when `notifyOnChange`, warns once per sync (contract fallback etc.), and when a removed id equals pi's current model id notifies a switch prompt. No credential ⇒ skip registration and hint `/clinefree`.

- [ ] **Step 1: Failing tests** — `diffModels(["a","b"],["b","c"])` → `{added:["c"],removed:["a"]}`; empty/empty → no-op. Sync orchestration tested via a fake source + fake pi object: assert register called with `providerId "clinefree"`, `models[0].id === fixture free[0]`, `api "openai-completions"`; removal of the active model triggers the switch notification; thrown source error → warning notify, no crash, previous models kept.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** `feat: provider registration + sync flow`

### Task 11: tui.ts — /clinefree command

**Files:**
- Create: `tui.ts`, `tui.test.ts`

**Interfaces:**
- Consumes: sync state (`lastResult`, tags, timestamps, credential mode/account, model list with capability source), `auth.runDeviceFlow`, refresh entrypoint from Task 10.
- Produces: `registerClinefreeCommand(pi, deps)` — `/clinefree` with a menu: **Status** (tags, last sync time, contract source incl. baked-in warning, auth mode + account email), **Models** (id, name, ctx/out, capability source `openrouter|vercel|default`), **Auth** (paste API key / device flow / clear), **Refresh now**, **History** (past added/removed). Pure helpers `formatStatus(s): string`, `formatModels(models): string` are the tested surface; the menu loop follows `pi-multikey/tui.ts` patterns.

- [ ] **Step 1: Failing tests** — `formatStatus` renders tags, TTL countdown, `baked-in` warning, masked credential (`sk-1234…abcd` style), account email; `formatModels` renders one line per model with its capability source and ctx/out.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** `feat: /clinefree command`

### Task 12: smoke.ts + README + final verification

**Files:**
- Create: `smoke.ts`, `README.md`

**Interfaces:**
- Consumes: all modules live.

- [ ] **Step 1: Write `smoke.ts`** — reads `CLINEFREE_SMOKE_KEY`; runs: `validateCredential` → `fetchLineup` → both feeds → `resolveCapabilities` for every lineup id (prints table) → one `max_tokens: 256` chat against `cline-free/mimo-v2.6-flash`; prints PASS/FAIL per step; exits non-zero on failure. Guard: refuses to run without the env var.
- [ ] **Step 2: Write `README.md`** — install, `/clinefree` auth (both modes), how sync works, the three capability sources and precedence, defaults, config/cache paths, smoke instructions. No secrets.
- [ ] **Step 3: Verify** — `npm run typecheck && npx vitest run` all green; `import('./index.ts')` via a one-off vitest test asserting `typeof default === "function"` with no side effects beyond config/cache creation.
- [ ] **Step 4: Commit** `feat: live smoke + readme` — then run the smoke once with the dev key (manual, outside CI) and record results in the PR description, not the repo.
