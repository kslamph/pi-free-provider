# pi-free-provider

**Free models in [pi](https://pi.dev/), kept in sync automatically.**

This extension gives pi two free pools as normal providers, with a model list that
refreshes itself on every session start instead of going stale in a config file:

- **`clinefree`** — the free bucket on `api.cline.bot` (Cline's model router).
- **`zenfree`** / **`zenfree.res`** — the free tier of OpenCode Zen.

You bring your own credential (or use the device-flow login); nothing is shared
and no quota is proxied through anyone else.

```
/model clinefree/reflection/beam-free
/model zenfree/deepseek-v4.1-flash-free
```

## Requirements

| What | Why |
|---|---|
| pi (`@earendil-works/pi-coding-agent`) | the host |
| Node ≥ 22 | pi's runtime |
| **bun** *(only for `zenfree`)* | Zen's gateway serves free requests only to Bun-shaped TLS clients; see [Bun](#bun-required-for-zenfree) |

## Install

```sh
pi install npm:pi-free-provider
```

Other ways in:

```sh
pi install git:github.com/kslamph/pi-free-provider   # straight from git
pi install /path/to/pi-free-provider                 # working checkout
pi -e npm:pi-free-provider                           # ephemeral, no install
```

Pinned versions, git refs and install troubleshooting: [INSTALL.md](./INSTALL.md).

Update or remove:

```sh
pi update npm:pi-free-provider
pi remove npm:pi-free-provider
```

## Sign in

Both sources are optional and independent — install one credential, or both.

```
/clinefree → Auth
```

| Option | What it does |
|---|---|
| **Paste API key** | a Cline API key (`sk-…`), verified against `GET /api/v1/users/me` (no quota used) |
| **Sign in with Cline (device flow)** | browser login; tokens refresh and rotate by themselves |
| **Clear credential** | forget it |

Both routes reach the same free models — a pasted key is not a paid-only path.
Pick by preference: a key is a single long-lived string, the device flow keeps
tokens rotating and never stores a key.

```
/zenfree → Auth
```

| Option | What it does |
|---|---|
| **Paste workspace key** | a key from [opencode.ai/auth](https://opencode.ai/auth) → workspace Keys |
| **Sign in with OpenCode** | device-flow login against OpenCode Console |
| **Clear credential** | forget it |

Both routes are equivalent for the free tier — the key and the console token are
entitled to the same free models, and both are served through the Bun relay, so
`bun` is required either way. Pick by preference: a workspace key does not
expire and is trivial to revoke, the device flow refreshes itself.

Credentials live in `~/.pi/agent/clinefree.json` and `~/.pi/agent/zenfree.json`
(mode `0600`). They are never written into a pi session, an export, or a repo.

## Use

Everything registers as a normal pi provider, so `/model`, `/models`, `-m`, and
subagents all work:

| Provider | Model ids | Notes |
|---|---|---|
| `clinefree` | `clinefree/<feed id>`, e.g. `clinefree/reflection/beam-free` | chat-completions |
| `zenfree` | `zenfree/<id>`, e.g. `zenfree/deepseek-v4.1-flash-free` | chat-completions |
| `zenfree.res` | `zenfree.res/<id>` | OpenAI **Responses** transport, for models that require it |

The exact current lineup is whatever the live feeds say — ask:

```
/clinefree → Models
/zenfree → Models
```

Each entry shows its context window, output cap, and where those numbers came
from. All of these models are zero-cost with a **daily per-account, per-model
quota**; hitting it produces a `429`, which is a limit, not a credential problem.

## Status and refresh

```
/clinefree → Status
/zenfree → Status
```

Shows the resolved client contract (the headers/version the upstream CLI sends),
feed freshness, the credential (masked), and the account. Press **`r`** in the
Status panel to force a refresh — otherwise everything refreshes on its own:

| What | When |
|---|---|
| model lineup | every session start |
| capability data (context/output/input) | once per newly seen model id, then cached |
| upstream client contract | when older than 30 minutes |
| zen credential token | automatically, shortly before it expires |

Every network path fails soft: an unreachable feed falls back to the last good
cache, then to documented defaults, with a warning — never a broken startup.

## Bun (required for `zenfree`)

Since the 2026-10-22 gateway change, OpenCode Zen serves free-tier requests only
to TLS clients shaped like its own Bun-based CLI. The identical request gets
`200` from Bun and `429` from Node, so `zenfree` spawns a small Bun relay
(`zen-sidecar.ts`) on loopback and sends the request through it; the request
shape itself is unchanged.

- Install bun: <https://bun.sh> (`curl -fsSL https://bun.sh/install | bash`).
- Resolution order: `$ZENFREE_BUN` → Bun on `PATH` (`bun.exe`/`bun.cmd` on
  Windows) → `~/.bun/bin/bun` (or `%USERPROFILE%\.bun\bin\bun.exe` on Windows).
- If bun is missing, the extension says so once and falls back to direct
  requests — which the gateway will most likely answer with `429`. `clinefree`
  is unaffected and needs no bun.

## Files and environment

| Path | Purpose |
|---|---|
| `~/.pi/agent/clinefree.json` / `~/.pi/agent/zenfree.json` | config + credential (`0600`) |
| `~/.pi/agent/clinefree/cache/` / `~/.pi/agent/zenfree/cache/` | contract, lineup, capabilities, sync history |

| Variable | Effect |
|---|---|
| `CLINEFREE_CONFIG`, `CLINEFREE_CACHE` | relocate that source's files |
| `ZENFREE_CONFIG`, `ZENFREE_CACHE` | relocate that source's files |
| `ZENFREE_BUN` | path to the bun binary |
| `ZENFREE_SIDECAR_PORT` | pin the relay's port (default: random) |

## Troubleshooting

| Symptom | Cause |
|---|---|
| `429` "Free usage limit reached" on `zenfree` | bun missing/invalid (`ZENFREE_BUN`), or the model's daily quota is spent |
| `403` "only available via Cline product surfaces" / FreeTierError | client-shape gate; the extension pads the request itself — report it if it persists |
| `426` | the upstream CLI version moved; the next contract refresh picks it up (`r` in Status) |
| `401` | credential rejected — re-add it via `/… → Auth` |
| a model vanished from `/model` | upstream dropped it, or (zen) the catalog flags it deprecated; the lineup is live, not pinned |
| no models at all | that source has no credential yet: `/clinefree → Auth` |

## Development

```sh
npm install
npm test          # vitest, no network — every external call is injectable
npm run typecheck
npm pack --dry-run   # check what actually ships (the Bun relay must be in it)

# live smoke (never in CI): keys come from the environment
CLINEFREE_SMOKE_KEY=sk-… ZENFREE_SMOKE_KEY=oc_sk_… node --experimental-strip-types smoke.ts
```

Releases are cut by tagging: bump `version` in `package.json`, commit, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow in
`.github/workflows/release.yml` verifies the tag, runs the tests, checks the
tarball, and publishes to npm.

## License

MIT — see [LICENSE](LICENSE).
