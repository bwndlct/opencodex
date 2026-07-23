# OpenCodex — agent rules

## Hot deploy

The formal LaunchAgent (`com.opencodex.proxy`) points directly at this checkout's
`src/cli/index.ts`, served by the bundled Bun at `node_modules/bun/bin/bun.exe`.

After modifying source or GUI, deploy with exactly two commands:

```bash
cd <opencodex-checkout>
bun run build:gui && launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy
```

`kickstart -k` kills the old child process and restarts within the same loaded
service. Never use `bootout` + `bootstrap` for routine deploys — it can leave
launchd in an intermediate state where nobody restarts the process.

### What each step does

- `bun run build:gui` rebuilds `gui/dist/` (Vite production build).
- `kickstart -k` restarts the service-runner so Bun picks up new `gui/dist`
  and server-side `.ts` files on next request.

### If only server-side `.ts` changed (no GUI)

```bash
launchctl kickstart -k gui/$(id -u)/com.opencodex.proxy
```

Bun recompiles TypeScript on startup; no explicit build step is needed.

### Release directories (`~/.opencodex-releases/`)

Legacy immutable release copies are retained under `~/.opencodex-releases/`
for rollback. The plist no longer references them. Do not create new release
directories for local deploys — the source tree is the runtime.

### Candidate instances

For isolated testing on a separate port, use a dedicated `OPENCODEX_HOME`
and `CODEX_HOME` and launch manually:

```bash
OPENCODEX_HOME=/tmp/ocx-candidate CODEX_HOME=/tmp/ocx-candidate-codex \
  bun run src/cli/index.ts start --port 8792
```

Never point the formal plist at a candidate home or port.

## GUI i18n

All user-facing strings go through `useT()` / `t("key")`. Add new keys to all
four locale files: `en.ts` (source of truth), `zh.ts`, `ko.ts`, `de.ts`.
Technical literals (header names, CLI samples, model identifiers) are exempt.

## Testing guidelines

This fork carries custom features (routing overrides, dual upstream, session
identity, etc.) that upstream does not have. Tests are the regression net that
protects these features when syncing upstream commits — but the test suite
should stay lean, not exhaustive.

- Write fewer tests, not more. Cover the critical path and key edge cases, then
  stop. Do not enumerate every input variant or duplicate scenarios that an
  existing test already exercises.
- Before adding a test, check whether an existing test already covers the same
  behavior. If it does, extend it instead of writing a new file or a parallel
  test block.
- Delegate test-writing to GLM or Luna models whenever possible. The Sol root
  agent plans and reviews; the worker drafts the test. Keep the test contract
  and acceptance criteria in the delegation prompt so the worker has enough
  context without guessing.

## Fork intrusion and upstream compatibility

This is a fork of `lidge-jun/opencodex`. Upstream advances frequently and must
be re-syncable without manual conflict resolution on core files.

- Prefer new files over editing upstream files. Fork-specific handlers belong
  in dedicated modules (e.g. `fork-api-handlers.ts`), not inline in
  `management-api.ts` or `responses.ts`.
- When editing an upstream file is unavoidable, keep the change minimal and
  clearly delimited (a single import, one hook call, one routing branch). The
  smaller the diff against upstream, the easier the next merge.
- Do not refactor or reformat upstream code that you are not actively changing.
  Cosmetic edits inflate the merge diff and create conflicts for no benefit.
- Group fork features into self-contained modules with clear public APIs so
  that upstream files only need a one-line wiring point.

## Branch and worktree cleanup

When work on a `codex/*` feature branch is finished and merged (or committed)
into `main`, immediately clean up the branch and its worktree:

```bash
# 1. Remove the worktree (safe even if the branch has one)
git worktree remove <worktree-path>

# 2. Delete the branch (use -d for merged, -D for unmerged-but-discarded)
git branch -d codex/<branch-name>
```

- Only delete a branch after confirming its commits are on `main` (or have been
  intentionally discarded). Use `git branch --merged main` to verify.
- Never delete `main`, the currently checked-out branch, or any branch with
  uncommitted work in its worktree.
- For worktrees with uncommitted changes, `git worktree remove` will refuse
  unless `--force` is passed; inspect the changes first.
- For remote-tracking branches that have been merged, also delete the remote
  ref (`git push origin --delete codex/<branch-name>`) if the branch is no
  longer needed upstream.
- Keep the main checkout and any actively-in-use worktrees.
