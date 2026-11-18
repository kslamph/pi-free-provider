# pi-free-provider

**Free models in [pi](https://pi.dev/), kept in sync automatically.**

This extension gives pi two free pools as normal providers, with a model list that
refreshes itself on every session start instead of going stale in a config file:

- **`clinefree`** — the free bucket on `api.cline.bot` (Cline's model router).
- **`zenfree`** / **`zenfree.res`** — the free tier of OpenCode Zen.

`clinefree` needs your own credential (or the device-flow login). `zenfree` is
anonymous-only: it never reads, stores, or sends a key or token, and uses
OpenCode's anonymous per-IP free quota. Nothing is shared and no quota is
proxied through anyone else.

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

Only `clinefree` needs a credential.

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

The clinefree credential lives in `~/.pi/agent/clinefree.json` (mode `0600`).

`zenfree` and `zenfree.res` work without setup once Bun is installed. They use
anonymous access (`Authorization: Bearer public`) and discover models from the
public OpenCode catalog on models.dev.

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
from. Zen uses an anonymous per-IP quota; Cline uses its own account quota.

## Status and refresh

```
/clinefree → Status
/zenfree → Status
```

Shows the resolved client contract (the headers/version the upstream CLI sends),
feed freshness, and authentication status. Press **`r`** in the
Status panel to force a refresh — otherwise everything refreshes on its own:

| What | When |
|---|---|
| model lineup | every session start |
| capability data (context/output/input) | once per newly seen model id, then cached |
| upstream client contract | when older than 30 minutes |

The session starts from the last cached lineup; the live refresh runs in the
background so a slow feed does not block Pi's prompt. Automatic metadata
requests time out after 10 seconds and the complete refresh has a 30-second
deadline. Every network path fails soft: an unreachable feed falls back to the
last good cache, then to documented defaults, with a warning.

## Bun (required for `zenfree`)

Since the 2026-10-22 gateway change, OpenCode Zen serves free-tier requests only
to TLS clients shaped like its own Bun-based CLI. The identical request gets
`200` from Bun and `429` from Node, so `zenfree` spawns a small Bun relay
(`zen-sidecar.ts`) on loopback and sends the request through it; the request
shape itself is unchanged.

Two steps:

1. Install Bun: `curl -fsSL https://bun.sh/install | bash`
   (Windows: `powershell -c "irm bun.sh/install.ps1 | iex"`).
2. Restart pi, then retry the request. Bun in `~/.bun/bin` (`%USERPROFILE%\.bun\bin`)
   is also picked up mid-session, because the relay re-resolves Bun on every request.

The extension finds Bun on `PATH` or in its standard per-user installation
directory (`~/.bun/bin` or `%USERPROFILE%\.bun\bin`). The relay automatically
binds an available local port.
If Bun is missing, the extension prints exactly these two steps once and falls
back to direct requests — which the gateway will most likely answer with `429`.
`clinefree` is unaffected and needs no Bun.

## Files and environment

| Path | Purpose |
|---|---|
| `~/.pi/agent/clinefree.json` | Cline config and credential (`0600`) |
| `~/.pi/agent/clinefree/cache/` / `~/.pi/agent/zenfree/cache/` | contract, lineup, capabilities, sync history |

| Variable | Effect |
|---|---|
| `CLINEFREE_CONFIG`, `CLINEFREE_CACHE` | relocate clinefree's files |
| `PI_CODING_AGENT_DIR` | Pi's agent directory (default `~/.pi/agent`); Zen keeps its internal cache under it |

Zen always uses the OpenCode upstream at `https://opencode.ai/inference/openai/v1`.
The Bun relay forwards to that same fixed endpoint; there is no `baseUrl` setting.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `429` "Free usage limit reached" on `zenfree` | Bun could not start, or the model's quota is spent |
| `403` "only available via Cline product surfaces" / FreeTierError | client-shape gate; the extension pads the request itself — report it if it persists |
| `426` | the upstream CLI version moved; the next contract refresh picks it up (`r` in Status) |
| `401` | anonymous requests should not 401 — check the network/proxy |
| a model vanished from `/model` | upstream dropped it, or (zen) the catalog flags it deprecated; the lineup is live, not pinned |
| no models at all | `clinefree` has no credential (`/clinefree → Auth`); `zenfree` could not reach models.dev and has no cache |

## Development

```sh
npm install
npm test          # vitest, no network — every external call is injectable
npm run typecheck
npm pack --dry-run   # check what actually ships (the Bun relay must be in it)

# live smoke (never in CI): keys come from the environment
node --experimental-strip-types smoke.ts
```

Releases are cut by tagging: bump `version` in `package.json`, commit, then
`git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow in
`.github/workflows/release.yml` verifies the tag, runs the tests, checks the
tarball, and publishes to npm.

## License

MIT — see [LICENSE](LICENSE).
