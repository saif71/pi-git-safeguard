# pi-git-safeguard

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that gates git
and GitHub CLI **write operations** behind explicit user approval — so the agent
can't autonomously `git commit`, `git push`, open or merge PRs, force-delete
branches, or rewrite history without you saying so.

Read-only commands (`git status`, `git diff`, `git log`, `gh pr view`, ...) are
never blocked.

## What gets blocked

**git:**
`commit` · `push` · `rebase` · `reset --hard/--keep/--merge` · `revert` ·
`cherry-pick` · `merge` · `am` · `apply` · `tag -d` ·
`branch -d/-D/-m/-M` · `stash drop/clear` · `update-ref` ·
`symbolic-ref --delete`

**GitHub CLI (`gh`):**
`pr create/merge/edit/close/ready` · `pr review --approve/--request-changes` ·
`issue create/edit/close` · `repo delete`

## Behavior

- **Interactive (TUI/RPC):** when the agent calls `bash` with a blocked command,
  a dialog asks you to **Allow once** or **Block**. If the dialog times out
  after 30s, the command is blocked (fail-safe).
- **Non-interactive (`pi -p`):** matched commands are **hard-blocked** — no
  override, no prompt.
- **Allow-once:** approving a command permits that exact command for a brief
  follow-up window (some git operations retry), then the guard re-arms.

## Configuration

| Env var                 | Effect                                       |
| ----------------------- | -------------------------------------------- |
| _(unset)_               | Guard active — block mode (default)          |
| `PI_GIT_SAFEGUARD=warn` | Only notify instead of blocking (audit mode) |
| `PI_GIT_SAFEGUARD=off`  | Disable the guard entirely                   |

Example:

```bash
PI_GIT_GUARD=off pi -p "ship it"
```

## Install

With pi:

```bash
pi install npm:pi-git-safeguard
```

Or try it once without installing:

```bash
pi -e npm:pi-git-safeguard
```

Manual install: copy `src/index.ts` to `~/.pi/agent/extensions/git-safeguard.ts`.

## Uninstall / disable

```bash
pi remove npm:pi-git-safeguard   # if installed as a package
PI_GIT_SAFEGUARD=off      # per-run disable
```

## How it works

Subscribes to the `tool_call` event and inspects `bash` tool calls. If the
command matches a blocked pattern and the mode is `block`:

- with UI → `ctx.ui.select()` approval dialog (30s timeout → block)
- without UI → returns `{ block: true, reason }`

**Note on matching:** patterns run against the raw command string, so a write
command mentioned inside a string (e.g. `echo "git commit"`) is also gated.
This fail-safe overblocking is intentional — when in doubt, ask the user.

## Development

```bash
npm install
npm run check     # typecheck + tests
```

## License

[MIT](./LICENSE) © saif71
