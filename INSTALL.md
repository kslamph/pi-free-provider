# Installing `pi-free-provider`

The package is **public** on npm ([`pi-free-provider`](https://www.npmjs.com/package/pi-free-provider))
and the source is public at <https://github.com/kslamph/pi-free-provider> (MIT).
Pick whichever route you prefer — npm is the common one, git is useful when you
want to follow `master` between releases or run your own patch.

For what the extension does, the sign-in flows and the env vars it honours, see
[README.md](./README.md).

---

## 0. Prerequisites

- [`pi`](https://pi.dev) installed, and **Node.js ≥ 22** (`node -v`).
- For the git routes: git (`git --version`).
- `bun` only if you want `zenfree` — the OpenCode Zen free tier is served through
  a small Bun relay (`bun --version`); `clinefree` works without it.

Runtime dependencies: none of your own. Every import is a pi-supplied peer
package, so there is nothing extra to install after the extension lands.

---

## 1. From npm (recommended)

```bash
pi install npm:pi-free-provider
```

Pin a version, or try it without installing:

```bash
pi install npm:pi-free-provider@0.2.1
pi -e npm:pi-free-provider
```

## 2. From git (follows `master`)

The repo is public, so no credentials are involved:

```bash
pi install git:github.com/kslamph/pi-free-provider
```

Use a pinned tag if you'd rather not track the default branch:

```bash
pi install git:github.com/kslamph/pi-free-provider@v0.2.1
```

If you have push access and want the SSH clone, force it with the full URL form
(the shorthand above always clones over HTTPS):

```bash
pi install git:git@github.com:kslamph/pi-free-provider.git
```

## 3. From a local checkout

Best if you intend to read or patch the source — nothing is fetched by pi:

```bash
git clone https://github.com/kslamph/pi-free-provider.git
pi install ./pi-free-provider
```

---

## 4. First run

```bash
pi                      # start a session
/clinefree              # → Auth → Paste API key | Sign in with Cline (device flow)
/zenfree                # → Auth → Paste workspace key   (OpenCode Zen, optional)
```

Credentials are stored locally (`~/.pi/agent/clinefree.json`,
`~/.pi/agent/zenfree.json`, mode `0600`) — **nothing in this repo contains or
receives a key.** Model ids then appear under `/model` as `clinefree/*`,
`zenfree/*` and `zenfree.res/*`.

---

## 5. Keeping up to date

```bash
pi update --extensions     # refreshes npm installs and branch-tracking git installs
pi list                    # shows configured packages
pi config                  # shows what each package registers
```

A pinned ref (`@0.2.1`, `@v0.2.1`, a commit) stays pinned — update by removing
and re-adding it with a newer ref. Installs from a local path just follow your
working tree; re-run `pi install ./pi-free-provider` only if you move the folder.

Uninstall:

```bash
pi remove npm:pi-free-provider
# or: pi remove git:github.com/kslamph/pi-free-provider
```

---

## 6. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `npm ERR! 404` on `pi install npm:pi-free-provider` | Registry lag right after a release, or a bad version pin. Check `npm view pi-free-provider version`; drop the `@version` to take `latest`. |
| `zenfree` models always answer `429 FreeUsageLimitError` | Bun is missing (or `$ZENFREE_BUN` is wrong), so the relay never started. `bun --version`, or set `ZENFREE_BUN=/path/to/bun`. `clinefree` is unaffected. |
| Clone succeeds but the extension seems absent | Restart pi or `/reload`; confirm with `pi list` and `pi config`. |
| `Permission denied (publickey)` on the SSH form | That form is only needed for push access — use the `git:github.com/…` or npm form instead. |
| Want to read/tweak the source first | Clone it and install the local path: `git clone https://github.com/kslamph/pi-free-provider.git && pi install ./pi-free-provider` |
| Something looks wrong in the model list | Run `/clinefree` → `Refresh` (or `/zenfree` → `Refresh`); the cached lineup lives in `~/.pi/agent/<provider>/cache`. |
