# PAIC Journeys — Progress

> Build status tracker. See [design-plan.md](design-plan.md) for what each milestone means and why (open questions live there too).

## M0 — Connection CRUD ✅

- [x] Repo scaffolded
- [x] Manifest with activity bar container, tree view, three commands, settings property
- [x] `Connection` type + add/edit/remove flow
- [x] Plaintext fields → `paicJourneys.connections` setting (workspace-if-open else global)
- [x] `saJwk` → `SecretStorage` keyed by `paicJourneys.saJwk.<host>`
- [x] Tree view with `host`/`name` label
- [x] Inline action buttons (Edit, Remove) on each connection row
- [x] Each connection row is collapsible (folder shape, even with no children yet)
- [x] Non-modal QuickPick confirmation for Remove (matches database extension pattern)
- [x] `LogOutputChannel('PAIC Journeys', { log: true })` wired into all commands
- [x] `dev-tail.sh` to follow the latest disk log file from a terminal (Linux + macOS)
- [x] esbuild build pipeline (`npm run build`, `npm run watch`)
- [x] `src/paic/auth.ts` — `mintToken()` (JWT-bearer, scope fallback, RS256)
- [x] Test Connection button in Add/Edit form (mints token, shows ✓/✗ inline)

## M1 — Forward exploration with detail panel ✅

**Goal:** pick connection → realm → journey → see scripts + inner-trees as children → select anything → see basic info in a detail panel.

### Structured logger (D9)

- [x] Add `pino` runtime dep (in-process `RotatingFileStream`, no `pino-roll`)
- [x] `src/util/logger.ts` — pino instance with `pino.multistream([channelAdapter, fileStream])`, `redact` paths for secrets, `base: { service, version }`, `level` per stream
- [x] Channel adapter: tiny `Writable` that parses NDJSON and routes to `LogOutputChannel.trace/debug/info/warn/error`
- [x] In-process `RotatingFileStream` (sync `openSync`/`writeSync`/`renameSync`); rotates at 5 MB × 5 files; injectable maxBytes/maxFiles for tests
- [x] Settings: `paicJourneys.logging.level`, `paicJourneys.logging.fileEnabled`
- [x] Migrated 17 existing `log.*` calls (12 in `extension.ts`, 5 in `connection-form.ts`) to pino's `log.{level}({fields}, "msg")` shape with `event` field
- [x] 9 unit tests in `tests/util/logger.test.ts`, all green
- [ ] Manual verification of NDJSON output at `globalStorageUri/logs/paic-journeys.ndjson` (do during M1 walkthrough)

### Transport + domain layers

- [x] `src/paic/errors.ts` — `PaicError` flattening AxiosError (`status`, `code`, `errorText`, `description`, `cause`) + `from(unknown)` factory
- [x] `src/paic/realm-path.ts` — `getRealmPath(realm)` verbatim port from frodo, leading-slash convention
- [x] `src/paic/pagination.ts` — `listAllPaged(fetchPage)` canonical do-while over `pagedResultsCookie`
- [x] `src/paic/concurrency.ts` — hand-rolled `mapConcurrent(items, n, fn)` (Q-3 resolved: hand-rolled wins, ~25 lines, zero deps)
- [x] `axios` dependency installed (^1.16.1) for use by `errors.ts` and the upcoming `http.ts`
- [x] 16 new unit tests in `tests/paic/{errors,realm-path,pagination,concurrency}.test.ts`, all green
- [x] `src/paic/http.ts` — `makeHttpClient(opts)` factory: per-connection axios instance with `axios-retry` (network + 5xx + 429 w/ Retry-After), request interceptor (Bearer + X-ForgeRock-TransactionId per-request + Accept-API-Version), response interceptor (structured logging + 401 token refresh + `PaicError.from` wrap)
- [x] 9 unit tests via `axios-mock-adapter` covering header injection, transaction-ID-per-request, 502 retry, 429+Retry-After, 401 refresh, double-401 cap, non-401 error wrap, http.request log, http.error log
- [x] Q-4 (TransactionId scope) resolved: **per-request UUID** — best correlation with tenant audit logs
- [x] Q-5 (429 strategy) resolved: **single axios-retry config with Retry-After-aware retryDelay** — keeps retry policy in one place
- [x] `src/paic/mappers.ts` — `Raw*` interfaces + `mapRealm` / `mapJourney` / `mapNodePayload` / `mapScript` + base64 script-body decode (Q-1 resolved: location is `src/paic/mappers.ts`, co-located with transport)
- [x] `src/paic/client.ts` — `makePaicClient({ http, log })` returning `PaicClient` with `listRealms` / `listJourneys` (paginated) / `getJourney` / `getNode` / `getScript`; correct `Accept-API-Version` per endpoint family; URL-encoding of journey/node/script IDs
- [x] `src/domain/types.ts` — `Connection`, `Realm`, `Journey`, `NodeRef`, `NodePayload` (discriminated union with `"ScriptedDecisionNode" | "InnerTreeEvaluatorNode" | "other"` discriminant), `Script` (Q-2 resolved: folder name is `src/domain/`)
- [x] `extension.ts` imports `Connection` from `@/domain/types` (local interface removed)
- [x] 14 new unit tests in `tests/paic/{mappers,client}.test.ts`, all green
- [x] Conventions doc updated to document AIC wire-protocol field-name exception (leading underscores in `Raw*` types are intentional)

### Tenant registry

- [x] `src/tenants/registry.ts` — `makeTenantsRegistry(deps, log)` with `list/add/update/remove/getJwk` + `onDidChange` event + `Disposable`. Owns the secret prefix; handles the host-rename secret-move case once. `makeProductionDeps(context)` adapter wires VS Code workspace+secrets.
- [x] `src/extension.ts` migrated: registry replaces the 10 inlined persistence touchpoints; `provider.refresh()` now hooks `registry.onDidChange` automatically (drops 3 manual refresh calls).
- [x] `tests/util/vscode-mock.ts` created (minimal `vi.mock("vscode", …)` factory — `MockEventEmitter` + `ConfigurationTarget` + `workspace` + `Disposable`). Per `.claude/rules/testing.md` convention.
- [x] 9 unit tests in `tests/tenants/registry.test.ts`, all green — covers persistence, rename-without-jwk secret move, rename-with-jwk overwrite, remove, getJwk, dispose-after.

### Tree view (deeper levels + D12 cutover)

- [x] `views/nodes/base.ts` — abstract `PaicNode` + `MessageNode` (D12 class hierarchy lands here)
- [x] `views/nodes/connection.ts` — L1; expands to realms
- [x] `views/nodes/realm.ts` — L2; expands to journeys
- [x] `views/nodes/journey.ts` — L3; expands via `journey-expand` shared helper
- [x] `views/nodes/script.ts` — L4 leaf (M3 will widen with library-script recursion)
- [x] `views/nodes/inner-journey.ts` — L4+ recursive with ancestor-visited cycle guard
- [x] `views/nodes/journey-expand.ts` — shared concurrency-capped expansion (cap=10) used by both `JourneyNode` and `InnerJourneyNode`
- [x] `views/paic-tree-provider.ts` — element-driven `TreeDataProvider`
- [x] `tenants/client-cache.ts` — per-host `PaicClient` with in-memory token cache
- [x] `paic/auth.ts` augmented: `MintTokenSuccess.accessToken` (required by client cache)
- [x] `extension.ts` migrated to `PaicTreeProvider` + `ClientCache`; `registry.onDidChange` drops stale clients and reloads the tree
- [x] Lazy `getChildren()` per kind; in-memory child cache; error/empty/cycle states surface as `MessageNode` leaves
- [x] `paicJourneys.refresh` (view title) and `paicJourneys.refreshNode` (inline per-row) commands
- [x] 15 new unit tests in `tests/views/nodes/*.test.ts` + `tests/tenants/client-cache.test.ts`, all green

### Detail panel (D15 trigger — webview framework lands here)

- [x] esbuild second entry → `out/webview.js` (267 KB, IIFE, React 18 + DOM)
- [x] `src/webview/messages.ts` — typed `E2W`/`W2E` discriminated unions + `isE2W`/`isW2E` guards; shared by both sides
- [x] `src/webview/inspector/panel.ts` — extension-side singleton lifecycle owner with CSP-locked HTML, nonce-restricted script, `localResourceRoots: [out/]`
- [x] `src/webview/inspector/ui/` — React panel: `main.tsx` entry + `App.tsx` router + 5 card components
- [x] Tree-selection via `vscode.window.createTreeView` → `onDidChangeSelection` → `panel.show(node)` → `postMessage` → kind-specific card render
- [x] Cards: Connection / Realm / Journey / Script / InnerJourney — metadata only at M1 (script body lands in M2)
- [x] In-panel link navigation: click a referenced script in JourneyCard → `postMessage({type:"navigate"})` → `treeView.reveal()` moves tree selection + inspector re-renders
- [x] VSCode CSS variables only; no component lib
- [x] `parent` linking + `getParent` on `PaicTreeProvider` (required by `treeView.reveal`)
- [x] `paicJourneys.openInspector` command + title-bar `$(preview)` button
- [x] `tsconfig.webview.json` separate config: `jsx:react-jsx`, DOM lib, no Node types; extension tsconfig excludes `src/webview/inspector/ui/**`
- [x] Build pipeline split: `npm run build` → `build:ext` + `build:webview`. Typecheck runs both configs.
- [x] 10 new tests across `tests/webview/{messages,inspector/panel}.test.ts`; mocked `WebviewPanel` + `createTreeView` in `vscode-mock.ts`

### Tests

- [x] Unit tests for `paic/auth.ts` (9 cases — mint, scope-fallback, invalid JWK, network error, non-OK responses, scheme-less host)
- [x] Unit tests for `paic/errors.ts`, `realm-path.ts`, `pagination.ts`, `mappers.ts`, `client.ts`, `http.ts`, `concurrency.ts` (shipped during M1 transport task)
- [x] Component smoke tests for the inspector cards — 15 cases across 5 cards (ConnectionCard / RealmCard / JourneyCard / InnerJourneyCard / ScriptCard) via `@testing-library/react` + happy-dom; per-file env via `// @vitest-environment happy-dom` comment
- [x] vitest + esbuild wired for JSX: `esbuild.jsx: "automatic"`, `include` widened to `**/*.test.{ts,tsx}`; `.tsx` tests routed through `tsconfig.webview.json` for DOM + JSX type-check
- [ ] Captured AIC responses scrubbed and committed under `tests/fixtures/` — deferred. Current tests use inline synthetic-but-realistic payloads; promotion to fixture files waits until we have a clean tenant capture to import.

## M2 — Fill the detail panel: real content ✅

Tech locked: **D17** (script body via `vscode.FileSystemProvider`) and **D18** (journey diagram via ReactFlow + dagre).

### Script body (D17) ✅

