# PAIC Journeys (VS Code Extension)

A VS Code extension for browsing and analyzing **journey dependency graphs** in Ping Advanced Identity Cloud (PAIC) tenants. Connects via service-account JWT-bearer auth, resolves journeys to their full transitive dependency tree (inner journeys, scripts, library scripts, themes, ESVs), and visualizes the result inside the editor.

## Stack

VS Code Extension API (Node.js extension host) | TypeScript | `esbuild` bundling | `axios` for PAIC REST | `jose` for JWT signing | Biome (lint) + Vitest (test). Webview UI (later) will be React + ReactFlow as a separate esbuild bundle.

## Structure

- `src/` — everything that ships
  - `extension.ts` — `activate()`, command registration, tree + inspector wiring
  - `paic/` — raw PAIC REST client (`auth`, `http`, `client`, `mappers`, `errors`, `realm-path`, `pagination`, `concurrency`). No VS Code imports.
  - `domain/` — clean TS types (`Connection`, `Realm`, `Journey`, `NodePayload`, `Script`). Pure types.
  - `resolver/` (planned, M4) — dependency graph builder + RealmIndex. No VS Code imports.
  - `tenants/` — connection registry (`registry.ts`) + per-host PaicClient cache (`client-cache.ts`); wraps settings + SecretStorage.
  - `views/` — `PaicTreeProvider` + node class hierarchy under `nodes/` (`base`, `connection`, `realm`, `journey`, `inner-journey`, `script`, `journey-expand`) + connection form.
  - `providers/` — VS Code provider-interface implementations (`script-fs-provider.ts` exposes `paic-script://` script bodies as a real editor tab; future home for `HoverProvider`, `CodeLensProvider`, `DefinitionProvider`, `DiagnosticCollection`).
  - `webview/` — inspector panel: extension-side singleton (`inspector/panel.ts`), typed `messages.ts` protocol, React UI under `inspector/ui/` (`main.tsx`, `App.tsx`, 5 cards). Built as a separate esbuild bundle to `out/webview.js`. M5/M6 will add query + graph panels reusing the same framework.
  - `util/` — `logger.ts` (pino multistream wrapper).
- `out/` — built output (`extension.js`, `webview.js`); produced by `npm run build`, gitignored
- `tests/` — non-shipped test infrastructure (fixtures, integration tests)
- `docs/` — design docs and decision log
- `.claude/` — agents, hooks, rules, skills for this project
- `poc/` (gitignored) — live-tenant scratch space: exploratory scripts, captured responses, dev notes. Never committed.
- `ref/` (gitignored) — read-only clones of reference repos (frodo-lib, frodo-cli, vscode-database-client) we cross-read for patterns. Never committed.
- `media/` (planned) — extension icons and webview static assets
- `dev-tail.sh` — tails the latest `PAIC Journeys` log file in a terminal

## Commands

- `npm run build` — esbuild bundles to `out/extension.js` + `out/webview.js`
- `npm run build:ext` / `npm run build:webview` — build just one
- `npm run watch` — watches the extension bundle. For inspector UI iteration, run `npm run watch:webview` in a second terminal.
- `npm run watch` — esbuild watch mode (rebuilds on save)
- `npm run lint` / `npm run lint:fix` — Biome check / auto-fix
- `npm run typecheck` — `tsc --noEmit`
- `npm test` — Vitest full suite
- `npm run test:fast` — Vitest unit tests only

## Dev loop

1. `code .` opens this repo.
2. `Cmd+Shift+P` → "Debug: Start Debugging" launches the Extension Development Host.
3. In the EDH window, click the PAIC Journeys icon (a `type-hierarchy` tree glyph) in the activity bar → PAIC Journeys sidebar.
4. After code changes: `npm run build` (or keep `npm run watch` running), then `Cmd+R` in the EDH window to reload.
5. Logs land in (platform-specific):
   - Linux: `~/.config/Code/logs/<session>/window<N>/exthost/boston-identity.ping-paic-journeys/PAIC Journeys.log`
   - macOS: `~/Library/Application Support/Code/logs/<session>/window<N>/exthost/boston-identity.ping-paic-journeys/PAIC Journeys.log`

   Use `./dev-tail.sh` to follow the latest one in a terminal (auto-detects platform).

F5 is bound to a system shortcut on Mac; use the command palette instead.

## Foundations / why we built it this way

- **Raw REST, not frodo-lib or fr-config-manager.** Audit found ~80% of frodo's surface (IDM/SAML/social/agent/file-I/O ops, 809-line global `State` machine, Polly mocks) is unused by us; the bits we want total ~250 lines. Plus architectural mismatch (frodo's global mutable state vs our per-connection client instances). See D2 in `docs/design-plan.md`.
- **Storage = settings.json + SecretStorage.** Plaintext fields (`host`, `saId`, optional `name`) in `paicJourneys.connections`; JWK in `SecretStorage` keyed by `paicJourneys.saJwk.<host>`. See D3 in `docs/design-plan.md`.
- **`host` is the stable identity** for each connection. `name` is an optional display label.

## Key constraints

- **No `process.exit()` anywhere.** It kills the Extension Host and takes down every other extension with us. Always throw.
- **No top-level `console.log`.** Use the `LogOutputChannel` (`log.info/warn/error/debug/trace`). Stderr is silently swallowed in production.
- **No network from webviews.** All HTTP happens in extension code; results flow to webviews via `postMessage`.
- **`@paic-apps/*` imports only allowed in `src/paic/*`.** Anything else is a layering violation.
- **VS Code engine pinned in `package.json`** — bump deliberately, not casually.

## Security & coding rules

All detailed rules live in `.claude/rules/` (auto-loaded each session):
- **[rules/security.md](.claude/rules/security.md)** — credentials, SecretStorage, PII, fixtures, never-commit, PAIC-tenant safety
- **[rules/conventions.md](.claude/rules/conventions.md)** — logging, imports, naming, errors, VS Code API patterns, commits
- **[rules/testing.md](.claude/rules/testing.md)** — test layout, fixtures, mocking VS Code APIs, integration patterns

## Docs

- [docs/design-plan.md](docs/design-plan.md) — design plan, locked decisions (D1–D16), data model, milestones, open questions
- [docs/sidebar-tree.md](docs/sidebar-tree.md) — sidebar tree shape reference
- [docs/logging-spec.md](docs/logging-spec.md) — structured logging contract (pino + NDJSON)
- [docs/progress.md](docs/progress.md) — current task tracker
- [docs/lessons.md](docs/lessons.md) — corrections and patterns to avoid repeating

## Sibling extensions (for cross-reference)

- `~/BostonIdentity/ping-paic-logs-vscode/` — log search/tail; same `settings.json + SecretStorage` pattern, different domain. Good reference for `TreeDataProvider`, env editor wizard, panel webview lifecycle.
- `~/BostonIdentity/ssh-fleet-vscode/` — multi-server SSH. Reference for hierarchical tree provider + YAML config + state management.
- `~/BostonIdentity/PingHub/paic-pipeline/` — the Next.js full-stack tool with the most mature journey viewer/diff today. Read-write peer to our read-only extension; we don't share code, but we hit the same PAIC REST endpoints.
