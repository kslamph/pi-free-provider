# pi-oc-cline

A pi extension that exposes **Cline's free models** as one auto-synced provider.

The free lineup on `api.cline.bot` rotates constantly — new models appear, old
ones are delisted. This extension keeps itself in sync so you never hand-edit
model definitions again:

- **Lineup** — `GET /api/v1/ai/cline/recommended-models` (`free[]` only), fetched
  live on every session start. New models are added automatically; delisted
  models are dropped immediately.
- **Capabilities** — resolved per model from two live feeds, in order:
  1. **models.dev** (`openrouter` block) — the canonical source Cline's runtime
     uses, with structured reasoning options,
  2. **Vercel AI Gateway** (`ai-gateway.vercel.sh/v1/models`) — the only place
     Vercel-only stealth ids (e.g. `stealth/pixel-canary`) exist,
  3. otherwise **fixed defaults**: 256K context / 32K output / text-only.
- **Contract** — the header set and endpoint path Cline's official CLI sends,
  extracted from the [cline/cline](https://github.com/cline/cline) repo at the
  latest release tags (`cli-v*`, `sdk/core/v*`, `sdk/llms/v*`). If extraction
  fails, a baked-in snapshot is used and you are warned — startup never blocks.

## Install

```bash
pi install /path/to/pi-oc-cline
```

## Sign in

```
/clinefree → Auth
```

Two modes, both sent as `Authorization: Bearer …`:

- **Paste API key** — a Cline API key (`sk-…`), validated against
  `GET /api/v1/users/me` (no model quota consumed).
- **Sign in with Cline (device flow)** — WorkOS device authorization, tokens
  refreshed and rotated automatically.

## Models

Everything is exposed as `clinefree/<feed id>`, e.g.
`clinefree/cline-free/deepseek-v4.1-flash`. All models are zero-cost with a
daily per-account, per-model quota. `/clinefree → Models` lists the current
lineup with each model's context, output cap, and where its capabilities came
from (`openrouter` / `vercel` / `default`).

## Sync behaviour

| What | When |
|---|---|
| live lineup | every session start (`/clinefree refresh` to force) |
| capability feeds | when the lineup contains a model id never fetched before; afterwards never re-fetched automatically — `/clinefree → Refresh now` forces a re-pull |
| contract tags | when older than 30 minutes; files re-downloaded only when a tag changed |

Capability data (context window, output cap, reasoning levels) for a given
model is effectively static, so each model's entry is fetched once and kept.
A delisted-then-relonged model reuses its stored entry; no wasted requests.

Everything fails soft: an unreachable feed falls back to the last-known-good
cache, then to defaults, with a warning — never a broken startup.

## Files

| Path | Purpose |
|---|---|
| `~/.pi/agent/clinefree.json` | config incl. credential (mode 0600) |
| `~/.pi/agent/clinefree/cache/` | contract / lineup / capabilities / sync history |

Env overrides: `CLINEFREE_CONFIG`, `CLINEFREE_CACHE`.

## Development

```bash
npm install
npm test          # vitest, no network — all external calls are injectable
npm run typecheck
CLINEFREE_SMOKE_KEY=sk-… node --experimental-strip-types smoke.ts   # live smoke, never in CI
```

## Status / history

`/clinefree` also shows the resolved contract tags, feed freshness, the
credential (masked), the account email, and the last add/remove diff.

## zenfree — OpenCode Zen free models (second source)

`zenfree` adds OpenCode Zen's free tier as a second, fully independent source:

- **Providers**: `zenfree/*` (openai-completions) and `zenfree.res/*` (openai-responses — e.g.
  muse-spark). One provider per transport because pi dispatches a custom `streamSimple` only on an
  api match; both share the same workspace key.
- **Auth**: pasted workspace key from opencode.ai/auth → workspace Keys. Stored in
  `~/.pi/agent/zenfree.json` (0600); cache under `~/.pi/agent/zenfree/cache/` (env
  `ZENFREE_CONFIG`/`ZENFREE_CACHE`).
- **Lineup + capabilities**: console `GET /api/v2/config` is authoritative — free = every cost
  tier `input == 0`; limits/input come from the same response, gaps filled from models.dev
  `opencode` (fetched once per model id, `Refresh` forces), then zen defaults (200K/32K,
  reasoning on). Delisted models drop immediately.
- **Client contract**: `User-Agent opencode/latest/<ver>/cli` from the official update service
  (`opencode.ai/update/api/latest/cli`), `x-opencode-client: cli`, plus per-conversation
  `x-opencode-session` and per-turn `x-opencode-request` ids (the gateway 403-rejects requests
  without them). The gateway prescribes `x-opencode-org-id` via the config; it is attached
  automatically.
- **Sync**: every `session_start`; `/zenfree` → Status · Models · Auth · Refresh · History.

Live smoke for both sources (keys via env, never committed):

```
CLINEFREE_SMOKE_KEY=sk-… ZENFREE_SMOKE_KEY=oc_sk_… node --experimental-strip-types smoke.ts
```