- [x] `src/providers/script-fs-provider.ts` — `PaicScriptFileSystemProvider implements vscode.FileSystemProvider` + `parseScriptUri` / `makeScriptUri` helpers + `SCRIPT_URI_SCHEME` const. Resolves `paic-script://<host>/<realm>/<scriptId>.<ext>` → `ClientCache.get(host).getScript(realm, id)`. Read-only enforced: `writeFile` / `delete` / `rename` / `readDirectory` / `createDirectory` all throw `FileSystemError.NoPermissions`. 5 s stat-then-read dedupe cache to avoid the double-fetch on open.
- [x] `extension.ts` wires `workspace.registerFileSystemProvider(SCRIPT_URI_SCHEME, …, { isReadonly: true, isCaseSensitive: true })` and registers a new `paicJourneys.openScriptBody` command (accepts a `ScriptNode` from tree right-click or a plain `{host, realm, scriptId, language?}` from the inspector webview).
- [x] Inspector `ScriptCard`: "Open body in editor" button → `postMessage({ type: "openScriptBody", … })`; `InspectorPanel.onMessage` routes that to the `paicJourneys.openScriptBody` command.
- [x] Tree right-click on `ScriptNode` rows: inline `$(go-to-file)` icon + context-menu entry → same command. `commandPalette` `when: false` hides the command from the palette since it requires args.
- [x] 14 unit tests in `tests/providers/script-fs-provider.test.ts` (URI parsing including sub-realms, `makeScriptUri` for JAVASCRIPT/GROOVY, `readFile`, `stat`, dedupe-cache, every mutating method's `NoPermissions` refusal, missing-script → `FileNotFound`, unavailable-client → `Unavailable`, `watch` no-op).
- [x] `src/providers/` introduced as a new architectural slot for VS Code provider implementations; `.claude/rules/conventions.md` + `CLAUDE.md` updated accordingly.
- [x] `tests/util/vscode-mock.ts` extended with `Uri.parse`, `FileSystemError.{NoPermissions,FileNotFound,Unavailable}`, `FileType`, `FilePermission`, `commands.executeCommand`, `workspace.registerFileSystemProvider`.

### Journey diagram (D18) ✅

- [x] Added `reactflow ^11.11.4` + `dagre ^0.8.5` (deps) + `@types/dagre` (devDep).
- [x] `src/webview/inspector/ui/diagram/layout.ts` — pure dagre auto-layout (TB rankdir, 30/48 node/rank spacing). Drops orphan edges. Flags the entry node.
- [x] `src/webview/inspector/ui/diagram/JourneyDiagram.tsx` — ReactFlow viewport with `Background` + `Controls`, `nodesDraggable={false}`, `fitView`, `hideAttribution`. Memoizes layout; routes `onNodeClick` to either `onOpenBody` (script kind) or `onNavigate` (inner kind).
- [x] One custom node component per AIC kind: `ScriptedDecisionNodeView`, `InnerTreeEvaluatorNodeView`, `OtherNodeView` (handles `PageNode`, `ConfigProviderNode`, etc. via a `prettyKind` formatter — M3 will split into per-kind components).
- [x] `JourneyCard` embeds `<JourneyDiagram>` below the metadata when `deps.nodeIndex` is present; threading host/realm/onNavigate/onOpenBody from `App.tsx`.
- [x] Inner-journey nodes carry their `payloadsByNodeId` (added to `JourneyNode` + `InnerJourneyNode`); `expandJourney` populates the map after `mapConcurrent` resolves so we don't double-fetch. Inspector reads it in `sendJourneyDeps` to build `nodeIndex` for diagram click handling.
- [x] `messages.ts` extended: `NodeInfo` interface + `journeyDeps.nodeIndex` field. `isE2W` guard unchanged (still discriminates by `type`).
- [x] esbuild emits `out/webview.css` from `import "reactflow/dist/style.css"` inside `JourneyDiagram.tsx`; webview HTML loads it via `<link rel="stylesheet">` ahead of our inline shell CSS. CSP `style-src` already allowed `webview.cspSource`.
- [x] Diagram CSS (`.diag-node`, `.entry`, `.script`/`.inner`/`.other`) added to the inline `INSPECTOR_CSS` in `panel.ts`; uses VSCode CSS variables for color and `--vscode-charts-*` for kind-coloring.
- [x] 11 new tests: 5 layout-function unit tests in `tests/webview/inspector/ui/diagram/layout.test.ts`; 5 component tests in `tests/webview/inspector/ui/diagram/journey-diagram.test.tsx` (ReactFlow stubbed via `vi.mock`); 1 JourneyCard test verifying diagram embedding; panel test extended with `nodeIndex` assertion. Total 122 → 133.

### Polish (M2 follow-up)

- [x] InnerJourneyCard diagram — `InnerJourneyNode.ensureJourney()` lazy-fetches + caches the inner journey's full skeleton (shared with tree expansion to dedupe the request). `InspectorPanel.toSelectPayload` is now async and awaits `ensureJourney()` so the diagram has real nodes to render. `InnerJourneyCard.tsx` embeds `<JourneyDiagram>` when both `journey.nodes` and `deps.nodeIndex` are present. Fetch failure falls back to a placeholder + warns.
- [x] Hover tooltips on tree items — every `PaicNode` subclass now sets `this.tooltip = vscode.MarkdownString` with kind-specific structured metadata (host / realm / status / entry-node / ancestor chain / etc.). `isTrusted: false` (no commands), `supportThemeIcons: true` for future icon embedding.
- [x] Tree collapse + selection state persistence — `TreeItem.id` set to `this.uid` on Connection/Realm/Journey/Script nodes. VS Code automatically persists collapse state per-id across reloads. Skipped on `InnerJourneyNode` because the class's domain `id` field (inner-journey AIC id like `PasswordReset`) shadows `TreeItem.id`; trade documented inline.
- [x] "Open in Diff Editor" command (`paicJourneys.diffScriptAcrossConnections`) — right-click a ScriptNode → optional peer-connection QuickPick (auto-picks when there's only one other connection) → `vscode.diff` opens the two `paic-script://` URIs side-by-side. Cross-tenant script diff is the headline use-case; free side-effect of D17.
- [x] Diagram node hover → full schema tooltip — `NodeInfo` extended with `outcomes` / `inputs` / `outputs` / `rawNodeType`; populated by `panel.ts:sendJourneyDeps`; rendered as native browser `title` attribute via the new shared `buildNodeTooltip` helper. Browser tooltip is dependency-free and keyboard-accessible.


## M3 — Wider dependency kinds ⏳ (current)

Tech locked: **D19** (conditional script-ref predicate table) + **D20** (regex script-body parsing, AST upgrade if needed).

### Node-payload widening (journey-level edges)

#### Slice 1 — D19 predicate + script-bearing payload variants ✅

- [x] `src/paic/script-ref-predicates.ts` (new) — `getScriptIdIfRef(payload): string | null`. Exhaustive switch (no `default`) over `NodePayload['nodeType']`; always-script kinds return `scriptId || null`, conditional kinds gate on the flag (`useScript` / `useFilterScript`), other kinds return null. TypeScript exhaustiveness check enforces drift-prevention as the union grows.
- [x] `src/domain/types.ts` — `NodePayload` union extended with 6 new variants: `ClientScriptNodePayload`, `ConfigProviderNodePayload`, `SocialProviderHandlerNodePayload`, `SocialProviderHandlerNodeV2Payload`, `DeviceMatchNodePayload`, `PingOneVerifyCompletionDecisionNodePayload`. Social variants also carry `filteredProviders: string[]`. Conditional variants carry their flag + optional `scriptId` (stale values preserved; predicate gates activation).
- [x] `src/paic/mappers.ts` — `mapNodePayload` extended with branches for all 6 new types. `RawNodePayload` interface gains `useScript`, `useFilterScript`, `filteredProviders` fields.
- [x] `src/views/nodes/journey-expand.ts` — script-discovery branch now calls `getScriptIdIfRef(p)` instead of hard-coding `ScriptedDecisionNode`. Single behavioral change: any of the 7 script-bearing node types now emits a `ScriptNode` child in the tree.
- [x] 15 new tests: 8 in `tests/paic/script-ref-predicates.test.ts` (every branch incl. conditional on/off + null kinds), 6 in `tests/paic/mappers.test.ts` (one per new variant + the V2 missing-field case), 1 in `tests/views/nodes/journey.test.ts` (ClientScriptNode emits a ScriptNode child).

#### Slice 4 — diagram custom-node components + NodeInfo widening + PageNode container walk ✅

- [x] `src/webview/messages.ts` — `NodeInfo.kind` widened to `"script" | "inner" | "theme" | "emailTemplate" | "socialIdp" | "other"`; added optional fields `themeId`, `emailTemplateName`, `socialIdpNames`, `useScript`.
- [x] `src/webview/inspector/ui/diagram/nodes/{PageNode,EmailNode,SocialProviderHandlerNode,SelectIdPNode,DeviceMatchNode,ConfigProviderNode,ClientScriptNode,PingOneVerifyCompletionDecisionNode}View.tsx` — 8 new ReactFlow node components (the catch-all `OtherNodeView` is now reserved for genuinely unknown AIC kinds only).
- [x] `src/webview/inspector/ui/diagram/nodes/tooltip.ts` — `buildNodeTooltip` extended for the 4 new `kind` values + the conditional-kind `useScript=false` decorator + SocialProviderHandler*-style entries (script + IdPs surface both lines).
- [x] `src/webview/inspector/ui/diagram/JourneyDiagram.tsx` — registers all 8 new node types; `rfNodeType()` now uses a `keyof` lookup. `onNodeClick` priority chain: script → inner → theme → emailTemplate → socialIdp.
- [x] `src/webview/inspector/panel.ts` — `sendJourneyDeps` now builds `nodeIndex` via the new `buildNodeInfo` helper (extracted at the bottom of the file). Three new uid-lookup maps (`themeUidById`, `emailUidByName`, `idpUidByName`) populated alongside the existing two; CSS rules added for 8 new view variants (`page`/`email`/`social`/`select-idp`/`device-match`/`config-provider`/`client-script`/`verify`).
- [x] `src/views/nodes/journey-expand.ts` — single-level **PageNode container walk**: after the top-level payload fetch, scan `PageNode.childRefs` and fetch each via `getNode` (concurrency-capped at 10). Merged children's payloads land in `payloadsByNodeId` so nested ScriptedDecisionNodes / InnerTreeEvaluatorNodes surface as journey-level deps. Failures logged + skipped (no throw).
- [x] 24 new test outcomes across 8 component smoke tests, the `tooltip.test.ts` (5 cases), 3 `JourneyDiagram` extensions, 1 panel-test extension, and 2 `journey-expand` container-walk cases. Total 204 → 228.
- [x] `/check fast` + `/check all` green; `npm run build` → `out/webview.js` 851 KB + `out/webview.css` 8.5 KB.
- [x] Lint clean (0 errors, 126 documented warnings — AIC wire-protocol underscore fields + biome `noSecrets` false-positives on AIC node-type name strings + cognitive complexity on the grown payload-mapping switch).

#### Slice 3 — journey-level new leaves (theme / email-template / social-idp) ✅

- [x] `src/paic/mappers.ts` — `PageNode` variant: `childRefs[]` (inline child-node refs preserved) + parsed `stage.themeId` (JSON + legacy `themeId=` forms).
- [x] `src/paic/mappers.ts` — `EmailSuspendNode` / `EmailTemplateNode` variants: `emailTemplateName: string`.
- [x] `src/paic/mappers.ts` — `SelectIdPNode` variant: `filteredProviders: string[]`.
- [x] `src/paic/mappers.ts` — `mapTheme`, `mapEmailTemplate`, `mapSocialIdp`, `mapEsvVariable`, `mapEsvSecret` (with their `Raw*` shapes).
- [x] `src/domain/types.ts` — 4 new payload variants + 4 new resource types (`Theme`, `EmailTemplate`, `SocialIdp`, `Esv = EsvVariable | EsvSecret`).
- [x] `src/paic/client.ts` — `getTheme(realm, themeId)` (IDM `/openidm/config/ui/themerealm` whole-config + client filter), `getEmailTemplate(name)` (IDM `/openidm/config/emailTemplate/<name>`, 404 → null), `listSocialIdps(realm)` (AM `_action=nextdescendents` POST), `getEsv(name)` (variables-then-secrets fall-through).
- [x] `src/views/nodes/{theme,email-template,social-idp}.ts` — three new leaf classes, each with kind-specific icon + tooltip.
- [x] `src/views/nodes/journey-expand.ts` — 3 new emission branches (theme via PageNode.stage, email-template via EmailSuspend/Template, social-idp via SocialProviderHandler*/SelectIdP filteredProviders). All deduped per-realm.
- [x] `src/webview/messages.ts` — `SelectPayload` widened with `theme` / `emailTemplate` / `socialIdp` kinds; `journeyDeps` E2W extended with `themes` / `emailTemplates` / `socialIdps` NodeRef arrays; `NodeRef.kind` union widened.
- [x] `src/webview/inspector/panel.ts` — `toSelectPayload` resolves Theme / EmailTemplate / SocialIdp / Esv resources via the new client methods (graceful name-only fallback on miss); `sendJourneyDeps` emits the new NodeRef arrays.
- [x] `src/webview/inspector/ui/App.tsx` — routes the 3 new card kinds; `JourneyDepsState` widened.
- [x] `src/webview/inspector/ui/cards/ThemeCard.tsx`, `EmailTemplateCard.tsx`, `SocialIdpCard.tsx` (new); `EsvCard.tsx` rewritten to render resolved metadata (variable expression type, secret encoding, description, lastChangeDate).
- [x] `JourneyCard.tsx` deps block refactored — single `DepsSection` helper now emits Scripts / Inner journeys / Themes / Email templates / Social IdPs subsections.
- [x] 30 new test outcomes across 8 mapper + 4 client + 3 journey-expand + 3 leaf-class + 4 card + 1 panel + 7 prior fixture updates. Total 174 → 204.

### New PAIC client methods

- [x] `src/paic/client.ts` — `getEmailTemplate(name) → EmailTemplate | null` (IDM `/openidm/config/emailTemplate/<name>`, 404 → null). Slice 3.
- [x] `src/paic/client.ts` — `getSocialIdp(realm, name) → SocialIdp | null` — thin wrapper around `listSocialIdps` + filter (AIC's direct lookup requires `(type, name)` which our callers don't carry). Slice 4 follow-up.
- [x] `src/paic/client.ts` — `getTheme(realm, themeId) → Theme | null` (IDM `/openidm/config/ui/themerealm` whole-config + client filter). Slice 3.
- [x] `src/paic/client.ts` — `getEsv(name) → Esv | null` (tries `/environment/variables/<name>`, falls back to `/environment/secrets/<name>` on 404). Slice 3.
- [ ] `listEsvs()` for the realm-index — explicitly deferred to **M4** (RealmIndex needs it; inspector cards don't).
- [x] Library scripts reuse `getScript`-shaped fetch — Slice 2 uses `getScriptByName(realm, name)` which returns the full `Script` via `mapScript`, including the base64-decoded body. (`script.context === "LIBRARY"` distinction is informational only — the wire shape is identical to a non-library script.)

### Script-body parsing (script-level edges, D20) ✅ — Slice 2

- [x] `src/util/script-body-parser.ts` — `extractScriptBodyRefs(body): { libraryScripts: string[]; esvs: string[] }`. Single regex set: `require('<name>')` (both quote styles, whitespace-tolerant), `&{esv.<NAME>}`, `systemEnv.<NAME>`. Returns deduped + sorted arrays. 9 unit tests cover every form + the dedup paths. (Originally placed in `src/resolver/`; moved to `src/util/` during M4 Slice 1 because the D21 boundary test caught the pre-existing `src/views/` → `src/resolver/` import.)
- [x] `src/paic/client.ts` — `getScriptByName(realm, name): Promise<Script | null>`. Uses `_queryFilter=name eq "<name>"` against `/am/json/<realmPath>/scripts`. Returns first result mapped via `mapScript`, or null on miss. Frodo's `scriptQueryURLTemplate` shape verbatim.
- [x] `src/views/nodes/script-expand.ts` — shared `expandScript({host, realm, body, selfKey, visited, cache, log, parent})` helper. Resolves `require()` names → UUIDs via concurrency-capped `getScriptByName` (cap=10), emits `LibraryScriptNode` for hits, `MessageNode("[cycle: <name>]")` when the name is in `visited`, `MessageNode("[missing library: <name>]")` for misses. Emits one `EsvNode` per unique ESV reference.
- [x] `src/views/nodes/script.ts` — `ScriptNode` collapsible (Collapsed by default). New `ensureBody()` lazy-fetches + caches the script body (shared in-flight Promise). `loadChildren()` runs `expandScript`. `refresh()` clears the body cache. New `visited?: readonly string[]` parameter, default `[]`.
- [x] `src/views/nodes/library-script.ts` — `LibraryScriptNode` constructed with body in hand (avoids a second `getScript` fetch since `getScriptByName` already returned it). Same `expandScript` recursion + `visited` cycle-guard pattern.
- [x] `src/views/nodes/esv.ts` — `EsvNode` (leaf, name only). Distinct icon (`symbol-variable`) + contextValue (`esv`). M3 polish adds `getEsv` metadata fetch.

### Other new tree-node classes (journey-level deps)

- [x] `src/views/nodes/theme.ts` — `ThemeNode` (leaf, journey-level). Slice 3.
- [x] `src/views/nodes/email-template.ts` — `EmailTemplateNode` (leaf, journey-level). Slice 3.
- [x] `src/views/nodes/social-idp.ts` — `SocialIdpNode` (leaf, journey-level). Slice 3.

### Inspector cards + diagram (partial — Slice 2 ships script-shaped, Slice 3 ships journey-shaped)

- [x] `src/webview/messages.ts` — extended `SelectPayload` with `libraryScript` + `esv` kinds; extended `E2W` with `scriptDeps` message; `NodeRef.kind` widened. `isE2W` guard updated.
- [x] `src/webview/inspector/panel.ts` — `toSelectPayload` handles `LibraryScriptNode` + `EsvNode`. New `sendScriptDeps(node)` mirrors `sendJourneyDeps`. `show()` routes script-shaped selections to it.
- [x] `src/webview/inspector/ui/App.tsx` — second deps state slot (`scriptDeps`) + new card-kind routing.
- [x] `src/webview/inspector/ui/cards/ScriptCard.tsx` — adds optional `deps` + `onNavigate` props; renders the shared `ScriptDepsBlock` (library scripts + ESVs as clickable links). `ScriptDepsBlock` exported for reuse.
- [x] `src/webview/inspector/ui/cards/LibraryScriptCard.tsx` — new card; mirrors `ScriptCard` with the "Library script" badge + same deps block + same Open-body-in-editor action (works against the M2 `paic-script://` URI).
- [x] `src/webview/inspector/ui/cards/EsvCard.tsx` — new card; metadata only at Slice 2 (hint about resolution coming in M3 polish).
- [x] New cards: `ThemeCard`, `EmailTemplateCard`, `SocialIdpCard` — Slice 3.
- [x] Diagram custom-node components replace the `Other` fallback for: `PageNode`, `EmailSuspendNode`/`EmailTemplateNode`, `SocialProviderHandlerNode*`, `SelectIdPNode`, `DeviceMatchNode`, `ConfigProviderNode`, `ClientScriptNode`, `PingOneVerifyCompletionDecisionNode` — Slice 4.
- [x] `panel.ts:sendJourneyDeps` — `nodeIndex` extended with the new kinds (`emailTemplate`, `socialIdp`, `theme`) via the `buildNodeInfo` helper — Slice 4.

#### ESV polish — bug fix shipped + follow-ups queued

Bug fix shipped in commit `b41ad21` (parser was capturing `"getProperty"` as ESV names + the dotted/hyphenated REST id mismatch returned 400). POC against sb3 (1,159 scripts) validated the new approach — see D20 + D22 in design-plan.md.

- [x] **D20 parser fix** — `['"](esv\.X)['"]` string-literal regex; dropped the broken `&{esv.X}` (0 hits in 1,159 scripts) and `systemEnv.X` (435 false-positive method-name captures); requires the `esv.` prefix (226/226 unique sb3 refs match)
- [x] **D22 dotted↔hyphenated translation** — `getEsv()` now translates `esv.x.y` → `esv-x-y` before the URL; canonical display name stays dotted; verified against `esv-kyid-portal-name` (200) vs `esv.kyid.portal.name` (400)
- [x] **Comment stripping** — `stripComments(body)` in `script-body-parser.ts` runs before the regex; removes `/* ... */` blocks + `//` EOL; preserves `://` URLs by lookbehind-via-capture
- [x] **D22 kind pre-labeling on script-expand** — `script-expand.ts` fires `listVariables(realm)` + `listSecrets(realm)` in parallel per expansion; pre-labels each `EsvNode` as `variable` / `secret` / `missing`; tree icons differ by kind. Specifically:
  - [x] `PaicClient.listVariables(realm)` + `listSecrets(realm)` added (paged, mirrors `listJourneys`; tenant-scoped — `realm` accepted for API symmetry); names translated dot↔hyphen at the mapper boundary so consumers see dotted form
  - [x] `EsvNode` widened with `kind?: "variable" | "secret" | "missing"` + optional `resolved?: Esv`; icon switches via `iconFor(kind)`; missing nodes carry a "(not in tenant)" description + `esvMissing` contextValue
  - [x] `panel.ts:toSelectPayload` reads `node.resolved` directly — no per-click fetch
- [x] **Right-click "Open script body" works on LibraryScriptNode too** — extended `package.json`'s `view/item/context` `when` clause for `paicJourneys.openScriptBody` from `viewItem == script` to `viewItem =~ /^(script|libraryScript)$/`. `parseOpenScriptArg` accepts `LibraryScriptNode` instances; language pulled from `arg.resolved?.language`. The inline `$(go-to-file)` icon + context-menu entry now appear on both kinds. Cross-tenant diff (`paicJourneys.diffScriptAcrossConnections`) stays narrower (ScriptNode only — library scripts don't have the same cross-tenant comparison story).
- [x] **D24 amendment — every show-a-card gesture spawns a new tab** — replaces the earlier "reuse one preview panel" rule. Collapses `InspectorPanel` + `DiagramPreviewPanel` into a single `InspectorTab` class (one card per instance, one webview per instance, no reuse). Extension-level factory tracks tabs for dispose. Tree click, card hyperlink click, diagram node click ALL spawn fresh tabs. `navigate` W2E message removed entirely. `uidIndex` / `NodeLookup` plumbing deleted (each tab is one-shot).
- [x] **D24 (initial) card-link consistency — route deps-list hyperlinks through the preview panel** — `JourneyCard` / `InnerJourneyCard` `DepsBlock` and `ScriptCard` / `LibraryScriptCard` `ScriptDepsBlock` now call `onPreview(uid)` instead of `onNavigate(uid)`. Main inspector + tree selection are preserved when clicking deps-list links — same behavior as diagram clicks. `ThemeCard.linkedTrees` stays plain text per the rationale (no global journey-by-id lookup available; that's M5 back-search territory). `App.tsx`'s `navigate` callback removed; `panel.ts:onMessage` `navigate` handler retained as dead code for future "Reveal in tree" right-click affordances.
- [x] **Diagram click → secondary preview panel** — clicking a node on the journey diagram now opens the corresponding card in a separate `WebviewPanel` opened beside the main inspector. **Does NOT replace the main inspector** (which still shows the journey) and **does NOT open the script body file** (the ScriptCard's "Open body in editor" button still works for that). Same UX for all kinds (script / inner / theme / email / socialIdp). Implementation:
  - New `W2E.previewNode` message
  - New `src/webview/inspector/preview-panel.ts` — `DiagramPreviewPanel` class; reuses the same React webview bundle; single panel reused across diagram clicks (no tab clutter); card-internal navigate clicks drill DOWN inside the preview itself
  - Extracted `buildSelectPayload(node, cache, log)` as a free export so both panels share the resolution logic
  - `JourneyDiagram` Props simplified: `onNavigate` + `onOpenBody` + `host`/`realm` removed; replaced by single `onPreview(uid)`
  - `JourneyCard` / `InnerJourneyCard` pass `onPreview` through; "Open body" affordances still exist on the cards themselves, not the diagram
- [x] **D23 card field widening — Journey, InnerJourney, Script** — surfaced raw fields per D23 policy (raw values, skip when undefined):
  - `Journey` domain + `RawJourney` + `mapJourney` widened with `innerTreeOnly`, `noSession`, `mustRun`, `transactionalOnly`
  - `JourneyCard.tsx` — shared `JourneyFlags` helper renders the 4 flags as raw `true`/`false` (skip-when-undefined). Exported for reuse by InnerJourneyCard.
  - `InnerJourneyCard.tsx` — uses `JourneyFlags` + added the missing `identityResource` row
  - `Script` domain + `RawScript` + `mapScript` widened with `context`, `description`, `isDefault` (raw `default`), `evaluatorVersion`, `lastModifiedBy`, `lastModifiedDate`. `description: null` from legacy scripts coerces to `undefined` in the domain.
  - `ScriptCard.tsx` — renders the new fields (Context in a `<code>` block, Default (OOTB) as raw bool, Last modified as ISO-8601)
  - 8 new tests (mapper + card) cover the new fields + the skip-when-undefined behavior. Total 266 → 274.
- [x] **Email template body via FileSystemProvider + richer card** — mirrors the M2 script-body pattern (D17). New `paic-email-template://<host>/<name>/<locale>.html` URI scheme served by `src/providers/email-template-fs-provider.ts`; opens via the new `paicJourneys.openEmailTemplateBody` command with VS Code's HTML language mode for free (syntax highlight / fold / find / copy). `EmailTemplate` domain type widened with `defaultLocale`, `displayName`, `description`, `templateId`, `mimeType`, `styles`, `html`, `advancedEditor`. `EmailTemplateCard` now renders all locales' subjects + an "Open body" button per locale + Disabled badge when applicable. 12 new tests covering mapper, FS provider, and card. Visual preview is **not** in scope — users wanting rendered HTML can install Microsoft's Live Preview extension and paste into a real `.html` file.
- [x] **Theme resolution path fix + ThemeCard widening** — discovered during smoke testing: `getTheme()` was reading the wrong wire path. AIC's `/openidm/config/ui/themerealm` returns `{ realm: { <realmName>: RawTheme[] } }` (singular `realm`, direct array — no `.themes` wrapper). Previous code looked at `realms[<realmName>].themes` and silently returned `null` for every lookup. Fixed `RawThemeRealmConfig` + `client.getTheme()` accordingly. Widened `Theme` domain type with `isDefault`, `linkedTrees` (journey IDs referencing the theme — free reverse-lookup for M5), `primaryColor`, `backgroundColor`, `backgroundImage`, `logo` (localized URL map), `logoAltText`, `journeyLayout`, `fontFamily`. `ThemeCard.tsx` rewritten to render: name in heading, "Default" badge when `isDefault`, color swatches, logo `<img>`, linked-journeys list.
- [x] **D22 EsvCard field expansion** — full REST metadata rendered for variables AND secrets:
  - [x] `EsvVariable` domain type widened with `lastChangedBy?`, `loaded?`, `valueBase64?`; `EsvSecret` widened with `lastChangedBy?`, `loaded?`, `activeVersion?`, `loadedVersion?`, `useInPlaceholders?`
  - [x] Mappers + `Raw*` shapes thread the new fields through
  - [x] `EsvCard.tsx` rewritten — kind-discriminated rendering (`VariableFields` / `SecretFields` / `SharedAuditFields`); `decodeEsvValue` UTF-8 round-trip via `atob` + `TextDecoder`; Copy button uses `navigator.clipboard.writeText`
- [x] **D25 hide PAIC root realm** — wire identifier is `parentPath === null` (or absent), not the name (varies by deployment: `"/"`, `"root"`, `"Top Level Realm"`). Added `isRoot: boolean` to the `Realm` domain type, set by `mapRealm` via `raw.parentPath == null`. `ConnectionNode.loadChildren` filters `!r.isRoot && r.name !== "/"` (belt-and-suspenders against name variants). Filter lives in view layer; data layer stays a faithful translation per D11. If on-prem AM support is added later, the filter becomes conditional on `connection.type`. 5 new tests (2 mapRealm wire shapes + 3 connection-filter variants). Total 274 → 278.

#### Diagram + theming polish (D26 + D27 + D28)

- [x] **D26 diagram direction → LR** — `layout.ts` flipped `rankdir: "TB"` → `"LR"`; bumped `ranksep: 48` → `70`. Also flipped Handle positions from `Top`/`Bottom` → `Left`/`Right` across all 11 existing node views so edges route into the sides of nodes (consistent with LR).
- [x] **D26 enable node dragging (non-persistent)** — `JourneyDiagram.tsx` migrated from `useMemo`-derived `rfNodes` to `useNodesState` + `nodesDraggable={true}`. Initial nodes re-seed via `useEffect` keyed on `journey.id`. Drag positions live for the inspector tab's lifetime; no persistence layer.
- [x] **D27 theme audit pass** — `panel.ts` `INSPECTOR_CSS`:
  - `.diag-node` background → `var(--vscode-editorWidget-background, var(--vscode-editor-background))` (fixes dark-on-dark)
  - Border widened `1px` → `1.5px`; per-kind stripe `3px` → `5px`
  - New `.diag-node.entry` rule: subtle `outline: 1.5px solid var(--vscode-focusBorder); outline-offset: -1px`
  - ReactFlow defaults overridden: `.react-flow__edge-path`/`__connection-path` stroke, `__edge-textbg`, `__edge-text`, `__background-pattern`, `__controls`, `__controls-button` (+ hover + svg)
  - `:focus-visible` rings on `button.link`, `.card-actions button`, `.diag-node`
  - Grep audit confirmed: every hex appears only as a `var(..., #fallback)` per D27
- [x] **D28 synthesize all three platform terminals (Start, Success, Failure)** — `layout.ts` exports `START_NODE_ID = "startNode"`, `SUCCESS_NODE_ID = "70e691a5-1e33-4ac3-a356-e7b6d60d92e0"`, `FAILURE_NODE_ID = "e301438c-0bd0-429c-ab0c-66126501069a"`. Start is always synthesized when `journey.nodes[entryNodeId]` exists, with an implicit `start→entry` edge. Success/Failure are synthesized on demand when referenced from a real node's `connections`. Pinning not needed — LR + dagre's `network-simplex` ranker naturally puts Start (no inbound) leftmost and Success/Failure (no outbound) rightmost.
- [x] **D28 StartNodeView + SuccessNodeView + FailureNodeView** — three non-clickable components under `src/webview/inspector/ui/diagram/nodes/`. Blue/green/red kind stripes via VS Code chart vars. Start has only a source handle (right); Success/Failure have only a target handle (left). Registered in `JourneyDiagram.nodeTypes`. Click handler's existing `if (info?.uid)` guard already no-ops for all three (no `nodeIndex` entry).
- [x] **D28 terminals anchored to vertical midpoint** — `computeLayout` recomputes `(min_y + max_y) / 2` of real journey nodes after dagre runs, then overrides each terminal's `y` to that value (consistent vertical center across simple/complex journeys).
- [x] **Only Start is undraggable** — Success/Failure carry the same draggability as real nodes (the user may want to rearrange terminal labels for readability). `NON_DRAGGABLE = Set([START_NODE_ID])` in `JourneyDiagram`.
- [x] **Reserve blue/green/red for terminals only** — earlier `social`/`select-idp` used red and `inner`/`device-match` used blue and `verify` used green, conflicting with Start (blue)/Success (green)/Failure (red). Reassigned: `inner` + `device-match` → cyan (`--vscode-terminal-ansiCyan`); `social` + `select-idp` + `verify` → magenta (`--vscode-terminal-ansiMagenta`). Per-kind palette is now: purple (scripts), orange (Page), yellow (Email), cyan (Inner/Device), magenta (Social/IdP/Verify), gray (Other). Terminals own blue/green/red exclusively.
- [x] **Removed `.diag-node.entry` outline** — redundant now that Start is a dedicated visual terminal. `isEntry` still drives the hover-tooltip "(entry)" suffix in `buildNodeTooltip`.
- [x] **D28 tests** — `layout.test.ts` +6 cases (Start always synthesized; Start NOT synthesized when entryNodeId missing; Success-only; Failure-only; both outputs; outputs not synthesized when unreferenced) + adjusted existing tests for the +1 node-count math. `journey-diagram.test.tsx` +2 (SuccessNode rf-type wiring, terminal click is a no-op). 3 new view tests (start/success/failure). Total 278 → 289.
- [x] **Lesson recorded** — `docs/lessons.md` 2026-05-18 entry: failure-UUID-from-memory bug + missing Start node both caught by user's `aaron_test_login` smoke test. Verify platform-constant IDs against captured fixtures before adding to source.
- [x] **D29 diagram expand-to-tab-width toggle** — `JourneyDiagram` adds a `ControlButton` as the **4th icon button** in ReactFlow's `Controls` panel (after zoom-in / zoom-out / fit-view), with the whole panel moved to **top-left** (`position="top-left"`). Inline SVG uses horizontal double-arrows (out = expand, in = collapse) — visually distinct from fit-view's frame icon and signals the "width-focused" nature of the toggle. Toggling switches the section between `360px` fixed height inside the card's `720px` cap and `aspect-ratio: 16/9` of full tab width via `:has(.diagram.expanded) { max-width: none }` on the parent card. Height is derived from width (ratio), not from `100vh`, since the webview is already vertically scrollable. Not fullscreen, not persisted. ReactFlow re-fits on toggle via captured instance + `fitView({ padding: 0.12 })` inside a `requestAnimationFrame`. +1 toggle test. Reactflow test mock updated (3 files) to render `ReactFlow` children + provide `Controls` + `ControlButton`. Total 289 → 290.

#### D26/D27/D28 still to verify manually

- [ ] **D27 acid-test** — smoke against Default High Contrast Dark theme (`Ctrl+K Ctrl+T`) before claiming visual done. If it reads correctly there, every theme works.
- [ ] **Live-tenant smoke** in EDH per the plan's verification list (LR direction, drag, terminals, drag-survives-render, theme switch).

#### D30 — Per-outcome handles inside decision nodes (TRIED, REVERTED 2026-05-19)

Implementation worked technically (297/297 tests passing, lint clean, build clean) but the visual result looked cluttered at our current node dimensions — inline-label stack + color stripe + header text + synthesized terminals were busier than the labels-on-edges baseline. User reviewed and reverted. Notes in D30 of `design-plan.md`. All D30 code + tests deleted; layout / JourneyDiagram / 11 node views / CSS restored to the post-D29 state. Total reverted from 297 → 290.

#### D31 — Use server-provided node coordinates instead of dagre auto-layout

- [x] **Domain widening** — `NodeRef` gains `x?: number` and `y?: number`. `Journey` gains `staticNodes?: Record<string, { x: number; y: number }>`.
- [x] **Wire types + mapper** — `RawJourney.staticNodes` typed; `mapJourney` threads node `x`/`y` onto each domain `NodeRef` and maps `raw.staticNodes` verbatim (defaults missing axes to `0`).
- [x] **layout.ts — server-coords primary, dagre fallback** — new `computeLayout` is a small dispatcher routing to `computeServerCoordLayout` (when `hasUsableServerCoords` is true) or the renamed `computeDagreLayout` (existing logic, unchanged behavior). Shared helpers `gatherReferencedOutputTerminals` + `buildEdges` extracted to avoid duplication. Server-coords path subtracts `NODE_W/2` / `NODE_H/2` to convert AIC's center-anchored pixels to ReactFlow's top-left; references `journey.staticNodes` for terminal positions with a "rightmost + center" fallback for terminals that are referenced but missing from `staticNodes`. Terminal vertical-midpoint anchoring (D28) stays in the dagre path only.
- [x] **JourneyDiagram.tsx** — no changes (layout output shape unchanged).
- [x] **Tests**:
  - `mappers.test.ts` +3: preserves node coordinates; maps staticNodes verbatim with `0` defaults; leaves staticNodes undefined when wire omits it.
  - `layout.test.ts` +3: server-coords path uses node x/y verbatim; server-coords path uses `staticNodes` for terminals; falls back to dagre when no node has non-zero coords.
  - Existing tests unchanged — the `journey()` factory doesn't supply coords by default, so all 290 existing tests continue to verify the dagre fallback. Total 290 → 296.

#### D32 — "Re-layout with dagre" Controls button

- [x] **`computeDagreLayout` exported** from `layout.ts` (was a private helper; same body, no behavior change).
- [x] **`toRfNode(n, nodeIndex)` extracted** as a module-level helper — the initial `useMemo` and the new `relayoutWithDagre` handler use the same transformation.
- [x] **5th `<ControlButton>` in `JourneyDiagram`** — small inline SVG icon that swaps with state: tree-graph (3 dots + 2 branches) for "Re-layout", counter-clockwise circular arrow for "Original layout". Plain-text labels live in the `title` (hover tooltip) + `aria-label` attributes.
- [x] **`toggleLayout` handler (D32 is a 2-state toggle)** — `usingDagre` boolean state. Click flips state, calls `computeDagreLayout(journey)` entering dagre mode or `computeLayout(journey)` returning to AIC's layout (D31 dispatcher), then `setRfNodes(layout.nodes.map(toRfNode))` + `requestAnimationFrame → fitView({ padding: 0.12 })`. Drag positions are discarded on toggle in both directions.
- [x] **Expand button uses icon + tooltip** — same pattern: horizontal-arrows-outward → expand, inward → collapse; plain text in `title` + `aria-label`.
- [x] **+1 test in `journey-diagram.test.tsx`** — seeds journey with server coordinates, asserts initial position is server-coords-derived, clicks the Re-layout button (queried by aria-label) → asserts position changes to dagre output, clicks again → asserts position returns to server coords. Mock extended with `data-rf-x`/`data-rf-y` attributes. Total 296 → 297.

#### D33 — Sidebar tree: kind-grouped children + category headers + alphabetical sort

- [x] **`CategoryHeaderNode` class** — `src/views/nodes/category-header.ts`. Extends `PaicNode`. `label = "── <Category> ──"`; `collapsibleState: None`; `contextValue: "categoryHeader"`; no icon, no tooltip, no children.
- [x] **`groupAndSort(nodes)` helper** — `src/views/nodes/grouping.ts`. Exports `kindOf(node)` + `groupAndSort(nodes)`. Classifies by `instanceof` (InnerJourney / Script / LibraryScript / Theme / EmailTemplate / SocialIdp / Esv). Sorts case-insensitively within kind via `localeCompare(..., { sensitivity: "base" })`. Inserts `CategoryHeaderNode` only when ≥2 kinds are present. Unknown nodes (MessageNode etc.) appended at the end in original order.
- [x] **`journey-expand.ts` + `script-expand.ts` wired** — return `groupAndSort(children)` at the end instead of raw `children`. Empty-list `MessageNode` short-circuit kept for clarity.
- [x] **`extension.ts` selection guard** — `treeView.onDidChangeSelection` now skips `CategoryHeaderNode` AND `MessageNode` before calling `inspectorFactory.spawn(node)`. Defensive bonus on `MessageNode`: clicking error / cycle / empty-state rows no longer spawns a vacant inspector tab.
- [x] **Tests** — new `grouping.test.ts` (6 cases: empty, single-kind no header, multi-kind headers in priority order, case-insensitive sort, unknown-kind appended) + `kindOf` smoke (2 cases for known/unknown classification). Existing `journey.test.ts` + `script.test.ts` length assertions updated to filter out `CategoryHeaderNode` before counting data kids. Total 297 → 304.
- [x] **Single-kind levels also sorted** — `RealmNode → JourneyNode` sorts journeys by `id` case-insensitive; `ConnectionNode → RealmNode` sorts realms by `name`. No category headers (single kind), just alphabetical order. +2 tests (realm sorts journeys, connection sorts realms). Total 304 → 306.

#### D34 — Migrate connection form to a separate React bundle

- [x] **New `src/webview/connection-form/`** directory mirrors the inspector layout:
  - `messages.ts` — typed `W2E` (save / cancel / validate) + `E2W` (validateResult ok/err) + `ConnectionFormData` / `ConnectionFormInitial` / `ConnectionFormPayload` types + `isW2E` guard.
  - `panel.ts` — extension-side `openConnectionForm(context, opts) → Promise<ConnectionFormData \| undefined>`; creates the WebviewPanel; embeds initial payload via `data-paic-payload`; wires `onDidReceiveMessage`; includes `handleValidate` (moved from the old file, unchanged); inlines `CONNECTION_FORM_CSS`.
  - `ui/main.tsx` — React entry. Reads payload from `data-paic-payload`; mounts `<App>`. Uses a local cast of `window.acquireVsCodeApi()` because the inspector's `main.tsx` already declares a global with a conflicting `W2E` type — each bundle now casts locally.
  - `ui/App.tsx` — form component. State (name/host/saId/jwk/errors), validation (required fields, duplicate host with Edit-same-host exception, JWK JSON validity, JWK required-in-Add / optional-in-Edit), Test Connection handler with monotonic requestId in a `useRef` (avoids stale-closure on the message listener).
- [x] **New esbuild target** — `package.json` adds `build:connection-form` + `watch:connection-form`; parent `build` chains all three (ext + webview + connection-form). Output: `out/connection-form.js` (262 KB).
- [x] **Deleted `src/views/connection-form.ts`** — old 467-line raw-HTML implementation removed.
- [x] **Updated `src/extension.ts`** — one import line moved to `./webview/connection-form/panel`. No behavioral changes; same external API.
- [x] **`localResourceRoots`** narrowed to `out/` so the bundle loads. CSP unchanged (`default-src 'none'; style-src ... 'unsafe-inline'; script-src 'nonce-…'`).
- [x] **Both tsconfigs updated** — main `tsconfig.json` excludes the new `src/webview/connection-form/ui/**`; `tsconfig.webview.json` includes `tests/webview/connection-form/ui/**` so test files get JSX + DOM lib.
- [x] **Tests** — new `tests/webview/connection-form/ui/app.test.tsx` (6 cases: required-field errors; duplicate-host in Add; Edit-same-host allowed; Edit JWK optional; Test Connection success roundtrip; stale-requestId ignored). Total 306 → 312.

#### Other M3 notes / non-goals

- [ ] First-click latency on journey expansion grows (PageNode container walk adds one extra `getNode` per child ref). Needs a live-tenant measurement pass against sb3 to record the actual range — not blocking the M3 commit; will be recorded here once captured.
- **Deferred** to a later milestone: `product-Saml2Node` (SAML2 entities + circles of trust — narrower customer segment, needs two-fetch resolution); `designer-*` custom marketplace nodes (minority of customers).
- **Deferred to M4** per D21: `listEsvs()` for the realm-index scan stays out of the tree's per-expansion path; the RealmIndex owns its own ESV index with its own refresh cycle. M5 back-search will consume that index, not the tree's per-expansion data.

## M4 — Resolver cache + inspector dependency view ✅

> Per D35 + D21. Per-root cache for forward transitive dep resolution; isolated from the lazy-tree cache and the realm index (D36) — enforced by the boundary test in D21.

### Slice 1 — Resolver data layer + D21 boundary test ✅

- [x] `src/domain/resolved-graph.ts` — wire-shape types (`ResolvedNode`, `ResolvedEdge`, `ResolvedGraph`, `ResolvedNodeKind`, `RootDescriptor`, `RootKind`) + `keyOf` helper. Lives in `domain/` (not `resolver/`) so the webview message protocol can import these in later slices without violating the D21 webview→resolver boundary.
- [x] `src/resolver/walk.ts` — `walkRoot(deps, root): Promise<ResolvedGraph>`. BFS over the root's transitive dep tree, concurrency-bounded via `mapConcurrent` (cap 10). Covers every dep kind the M3 lazy walker produces: script (incl. all D19 conditional kinds), inner-journey, library-script via `require()`, ESV via `extractScriptBodyRefs`, theme via `PageNode.themeId`, email-template via `EmailSuspendNode`/`EmailTemplateNode`, social-IdP via `filteredProviders`. Single-level PageNode container walk matches the lazy tree's behavior.
- [x] Collapsed `ResolvedNodeKind` so that journeys and inner-journeys both map to kind `"journey"` (same AIC entity; only the entry point differs — required for J → IJ → J cycle detection) and scripts and library-scripts both map to kind `"script"`. `RootKind` preserves the user-facing entry distinction.
- [x] **Architectural cleanup:** moved `script-body-parser.ts` from `src/resolver/` to `src/util/` (it's a pure parser with no resolver-cache coupling — the new D21 boundary test caught the pre-existing `src/views/nodes/script-expand.ts` → `src/resolver/` import this caused).
- [x] `tests/resolver/walk.test.ts` — 12 cases against `makeFakePaicClient`: empty journey, one-script child, inner-journey recursion (depth chain), J→IJ→J cycle (back-edge marked `cycle: true`, no re-walk), PageNode container walk (composite `via`), theme via PageNode, script-root with `require()` + ESV literal, library-script recursion (A→B→C), same-layer dup (one node, one non-cycle edge), D19 conditional predicate (DeviceMatchNode `useScript` on/off), email + social-idp + multi-script combo, `durationMs` is finite non-negative.
- [x] `tests/architecture/layer-boundaries.test.ts` — D21 import-boundary enforcement (4 rules: realm-index / resolver / views / webview). Regex matches `@/` aliased and any-depth relative imports. Guards missing dirs (`src/realm-index/` not existing yet trivially passes).
- [x] `tests/util/script-body-parser.test.ts` — relocated alongside the moved source file.

**Verification (Slice 1):** lint 0 errors / 154 warnings (+2 baseline-style complexity warnings on the new walker, matching `journey-expand.ts` + `script-expand.ts`); typecheck clean across both tsconfigs; tests 312 → **328** (+16 new outcomes: 12 walk + 4 boundary); all three bundles emit (`out/extension.js` + `out/webview.js` + `out/connection-form.js`).

### Slice 2 — Resolver cache + sidebar refresh wiring ✅

- [x] `src/resolver/cache.ts` — `makeResolverCache(deps)` factory + `ResolverCache` interface. Keyed by `{host, realm, kind, id}`; in-flight dedup via a parallel `inFlight: Map<string, Promise<ResolvedGraph>>`. API: `resolve(key, walkDeps)`, `dropOne(key)`, `dropAllForHost(host)`, `dispose()`. Walker injected via `deps.walk` (defaults to `walkRoot`) so the cache is unit-testable in isolation. Walker errors are NOT cached — the `finally` clears `inFlight` whether the walk resolves or rejects.
- [x] **D21-compliant invalidation pattern.** Per the boundary test from Slice 1, `src/resolver/cache.ts` cannot import `TenantsRegistry`. Per-host invalidation is wired from `src/extension.ts` (the one site that imports both layers) — the cache exposes `dropAllForHost(host)` and the extension calls it on `registry.onDidChange` for each prior host. Mirrors exactly how `clientCache.drop(h)` is invalidated today.
- [x] `src/extension.ts` — four small wiring edits next to existing `clientCache` touchpoints:
  - Construct `resolverCache = makeResolverCache({ log })` after `clientCache`; push `dispose` onto `context.subscriptions`.
  - `registry.onDidChange` handler: also `resolverCache.dropAllForHost(h)` for each prior host.
  - `paicJourneys.refresh` command: also `resolverCache.dropAllForHost(h)` for each prior host.
  - `paicJourneys.refreshNode` command: `resolverCache.dropAllForHost(node.host)` when the node carries a `host` field (defensive `"host" in node` + typeof check rather than `instanceof` per-class checks).
- [x] `tests/resolver/cache.test.ts` — 10 cases against a stub walker (`vi.fn`): miss-walks-and-stores, hit-returns-cached, in-flight dedup of concurrent calls, `dropOne`, `dropAllForHost` evicts target host, `dropAllForHost` preserves other hosts, `dispose` clears all, walker errors not cached (retry), key isolation across `kind` (journey vs script with same id), `dispose` is a callable Disposable.

**Verification (Slice 2):** lint 0 errors / 154 warnings (no new warnings); typecheck clean; tests 328 → **338** (+10 new outcomes); build emits all three bundles cleanly.

### Slice 3 — Protocol additions + JourneyCard segmented control ✅

- [x] **Protocol additions** in `src/webview/messages.ts`:
  - W2E: `{ type: "resolveFull" }` — the tab derives the root identity from its node, so no payload is needed.
  - E2W: `{ type: "resolveResult"; ok: true; graph: ResolvedGraph } | { type: "resolveResult"; ok: false; message: string }`.
  - `isW2E` / `isE2W` guards updated.
- [x] **Panel handler** in `src/webview/inspector/panel.ts`:
  - `InspectorFactoryDeps` + `InspectorTabDeps` carry `resolverCache: ResolverCache`.
  - `InspectorTab` stashes the constructor `node` as a class field.
  - `handleResolveFull()` uses a new `nodeToResolverKey(node)` helper that maps each of the 4 root-capable PaicNode subclasses (`JourneyNode` → kind+`journey.id`, `InnerJourneyNode` → kind+`id`, `ScriptNode` / `LibraryScriptNode` → kind+`scriptId`) to a `ResolverKey`. Unsupported kinds (`Connection`, `Realm`, `Esv`, `Theme`, `EmailTemplate`, `SocialIdp`) silently no-op.
  - Calls `cache.get(host)` → `resolverCache.resolve(key, { client, log })` → posts `resolveResult` (ok or err).
- [x] **Wiring** — `src/extension.ts` passes `resolverCache` to `new InspectorFactory({ ... })`.
- [x] **App.tsx state slot** — `resolveState: ResolveState` (idle / loading / ok / err). Reset on `select` E2W. `onResolve()` callback posts `resolveFull` W2E. Passed to `JourneyCard` as `resolved` + `onResolve` props.
- [x] **New shared component** `src/webview/inspector/ui/cards/ResolvedView.tsx`:
  - `ResolvedView({ directContent, resolved, onResolve, onPreview })` — section wrapper with header (h2 + summary + segmented control) and conditional body.
  - Inline `SegmentedControl` (Direct / Full tree / Flat) with `role="radiogroup"` + `role="radio"` buttons (the standard segmented idiom; `// biome-ignore lint/a11y/useSemanticElements`).
  - `ResolvedTree` — recursive `<ul>` from root. `(dup)` marker for `edge.cycle === true` (does NOT recurse). Loading/error/empty states.
  - `ResolvedFlat` — sorted unique non-root nodes with ref-count + shortest depth. Empty state.
  - `ResolvedFooter` — `Cycles: N · Depth: M · Resolved in T ms`.
  - `labelFor(kind)` translates `ResolvedNodeKind` → display label.
- [x] **JourneyCard wires `ResolvedView`** — `<DepsBlock>` is now wrapped: the segmented control sits above the existing direct-deps rendering; Full/Flat modes delegate to `ResolvedView` internals.
- [x] **CSS additions** in `INSPECTOR_CSS` (`src/webview/inspector/panel.ts`):
  - `.deps-section-header` (flex row), `.deps-summary`, `.deps-segment-control[.active]`, `.deps-tree[-list,-row,-dup]`, `.deps-flat[-row,-meta]`, `.deps-kind`, `.deps-resolve-loading[-error,-footer]`. All use VS Code semantic vars per D27.
- [x] **D21 boundary-test refinement** in `tests/architecture/layer-boundaries.test.ts`:
  - Dropped the broad `src/webview` rule (which would have forbidden panel.ts from importing the resolver).
  - Added narrower rules for `src/webview/inspector/ui` and `src/webview/connection-form/ui` (the React runtime sandboxes) that forbid `resolver | realm-index | tenants | paic` imports.
  - The spirit of D21 is preserved: runtime UI files stay cache-free; extension-side panel files are the wiring shim.
- [x] **Test setup additions**:
  - `makeFakeResolverCache(opts)` factory in `tests/views/fakes.ts` — supports per-key canned graphs + a `rejectWith` mode for the error-path test.
  - All existing `new InspectorFactory({...})` calls in `tests/webview/inspector/panel.test.ts` updated to pass `resolverCache`.
- [x] **New tests** — total 338 → 356 (+18):
  - `tests/webview/messages.test.ts` — extended `isW2E` / `isE2W` cases for the new message types.
  - `tests/webview/inspector/panel.test.ts` — 3 cases for `resolveFull` (ok roundtrip, err roundtrip, unsupported-kind no-op).
  - `tests/webview/inspector/ui/cards/resolved-view.test.tsx` — 12 cases (segmented control rendering, default mode, click-fires-onResolve, click-skips-onResolve-when-ok, summary visibility, loading/err states, tree rendering, `(dup)` cycle marker, click-to-preview, flat sorting + ref counts, flat empty state).
  - `tests/webview/inspector/ui/cards/journey-card.test.tsx` — 3 cases for the segmented control + existing tests updated to pass `resolved`/`onResolve` props.
- [x] **`docs/design-plan.md` D21** — the "Import-direction rule" subsection (mechanism 2) now splits webview into `<surface>/ui/*` (UI sandbox — strictly cache-free) and `<surface>/panel.ts` files (extension-side wiring shim — allowed to import any layer).

**Verification (Slice 3):** lint 0 errors / 154 warnings (no new warnings); typecheck clean across both tsconfigs; tests 338 → **356** (+18 new outcomes); build emits all three bundles cleanly.

### Slice 4 — Extend segmented control to InnerJourneyCard / ScriptCard / LibraryScriptCard ✅

- [x] **`src/webview/inspector/ui/cards/InnerJourneyCard.tsx`** — added `resolved: ResolveState` + `onResolve: () => void` props; wrapped `<DepsBlock>` in `<ResolvedView>` below the journey diagram.
- [x] **`src/webview/inspector/ui/cards/ScriptCard.tsx`** — added `resolved: ResolveState` + `onResolve: () => void` props; wrapped `<ScriptDepsBlock>` in `<ResolvedView>`. `onPreview` stays optional on the card; `ResolvedView`'s required `onPreview` is satisfied with a module-scope `noopPreview` fallback (defensive — App.tsx always passes a real `previewNode`).
- [x] **`src/webview/inspector/ui/cards/LibraryScriptCard.tsx`** — same pattern as ScriptCard.
- [x] **`src/webview/inspector/ui/App.tsx`** — kind-switch router now passes `resolved={resolveState}` + `onResolve={onResolve}` to InnerJourneyCard / ScriptCard / LibraryScriptCard (JourneyCard already had them from Slice 3). No new state — Slice 3's `resolveState` slot serves all four cards; the panel-side `nodeToResolverKey` already maps each PaicNode subclass to the correct `RootKind`.
- [x] **`tests/webview/inspector/ui/cards/inner-journey-card.test.tsx`** — existing tests' render calls updated to pass `resolved={idle}` + `onResolve={noop}`. 2 new segmented-control cases (renders Direct/Full/Flat radios; clicking Full tree fires `onResolve` when idle).
- [x] **`tests/webview/inspector/ui/cards/script-card.test.tsx`** — same prop updates. 2 new cases (segmented control present; switching to Full with `status: "ok"` renders the resolved tree with the linked entity's displayName + duration footer).
- [x] **`tests/webview/inspector/ui/cards/library-script-card.test.tsx`** — same pattern as inner-journey (2 new cases: segmented control present; clicking Full fires `onResolve`).

**Verification (Slice 4):** lint 0 errors / 156 warnings (+2 baseline-style warnings from the `noopPreview` `const`s in Script/LibraryScript cards); typecheck clean across both tsconfigs; tests 356 → **362** (+6 new outcomes); build emits all three bundles cleanly. After Slice 4, every card kind with a forward-dep walk (Journey / InnerJourney / Script / LibraryScript) shows the segmented control end-to-end.

### Slice 5 — Per-card refresh button + `refreshResolved` protocol ✅

- [x] **Protocol addition** in `src/webview/messages.ts` — added `{ type: "refreshResolved" }` to W2E (no payload; the tab derives the root from its node identically to `resolveFull`). `isW2E` guard extended.
- [x] **Panel handler refactor** in `src/webview/inspector/panel.ts`:
  - `handleResolveFull(forceRefresh: boolean)` — when true, calls `resolverCache.dropOne(key)` (Slice 2 API) before re-resolving. Single code path; one extra log line for the drop.
  - `onMessage` routes `resolveFull` → `handleResolveFull(false)` and `refreshResolved` → `handleResolveFull(true)`.
- [x] **`ResolvedView` refresh button** in `src/webview/inspector/ui/cards/ResolvedView.tsx`:
  - Added `onRefresh: () => void` to `ResolvedViewProps`.
  - Renders `<button class="deps-refresh">↻</button>` inside `.deps-section-header` after the segmented control.
  - Conditional on `resolved.status === "ok" || resolved.status === "err"` — hidden during idle/loading, so the user only sees "refresh" when there IS something to refresh (matches D35's visibility rule).
  - `title` + `aria-label` provide the accessible "Refresh dependencies" hint.
- [x] **CSS** — `.deps-refresh` styles added to `INSPECTOR_CSS` (transparent background, panel-border outline, hover swap, focus-visible ring; uses VS Code semantic vars per D27).
- [x] **App.tsx** — new `onRefresh` callback (sets `resolveState` to `loading` synchronously, posts `refreshResolved` W2E). Passed to all four root-capable cards.
- [x] **Four card prop pass-throughs** — `JourneyCard.tsx`, `InnerJourneyCard.tsx`, `ScriptCard.tsx`, `LibraryScriptCard.tsx` each add `onRefresh: () => void` to their `Props` and forward it to `<ResolvedView>`.
- [x] **Placement note (deviates from D35's literal text):** D35 placed the refresh button "on the card header next to `[↗ open]`"; we placed it inside `ResolvedView`'s section header instead — single code change (touch one shared component, all 4 cards inherit), visually grouped with the data it refreshes. The spirit of "visible + per-card" is preserved. Easy to move to the card header later if a `[↗ open]` action lands there.
- [x] **Tests** — total 362 → **366** (+4):
  - `tests/webview/messages.test.ts` — extended the existing `isW2E` test to cover `refreshResolved`.
  - `tests/webview/inspector/panel.test.ts` — +1 case for the `refreshResolved` roundtrip (verifies `resolverCache.dropOne` is called with the right `ResolverKey` before `resolve`, and a fresh `resolveResult` is posted).
  - `tests/webview/inspector/ui/cards/resolved-view.test.tsx` — +3 cases (button hidden in idle/loading; visible in ok/err; clicking fires `onRefresh`).
  - All 4 card tests had `onRefresh={noop}` threaded into every existing `render(...)` invocation (no new test cases — coverage already provided by ResolvedView's segmented + refresh tests).

**Verification (Slice 5):** lint 0 errors / 156 warnings (no new warnings); typecheck clean across both tsconfigs; tests 362 → **366** (+4 new outcomes); build emits all three bundles cleanly.

**M4 complete.** After Slice 5, every root-capable card (Journey / InnerJourney / Script / LibraryScript) supports Direct / Full tree / Flat toggling + per-card refresh end-to-end. Next milestone: **M5 — Search page (reverse-dep + name + orphans)** per D36.

## M5 — Search page (reverse-dep + name + orphans) ✅

> Per D36 + D21. Standalone Search webview backed by a per-`{host, realm}` realm index. Lazy, user-explicit, isolated.

### Slice 1 — Realm-index data layer ✅

- [x] `src/domain/realm-index.ts` — wire-shape types (`EntityKind`, `RealmIndexEntity`, `ReverseRef`, `RealmIndexEntry`, `entityKeyOf`). Lives in `domain/` so Slice 2's webview message protocol can import them without violating the D21 webview→realm-index boundary (same pattern as `src/domain/resolved-graph.ts`).
- [x] `src/realm-index/build.ts` — `buildRealmIndex(deps, host, realm)`. Per-realm scanner: lists journeys, fetches every node payload (single-level PageNode container walk), BFS over `require()` chains to discover library scripts + ESVs, fetches `listThemes` + `listSocialIdps`, merges `Theme.linkedTrees` reverse-refs. Concurrency-bounded via `mapConcurrent` (cap=10). Per-step errors logged + skipped — partial data survives. Reuses `getScriptIdIfRef` (D19) + `extractScriptBodyRefs` (D20).
- [x] `src/realm-index/cache.ts` — `makeRealmIndexCache({log, build?})`. `peek(host, realm)` synchronous lookup, `build(host, realm, deps)` single-flight, `dropOne(host, realm)`, `dropAllForHost(host)`, `dispose()`. Per D21, this file does NOT import `TenantsRegistry`; per-host invalidation will be wired from `extension.ts` in Slice 2. Per D36, deliberately does NOT subscribe to sidebar-refresh events. Builder errors clear the in-flight entry but don't cache.
- [x] `src/realm-index/queries.ts` — pure functions over `RealmIndexEntry`. `findUsages(entry, targetKey)` reads `inboundRefs`. `searchByName(entry, pattern, kinds?)` case-insensitive locale-aware substring match, sorted by displayName; empty pattern returns `[]`. `findUnused(entry, kinds?)` returns entities with zero inbound refs; excludes `journey` from the default kind set (journeys are entry points by definition).
- [x] **Email-template enumeration gap** — `PaicClient.listEmailTemplates()` doesn't exist. Slice 1 materializes email templates only when a journey references one; `findUnused` for `emailTemplate` returns `[]`. Documented as a Risks item in the slice plan; Slice 2 will either add the list endpoint or surface the gap in the Search UI.
- [x] **Tests** — total 366 → **424** (+58 outcomes):
  - `tests/realm-index/queries.test.ts` — 16 cases covering all three queries (happy paths, empty/missing targets, kind filtering, journey-exception rule, sort stability).
  - `tests/realm-index/build.test.ts` — 15 cases against `makeFakePaicClient`: empty realm, journey/script collection + dedup, library-script chains via `require()`, ESV classification (variable/secret), unknown-ESV omission, theme `linkedTrees` merge, social-IdP orphan-but-listed, inner-journey edges, email-template materialization, per-kind counts, per-step error resilience (node fetch failure + script fetch failure).
  - `tests/realm-index/cache.test.ts` — 11 cases mirroring `tests/resolver/cache.test.ts`: `peek` returns null on miss, `build` invokes + stores, post-build peek, single-flight dedup, `dropOne`/`dropAllForHost` scoped invalidation, error-not-cached, `dispose` clears, per-realm isolation, Disposable shape.
- [x] **D21 boundary test passes.** The pre-existing `src/realm-index` rule now scans real files — confirms no imports from `views/`, `resolver/`, `webview/`, `tenants/`.
- [x] **Verification:** `npm run lint` 0 errors / 157 warnings (+1 baseline-style cognitive-complexity on `buildRealmIndex` matching `walkRoot` / `journey-expand`); typecheck clean across both tsconfigs; `npm run build` emits all four bundles; live-tenant smoke deferred until Slice 2 wires the Search webview.

### Slice 2 — Search webview surface ✅

- [x] `src/webview/search/messages.ts` — typed W2E/E2W discriminated unions + `isW2E` / `isE2W` guards. Eight W2E variants (`ready`/`peek`/`build`/`rescan`/`listEntities`/`query` × 3 modes/`previewByKey`) + nine E2W variants. `SearchPayload` carries `host`, `realm`, optional `prefill` for Slice 3 entry points, `availableRealms`. Lazy `listEntities` round-trip avoids shipping the full entry map across postMessage on every peek.
- [x] `src/webview/search/panel.ts` — `SearchFactory` (single-instance-per-`(host, realm)` map, mirrors D36) + `SearchTab` (one webview panel per key). Message handlers: `peek` (synchronous cache status), `build` (calls `realmIndexCache.build` with single-flight; posts `buildStart` then `buildDone` or `buildError`), `rescan` (`dropOne` then `build`), `query` (dispatches to `findUsages` / `searchByName` / `findUnused` and hydrates result entities for findUsages), `listEntities` (returns grouped entity map for the dropdown), `previewByKey` (delegates to `inspectorFactory.spawnByDescriptor`). Inline `SEARCH_CSS` reuses VS Code semantic vars per D27.
- [x] `src/webview/inspector/panel.ts` — extracted descriptor → PaicNode logic into module-level `buildPaicNodeFromDescriptor` + exported `InspectorFactory.spawnByDescriptor(host, realm, descriptor)` as a public method. Existing `InspectorTab.handlePreviewResolved` rewritten to delegate. Single source of truth per the 2026-05-19 lesson — both Full/Flat resolved-graph clicks (M4) and Search-page result-row clicks (Slice 2) use the same code path.
- [x] `src/webview/search/ui/{main,App}.tsx` — React entry + top-level component (single file holds Header / ModeSwitcher / QueryControls × 3 modes / Results). State shape: `BuildState` (idle/building/err), `QueryState` (idle/running/err/okFindUsages/okByName/okUnused). `useEffect`-registered window message listener routes E2W messages by type. Find-usages mode lazily fires `listEntities` when entered and the cache is built. By-name + Unused use kind-filter chips (multi-select). Result-row click → `previewByKey` → new inspector tab via factory.
- [x] **Build pipeline** — `build:search` + `watch:search` scripts in `package.json`; parent `build` chains five bundles (extension, webview, connection-form, **search**, codicons). `out/search.js` is ~272 KB.
- [x] **Extension wiring** in `src/extension.ts` — constructs `realmIndexCache = makeRealmIndexCache({ log })` + `searchFactory = new SearchFactory({ context, cache, realmIndexCache, inspectorFactory, log })`. `registry.onDidChange` drops realm-index entries for prior hosts + clears searchFactory registry. `paicJourneys.refresh` deliberately does NOT clear realmIndexCache (per D36 — rebuilding is a 10-second-class operation, must be user-explicit via `Rescan`). New `paicJourneys.openSearch` command QuickPicks connection + realm (skipping root realm via D25 filter), then spawns the Search webview.
- [x] **tsconfig updates** — both `tsconfig.json` (extension) and `tsconfig.webview.json` (UI) extended to include / exclude the new `src/webview/search/ui/**` paths.
- [x] **`paicJourneys.openSearch` command** registered in `package.json` `contributes.commands` (title "PAIC: Search…", icon `$(search)`). Command palette accessible (no `commandPalette` `when: false` entry) — no sidebar icon / context menu yet (Slice 3).
- [x] **Tests** — total 424 → **456** (+32 outcomes):
  - `tests/webview/search/messages.test.ts` — 6 cases (every W2E + E2W discriminant + malformed/cross-bundle false-positive rejection).
  - `tests/webview/search/panel.test.ts` — 15 cases (single-instance behavior; peek/build/rescan/query × 3 modes/listEntities/previewByKey roundtrips; queryError when no entry).
  - `tests/webview/search/ui/app.test.tsx` — 9 cases (ready+peek on mount; Header empty/populated states; Build button posts `build`; buildDone refreshes counts; mode switch + query roundtrip; result-row click posts previewByKey; auto-fires listEntities when switching to Find usages with built index; disabled Search button without a selected target).
  - `tests/webview/inspector/panel.test.ts` — 2 new cases for `spawnByDescriptor` (script descriptor opens new tab with select payload; cross-kind coverage via Promise.all on 5 kinds).
- [x] **Verification:** lint 0 errors / 163 warnings (+6 from Slice 1's 157, all baseline-style cognitive complexity on the new scanner / build / queries); typecheck clean across both tsconfigs; `npm run build` emits all five bundles cleanly; D21 boundary test still green.

**Smoke (EDH) deferred** — the data + UI work fully; live-tenant smoke runs when the user manually opens the command palette → "PAIC: Search…" against a real connection.

### Slice 3 — Entry-point integrations ✅

- [x] **Sidebar title-bar `$(search)` icon** — `package.json` `view/title` entry for `paicJourneys.openSearch` lands in `navigation@2` (between Add Connection and Refresh). One-click opens the QuickPick flow.
- [x] **Right-click "Search…" context menus** — `view/item/context` entries on both `viewItem == connection` (group `1@2`) and `viewItem == realm` (group `1@1`) bind `paicJourneys.openSearch`. The command handler now accepts the tree node as its first argument and branches accordingly: `RealmNode` skips both QuickPicks; `ConnectionNode` skips the host picker; no arg (palette / sidebar icon) shows the full flow.
- [x] **Card portal `[🔍 Find usages]` button** on five inspector cards: `ScriptCard`, `LibraryScriptCard`, `EsvCard`, `ThemeCard`, `InnerJourneyCard`. Per D36, `JourneyCard` is intentionally excluded — root journeys are entry points, "find usages" of one is a degenerate query.
- [x] **Inspector W2E protocol** extended with a `findUsages` variant carrying `{host, realm, kind, id, displayName, isLibrary?, esvKind?}`. `isW2E` guard updated. Routed via `vscode.commands.executeCommand("paicJourneys.findUsages", ...)` in `panel.ts` `onMessage` — mirrors the existing `openScriptBody` / `openEmailTemplateBody` pattern, so the inspector tab never imports `SearchFactory` directly.
- [x] **New `paicJourneys.findUsages` command** registered in `extension.ts` (palette-hidden via `commandPalette.when = false`). Translates the descriptor to a `SearchPrefill` and calls `searchFactory.spawn(host, realm, { mode: "findUsages", targetKind, targetKey: entityKeyOf(kind, id) })`. Defensive arg parser (`parseFindUsagesArg`) duck-types the payload + rejects unknown kinds.
- [x] **Search-page prefill auto-run** — `src/webview/search/ui/App.tsx` gains a `useRef`-guarded `useEffect` that fires `onSearch()` once when the embedded prefill carries `mode: "findUsages"` + `targetKey` AND the realm index is built AND the dropdown selection matches. If the index isn't built when the page opens, the prefill seeds the dropdown; the user clicks Build, listEntities re-fetches, and the auto-run effect fires.
- [x] **Tests** — total 456 → **463** (+7 outcomes):
  - `tests/webview/messages.test.ts` — +1 case (W2E guard accepts `findUsages`).
  - `tests/webview/inspector/panel.test.ts` — +1 case (`findUsages` W2E dispatches `paicJourneys.findUsages` via `executeCommand` with the right descriptor).
  - `tests/webview/inspector/ui/cards/{script,library-script,esv,theme,inner-journey}-card.test.tsx` — +1 case each (button click fires `onFindUsages` with the right descriptor).
  - `tests/webview/search/ui/app.test.tsx` — +1 case (auto-run fires once when prefill + built cache align; repeated peekResult does NOT re-trigger thanks to the one-shot ref).
- [x] **Verification:** lint 0 errors / 163 warnings (no new); typecheck clean across both tsconfigs; `npm run build` emits all five bundles; D21 boundary test still green.

### Slice 4 — Search page UX redesign: singleton page + in-page dropdowns ✅

User feedback after Slices 2+3 reshaped the entry-point UX: instead of QuickPick prompts gating the page open, the Search page now **opens immediately** with two in-page dropdowns (Connection + Realm). This **amends D36** — see the "Singleton Search page (AMENDED 2026-05-19)" note in `docs/design-plan.md`.

- [x] **D36 amended** — the original "single instance per `(host, realm)`" rule is superseded. With realm as an in-page dropdown, per-realm tabs are incoherent → the Search page is now a **singleton**. Re-invoking any entry point focuses the one tab and re-seeds its dropdowns.
- [x] `src/webview/search/messages.ts` reworked — `SearchPayload` now carries `connections` (the dropdown list, shipped in the embedded payload) + `selectedHost` / `selectedRealm` (pre-selection) instead of fixed `host`/`realm`. New `listRealms` W2E + `realmsResult` / `realmsError` E2W (realm lists need a `client.listRealms()` call per connection, fetched on demand). Every host/realm-scoped W2E now carries `host` + `realm` explicitly; every result E2W echoes them so the React app drops stale replies after a mid-flight dropdown change.
- [x] `src/webview/search/panel.ts` — `SearchFactory` is now a singleton manager (`spawn(opts)` focuses-or-creates one tab; takes a `listConnections` dep read fresh per spawn). `SearchTab` is stateless w.r.t. selection — every handler reads `host` / `realm` from the message. New `listRealms` handler filters the root realm (D25). `clearRegistry()` re-renders the open tab with the fresh connection list.
- [x] `src/webview/search/ui/App.tsx` — new `ScopeSelector` (two `<select>` dropdowns). Connection-change → fetch realms (cached per host in `realmsByHost`). The cache-status header / query controls / results render **only once both dropdowns are set**, gated on `scopeReady`. All W2E posts thread the current `(host, realm)`; the message listener drops results whose `(host, realm)` ≠ current selection.
- [x] `src/extension.ts` — `paicJourneys.openSearch` drops its QuickPick flow entirely: it just `searchFactory.spawn(opts)` with `selectedHost` / `selectedRealm` pre-filled from a `RealmNode` / `ConnectionNode` arg (or nothing from the palette / sidebar icon). `paicJourneys.findUsages` spawns with `{ selectedHost, selectedRealm, prefill }`. The old `pickRealmForSearch` QuickPick helper is deleted. `SearchFactory` gains a `listConnections` dep.
- [x] **Tests reworked** — `tests/webview/search/{messages,panel}.test.ts` + `ui/app.test.tsx` rewritten for the new protocol, singleton factory, and dropdown-driven scope. 30 search-test outcomes (5 messages + 15 panel + 10 App). Total **462 passing**.
- [x] **Verification:** lint 0 errors / 163 warnings; typecheck clean; `npm run build` emits all five bundles; D21 boundary test green.

### Slice 5 — Realm-index build performance ✅

Live sb3 smoke surfaced a slow build: `alpha` took **108 s** (~2,300 HTTP calls). Log analysis found two issues — see the `docs/lessons.md` 2026-05-19 "Nested `mapConcurrent`" entry + the "Build concurrency" note in `design-plan.md` D36.

- [x] **One shared per-build limiter.** Nested `mapConcurrent(…, 10)` calls multiplied to ~80 concurrent in-flight (getNode avg latency ballooned to 2,485 ms from tenant-side queuing). Replaced with a single `makeLimiter(10)` instance created per `buildRealmIndex` call, stored on `BuildState`, threaded through every `PaicClient` call across every phase. True cap-10, matches the tree + resolver, far gentler on the tenant (D16). Per-build instance — never shared with the tree-lazy or resolver caches (D21 intact).
- [x] `src/paic/concurrency.ts` — added `makeLimiter(n)` returning `{ run<T>(task) }`. Pure concurrency primitive alongside `mapConcurrent`; caps total in-flight across all `run()` calls on the instance (vs `mapConcurrent` which caps its own per-call pool).
- [x] **Batched script-phase library lookups.** The `require()`-chain BFS `await`ed `getScriptByName` per-script inside a `for` loop → effective concurrency ~4. `scanScripts` now does a first pass (enrich entities + collect the layer-wide union of library names) → one batched `getScriptByName` lookup → second pass emitting edges from the resolved map. Extracted `fetchScript` + `enrichScriptEntity` helpers.
- [x] `tests/paic/concurrency.test.ts` — +4 `makeLimiter` cases (caps in-flight across independent `run()` calls; resolves with task result; a rejected task frees its slot + propagates; throws on `n < 1`). `build.test.ts` stays green — all 15 cases pass unchanged (behavior identical; only call scheduling differs).
- [x] **Verification:** lint 0 errors / 163 warnings; typecheck clean; 462 → **466 tests**; build emits all 5 bundles.
- [x] **Re-smoke confirmed (sb3 `alpha`)** — build time **108.5 s → 67.8 s** (−37%). Identical output (778 entities / 1,864 refs). Total HTTP calls 2,259 → 1,863 (layer-wide dedup of `require()` lookups). getNode per-call latency **2,485 ms → 334 ms** (no longer bursting ~80-wide and overwhelming the tenant — true cap-10). Scripts phase ~58 s → ~17 s (serialization removed; true cap-10). getNode phase stayed ~flat at ~42 s — the predicted trade: same speed, far gentler per call.

### Slice 6 — Build progress indicator ✅

A realm-index build is a ~68 s foreground operation; the Search page previously showed a static "Building realm index…" string for the whole wait. Slice 6 replaces it with a live progress bar.

- [x] `src/realm-index/build.ts` — `RealmIndexBuildDeps` gains an optional `onProgress(p: BuildProgress)` callback. `BuildProgress = { phase: "preparing" | "journeys" | "scripts" | "finishing"; done?: number; total?: number }`. **Both** long phases report a unified `done` / `total`: the journey scan per completed journey (`total` = journey count); the script-BFS per fetched script, where `total` is the BFS's `enqueued`-set size — it seeds with the journey-referenced frontier and grows as library scripts surface, so `done` chases it and the phase ends at `N / N` (same `X / Y` label shape as journeys).
- [x] **Overlap optimization** (folded in) — the tenant ESV-index fetch now runs concurrently with `listJourneys` (one `Promise.all`); `listThemes` + `listSocialIdps` run concurrently with the script-body BFS. The phases touch disjoint `BuildState` slices; the synchronous `materializeEntity` / `addEdge` writes never tear (JS single-threaded).
- [x] `src/realm-index/cache.ts` — no change needed; `onProgress` rides through transparently inside `RealmIndexBuildDeps`, which `cache.build()` already forwards to `buildRealmIndex`.
- [x] `src/webview/search/messages.ts` — new `buildProgress` E2W message `{ host, realm, phase, done?, total? }`; `isE2W` updated.
- [x] `src/webview/search/panel.ts` — `handleBuild` passes an `onProgress` that **coalesces** updates: an immediate post on every phase change, otherwise throttled to ~5 Hz (`PROGRESS_THROTTLE_MS = 200`) — never one message per journey.
- [x] `src/webview/search/ui/App.tsx` — `BuildState.building` carries `progress` + a `pct`; the Header renders a **progress bar + phase label + percentage** (full header width) while building — e.g. `Scanning journeys — 87 / 142` or `Resolving scripts — 300 / 540` over a filled bar. Bar fill uses `--vscode-progressBar-background` (D27). Percentage spans four contiguous monotonic bands (preparing 0–5 %, journeys 5–78 %, scripts 78–98 %, finishing 98–100 %); both determinate phases interpolate within their band by `done`/`total`. Because the script `total` grows, the displayed `pct` is **clamped monotonically** in the message handler (`Math.max(raw, prevPct)`) — a progress bar never retreats.
- [x] Tests — total 466 → **471**: `build.test.ts` +1 (`onProgress` fires across phases with determinate journey `done`/`total`); `panel.test.ts` +1 (`buildProgress` relayed from the builder's `onProgress`); `app.test.tsx` +3 (journey-phase bar; scripts-phase bar with unified `X / Y` label; monotonic clamp holds the bar when the script total grows).
- [x] **Verification:** lint 0 errors / 163 warnings; typecheck clean; build emits all 5 bundles.

### Slice 7 — Find-usages results: grouped list + path tree ✅

Find-usages previously rendered a flat one-hop `kind · name → via` list. Two improvements (user-reviewed mockups, approved) — both derived purely from the in-memory `RealmIndexEntry.inboundRefs`, no new fetches or cache changes:

- [x] **Kind-grouped result list** — all three query modes render results under `── <Kind> (N) ──` divider headers with codicons, alphabetical within kind (the inspector-card / sidebar vocabulary). New pure helper `src/webview/search/ui/grouping.ts` — `displayKindOf` (splits `script` by `isLibrary`), `DISPLAY_KIND_LABEL` / `DISPLAY_KIND_ICON`, generic `groupByKind<{entity}>`.
- [x] **Path-tree view** — a `List | Tree` segmented toggle on Find-usages results (resets to List on each new query). Tree shows every path from a journey root down to the searched entity (the searched thing is the leaf). New pure query `findUsagePaths(entry, targetKey): UsagePaths` in `src/realm-index/queries.ts`: reverse-reachability BFS over `inboundRefs` to collect ancestors → relevant-restricted forward adjacency → roots (journeys; non-journey roots flagged `orphanRoot` = dead-code path) → forward DFS render in display order with a shared `rendered` set (first displayed occurrence wins; repeats / cycles collapse to `(dup)`).
- [x] `src/domain/realm-index.ts` — `UsagePathNode` + `UsagePaths` types (in `domain/` so producer + webview both import, per the `ResolvedGraph` precedent).
- [x] `src/webview/search/messages.ts` — `queryResult` findUsages variant gains `paths: UsagePaths` (computed alongside `refs` — same `entry`, cheap, no extra round-trip; the `List|Tree` toggle is client-side).
- [x] `src/webview/search/panel.ts` — `handleQuery` findUsages computes + posts `paths`; `SEARCH_CSS` gains `.search-divider` + `.search-tree*`.
- [x] `src/webview/search/ui/{grouping.ts, UsagePathTree.tsx, App.tsx}` — recursive tree renderer (codicon + `via` + `(dup)` + `⚠ no journey reaches this` for orphan roots); App threads grouped lists for all modes (new `GroupedList` / `EntityRow` / `ResultDivider`), the `List|Tree` `UsagesViewToggle`, and `usagesView` state; tree nodes click → `previewByKey`.
- [x] Tests — total 471 → **481**: `queries.test.ts` +7 `findUsagePaths` (linear chain, via labels, multi-root, dup, cycle, orphan root, unknown target); `messages` / `panel` extended for the `paths` field; `app.test.tsx` +3 (kind-grouped dividers, `List|Tree` toggle defaulting to List, switching to Tree renders the path tree).
- [x] `docs/design-plan.md` D36 — "Result rows" note amended for the grouped list + path-tree view.
- [x] **Verification:** lint 0 errors / 164 warnings (+1 baseline-style cognitive-complexity on `findUsagePaths`); typecheck clean across both tsconfigs; `npm run build` emits all 5 bundles.

## M6 — Realm-wide graph webview ⏳

- [ ] `src/webview/graph/` — third React entry
- [ ] Re-uses ReactFlow already loaded at M2
- [ ] Hierarchical + force-directed layouts toggle
- [ ] Kind-colored nodes, typed edges
- [ ] Filter chips per `NodeKind`

## M7 — Impact analysis + saved graphs + diff ⏳

- [ ] Impact = reverse-reachability over the union of edge kinds
- [ ] "Save Graph" explicit user action → `globalStorageUri/cache/<host>/graphs/<timestamp>.json` (the only on-disk derived data we ever write)
- [ ] Diff two saved graphs

---

## What's working today

**Connections (M0)**
- Activity bar icon (`type-hierarchy` tree glyph) opens the PAIC Journeys sidebar.
- Add / Edit / Remove Connection commands; round-trip with JWK in SecretStorage.
- Inline Edit + Remove buttons on each connection row; non-modal QuickPick remove confirmation.
- Test Connection button in the Add/Edit form (live JWT-bearer mint + verification, confirmed against sb3).

**Tree (M1)**
- Lazy expansion through L4: connection → realm → journey → script | inner-journey (with recursion + cycle guard).
- One `PaicClient` per host with an in-memory bearer-token cache; cached clients dropped when the registry mutates.
- Inline refresh button on every expandable row + view-title Refresh; per-row error / empty / cycle states surface as `MessageNode` leaves.

**Inspector (M1)**
- Detail panel opens beside the editor on first selection; reused across selections; survives focus shifts (`retainContextWhenHidden`).
- 5 kind-specific cards (Connection / Realm / Journey / Script / InnerJourney) rendering metadata; journey cards list referenced scripts + inner journeys.
- Click a reference in an inspector card → `treeView.reveal()` moves tree selection + the inspector switches to the new card.
- VS Code theming via `--vscode-*` CSS variables; CSP locked down with nonce-restricted script-src.

**Observability**
- Structured NDJSON logs at `<globalStorageUri>/logs/paic-journeys.ndjson` (5 MB × 5 file rotation) + VS Code Output panel via pino multistream.
- Secret-keyword redaction (`saJwk`, `jwk`, `bearer`, `assertion`, `password`, `token`, `secret`, `authorization`).
- `./dev-tail.sh` follows the latest disk log file across EDH reloads.

**Build + test**
- `npm run build` → `out/extension.js` + `out/webview.js` + `out/connection-form.js` + codicons assets.
- `npm run typecheck` covers both `tsconfig.json` and `tsconfig.webview.json`.
- 481 unit tests across PAIC transport (incl. `makeLimiter`), tenant registry + client cache, tree nodes, inspector panel + protocol (incl. `findUsages` dispatch), React card + diagram components (incl. 5 card `[🔍 Find usages]` button cases), resolver walk + cache (M4), realm-index build + cache + queries with progress reporting (M5 Slices 1, 5, 6), the Search webview's messages + panel + App with singleton-page + connection/realm dropdowns + build progress bar (M5 Slices 2–4, 6), and the `InspectorFactory.spawnByDescriptor` refactor.

## What's broken today

(nothing)

## Active blockers

(none)
