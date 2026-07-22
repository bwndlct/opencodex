# OpenCodex — agent rules

## Hot deploy

The formal LaunchAgent (`com.opencodex.proxy`) points directly at this source tree:
`/Users/edy/Desktop/project/opencodex/src/cli/index.ts`, served by the bundled
Bun at `node_modules/bun/bin/bun.exe`.

After modifying source or GUI, deploy with exactly two commands:

```bash
cd /Users/edy/Desktop/project/opencodex
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
