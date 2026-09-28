# Installing `pi-free-provider` from this repo

You have been added as a collaborator on this **private** repo, so pi can install
it straight from git. pi shells out to plain `git clone`, which means **your own
GitHub credentials** do the work — the extension just needs the clone to succeed
non-interactively.

Accept the invitation first: <https://github.com/kslamph/pi-free-provider>
(you should have a notification / email from GitHub; if not, ask me to re-send it).

---

## 0. Prerequisites

- [`pi`](https://pi.dev) installed, and **Node.js ≥ 22** (`node -v`).
- git installed (`git --version`).
- One of the two auth setups below (SSH *or* HTTPS). You only need one.

Verify before installing — this is the single most useful check:

```bash
git ls-remote https://github.com/kslamph/pi-free-provider.git HEAD   # HTTPS test
git ls-remote git@github.com:kslamph/pi-free-provider.git HEAD       # SSH test
```

If a URL prints a commit SHA, `pi install` will work. If it prompts for a
username/password, finish that section below first.

---

## 1a. Install with HTTPS auth

Easiest if you already use the GitHub CLI.

```bash
# one-time: sign in and hand git your credentials
gh auth login
gh auth setup-git          # registers the gh credential helper for github.com
```

No `gh`? Use a **fine-grained personal access token** (or classic token with
`repo` scope) with the git credential helper:

```bash
git config --global credential.helper store   # or: osxkeychain / libsecret / manager
git ls-remote https://github.com/kslamph/pi-free-provider.git HEAD
#   Username: kslamph-or-your-login
#   Password: <paste the token, NOT your account password>
```

Then install:

```bash
pi install git:github.com/kslamph/pi-free-provider
```

> pi builds the clone URL as `https://github.com/<owner>/<repo>` for this form, so
> the credential helper above is what authenticates it.

## 1b. Install with SSH auth

```bash
# generate a key if you don't have one
ssh-keygen -t ed25519 -C "your-email@example.com" -f ~/.ssh/id_ed25519 -N ""

# print the public key and add it at github.com → Settings → SSH and GPG keys
cat ~/.ssh/id_ed25519.pub

# authorize the host and test
ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null
ssh -T git@github.com      # expect: "Hi jkevinp! You've successfully authenticated"
```

Then install using the **`git@…` form of the URL** (this is what forces SSH —
the shorthand `git:github.com/…` would otherwise clone over HTTPS):

```bash
pi install git:git@github.com:kslamph/pi-free-provider.git
```

---

## 2. First run

```bash
pi                      # start a session
/clinefree              # → Auth → Paste API key | Sign in with Cline (device flow)
/zenfree                # → Auth → Paste workspace key   (OpenCode Zen, optional)
```

Your credentials are stored locally (`~/.pi/agent/clinefree.json`,
`~/.pi/agent/zenfree.json`, mode `0600`) — **nothing in this repo contains or
receives a key.** Model ids then appear under `/model` as `clinefree/*`,
`zenfree/*` and `zenfree.res/*`.

---

## 3. Keeping up to date

Installs without a pinned ref track the repo's default branch:

```bash
pi update --extensions          # pulls my latest pushes
pi list                         # shows configured packages
```

If you pinned a tag or commit (`pi install git:github.com/kslamph/pi-free-provider@v0.1.0`),
that ref stays pinned — updating means removing and re-adding, or installing a new ref:

```bash
pi remove git:github.com/kslamph/pi-free-provider@v0.1.0
pi install git:github.com/kslamph/pi-free-provider
```

Uninstall:

```bash
pi remove git:github.com/kslamph/pi-free-provider
```

---

## 4. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `pi install` prints a `Username for 'https://github.com'` prompt (or hangs) inside the pi TUI | No usable HTTPS credential. Run `git ls-remote …` in a normal terminal to authenticate once, or switch to the SSH form. |
| `403` / `repository not found` on a repo you know exists | You haven't accepted the collaboration invitation, or it was revoked. Open the repo URL and accept. |
| `Permission denied (publickey)` on the SSH form | Key not added to your GitHub account, or the SSH agent doesn't have it: `ssh-add ~/.ssh/id_ed25519`. |
| Clone succeeds but the extension seems absent | Restart pi or run `/reload`; confirm with `pi list` and `pi config`. |
| Want to read/tweak the source first | Clone it yourself and install the local path — no pi-side auth involved: `git clone git@github.com:kslamph/pi-free-provider.git && pi install ./pi-free-provider` |
| Runtime deps? | None. All imports are pi-supplied peer packages, so the `npm install --omit=dev` pi runs after cloning installs nothing extra. |
