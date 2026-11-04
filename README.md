# devhost-plugin-disk-cleanup

A [devhost](https://github.com/bankyadam/devhost.app) plugin that frees disk space on the Mac mini without losing committed or tracked work:

- the **Homebrew** download cache (`brew cleanup -s --prune=all`),
- the **npm** cache (`npm cache clean --force`, the npm next to the Node devhost runs on),
- old **Remote Control worktrees** (`<environment>/.claude/worktrees/*`, one per session), removed with `git worktree remove` (no `--force`), and only when the worktree is clean, every commit in it is on a remote, no process works in it, its session is not active, and it was not used for `worktreeIdleHours`. Ignored files that are not build output (`.env`, local config; `node_modules`, `dist`, `target`, caches go) keep the worktree, because they would be lost with it. A mistyped number option falls back to its default.

## Install

```sh
devhost plugin install git@github.com:bankyadam/devhost-plugin-disk-cleanup.git --enable
```

or in the desktop app: Plugins → Install from GitHub…

## Use

| | |
|---|---|
| `devhost plugin run disk-cleanup report` | Sizes, and why each worktree that stays, stays. |
| `devhost plugin run disk-cleanup clean [--dry-run]` | Frees it (asks first; `--yes` answers). |
| `devhost doctor` | `plugin.disk-cleanup.reclaimable` warns above `warnGiB`. |

In the app: Plugins → disk-cleanup → Preview / Free disk space…

## Options

```yaml
plugins:
  disk-cleanup:
    enabled: true
    options:
      categories: [homebrew, npm, worktrees]   # default: all
      worktreeIdleHours: 24
      warnGiB: 5
```

## Development

Plain ES module, no build. It uses only the devhost plugin API (the `ctx` argument) and Node's own modules. `npm test` runs the tests against a scripted context (`test/fake.js`).
