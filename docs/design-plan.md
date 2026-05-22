# PAIC Journeys (VS Code Extension) — Design Plan

> Single source of truth for what we're building and why. Companions: [progress.md](progress.md) for build status, [sidebar-tree.md](sidebar-tree.md) for the sidebar shape, [logging-spec.md](logging-spec.md) for the log contract, [lessons.md](lessons.md) for corrections.

## Concept

A VS Code extension that turns *"what does this PAIC journey actually depend on?"* into a first-class artifact. The user connects to one or more PAIC tenants, picks a journey, and gets:

1. A **lazy tree view** in the sidebar — connection → realm → journey → expand to direct dependencies (scripts, inner journeys, later themes/ESVs) → keep expanding to leaves.
2. A **graph webview** in the editor area — the resolved dependency graph rendered with ReactFlow.
3. A **query panel** — reverse lookups ("which journeys use this script?"), orphans ("scripts referenced by nothing"), and impact analysis ("if I change this script, what breaks?"). Driven by a per-realm index.

Read-only. No pull/push/promote. Service-account JWT-bearer auth. Multi-tenant, local-only.

## Why this is worth building

Surveyed tools that already touch journey dependencies (PAIC UI export, `frodo`, `fr-config-manager`, the `paic-pipeline` Next.js viewer). Each falls short in a specific way:

- **PAIC UI export** is fixed-shape JSON. Not a graph, not analyzable.
- **frodo** has the walking primitives but doesn't expose them as a queryable graph (its `getTreeDescendents` and `getLibraryScriptsRecurse` exist but aren't wired into the user-facing export).
- **fr-config-manager** produces a directory tree, narrower deps than frodo, sequential, no graph.
- **paic-pipeline** has the best per-journey viewer but it's one journey at a time — no transitive graph, no reverse lookup.

**The unfilled gap is the realm-scoped dependency graph as a queryable artifact.** Forward exploration (tree view) is table stakes; reverse lookups + orphans + impact are the differentiator. A POC scan against a sandbox tenant's `alpha` realm measured this concretely: 84 journeys, 1,061 calls, ~15 s at concurrency 10 — and one shared script touched by 55 of those 84 journeys. Today nobody sees that; tomorrow our tool surfaces it in seconds.

## Operating principles

These are the meta-rules that should survive any individual feature decision:

1. **Incremental end-to-end slices over horizontal layers.** Each milestone delivers a working, testable user-facing flow. We don't build an entire layer (client / resolver / tree / webview) in isolation and then wire it up at the end. The first slice is *narrow but complete*: one connection, one journey, scripts and inner-trees visible, script body openable. We add depth slice by slice.

2. **Foundation chosen so each new slice doesn't force a redesign.** The layered architecture (transport / domain / consumers), the tree-node class hierarchy, and the typed extension⇄webview message protocol are introduced *exactly when* the second consumer arrives — not earlier, not later. The price of doing them at the right moment is keeping the option open from milestone 1.

3. **Stateless start.** Reload = clean slate. No database, no on-disk cache of derived data, no journal of fetched payloads. Only user-owned config persists (connections + JWK). Same rationale as why we don't ship SQLite: simpler, safer, no staleness anxiety, no cache invalidation problem.

4. **Pay for what you use.** Browsing is lazy and per-click. The realm-skeleton scan that powers analysis features runs in the background only after the user expands a realm. Reverse-lookup queries don't fire until the user opens the query panel.

5. **Browsing ≠ analysis.** Tree view is for forward exploration. Query panel is for cross-cutting queries. They share the same index when present, but live on separate surfaces so neither clutters the other.

6. **Idea-debt over code-debt.** We borrow patterns from frodo-lib (scope fallback, retry, realm-path translation, node-type tables) but not the library itself. See D2.

## Locked decisions

### D1 — Stack

VS Code Extension API + TypeScript + esbuild bundle. No webpack. Webview UIs (when introduced) are React + ReactFlow as a separate esbuild entry point.

### D2 — Foundation: raw REST, not frodo-lib

Lifted ideas (auth flow, scope fallback, realm-path helper, pagination shape, node-type tables, retry interceptor) — no library dependency. Audit conclusion: the bits we'd actually use total ~250 lines of equivalent code; the bits we'd inherit but never use (IDM/SAML/social/IGA/agent/secret/theme/oauth-client/policy ops, file-I/O exporters, frodo's 809-line global `State` machine, Polly mocks) are 80%+ of frodo's surface. Architectural mismatch — frodo is CLI-shaped with a global mutable `State`, we want **per-connection** client instances — is the deciding factor. Plus frodo is pre-release (`4.0.0-42`) with API churn; pulling it in would force chasing upgrades.

### D3 — Storage: settings.json + SecretStorage, keyed by `host`

Per-connection: `host`, `saId`, optional `name` in `paicJourneys.connections` (settings.json). `saJwk` in `SecretStorage` keyed by `paicJourneys.saJwk.<host>`. Workspace-if-open else global target. No registry file in `globalStorageUri` — settings.json IS the registry. No master key or local encryption — `SecretStorage` (OS keychain) handles that. Failure modes worth handling: orphaned-settings-no-secret (sync to fresh machine) → "credentials missing" with right-click "Set Credentials"; secret-no-settings (manual edit gone wrong) → "Clean Up Orphaned Credentials" command, never auto-delete.

### D4 — `host` is the stable identity

Not a synthetic UUID, not a user-given name. Hosts are unique, stable, and human-meaningful. `name` is a pure display label, optional.

### D5 — "Connection" (not "tenant", not "environment")

User-facing vocabulary follows frodo's "connection profile" idea. Matches what the data actually is (a connected session against a host with creds). Avoids the "environment" overload from VS Code's own usage.

### D6 — Read-only

No pull, no push, no promote. If anyone wants those, they use paic-pipeline. We stay focused on analysis.

### D7 — Resolver: full-depth BFS with cycle guard

For each journey we *actually walk*: fetch tree skeleton → fetch reference-bearing node payloads → recurse on `InnerTreeEvaluatorNode.tree` → fetch script bodies on demand → (later) recurse on `require()` for library scripts → (later) extract ESV references from script bodies. Cycle guard via visited-set keyed by `(kind, id)`. Implementation grows by milestone (see Milestones below).

### D8 — In-memory only, no on-disk persistence of derived data

Token cache, resolver memo, RealmIndex — all in session memory. No `globalStorageUri/cache/*.json` writes for derived data. Reload = clean slate. Only user-owned config persists.

### D9 — Logging: structured NDJSON via pino, fanned out to file + Output panel

**Library:** [`pino`](https://github.com/pinojs/pino) (same choice as llm-gateway) + a small in-process `RotatingFileStream` for size-based rotation. Pino gives us ISO timestamps, level filtering, child loggers, error auto-serialization, and built-in `redact` paths for secrets. Boring, fast, well-known.

Rationale for in-process rotation (not `pino-roll`): pino-roll is implemented as a pino transport, which runs on a worker thread. `pino.multistream` — which we use to fan out to both the file and the Output panel — accepts only synchronous streams in its array, not worker-based transports. So pino-roll can't sit in the multistream. The ~50-line `RotatingFileStream` (`fs.openSync` + `fs.writeSync` + `fs.renameSync`) composes cleanly with multistream and avoids worker-thread fragility inside the Extension Host.

**Two sinks via `pino.multistream`:**
- **File:** `globalStorageUri/logs/paic-journeys.ndjson` — one JSON object per line, size-rotated at 5 MB × 5 files. This is what log shippers (Vector / Filebeat / Promtail / Loki / Datadog) tail.
- **Output panel:** a tiny `Writable` adapter parses each line and routes it to `vscode.window.createOutputChannel('PAIC Journeys', { log: true })` so users still get the friendly VS Code Output-panel UX.

**Why two sinks:** VS Code extensions can't usefully write to stdout (it's swallowed). We can't borrow llm-gateway's "Docker captures stdout" model directly. The file sink replaces stdout for log shipping; the channel sink preserves the in-editor UX.

**Record shape** (verbatim from llm-gateway's spec, adapted):

```jsonc
{ "time": "2026-05-17T15:23:45.123Z",
  "level": "info",
  "service": "paic-journeys",
  "version": "0.0.1",
  "component": "paic.http",      // from log.child({component: "paic.http"})
  "event": "http.request",       // categorical event name (namespace.action)
  "msg": "GET /trees status=200",// human-readable, no dynamic values
  "host": "openam-sb3...",       // arbitrary structured fields
  "status": 200,
  "duration_ms": 187 }
```

**Secret redaction** via pino's built-in `redact` paths:
```
["saJwk", "*.saJwk", "jwk", "*.jwk", "bearer", "assertion",
 "*.password", "*.token", "*.secret", "authorization"]
```
Matching values are replaced with `"[Redacted]"` before serialization. Recursive.

**Settings:**
- `paicJourneys.logging.level` — `error|warn|info|debug|trace`, default `info`.
- `paicJourneys.logging.fileEnabled` — boolean, default `true`. Privacy-conscious users can disable file sink and keep only the Output panel.

**Never log secrets** — the redact list is the safety net, but the rule still applies: avoid passing JWKs, tokens, or `SecretStorage` values into logger calls at all.

See [logging-spec.md](logging-spec.md) for the full field/event/level taxonomy.

### D10 — Never `process.exit()`

Anywhere. Throwing is the only way to fail in extension code.

### D11 — Data layer split (transport / domain / consumers)

Introduced at milestone M1.

```
src/paic/        TRANSPORT       Raw PAIC REST shapes; one-to-one with API.
                                Knows pagination, auth, retry, errors.
                                Returns PAIC envelopes — no reshape.

src/domain/     DOMAIN MODEL    Clean TS types: Connection, Realm, Journey,
                                Script, InnerJourney, Theme, ESV.
                                Decoupled from REST shape.

src/resolver/   ┐
src/views/      ├── CONSUMERS   Consume domain types only. Never raw REST.
src/webview/    ┘
```

Translation lives in mappers — `src/paic/mappers.ts` (open question: could move to `src/domain/from-paic.ts` later if "domain knows nothing about PAIC" purity matters more than locality).

### D12 — Tree-node class hierarchy at M1 (shipped)

Rationale at original lock-in: while the tree had only one level (connections), a plain interface + flat provider was correct. When the second level lands, refactor to `abstract class PaicNode` with one subclass per kind, each implementing `getChildren()` + tree-item rendering. Mirrors the database extension's `model/interface/node.ts` pattern.

**Shipped in M1**: cutover landed alongside the L2-L4 tree task. `src/views/nodes/{base,connection,realm,journey,inner-journey,script,journey-expand}.ts` implements the hierarchy; `PaicTreeProvider` delegates `getChildren` to each node and implements `getParent` so `TreeView.reveal()` can be driven from the inspector.

### D13 — RealmIndex: background skeleton scan on realm-expand (SUPERSEDED 2026-05-19 by D36)

**Status: superseded.** The original plan was to start a background realm scan when a realm node expands, so the index would be warm by the time the user opened the query panel. D36 reverses this: scans are always **user-explicit and foreground**, never background.

Reasons for the change:
- Implicit work on tree expansion is surprising — users don't expect "I clicked to see the journey list" to start a multi-second tenant-wide call pattern.
- Aligns the realm-index cache with the same "lazy, on user click" rule as the resolver cache (D35), keeping the project's cache-invalidation story uniform across the three independent subsystems (per the updated D21).
- Users who never open the Search page never pay for an index build they don't use.

See D36 for the replacement design. The historical text below is kept for context only.

> When a realm node is expanded, the tree populates instantly from `listJourneys` (~1 call). A background worker simultaneously walks every journey's skeleton + reference-bearing node payloads, building an in-memory `RealmIndex` keyed by `(host, realm)`. Measured cost: **~1,060 calls, ~15 s** at concurrency 10 for sb3's 84-journey realm.
>
> Index contains:
> - journey list with skeletons
> - `journey → script` edges
> - `journey → inner-journey` edges
> - (later) `journey → theme`, `script → library-script`, `script → esv`
> - inverted indexes for reverse lookups
>
> In-memory only (per D8). Reload re-pays the scan on next realm-expand.

### D14 — Query panel (SUPERSEDED 2026-05-19 by D36)

**Status: superseded.** D14 originally framed reverse-lookup / orphans / impact as a generic multi-tab panel on top of an already-running RealmIndex. D36 reshapes this into a per-realm **Search page** with three modes (Find usages / By name / Unused), an explicit `Build index` flow, and entry-point pre-fills (header / connection / realm / card portal). The key reframing: D14 treated the panel as a UI on top of an index lifecycle; D36 makes the Search page the *primary surface* for the realm-index data — there is no separate index lifecycle and no other surface that consumes the index.

See D36 for the replacement design. The historical text below is kept for context only.

> Reverse lookup / orphans / impact analysis live on a dedicated query panel (webview), opened via right-click on a realm or a top-bar button. Not inlined as badges in the tree. Same panel hosts all query types as tabs. Driven by the RealmIndex; if index isn't ready, panel shows "indexing… N/total" progress.

### D15 — Webview framework: React + esbuild, introduced at M1

One stack for all webviews (locked in by ReactFlow's React requirement for the graph view). Plain CSS using `--vscode-*` variables; revisit VSCode Elements / Tailwind only if surface grows. Second esbuild entry → `out/webview.js`. Typed message protocol in `src/webview/messages.ts` (discriminated unions, imported by both sides).

**Trigger moved to M1** so the first user-visible milestone already has a real detail panel — that's what makes the slice feel e2e. Connection form rewrite from template strings is *not* coupled to D15; it can stay as-is until it earns a rewrite.

### D16 — Build our own concurrency-capped HTTP foundation

~250 lines total across `src/paic/http.ts`, `src/paic/errors.ts`, `src/paic/pagination.ts`, `src/paic/realm-path.ts`, `src/paic/concurrency.ts`. Borrows ideas from frodo (axios-retry, 429 Retry-After, X-ForgeRock-TransactionId header, scope fallback) without taking frodo as a dependency. **One thing frodo doesn't do that we must:** cap parallelism (frodo `Promise.all`s without limits; we cap at ~10 to avoid stressing customer tenants on 1,000-call scans).

### D17 — Script body: VS Code `FileSystemProvider`, not in-webview renderer

For M2 (and beyond), scripts open in a real VS Code editor tab via a `paic-script://` URI scheme backed by `vscode.FileSystemProvider`. Inspector `ScriptCard` stays metadata-only (id, name, language, outcomes, referenced-by) and exposes an **Open body in editor** action. Read-only is enforced at M2 by `writeFile` throwing `FileSystemError.NoPermissions`.

**Why FileSystemProvider, not TextDocumentContentProvider:** both APIs surface as a real editor tab with full editor features (find, fold, multi-cursor, themes, minimap, language tokenizer). `FileSystemProvider` is the *read-write capable* surface — flipping to edit later is removing a single one-line refusal, not a re-architecture. Same URI scheme, same editor UX, strict superset of capability.

**Why not Monaco-in-webview:** ~1.5 MB bundle hit and a custom save/dirty/diff lifecycle that duplicates what the host editor already gives us for free. **Why not `react-syntax-highlighter`:** display-only — no find, no fold, no minimap, no future edit. Dead end.

**Bonus capabilities for free**, on top of D17's base shape:
- Diff scripts across tenants: `vscode.diff paic-script://tenantA/realm/x.js paic-script://tenantB/realm/x.js`
- Custom hover / code-lens / definition providers attach to any URI scheme — natural insertion point for "find all references" / "go to caller-journey" (M5+)
- Realm-as-folder browsing via `readDirectory` becomes a viable surface (M5+)

URI shape: `paic-script://<host>/<realm>/<scriptId>.<ext>` with `<ext>` ∈ {`js`, `groovy`} so the language-id auto-detects. Retires Q-16.

### D18 — Journey diagram: ReactFlow + dagre at M2

The per-journey node-flow diagram in the inspector renders via **ReactFlow** (graph-as-React-components) with **dagre** for auto-layout. Each AIC node kind has its own custom React node component; M3 expands the set.

**Considered and rejected: Mermaid.** Mermaid's declarative "describe-and-render" model is excellent for static diagrams but closes the door on every node-level interaction the product will plausibly want — hover-for-schema, right-click context menus, click-to-drill-into-referenced-script, custom node shapes per AIC kind, drag-to-rearrange, eventual inline-edit gestures (when D6 lifts). ReactFlow's "node = React component" model is the only one that doesn't paint us into a corner.

**Bundle cost:** ~+200 KB into `out/webview.js` (ReactFlow ~150 + dagre ~50). React + ReactDOM are already paid for. Comfortable.

**Reuse path:** the M6 realm-wide graph (D14 surface) and any M3 widening of node kinds both compose on top of this — same library, same custom-node pattern. Strengthens D15's framework lock.

### D19 — Conditional script-ref pattern: per-type predicate, not boolean type-membership

M1's resolver assumed *"if the node type is X, it has a script ref."* M3 introduces node types where the script ref's presence depends on a flag in the payload: `DeviceMatchNode` carries a script only when `payload.useScript === true`, `PingOneVerifyCompletionDecisionNode` only when `payload.useFilterScript === true`. We codify this as:

```ts
type ScriptRefPredicate = (payload: NodePayload) => boolean;
const SCRIPT_REF_PREDICATES: Record<string, ScriptRefPredicate> = {
  ScriptedDecisionNode: () => true,
  ClientScriptNode: () => true,
  ConfigProviderNode: () => true,
  SocialProviderHandlerNode: () => true,
  SocialProviderHandlerNodeV2: () => true,
  DeviceMatchNode: (p) => p.useScript === true,
  PingOneVerifyCompletionDecisionNode: (p) => p.useFilterScript === true,
};
```

Same table powers the tree's child-discovery, the diagram's click-to-drill, and (later) the RealmIndex's edge build. Lifted from frodo's `scriptedNodesConditions` shape (`ref/frodo-lib/src/ops/JourneyOps.ts:546`); we use ideas, not the library (per D2).

### D20 — Script-body parsing: loose-regex with "declared" semantics

Library-script references (`require('<name>')`) and ESV references live in script-body text, not in node payloads. M3's resolver extracts them via regex over the fetched JS/Groovy body. POC against sb3 (1,159 scripts) refined the original design:

```ts
const REQUIRE = /require\s*\(\s*['"]([^'"\\]+)['"]\s*\)/g;
const ESV     = /['"](esv\.[A-Za-z0-9_.-]+?)['"]/g;
```

**ESV regex rationale (POC-validated, see `poc/FINDINGS-esv.md`):**

- The original `&{esv.X}` syntax is an IDM config-string form, **never used inside JavaScript bodies** (0 hits across 1,159 scripts). Dropped.
- The original `systemEnv.X` syntax captured method names (`"getProperty"`) as false positives 435 times. Dropped.
- The dominant pattern is `systemEnv.getProperty("esv.x.y.z")` (383 scripts, 779 refs). The string literal IS the ESV name in dotted form.
- A broader class of scripts (442 total, 915 refs) declare ESV names as **string-literal config object fields** without calling `getProperty()` in the same body — the actual lookup happens in a downstream library that reads `nodeConfig.<field>`. The broad string-literal regex catches both call patterns and these config declarators.
- All 226 unique ESV refs in sb3 begin with `esv.` — safe to require the prefix.

**Semantics — "declared", not "used at runtime":** the parser reports every `esv.X` string literal that appears in source. This may include dead code or commented-out alternatives. We accept these phantom deps for two reasons: (1) we follow the npm / pip / maven convention of "all declared deps shown, dead-dep detection is a separate tool"; (2) **false negatives are more dangerous than false positives** for a dependency tool — missing a real dep could lead a user to delete an ESV that's actually live in prod.

**Comment stripping** runs before the regex to remove the largest false-positive class (`//` line + `/* */` block comments). Preserves URLs by not stripping `//` after `:`.

**Acorn-AST fallback** still available as Plan B if customers report meaningful false-positives the comment-stripped regex can't handle. Retires Q-13.

### D21 — Three independent cache subsystems (tree-lazy, resolver, realm-index)

Three completely decoupled data subsystems, each owning its own freshness, lifetime, and invalidation rules. None reads from or writes to any other subsystem's cache.

| Layer | Mode | Cache scope | Refresh trigger |
|---|---|---|---|
| **Tree / inspector — Direct view** | Lazy, always-fresh | Per-expansion, throwaway | Each tree expansion fetches fresh |
| **Resolver cache** (D35) | Lazy, on user click | Per-root: `{host, realm, kind, id}` | Per-card refresh + sidebar refresh + `registry.onDidChange` |
| **Realm index** (D36) | Lazy, on user click | Per realm: `{host, realm}` | `Rescan realm` button + `registry.onDidChange` (sidebar refresh deliberately does NOT clear it — see D36) |

Rationale:
- **Tree Direct view** = "show what's there *right now*" → freshness wins; never serves from a cache.
- **Resolver cache** = "the full forward dep truth for one root" → reused across Full/Flat toggles on the inspector card. Per D35.
- **Realm index** = "everything in this realm, inverted for reverse-lookup queries" → reused across Search-page queries. Per D36.

The three caches **never share state.** The realm index never serves the tree or the resolver. The resolver cache never feeds the realm index. Coupling any two would make refresh behavior unpredictable and break the per-subsystem invalidation contracts.

Within the tree's lazy model, **per-expansion eager batching is allowed** (and used for ESV kind pre-labeling, see D22). That batching is scoped to one expansion event, fetched fresh, discarded on refresh — it does not leak into the other two subsystems.

**Enforcement — five mechanisms:**

1. **Physical layering.** Each subsystem lives in its own directory; all three sit on top of `src/paic/` (the only shared dependency):
   ```
   src/paic/         ← HTTP + auth substrate (no caches live here)
   src/resolver/     ← resolver cache (D35), per-root forward graphs
   src/realm-index/  ← realm index (D36), per realm inverted index
   src/views/        ← tree (lazy expand cache)
   src/webview/      ← UI; never reads cache state directly
   ```

2. **Import-direction rule** (codified in `conventions.md`):
   - `src/resolver/*` and `src/realm-index/*` may import from `src/paic/*`, `src/domain/*`, `src/util/*` only. Neither imports the other; neither imports `src/views/*`, `src/webview/*`, or `src/tenants/*`.
   - `src/views/*` may NOT import from `src/resolver/*` or `src/realm-index/*`.
   - **`src/webview/<surface>/ui/*` (the React runtime sandbox)** must NOT import from `src/resolver/*`, `src/realm-index/*`, `src/tenants/*`, or `src/paic/*`. UI talks to the extension via `postMessage` only.
   - **`src/webview/<surface>/panel.ts` files** (the extension-side wiring shim) MAY import from any layer — they are the bridge between UI and caches.

3. **Independent invalidation subscriptions.** Both `src/resolver/cache.ts` and `src/realm-index/cache.ts` subscribe to `registry.onDidChange` directly. Neither calls into the other; neither queries the other for state.

4. **Boundary test** (`tests/architecture/layer-boundaries.test.ts`). Vitest scans the source tree for forbidden imports and fails the build on violation. This is the load-bearing enforcement — convention docs drift, tests don't. Implementation sketch:

   ```ts
   const forbidden: Array<[string, RegExp]> = [
     ["src/realm-index", /from\s+["'](@\/|\.\.?\/)(views|resolver|webview|tenants)/],
     ["src/resolver",    /from\s+["'](@\/|\.\.?\/)(views|realm-index|webview|tenants)/],
     ["src/views",       /from\s+["'](@\/|\.\.?\/)(realm-index|resolver)/],
     ["src/webview",     /from\s+["'](@\/|\.\.?\/)(realm-index|resolver)/],
   ];
   ```

5. **Naming conventions.** Resolver exports `Resolved*` (`ResolvedGraph`, `ResolverCache`); realm-index exports `RealmIndex*` (`RealmIndexEntry`, `RealmIndexCache`, `ReverseRef`). Cross-layer imports show up in PR diffs immediately, before the boundary test even runs.

The boundary test is the load-bearing enforcement; the rest make violations obvious in code review.

### D22 — ESV resolution: REST id translation, kind pre-labeling, card field set

Three locked aspects of ESV handling (validated against sb3 — see `poc/FINDINGS-esv.md`):

**1. Dotted ↔ hyphenated id translation.** Scripts reference ESVs in dotted form (`esv.kyid.portal.name`); the PAIC REST API requires hyphenated ids (`esv-kyid-portal-name`). The dotted form returns 400; only hyphenated returns 200. Translation lives inside `PaicClient.getEsv()` and the resolver-side list-then-filter; the dotted form remains the canonical display name everywhere else.

**2. Per-script-expansion kind pre-labeling.** When a `ScriptNode` expansion emits any `EsvNode`, the tree fires `listVariables(realm)` + `listSecrets(realm)` once per expansion to label each emitted node as `variable` / `secret` / `missing`. This is "small eager" inside the otherwise-lazy tree (per D21 — scoped to the expansion event, not shared with back-search). Tree icons differ by kind (variable vs secret vs `?` for missing). Cost: 2 list calls per script-expand; ESV lists are small (sb3 had 409 vars + 58 secrets — a few KB each paged). Missing entries stay in the tree with a "Not found in tenant" hint — we can't always distinguish a regex false-positive from a recently-deleted ESV.

**3. Card field set.** EsvCard renders the full REST-returned metadata for each kind. ESV variables are **not secrets**; decode `valueBase64` and display in the card.

| Field | Variable card | Secret card |
|---|---|---|
| Host / Realm / Name | ✓ | ✓ |
| Kind ("Variable" / "Secret") | ✓ | ✓ |
| Description | ✓ | ✓ |
| `expressionType` | ✓ (`string` / `int` / `bool` / `list` / `object`) | — |
| `encoding` | — | ✓ (`generic` / `pem` / `base64hmac` / `base64aes` / …) |
| Decoded value | ✓ (UTF-8 decode of `valueBase64`; `<code>` block + Copy button) | — (API never returns the value) |
| `activeVersion` / `loadedVersion` | — | ✓ |
| `useInPlaceholders` | — | ✓ |
| `loaded` | ✓ ("Yes (live)" / "No (staged)") | ✓ |
| `lastChangeDate` / `lastChangedBy` | ✓ | ✓ |

Value decoding (webview-side, no `Buffer`):

```ts
function decodeEsvValue(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
```

Display the decoded string as-is regardless of `expressionType` — users interpret per type. No pretty-print / coercion at M3; JSON pretty-print on `list`/`object` is a future polish if requested.

### D23 — Inspector card field policy: surface raw values, skip when undefined

Cards display fields from the PAIC REST response as-is, with these conventions:

- **Booleans render as raw `true` / `false`** — no humanization. Audit + grep friendly; the field names (`innerTreeOnly`, `useScript`, etc.) are AIC-developer-recognized terms.
- **Undefined values skip the row.** Matches existing behavior for `description` / `identityResource`. We don't render `"—"` or `"(unset)"` placeholders. In practice all the always-present fields come back from PAIC; the skip is a defensive fallback for stale/mocked/older-tenant responses.
- **Field selection is deliberate, not exhaustive.** Each card surfaces fields a developer needs in the moment — identity, status, audit (last-modified), and dependency-graph-relevant flags. We intentionally skip wire-shape noise (`_rev`, `staticNodes`, `uiConfig`, branding sub-styles, account-page-only colors).
- **`script.context` is a key signal.** It declares which subsystem invokes the script (`AUTHENTICATION_TREE_DECISION_NODE` for journey scripts, `LIBRARY` for required modules, plus ~20 specialized OAuth/SAML/OIDC contexts). Always shown when defined — useful for sanity-checking a script's placement in the graph.
- **Audit trail uses last-modified, not created.** `lastModifiedBy` + `lastModifiedDate` cover the common audit question ("who touched this most recently?"). `createdBy` + `creationDate` are redundant for our purposes and not surfaced.

Locked per-card field sets:

| Card | Always shown (when defined) |
|---|---|
| **JourneyCard / InnerJourneyCard** | id, host, realm, enabled, description, identityResource, entryNodeId, node count, `innerTreeOnly`, `noSession`, `mustRun`, `transactionalOnly` |
| **ScriptCard** | name/id, host, realm, language, `context`, `description`, `default`, `evaluatorVersion`, `lastModifiedBy`, `lastModifiedDate`, Open-body action, deps block |
| **ThemeCard** | id, host, realm, name, isDefault, journeyLayout, fontFamily, primaryColor (swatch), backgroundColor (swatch), backgroundImage, logo image, linkedTrees |
| **EmailTemplateCard** | name, host, realm, enabled, displayName, description, defaultLocale, mimeType, from, per-locale subjects, per-locale Open-body buttons |
| **EsvCard** | name, host, realm, kind, expressionType / encoding, description, value (variables only — decoded), loaded, lastChangeDate, lastChangedBy, version fields (secrets only), useInPlaceholders (secrets only) |

### D24 — Every "show a card" gesture opens a fresh tab; no panel reuse

Every action that displays an inspector card opens a **new independent `WebviewPanel`**. Existing tabs are never touched. The user accumulates tabs as they explore and manages them with VS Code's normal tab UI (close, pin, drag-to-new-window).

| User gesture | What happens |
|---|---|
| **Tree click** (sidebar tree node) | New tab beside the editor with the clicked node's card |
| **Card hyperlink click** (deps-list link inside any card) | New tab with the target's card |
| **Diagram node click** | New tab with the target's card |
| **"Open body" buttons** (ScriptCard, EmailTemplateCard per-locale) | Editor tab via the FS providers (`paic-script://`, `paic-email-template://`) — unchanged |

Rationale: a user inspecting a journey wants to fan out into its referenced scripts / inner journeys / themes / etc. without losing the source view. Replacing the current tab on every click destroys the comparison context. Spawning a new tab per click preserves history, lets users compare side-by-side via VS Code's drag-tab UX, and aligns with how developers already use editor tabs.

Implementation collapses `InspectorPanel` + `DiagramPreviewPanel` into a single `InspectorTab` class — one card per instance, one webview per instance, no reuse. An extension-level factory tracks active tabs for clean dispose on extension deactivation. Each tab loads its own copy of the React bundle (~850 KB); ~8 MB across 10 tabs is acceptable cost for the UX win.

`ThemeCard.linkedTrees` remains **NOT** clickable. The 18-journey list inside a theme is informational only — clicking would require materializing a JourneyCard from just an ID, but our tree is lazy (no global journey-by-id index). That kind of "jump anywhere by id" lookup is a back-search (M5) capability, not an inspector feature.

The `W2E.navigate` message is **removed** — no UI surface posts it after this change, and the previous "treeView.reveal + show" semantics no longer fit the new-tab-each-time model. Explicit "Reveal in tree" actions, if needed later, will be a new command (right-click → "Reveal in tree"), not a reused message type.

### D25 — Hide the platform root realm from the tree

PAIC's `GET /am/json/global-config/realms` returns the platform root realm alongside `alpha` and `bravo`, but tenant service accounts always get **403** on its journey/script endpoints. Showing it would train users to ignore failure states on tree expansion — the opposite of what we want when real failures occur.

The wire identifier for the root realm is `parentPath === null` (or absent), not the name. Different AIC deployments report the root's name as `"/"`, `"root"`, or `"Top Level Realm"` — name-based filtering is fragile. The `Realm` domain type carries an `isRoot: boolean` set by the mapper (`raw.parentPath == null`), and `ConnectionNode.loadChildren` filters `!r.isRoot && r.name !== "/"` (belt-and-suspenders for variants that report the name as `"/"` with a non-null parentPath).

The filter lives in the view layer, not the data layer: `client.listRealms()` stays a faithful translation of the wire response (D11), `isRoot` is a derived domain flag. If on-prem AM support is added later, the `Connection` type grows a discriminator (`paic` vs `am-onprem`) and the filter becomes conditional on `connection.type === "paic"`.

### D26 — Diagram layout: left-to-right dagre, non-persistent node dragging

**Direction: left-to-right (`rankdir: "LR"`).** AIC journeys read as authentication *flows* — entry on the left, outcomes on the right. Top-to-bottom layouts grow vertically fast (sb3's `kyid_2B1_MasterLogin` has ~30 nodes and scrolls forever) and don't match the mental model of "flow from start to end." AIC's own admin UI uses LR for the same reason. The change is a single field flip in `layout.ts`; node-anchor handles continue to use ReactFlow defaults (dagre routes edges to handle positions automatically).

**Algorithm: stay on dagre.** Dagre is the standard Sugiyama-style hierarchical layout (layer-assign → crossing-minimize → coordinate-assign). It's deterministic, runs in <10ms for journeys we've seen, and is what PingHub's pipeline diagram + most DAG viewers use. Tune knobs before switching libraries:

| Knob | Today | LR target |
|---|---|---|
| `rankdir` | `TB` | `LR` |
| `ranksep` (between-layer gap) | 48 | 70 (room for edge labels in LR) |
| `nodesep` (within-layer gap) | 30 | 30 (unchanged) |
| `ranker` | default (`network-simplex`) | unchanged — switch to `tight-tree` only if narrow journeys look bad |

**Alternatives considered + rejected (for now):**
- **ELK** — more layout strategies and real orthogonal edge routing. ~700 KB dep, async API. Worth revisiting if dagre's edge crossings get noisy on real customer journeys with many cycles. Not a today problem.
- **cytoscape + cose-bilkent** (force-directed) — wrong fit. Journeys are hierarchies, not hairballs.

**Node dragging: enabled, NOT persisted.** Flip `nodesDraggable={true}` and back it with ReactFlow's `useNodesState` so positions are owned in component state, not recomputed every render. Drag positions live for the lifetime of the inspector tab and die when the tab closes. No settings, no message protocol, no persistence layer.

Why not save positions? (a) Every "show a card" gesture spawns a fresh tab per D24 — there is no stable "this is the journey diagram" surface to attach saved positions to. (b) Persistence would force a key choice (per-host? per-realm? per-journey?) and an eviction strategy we don't need to make now. (c) The use case is "rearrange a bit to see something clearly," not "design a layout." Ephemeral drag covers that.

### D27 — Webview theming: VS Code semantic CSS variables, never hardcoded colors

The inspector webviews must work in any VS Code theme — default dark, default light, GitHub themes, Solarized, Dracula, and the two high-contrast themes. VS Code injects ~150 `--vscode-<area>-<purpose>` CSS custom properties into every webview that remap automatically when the user switches themes. Using them is free theme support; ignoring them is a recurring bug factory.

**Rules:**
1. **Never hardcode a color** in webview CSS. Inline `var(--vscode-*, #fallback)` is fine — the fallback hex is a safety net for unknown themes, not the actual color we expect. Existing chart-color fallbacks (`var(--vscode-charts-purple, #b180d7)`) are the model.
2. **Never rely on background-contrast alone** for shape definition. High-contrast themes flatten background differences — always pair `background` with a `border` so cards stay readable.
3. **Use semantic variables** (table below), not the most-similar-looking one. Don't reach for `--vscode-editor-background` when the surface is actually a raised panel; reach for `--vscode-editorWidget-background`.
4. **Override ReactFlow's defaults.** ReactFlow ships its own CSS with hardcoded grays for edges, controls, minimap, and the background-dot pattern. Override all of these to point at VS Code vars so they follow the theme.
5. **Provide a focus ring** (`outline: 2px solid var(--vscode-focusBorder)` on `:focus-visible`) on every interactive element. Required for keyboard a11y and shows clearly in every theme including high contrast.

**Semantic variable cheat sheet** (canonical use across all webview cards + diagram):

| Purpose | Variable |
|---|---|
| Page background (the canvas behind cards) | `--vscode-editor-background` |
| Card / raised surface (hover popups, peek widgets, our diagram nodes) | `--vscode-editorWidget-background` |
| Default body text | `--vscode-foreground` |
| Dimmed / secondary text (IDs under names, captions) | `--vscode-descriptionForeground` |
| Hyperlinks | `--vscode-textLink-foreground` / `--vscode-textLink-activeForeground` |
| Borders, dividers | `--vscode-panel-border` (fallback `--vscode-editorWidget-border`) |
| Inline `<code>` background | `--vscode-textBlockQuote-background` |
| Inputs | `--vscode-input-background` / `--input-foreground` / `--input-border` |
| Primary buttons | `--vscode-button-background` / `--button-foreground` / `--button-hoverBackground` |
| Secondary buttons | `--vscode-button-secondaryBackground` / `--secondaryForeground` |
| Per-kind accents (script/inner/page/email/etc.) | `--vscode-charts-{red\|orange\|yellow\|green\|blue\|purple\|foreground}` |
| Focus ring | `--vscode-focusBorder` |
| Error text | `--vscode-errorForeground` |
| Warning text | `--vscode-editorWarning-foreground` |
| Code-block font | `--vscode-editor-font-family` / `--vscode-editor-font-size` |

**Acid test:** if the webview looks right in **Default High Contrast Dark** (`Ctrl+K Ctrl+T` → "Default High Contrast"), it'll look right in every theme. Pure-black background + pure-white text strips away all subtle gray contrast, forcing the layout to stand on real borders + semantic colors.

### D28 — Synthesize platform-fixed terminal nodes (Start, Success, Failure)

AIC journeys begin and end at three platform-fixed nodes that appear under `staticNodes` on the wire. They are **NOT** in the journey's `nodes` map — the platform treats them as implicit. IDs verified against frodo-lib captures and live AIC payloads:

| Terminal | Stable ID | nodeType | Direction |
|---|---|---|---|
| Start | `"startNode"` (literal string) | `StartNode` | Source only (no inbound) |
| Success | `70e691a5-1e33-4ac3-a356-e7b6d60d92e0` | `SuccessNode` | Sink only (no outbound) |
| Failure | `e301438c-0bd0-429c-ab0c-66126501069a` | `FailureNode` | Sink only (no outbound) |

Without synthesis, AIC's admin-UI-like flow ("Start → entry → … → Success/Failure") is broken in three ways: (a) no visual Start pill on the left, (b) edges to Success/Failure get dropped by the orphan-target guard, (c) `ScriptedDecisionNode` with `{ Success: <succID>, Failure: <failID>, Locked: "node-X" }` would render only the `Locked` edge — visually a journey "with no end."

**Three-part fix:**

1. **Always synthesize the Start node** when the journey has a valid `entryNodeId` (i.e. `journey.nodes[entryNodeId]` exists). Adds an implicit edge `startNode → entryNodeId` labeled `"start"`. The Start view has only a source handle (right side).
2. **Synthesize Success/Failure on demand** when at least one real edge points to either ID. Each gets a target handle (left side) and no source handle.
3. **Stop dropping their edges.** Replace the absent-target guard with: drop only if the target is neither in `journey.nodes` nor one of the two output-terminal IDs. Start's edge is added explicitly above.

**Three node views:**

- `StartNodeView` — blue stripe (`var(--vscode-charts-blue, #4f8cc9)`), label "Start", source handle right
- `SuccessNodeView` — green stripe (`var(--vscode-charts-green, #6c9b34)`), label "Success", target handle left
- `FailureNodeView` — red stripe (`var(--vscode-charts-red, #c93636)`), label "Failure", target handle left

All three follow the same `.diag-node` shape as other kinds (consistent visual language) but are non-clickable (no `info.uid` — there's nothing to inspect, they're platform constants). Hover tooltip: "Platform terminal — every AIC journey begins/ends here."

**Pinning positions** is not needed for horizontal placement — in LR with dagre's default `network-simplex` ranker, Start (no inbound edges) naturally lands in the leftmost layer and Success/Failure (no outbound edges) naturally land in the rightmost layer.

**Vertical pinning** *is* applied: after `dagre.layout()` runs, we recompute the y-midpoint of all real journey nodes (`(min_y + max_y) / 2`) and override each terminal's y to that value. Without this, dagre places terminals wherever the algorithm finds room — often offset from the visual center, which makes simple journeys look lopsided. Anchoring all three terminals to the same y also makes the flow's entry/exit symmetric and predictable.

**Only Start is undraggable.** It anchors the leftmost-vertical-center of every flow. Success and Failure can be dragged like real nodes — users may want to rearrange them to keep adjacent outcomes visually together. `JourneyDiagram` carries `NON_DRAGGABLE = new Set([START_NODE_ID])` and applies `draggable: false` only to that one node.

**Color palette discipline.** Per D27 the diagram uses VS Code chart/terminal colors. **Blue / green / red are now reserved exclusively for the three terminals** (Start / Success / Failure). Real journey nodes draw from the rest of the palette: purple (script family), orange (Page), yellow (Email), cyan (Inner Journey / DeviceMatch), magenta (Social IdP / SelectIdP / PingOne Verify), and gray (Other fallback). This avoids confusion where, e.g., a red `social` stripe could look like a Failure terminal at a glance.

**No separate entry-node marker.** Earlier the entry node carried a thin blue `outline` to mark "the flow starts here." With Start synthesized as a dedicated visual terminal (always present per D28), that secondary marker is redundant and was removed. The `isEntry` flag still drives the hover-tooltip "(entry)" suffix in `buildNodeTooltip` — useful textual context that doesn't compete visually.

### D34 — Migrate the connection form from raw HTML to a separate React bundle

The connection form (`openConnectionForm` — used by the Add Connection / Edit Connection commands) is the lone remaining webview that emits raw HTML strings + inline JavaScript via a hand-built `renderHtml()`. ~320 lines of template string with embedded `<style>` + `<script>` and ad-hoc `document.getElementById(...)` wiring. Every other webview surface in the project (inspector cards, diagram panels) is React, lives under `src/webview/`, and gets built into `out/webview.js` by a dedicated esbuild target.

Migrate the connection form to follow the same pattern, but as **a separate React bundle** rather than expanding `out/webview.js`. The form has its own lifecycle (modal-style dialog returning a `Promise<ConnectionFormData | undefined>`), its own message protocol (Test Connection roundtrip with request ids), and zero overlap with inspector data models. Mixing it into the inspector bundle bloats that surface with code the user only hits when adding/editing a connection.

The pattern also matches what's already anticipated in CLAUDE.md: *"M5/M6 will add query + graph panels reusing the same framework."* Adding a third React surface (the form) now establishes the "one bundle per panel" convention before we have to repeat the work for query + graph.

**Final shape:**

```
src/webview/connection-form/
├── panel.ts          ← extension-side openConnectionForm()
├── messages.ts       ← typed W2E / E2W protocol
└── ui/
    ├── main.tsx      ← React entry; reads data-paic-payload; mounts <App>
    └── App.tsx       ← form state, validation, message-posting
```

**esbuild target.** A new `build:connection-form` script bundles `src/webview/connection-form/ui/main.tsx` → `out/connection-form.js`. The parent `build` runs all three (ext + webview + connection-form). Same flags as the inspector webview (`--platform=browser --format=iife --jsx=automatic`).

**API stays identical.** `openConnectionForm(context, opts) → Promise<ConnectionFormData | undefined>` is preserved. Its body is what changes — from "render a 320-line HTML template" to "create a WebviewPanel that loads `out/connection-form.js` with an embedded `data-paic-payload`, then resolve the returned promise on the next `save` or `cancel` message from the React app." Callers (`commands/add-connection.ts`, `commands/edit-connection.ts`) need zero updates.

**File moves.** `src/views/connection-form.ts` is deleted; the new home is `src/webview/connection-form/panel.ts`. Import paths in the two command files get a one-line update each (`../views/connection-form` → `../webview/connection-form/panel`).

**Messages** mirror the inspector's protocol style — W2E + E2W typed unions with discriminant `type`:

```ts
export type W2E =
  | { type: "save"; data: ConnectionFormData }
  | { type: "cancel" }
  | { type: "validate"; data: ConnectionFormData; requestId: number };

export type E2W = { type: "validateResult"; requestId: number } & (
  | { ok: true; expiresIn: number; droppedScopes: string[] }
  | { ok: false; message: string }
);
```

Initial payload (mode + initial values + existingHosts) is embedded in the page via a `data-paic-payload` attribute on the mount div — same trick the inspector uses — so we don't need an `init` message at all.

**Test plan.** New `tests/webview/connection-form/ui/` directory with happy-dom + React Testing Library tests for the form:
- Required-field validation surfaces error text
- Duplicate-host detection in Add mode
- JWK-optional in Edit mode
- Save button posts the typed save message
- Cancel button posts cancel
- Test Connection button shows pending → ok / error state from the `validateResult` message

**What stays the same:**

- `handleValidate` (mint token via `paic/auth`, log success/failure) — stays in the extension-side `panel.ts` unchanged. The webview never touches `axios` / `jose` (D2 / D27).
- CSP shape (`script-src 'nonce-...'`, no remote anything), `localResourceRoots` (now includes `out/` so the bundle loads).
- `SecretStorage` flow: webview never receives the existing JWK; `handleValidate` looks it up extension-side via `getExistingJwk`.

**What does NOT migrate (out of scope for D34):**

- The two command files (`add-connection`, `edit-connection`) — their `openConnectionForm()` calls are unchanged.
- The `tenants/registry.ts` save/edit logic.

### D35 — Inspector dependency view: three modes (Direct / Full tree / Flat) + per-root resolver cache

The inspector card's "Dependencies" section grows from M2's level-1-only view into three explicit modes via a segmented control:

| Mode | Behavior | Resolver work |
|---|---|---|
| **Direct** (default) | Renders the level-1 deps that journey/script expansion already computed | None — no resolver call |
| **Full tree** | Transitive tree to leaves. Repeated subtrees collapse to a single `(dup)` marker. Footer shows cycle count, max depth, resolve duration | First click triggers one resolver run |
| **Flat** | Deduplicated unique-node list. One row per distinct dep, annotated with ref-count and depth set | Free after Full has run |

Full and Flat share the **same in-memory result** — toggling between them after the first resolve is free. Direct never triggers a resolver call. Every row's name is a hyperlink that routes through the same selection plumbing the sidebar uses; clicking opens the target's card in a new tab per D24. The section header always shows `N unique · M refs` so the user has a sense of scale before they expand.

**Mockup** (Login journey):

```
Dependencies     ( • Direct )  ( ○ Full tree )  ( ○ Flat )    7 unique · 9 refs

Direct:
├─ Inner Journey   sub-login-mfa            →
├─ Script          email-validator          →
├─ Library Script  helpers                  →
├─ ESV             API_KEY                  →
└─ Theme           corporate                →

Full tree:
├─ Inner Journey   sub-login-mfa                    →
│   ├─ Script          mfa-decision                 →
│   │   └─ Library Script  helpers                  →  (dup)
│   └─ ESV             MFA_SECRET                   →
├─ Script          email-validator                  →
│   └─ Library Script  helpers                      →  (dup)
├─ Library Script  helpers                          →
├─ ESV             API_KEY                          →
└─ Theme           corporate                        →
Cycles: none  ·  Depth: 3  ·  Resolved in 412 ms

Flat:
Inner Journey   sub-login-mfa          →  1 ref   (depth 1)
Script          mfa-decision           →  1 ref   (depth 2)
Script          email-validator        →  1 ref   (depth 1)
Library Script  helpers                →  3 refs  (depth 1,2,3)
ESV             API_KEY                →  1 ref   (depth 1)
ESV             MFA_SECRET             →  1 ref   (depth 2)
Theme           corporate              →  1 ref   (depth 1)
```

**Resolver cache** (lives in `src/resolver/`, isolated per D21):

- **Key:** `{host, realm, kind, id}` — root node identity scoped by connection. `kind ∈ {journey, innerJourney, script, libraryScript}`.
- **Population:** lazy. First Full/Flat click for a given root builds the entry. Direct view never populates.
- **Lifetime:** in-memory, session-scoped. Cleared on `deactivate()`.

Invalidation:

| Trigger | Scope cleared |
|---|---|
| Per-card refresh button | One entry — just that root |
| Sidebar tree refresh on the connection | Every entry under that host |
| Connection edited or removed (`registry.onDidChange`) | Every entry under that host |
| Session end | Everything |

**Not** invalidated by: opening another card, toggling Direct/Full/Flat, re-opening the same root, token expiry (orthogonal — `PaicClient`'s concern).

**Per-card refresh button** lives on the card header next to `[↗ open]`. Visible only after a Full or Flat resolve has happened for that card (no cache to refresh otherwise). Clearing scope is just the one root — the surgical equivalent of the sidebar's connection-wide refresh.

**Implementation order:**
1. `src/resolver/walk.ts` — pure graph builder over `PaicClient`. Returns `{nodes, edges, depth, cycles, durationMs}`. Cycles detected and broken; edges to the cycle target carry a `cycle` marker.
2. `src/resolver/cache.ts` — keyed map + invalidation API + `registry.onDidChange` subscription.
3. Inspector protocol additions (`resolveFull` / `resolveResult` / `refreshResolved` in `src/webview/messages.ts`).
4. Card UI changes — segmented control + Full/Flat render + per-card refresh button on Journey/InnerJourney/Script/LibraryScript cards.
5. Sidebar refresh path (`paicJourneys.refresh` + per-row `refreshNode`) also calls `resolverCache.dropAllForHost(host)`.
6. Tests — `src/resolver/walk.test.ts` (fixtures with inner tree, library script, ScriptedDecisionNode, PageNode, cycle), `src/resolver/cache.test.ts`, inspector UI tests for the three modes + refresh-button visibility.

### D36 — Standalone Search page (reverse-dep + name + orphans) + realm index

Reverse-dependency lookups, name search, and dead-code detection live on their own webview surface, **not** inside the inspector card. Backed by a per-realm index that is **lazy**, **user-explicit**, and **isolated** from every other cache in the codebase per D21.

This decision **supersedes D13** (RealmIndex background scan on realm-expand) and **D14** (generic multi-tab query panel). No data fetches on realm-expand; every Search page action waits for explicit user intent.

**Three query modes** (segmented control, mutually exclusive):

| Mode | Question answered |
|---|---|
| **Find usages** | Which journeys reference this entity? |
| **By name** | Substring/glob match across selected kinds |
| **Unused / dead code** | Orphans — entities with 0 inbound references in this realm |

**Entry points** (each pre-fills more of the query as scope narrows):

| Trigger | Pre-fill |
|---|---|
| Sidebar title-bar 🔍 icon (next to `+`) | nothing |
| Right-click connection → "Search…" | connection |
| Right-click realm → "Search…" | connection + realm |
| Card portal `[🔍 find usages]` button | connection + realm + query |

**Singleton Search page (AMENDED 2026-05-19).** The original spec said "single instance per `(host, realm)`" — one tab per realm. That was reversed during M5 implementation: the Search page now picks its `(host, realm)` via **two in-page dropdowns** (Connection + Realm) rather than a pre-open QuickPick. Once the realm is a dropdown *inside* the page, per-realm tabs are incoherent (two tabs could both show `alpha`). So there is exactly **one Search tab, period** — re-invoking any entry point focuses the existing tab and re-seeds its dropdowns.

The entry points become pre-selection of those dropdowns rather than pre-keyed tabs:

| Trigger | Pre-fills |
|---|---|
| Sidebar title-bar 🔍 icon | nothing — both dropdowns empty |
| Right-click connection → "Search…" | connection dropdown auto-selected |
| Right-click realm → "Search…" | both dropdowns auto-selected |
| Card portal `[🔍 Find usages]` button | both dropdowns + query prefill (auto-runs) |

The page's cache-status header, query controls, and results render only **after both dropdowns are set**, driven by `realmIndexCache.peek(host, realm)`. Realm lists are fetched on demand per connection (a `listRealms` round-trip) when the connection dropdown changes; the connection list ships in the embedded payload. Because the selection lives in the webview, every host/realm-scoped `W2E` message carries `host` + `realm` explicitly and the extension-side panel is stateless w.r.t. the current selection; result `E2W` messages echo `host` + `realm` so the React app can drop stale replies after a mid-flight dropdown change.

**Lazy execution contract — no background work ever:**

- Opening the Search page never triggers a scan.
- After selecting connection + realm, the page shows cache status and stops. Empty state shows `[ Build index ]`; built state shows stamp + `[ ↻ Rescan ]`.
- A queued query from the card portal is parked in the input box until the user clicks `Build index` (if needed). After the index builds, the held query auto-runs.

**Page layout sketch:**

```
🔍 Search — alpha @ openam-tenant.example.forgeblocks.com         [× close]
─────────────────────────────────────────────────────────────────────────────
Realm index:  142 journeys · 87 scripts · 23 ESVs · 4 themes · 12 lib scripts
Last scan:    3m 12s ago                            [↻ Rescan realm]
─────────────────────────────────────────────────────────────────────────────
Query mode:   ( • Find usages )  ( ○ By name )  ( ○ Unused / dead code )

Find what references:
  Kind:    [ Script ▾ ]
  Name:    [ email-validator                                           ▾ ]
  Id:      00000000-0000-0000-0000-000000000004
                                                          [ Search ]
─────────────────────────────────────────────────────────────────────────────
Results — 4 references
  Journey         Login                       →  direct script ref
  Journey         Login-MFA                   →  direct script ref
  Inner Journey   sub-registration-verify     →  PageNode → script ref
  Inner Journey   sub-password-reset          →  direct script ref
```

**Realm index** (`src/realm-index/`):

- **Key:** `{host, realm}`. One entry per (connection, realm) pair.
- **Value shape:** `entities` (per-kind id→summary maps), `inboundRefs` (entity-key → list of `{fromKind, fromId, via}` references), `nameIndex` (lowercased substring → entity keys, for By-name mode), `builtAt`, `scanDurationMs`.
- **Population:** explicit. `Build index` / `Rescan` click only.
- **Lifetime:** in-memory, session-scoped.

Invalidation:

| Trigger | Scope cleared |
|---|---|
| `Rescan realm` button | One entry — that `(host, realm)` |
| Connection edited/removed (`registry.onDidChange`) | Every entry under that host |
| Session end | Everything |
| **Sidebar tree refresh** | **NOT cleared** — rebuilding a realm index is a 10-second-class operation and shouldn't be silently triggered. Users opt in via `Rescan` |

**Build concurrency (AMENDED 2026-05-19).** A realm-index build is the project's heaviest call pattern (sb3 `alpha`: ~2,300 HTTP calls). The original `buildRealmIndex` used a per-phase `mapConcurrent(…, 10)` at each fan-out point — but those fan-outs *nest* (`scanJourney` runs 10-wide, and each `scanJourney` fans out `getNode` 10-wide), so total in-flight burst to ~80 concurrent. That both stressed the tenant (against D16's "cap at ~10 … on 1,000-call scans") and inflated per-call latency via server-side queuing.

The build now uses **one shared concurrency limiter per build invocation** — `makeLimiter(10)` (`src/paic/concurrency.ts`), created fresh inside each `buildRealmIndex` call and threaded through every `PaicClient` call in every phase. Total in-flight is a true 10, matching the tree and resolver. The limiter is a **per-build instance** — it is never shared with the tree-lazy cache or the resolver cache, so D21's three-independent-subsystems rule is preserved (a build's concurrency budget does not interact with concurrent tree expansions).

The script-body phase additionally batches its `require()` library-name lookups **layer-wide** (collect every name across a BFS layer → dedupe → one parallel batch) rather than the original per-script serial loop, which had collapsed effective concurrency to ~4. See the `docs/lessons.md` 2026-05-19 entry.

Measured on sb3 `alpha`: **108.5 s → 67.8 s**, getNode per-call latency 2,485 ms → 334 ms (true cap-10, no longer overwhelming the tenant). Two adjacent phases also overlap: the tenant ESV-index fetch runs alongside `listJourneys`, and `listThemes` + `listSocialIdps` run alongside the script-body BFS (the phases touch disjoint slices of the shared `BuildState` maps, and JS's single-threaded model means the synchronous `materializeEntity` / `addEdge` writes never tear).

**Build progress reporting.** A realm-index build is a ~70 s foreground operation, so the Search page shows live progress rather than a static "Building…" string. `buildRealmIndex` takes an optional `onProgress(p: BuildProgress)` callback; `BuildProgress` is `{ phase: "preparing" | "journeys" | "scripts" | "finishing"; done?: number; total?: number }`. **Both long phases are determinate and report a unified `done` / `total`**: the journey scan's `total` is the (fixed, known) journey count; the script-BFS scan's `total` is the count of distinct scripts the BFS has *enqueued so far* — it seeds with the journey-referenced frontier and grows as deeper layers surface library scripts, so `done` always chases `total` and the phase ends cleanly at `N / N` (same `X / Y` label shape as journeys). The extension-side panel **coalesces** these (an immediate post on every phase change, otherwise throttled to ~5 Hz — not one message per journey/script) into a `buildProgress` E2W message. The Search webview renders a **progress bar + phase label + percentage** — e.g. `Scanning journeys — 87 / 142` / `Resolving scripts — 300 / 540`, with a filled bar. The percentage spans four contiguous, monotonically-increasing bands (preparing 0–5 %, journeys 5–78 %, scripts 78–98 %, finishing 98–100 %); each determinate phase interpolates within its band. Because the script `total` grows, the raw ratio can dip a hair at a BFS-layer boundary — so the webview also **clamps the displayed percentage monotonically** (a progress bar never retreats). The result advances smoothly start to finish.

**Result rows** are **kind-grouped** under `── <Kind> (N) ──` divider headers with codicons, alphabetical within kind — the same vocabulary as the inspector cards + sidebar tree. Clicking a row opens the target's card via the same selection plumbing the sidebar uses.

**Find-usages results have two views (a `List | Tree` toggle).** *List* is the kind-grouped one-hop view above — the entities that directly reference the target. *Tree* renders `findUsagePaths` — the slice of the realm's forward dependency graph from every journey (or orphan) root down to the searched target, which is the leaf of every branch. It answers the project's actual question ("which journey, through what chain, reaches this entity?") rather than just "who references it." The tree is a pure derivation of `RealmIndexEntry.inboundRefs`: reverse-reachability BFS from the target → relevant ancestor set → relevant-restricted forward adjacency → roots (non-journey roots flagged `orphanRoot` — the target is kept alive only by dead code) → forward DFS render. The DFS uses a **per-path** visited set, so each root renders as its own complete part-tree and every branch ends at the target; `(dup)` collapsing is reserved for true cycles (a node already on the current path) — see D37. `UsagePathNode` / `UsagePaths` live in `src/domain/realm-index.ts`; the tree ships in the `queryResult` message alongside the flat `refs` (cheap to compute, so the toggle needs no extra round-trip).

**VS Code surface constraints:**
- Title-bar icon is `$(search)` against the view's `view/title` menu, command `paicJourneys.openSearch`.
- Right-click "Search…" entries on the connection node (alongside Edit / Delete) and on the realm node (new context menu).
- Search webview is its own esbuild bundle (`out/search.js`), following the connection-form pattern (D34).

**Implementation order:**
1. `src/realm-index/types.ts` — `RealmIndexEntry`, `ReverseRef`, `EntityKey`, per-kind summary types.
2. `src/realm-index/build.ts` — pure realm scanner taking a `PaicClient`. Concurrency-bounded via one per-build `makeLimiter(10)` shared across all phases (see "Build concurrency" above).
3. `src/realm-index/cache.ts` — `{host, realm}` → entry map; `dropOne(host, realm)`, `dropAllForHost(host)`, `registry.onDidChange` subscription.
4. `src/realm-index/queries.ts` — pure functions over a `RealmIndexEntry`: `findUsages`, `searchByName`, `findUnused`.
5. New webview surface under `src/webview/search/` — its own bundle (mirrors D34's connection-form structure).
6. `src/extension.ts` — register `paicJourneys.openSearch` command + title-bar + connection/realm context menus.
7. Card portal — add `[🔍 find usages]` button to inspector card headers for kinds with reverse-dep relevance (script, library script, ESV, theme, inner journey).
8. Boundary test (`tests/architecture/layer-boundaries.test.ts`) — see D21.
9. Per-kind unit tests + UI tests (three modes + empty-state + queued-query-after-build flow).
10. `conventions.md` import-rule additions — see D21.

### D37 — Find-usages tree: per-path part-trees, root-to-target usage count, target-only `via`

The M5 (D36) `findUsagePaths` tree shipped with a single shared `rendered` set across all roots — M4 "Full tree" dedup, reused. That broke two invariants the tree is supposed to hold, so D37 reshapes how the tree is built, counted, and labelled.

**Problem with the shipped behavior.** The shared `rendered` set means the *first* DFS to reach an entity renders it in full; every later encounter — whether a genuine second path or a cycle — collapses to `(dup)`. Two consequences:

1. *Roots that share a subtree look merged.* Two distinct journey roots that both reach the target through the same intermediate journey render the shared subtree fully under whichever root the DFS hit first; the other root shows a hollow `(dup)` stub. They are separate roots, but visually they read as one tangled tree.
2. *Branches can end at `(dup)`, not the target.* When a branch's only route to the target runs through an already-rendered node, the branch terminates at a `(dup)` stub (`children: []`) and the target — which the doc comment promises is "the leaf of every branch" — is silently dropped from that branch.

**Decision — three changes:**

1. **Per-path visited set.** The forward DFS carries a visited set scoped to the *current root-to-node chain*, not a set shared across all roots. Each root renders as its own complete part-tree; a subtree shared by N paths is drawn N times, in full, and every branch ends at the target. `(dup)` is reserved for a **true cycle** — a node already on the current path back to its root — which still must collapse to avoid infinite recursion.
   - *Trade-off:* a diamond-heavy slice renders larger (shared subtree repeated per path). Acceptable — journey graphs are shallow; the clarity of "every branch ends at the target" outweighs the duplication. A per-path collapse-on-demand can be added later if a wide fan-in ever makes it verbose.

2. **Usage count = distinct root-to-target simple paths.** `UsagePaths` gains a `usageCount: number` — the number of distinct simple paths from a *journey root* down to the target. `1→2→3→4` and `1→2→4` count as **2**; an internal segment like `2→3→4` does **not** count on its own, because `2` is not an entry point — it is a segment of a longer root path, not a usage. (Considered and rejected: "reaching journeys" — too coarse, collapses multiple distinct flows from one journey; "inbound edges" — says nothing about which journeys; "every subpath" — double-counts and balloons with depth.) Cycles are excluded by the simple-path rule (no repeated node). Orphan-root paths are counted separately or excluded — they are dead-code reach, not live usage.

3. **`via` on the target only.** The edge label (`via ScriptedDecisionNode`, `via InnerTreeEvaluatorNode` — *how* a parent references a child) is kept on every `UsagePathNode` in the data, but the Tree renderer shows it **only on the target leaf**. Intermediate hops are just "the path passes through here"; the target's `via` is the one piece of real signal — *how the searched entity itself is referenced*. This is a display decision: `findUsagePaths` stays purely about graph shape, `UsagePathTree.tsx` (which already has `paths.targetKey`) gates the `via` span on `node.key === paths.targetKey`.

**Implementation order:**
1. `src/domain/realm-index.ts` — add `usageCount` to `UsagePaths`; update `UsagePathNode.dup` doc to "cycle on the current path."
2. `src/realm-index/queries.ts` — `findUsagePaths` DFS rewrite: per-path visited set, cycle-only `(dup)`, `usageCount` accumulation at each target-reaching leaf.
3. `src/webview/search/ui/UsagePathTree.tsx` — render `via` only on the target node; surface `usageCount`.
4. Tests — `queries.test.ts`: shared-subtree (two roots, both render full), diamond (target is leaf on every branch), cycle (single `(dup)`), `usageCount` for diamond / multi-root / cycle-excluded.

**Amendment (2026-05-22) — node-instance edges + sibling collapse.** Validated against a live sb3 export: the decision script `KYID.2B1.ChooseGoBack.LoginMFAAuthn` is referenced by **11 distinct `ScriptedDecisionNode`s across 5 journeys** — three of those journeys hold **3** scripted-decision nodes each pointing at the same script. The shipped index under-counted this: `addEdge` deduped on `edgeKey = ${fromKey}|${toKey}|${via}` with `via = payload.nodeType`, so three different nodes of the same type collapsed to one edge — a journey that uses the script 3× showed it 1×. Four refinements:

1. **Edge identity = node instance, not node type.** `ReverseRef` gains `fromNodeId` (the journey node's `_id`). `addEdge`'s dedup key becomes `${fromKey}|${toKey}|${fromNodeId}` — distinct journey nodes are now distinct edges even when they share a `nodeType`. The `via` string (`"ScriptedDecisionNode"`, …) is retained verbatim for display. Result: the List view (direct references) shows the true **11**, matching the tenant.

2. **Tree renders distinct topology, not repeated leaves — `refCount` badge.** When several sibling edges from one parent share the *same* `(toKey, via)` (i.e. the same script referenced by N same-type nodes), the Tree collapses them into **one** `UsagePathNode` carrying `refCount: N`, rendered with an `(N refs)` badge — not N identical sibling rows. `UsagePathNode` gains `refCount?: number` (omitted / `1` when not collapsed). Edges that differ in `via` do **not** collapse — a different `via` is a different relationship and stays a separate node.

3. **`usageCount` multiplies by `refCount`.** A target-reaching collapsed node contributes `refCount` to `usageCount`, not 1 — the badge is the multiplier. So `usageCount` remains "distinct root-to-target paths": three nodes hitting the script on one path are three paths, shown as one badged leaf. On the sb3 data this yields **20** (11 direct edges fanned across the journeys' nesting), versus the **11** direct-reference count in the List view header. The Find-usages header is view-aware: List → `N direct reference(s)`, Tree → `N journey path(s) to target`.

4. **Merge within a root, separate across roots.** Confirmed scope of "merged": a single top-level journey root renders as **one** tree with shared prefixes drawn once and branching fanned out (a journey reaching the target two ways = one tree, two target leaves). Distinct top-level roots are **separate** trees — never forced under a synthetic parent. This is what the D37 per-path visited set already produces; the amendment locks it as intentional and forbids further per-path splitting (no "one tree per path" view — `usageCount` is the scalar path answer; the tree is the structural one).

5. **List and Tree are one concept — anchored on a shared number.** The Find-usages `List | Tree` toggle must read as a zoom control, not two unrelated reports. The **List collapses N same-`(entity, via)` refs into one row with the same `(N refs)` badge** the Tree uses on leaves — so toggling never reshuffles or restructures rows.

   The harder problem is the *headers*: a user reading `20 reference paths · from 4 entry points` (Tree) next to `11 direct references · in 5 journeys` (List) tries to reconcile the numbers and can't — `5 ≠ 4`, `11 ≠ 20`. They cannot reconcile, because the views slice on different denominators (List groups by the journey that *directly* holds a node; Tree counts root-to-target *paths*, which multiply with graph nesting). Wording alone does not fix mismatched numbers.

   The fix has two halves. **(a) Both headers lead with the one number that is genuinely identical** — the **reference count** (count of direct node references to the target). That count is a property of the *target itself*, stable across both views — unlike `path count`, `journey count`, `entry-point count`, which are traversal artifacts that shift with graph shape. **(b) Each header's *second* number is the one countable in that specific view** — never a number the user cannot verify on screen. List shows journey rows; Tree shows one `★` leaf per path. So:
   - List → `N references in M journeys` (M = the journey rows)
   - Tree → `N references reached on P paths` (P = the `★` leaves)

   `N references` is byte-identical in both — leading position, same noun, and the List literally renders it (its row badges sum to N). The Tree's `reached on P paths` states the reconciliation in one phrase: the *same* N references, with the journey graph routing to them P ways — so `P > N` reads as expected (more routes than references), not as a contradiction. The 11→20 gap was verified against the sb3 export: the 20 path-leaves are the 11 distinct `ScriptedDecisionNode`s, with 4 of them re-counted because their journey is reached by multiple upstream routes (`MFA_Authentication_LoginMain`'s 3 nodes ×3, `sendOTPmobile`'s node ×4). On the sb3 data: List → `11 references in 5 journeys`, Tree → `11 references reached on 20 paths`.

**Amendment implementation order:**
1. `src/domain/realm-index.ts` — `ReverseRef` gains `fromNodeId`; `UsagePathNode` gains `refCount?`.
2. `src/realm-index/build.ts` — thread the journey node `_id` into `addEdge`; dedup key uses `fromNodeId`.
3. `src/realm-index/queries.ts` — `findUsagePaths` groups sibling forward edges by `(toKey, via)`, emits one node per group with `refCount`; `usageCount += refCount` at each target-reaching group.
4. `src/webview/search/ui/UsagePathTree.tsx` — render an `(N refs)` badge when `refCount > 1`.
5. Tests — `build.test.ts`: two same-type nodes → two edges (no collapse). `queries.test.ts`: sibling collapse with `refCount`, `usageCount` multiplication, different-`via` siblings stay separate.

### D38 — Custom `Combobox` for every webview dropdown (replace native `<select>`)

**Problem.** A native HTML `<select>` is themed only while *closed* — the moment it opens, the **operating system** draws the option list, ignoring the VS Code theme entirely (a white menu in dark mode on macOS). The Search page's Find-usages Target picker also has a hard usability problem: its kind can hold hundreds of entities (344 scripts in sb3) and a `<select>` has no way to filter. The D37 work introduced a type-to-filter `EntityCombobox` for the Target only; this decision generalizes it and makes it the **single dropdown primitive for all webviews**.

**Decision.** All native `<select>` elements in webview UI are replaced by one custom `Combobox` React component — a text input + an absolutely-positioned, HTML-drawn popup list. Because the popup is our own markup it is themed via `--vscode-*` variables (dark in dark mode, light in light mode — consistent, unlike the OS-drawn `<select>` list). Every dropdown thereby also gains **type-to-filter** for free: the input narrows the list by case-insensitive substring on the option label (the same matcher the By-name query uses). Empty input shows all options; no match shows a muted `No entity matches` row.

`Combobox` is **generic over `{ value: string; label: string }`** — not tied to `RealmIndexEntity` — so every dropdown can use it. It supports an optional `placeholder` and a `disabled` state (the Realm picker is disabled until a Connection is chosen). Keyboard: ↑/↓ move, Enter selects, Esc closes; outside-click closes. ARIA combobox pattern — focus stays on the input, the active option tracked via `aria-activedescendant`.

**Audit — every `<select>` to convert** (all in `src/webview/search/ui/App.tsx`; the connection-form and inspector bundles have none):

| Dropdown | Component | Options | Filter value |
|---|---|---|---|
| Connection | `ScopeSelector` | configured connections | host / display name |
| Realm | `ScopeSelector` | realms in the connection | realm name |
| Kind | `FindUsagesControls` | 7 fixed entity kinds | kind label |
| Target | `FindUsagesControls` | entities of the chosen kind (≤ ~344) | `displayName` — already a combobox (D37), refactored onto the generic component |

**Rationale for converting even the small ones.** Connection (1–10 items), Realm (2–5), Kind (7 fixed) gain little from filtering — but converting them is what makes the page *consistent*: one dropdown look, one popup style, no white-in-dark-mode flash on any control. A mixed page (some native, some custom) is worse than uniformly-custom. The filter on a 7-item list is harmless overhead.

**Implementation order:**
1. Generalize `EntityCombobox` → `Combobox` in `src/webview/search/ui/` taking `readonly { value: string; label: string }[]`, `selectedValue`, `onSelect`, optional `placeholder` + `disabled`.
2. `FindUsagesControls` — Target maps entities to `{ value: entity.key, label: displayName }`; Kind maps the 7 kinds to `{ value: kind, label: KIND_LABEL[kind] }`.
3. `ScopeSelector` — Connection + Realm use `Combobox`; Realm passes `disabled` until a host is selected.
4. `panel.ts` — drop the now-unused native `select` rules from `SEARCH_CSS`; `Combobox` styling already covers the popup.
5. Tests — generalize the existing combobox tests; add coverage for the `disabled` Realm state and Connection/Kind selection.

### D39 — Entity icon set: consistent codicons across sidebar, inspector, and Search

**Problem.** The same entity kind was given different codicons in different surfaces. Two real defects:

1. **Journey was inconsistent** — `symbol-class` in the sidebar tree vs `type-hierarchy-sub` on the Search page.
2. **Journey and Inner Journey collided in Search** — both rendered `type-hierarchy-sub`, so a top-level journey and a nested one were visually identical there (the sidebar did distinguish them).

Also: **Connection used `plug`**, which reads as a generic "is-connected" status. A PAIC connection is not a wire — it is a *named tenant environment addressed by hostname*; the icon should say that.

**Decision — the canonical entity → codicon map** (used identically by `src/views/nodes/*`, `src/webview/inspector/ui/cards/grouping.ts`, and `src/webview/search/ui/grouping.ts`):

| Entity | Codicon | Note |
|---|---|---|
| Connection | `server-environment` | a tenant environment at a hostname — was `plug` |
| Realm | `globe` | unchanged |
| Journey | `type-hierarchy` | the root of a dependency tree — was `symbol-class` (sidebar) / `type-hierarchy-sub` (search) |
| Inner Journey | `type-hierarchy-sub` | unchanged — the `-sub` variant deliberately pairs with Journey's `type-hierarchy` |
| Script | `symbol-method` | unchanged |
| Library Script | `library` | unchanged |
| Theme | `paintcan` | unchanged |
| Email Template | `mail` | unchanged |
| Social IdP | `link-external` | unchanged — Search's stray `person` is corrected to match |
| ESV (variable) | `symbol-variable` | unchanged |
| ESV (secret) | `lock` | unchanged |
| ESV (missing) | `warning` | unchanged |

**Key pairing:** Journey (`type-hierarchy`) + Inner Journey (`type-hierarchy-sub`) are one visual family — same hierarchy glyph, the `-sub` marking the nested case. This both fixes the Search collision and makes the parent/child relationship legible at a glance.

**Implementation order:**
1. `src/views/nodes/connection.ts` — `plug` → `server-environment`.
2. `src/views/nodes/journey.ts` — `symbol-class` → `type-hierarchy`.
3. `src/webview/search/ui/grouping.ts` — `journey: type-hierarchy-sub` → `type-hierarchy`; `socialIdp: person` → `link-external`.
4. Inspector `cards/grouping.ts` — already correct (`innerJourney: type-hierarchy-sub`, `socialIdp: link-external`); no change.
5. `docs/sidebar-tree.md` — refresh the icon legend.

### D40 — Connection "verified this session" indicator — session-only, not persisted

**Goal.** A connection can be **saved without being tested** (Save and Test Connection are independent actions in the form). The sidebar tree should show, at a glance, which connections have been verified.

**Rejected — a persisted `validated` field.** The obvious idea is a boolean on the connection config. Rejected: it goes stale the instant it is written. A connection that passes today fails tomorrow when the JWK rotates, the service account is disabled, or the host changes — and a persisted `validated: true` would then show a green indicator for a dead connection. That is worse than no indicator: false confidence. It is also the wrong storage class — the connection config (`host`, `saId`, `name`) holds *identity*, the data Settings Sync replicates across machines; "did the last test pass" is per-session *runtime state* that should not sync.

**Reference — `vscode-database-client`.** Audited how that extension does its green connection icon: it swaps `<dbtype>_active.svg` for `<dbtype>.svg` purely on an in-memory check (`activeNode?.key === this.key`) — the "active" state is **not** saved and does **not** mean "test passed"; it means "this is the connection currently open this session." Confirms the model: session-only, in-memory, no config field.

**Decision.** A **session-scoped, in-memory** verification status — never persisted, cleared on every Extension Host reload, so it can never be stale.

- A small in-memory `Map<host, "ok" | "fail">` (a `ConnectionStatus` session store, owned at the extension level alongside the registry).
- A successful **Test Connection** (token mint OK in the connection form) records `ok` for that host; a failure records `fail`.
- `ConnectionNode` colors its `server-environment` icon from the store via `ThemeIcon` + `ThemeColor` — **not** separate SVG files (we have one codicon; the color-overlay API themes correctly and needs no art):
  - `ok` → `new ThemeIcon("server-environment", new ThemeColor("charts.green"))`
  - `fail` → `... new ThemeColor("charts.red")`
  - untested this session → plain `new ThemeIcon("server-environment")` (no color)
- The dot means **"verified this session"**, never "validated forever". A fresh window starts every connection un-tinted until tested again — honest by construction.

Also (UI parity, D39 family): the **Test Connection** button in the connection form moves to the **primary (accent) style** — it is a real, encouraged action, and the form's button styling should be consistent.

**Implementation order:**
1. New session store — `ConnectionStatus` map with `markOk(host)` / `markFail(host)` / `get(host)`, created in `extension.ts`, passed to the connection-form panel + the tree provider's `ConnectionNode` factory.
2. Connection-form panel — on `mintToken` success/failure, call `markOk` / `markFail`; fire the tree's refresh so the icon updates.
3. `ConnectionNode` — pick the icon color from the store.
4. `connection-form/ui/App.tsx` — Test Connection button `secondary` → `primary`.
5. Tests — `ConnectionNode` icon reflects each status; store round-trip.

### D33 — Sidebar tree: kind-grouped children with category headers + alphabetical sort

Today the sidebar tree builds a journey's (or script's) children in **discovery order** — whatever order the dependency walker emits as it crawls a journey's nodes. A real journey can mix Inner Journeys, Scripts, Themes, Email Templates, and Social IdPs in any sequence, and the result is hard to scan.

We sort children by **kind** (using a fixed priority list), then by **name** alphabetically within each kind. Between kind groups, we insert a non-clickable `─── <Category> ───` divider row so the kind structure is visually obvious even on tall trees.

**Kind priority** (where mixed kinds appear, applied uniformly at every level):

| # | Kind | Domain class | Header label |
|---|---|---|---|
| 1 | Inner Journey | `InnerJourneyNode` | `─── Inner Journeys ───` |
| 2 | Script | `ScriptNode` | `─── Scripts ───` |
| 3 | Library Script | `LibraryScriptNode` | `─── Library Scripts ───` |
| 4 | Theme | `ThemeNode` | `─── Themes ───` |
| 5 | Email Template | `EmailTemplateNode` | `─── Email Templates ───` |
| 6 | Social IdP | `SocialIdpNode` | `─── Social IdPs ───` |
| 7 | ESV | `EsvNode` | `─── ESVs ───` |

Within each kind: case-insensitive sort by display name (the resolved human name — script's `name`, journey's `id`, theme's `name`, etc.), NOT by UUID.

**Where this applies:**

- `JourneyNode` children (and `InnerJourneyNode`, which expands the same way) — most-mixed case; uses `groupAndSort` with category headers
- `ScriptNode` children (mixes `LibraryScriptNode` + `EsvNode`) — same
- `RealmNode → JourneyNode` (single kind) — alphabetical sort by `journey.id`, no header
- `ConnectionNode → RealmNode` (single kind) — alphabetical sort by `realm.name`, no header

Sort is locale-aware case-insensitive (`localeCompare(..., { sensitivity: "base" })`) everywhere for consistency.

**Always emit the divider with its bucket count — `── <Kind> (N) ──`.** Original D33 spec skipped the divider when a single kind was present at one level ("redundant clutter"); this was reversed on **2026-05-19** because in deep transitive trees (Full / Flat view), single-kind levels lost their visual marker and made the structure hard to follow — especially on copy-paste, where the HTML indent is gone but the divider text would have remained. The rule now applies uniformly across the sidebar AND the inspector's Full / Flat resolved views. The sidebar's `CategoryHeaderNode` was updated to render `── <Kind> (<count>) ──` and the `multi >= 2` gate was dropped from both `groupAndSort` implementations (`src/views/nodes/grouping.ts` + `src/webview/inspector/ui/cards/grouping.ts`). Lesson recorded in `docs/lessons.md` 2026-05-19.

**Divider rendering:**

A new `CategoryHeaderNode` class (or small extension of the existing `MessageNode` pattern). Visual contract:

- `label`: the divider text including the em-dashes, e.g. `"─── Inner Journeys ───"`
- `description`: undefined (no count — keeps the row light)
- `collapsibleState`: `None` (leaf)
- `iconPath`: undefined (no icon — the em-dashes provide visual weight)
- `contextValue`: `"categoryHeader"` (so context menus skip it)
- `tooltip`: undefined
- Not selectable in any meaningful way — clicking it does nothing (no preview card spawns; the `instanceof` checks in `InspectorFactory.spawn` won't match)

**Implementation sketch:**

A new pure helper `src/views/nodes/grouping.ts`:

```ts
export type NodeKind =
  | "innerJourney" | "script" | "libraryScript" | "theme"
  | "emailTemplate" | "socialIdp" | "esv";

const KIND_ORDER: Record<NodeKind, number> = {
  innerJourney: 0, script: 1, libraryScript: 2,
  theme: 3, emailTemplate: 4, socialIdp: 5, esv: 6,
};

const KIND_HEADER: Record<NodeKind, string> = {
  innerJourney: "── Inner Journeys ──",
  script: "── Scripts ──",
  libraryScript: "── Library Scripts ──",
  theme: "── Themes ──",
  emailTemplate: "── Email Templates ──",
  socialIdp: "── Social IdPs ──",
  esv: "── ESVs ──",
};

function kindOf(node: PaicNode): NodeKind | null { ... } // instanceof switch

/** Sort + group + insert dividers (when 2+ kinds present). */
export function groupAndSort(nodes: PaicNode[]): PaicNode[] {
  const byKind = new Map<NodeKind, PaicNode[]>();
  for (const n of nodes) {
    const k = kindOf(n);
    if (k === null) continue; // skip unknown — shouldn't happen at L4
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k)!.push(n);
  }
  const presentKinds = [...byKind.keys()].sort((a, b) => KIND_ORDER[a] - KIND_ORDER[b]);
  const multi = presentKinds.length >= 2;
  const out: PaicNode[] = [];
  for (const k of presentKinds) {
    const group = byKind.get(k)!.sort((a, b) =>
      (a.label?.toString() ?? "").localeCompare(b.label?.toString() ?? "", undefined, { sensitivity: "base" })
    );
    if (multi) out.push(new CategoryHeaderNode(KIND_HEADER[k]));
    out.push(...group);
  }
  return out;
}
```

`journey-expand.ts` + `script-expand.ts` each replace their current `children.push(...)` final return with `return groupAndSort(children)`.

**What stays the same:**

- The walk logic — `expandJourney` / `expandScript` still produces the same set of nodes, just unordered. We sort at the boundary, not during the walk.
- Click behavior — clicking a real node still spawns a preview tab. Clicking a header is a no-op (no `instanceof` match in the factory).
- Drag, refresh, context menus — unchanged for real nodes; not applicable to headers.

**Risks:**

- **Test fixtures assert order.** A handful of existing tests use `expect(children[0]).toBeInstanceOf(...)`. Need to update those to account for header rows and the new ordering. Most assert presence + counts, not specific positions.
- **The "skip header when single kind" rule** changes count expectations subtly. Tests should be explicit about this branch.

### D32 — "Re-layout" / "Original layout" toggle (5th Controls button)

D31 makes the diagram faithful to AIC's hand-placed coordinates — that's the right default. But some journeys have messy hand-placements (overlapping nodes, oddly spaced clusters, retry loops in awkward corners) where the user might prefer a clean algorithmic arrangement.

A fifth text-labeled button is added to the `<Controls>` panel (after zoom-in / zoom-out / fit-view / Expand). It's a **two-state toggle**:

- Default (`usingDagre = false`): button label "Re-layout". Diagram renders AIC's server-coords layout.
- After click (`usingDagre = true`): button label "Original layout". Diagram renders dagre's clean layout.
- Clicking again returns to AIC's layout. Both directions discard any drag positions made while in that mode.

**Mechanics:**

1. `computeDagreLayout` is exported from `src/webview/inspector/ui/diagram/layout.ts` (was a private helper).
2. `JourneyDiagram` holds a `usingDagre` boolean state and a `toggleLayout` callback:
   ```ts
   const toggleLayout = useCallback(() => {
     const next = !usingDagre;
     setUsingDagre(next);
     const layout = next ? computeDagreLayout(journey) : computeLayout(journey);
     setRfNodes(layout.nodes.map((n) => toRfNode(n, nodeIndex)));
     window.requestAnimationFrame(() =>
       rfInstanceRef.current?.fitView({ padding: 0.12 }),
     );
   }, [usingDagre, journey, nodeIndex, setRfNodes]);
   ```
   `computeLayout` is the D31 dispatcher: it returns the server-coords layout when usable and falls back to dagre otherwise. Toggling back is symmetric.
3. The button text + tooltip flip based on `usingDagre`. A shared `ctrl-text-button` class widens the button so the label fits.

**What stays the same:**

- Server coordinates remain the default on first render — D31 unchanged.
- Drag (D26), expand (D29), terminal anchoring (D28) all still work after a toggle — the new positions become the new `useNodesState` seed.
- No persistence across tabs — closing and reopening reverts to AIC's layout regardless of which state the button was in. Matches D26.

**Risks / non-risks:**

- **Edge endpoints** auto-follow nodes via ReactFlow's id references; no manual edge updates needed.
- **Drag positions are discarded on toggle** — expected. The toggle is a "give me a fresh arrangement" gesture, not a drag-preserver.
- **No mode flicker.** State is local to the React component; both layout functions are pure, sync, and fast (<10 ms each).

### D31 — Use server-provided node coordinates instead of dagre auto-layout

AIC's journey wire response carries the **exact node positions** the user laid out in the admin UI:

- Every entry in `journey.nodes[id]` has `x` and `y` fields — pixel coordinates from the AIC canvas.
- A separate `journey.staticNodes` map carries coordinates for the three platform terminals:
  - `staticNodes.startNode` → `{x, y}`
  - `staticNodes["70e691a5-..."]` → Success
  - `staticNodes["e301438c-...-66126501069a"]` → Failure

This means we can **render the diagram exactly as the user designed it in AIC**, instead of running our own layout algorithm. dagre produces a clean tree but it doesn't match what the user is looking at when they edit the journey — and many real-world journeys have deliberate spatial arrangement (e.g. fallback loops on one side, happy paths in a column) that dagre flattens away.

**Approach:**

1. **Pass server coordinates straight through.** `NodeRef.x` / `y` become part of the domain type; `Journey.staticNodes` is added. `mapJourney` threads both through verbatim — D11's "faithful translation" principle.
2. **Layout uses server coordinates as the primary source.** `computeLayout` reads `journey.nodes[id].x/y` for real nodes and `journey.staticNodes[id].x/y` for terminals. The result feeds directly into ReactFlow's `position`.
3. **Dagre stays as a fallback.** If a journey has no coordinates (e.g. journeys created via API without ever opening the admin UI, or older exports), or if more than a small threshold of nodes have `x === 0 && y === 0`, fall back to the dagre-based layout we have today.
4. **NODE_W / NODE_H stay constant.** AIC's coordinates are top-left-anchored pixel positions in its canvas; we render them at the same scale. ReactFlow's `fitView` handles the zoom-to-fit automatically.
5. **Terminal-anchoring code from D28 is removed** when using server coordinates — server already centers Start vertically and stacks Success/Failure naturally. Anchoring stays in the dagre fallback path.
6. **LR direction stays.** AIC's own layout is LR (verified: `startNode.x = 70`, internal nodes 200–500, terminals 692). Our LR flips match the source data.

**Why this is better than dagre:**

- **Matches the user's mental model exactly** — they see the same diagram in our extension that they see in AIC's admin UI.
- **Removes a whole class of layout-quirk bugs** — dagre sometimes produces awkward placements for cycles or wide journeys; the user's hand-tuned layout doesn't have those.
- **Simpler code path** — no dagre invocation for the common case. Dagre stays only as the fallback for coordinate-less journeys.
- **Drag-to-rearrange still works** (D26) — `useNodesState` still owns positions for the tab's lifetime; the initial values just come from the wire instead of dagre.

**What needs care:**

- **Coordinate scale.** AIC's canvas uses pixel values that can be very large (Success node at x=1236 in one capture). Our diagram canvas auto-fits via `fitView`, so absolute scale doesn't matter — only relative positions do.
- **Coordinate offset.** AIC's coordinates are anchored to its canvas origin, not ours. ReactFlow's pan/zoom adapts.
- **Missing coordinates.** Some node references may have `x` / `y` undefined or 0. Our fallback rule: if `journey.entryNodeId` exists and its node has no coordinates, OR if all real nodes have `x === 0 && y === 0`, treat the journey as "uncoordinated" and run dagre. Per-node missing coordinates default to `(0, 0)` and accept the overlap — rare edge case.
- **Inner journeys.** Each inner journey is fetched separately and has its own `staticNodes`. The recursive `getJourney` already returns the full shape; the inner-journey card builds its own diagram from the inner's coordinates.

**Risks:**

- **Hand-edited journeys may have overlapping nodes** if a user dragged two nodes to similar positions in AIC. Faithful reproduction means we'd show the overlap too. Acceptable — it's accurate to what AIC shows.
- **Older exports / API-created journeys** may have placeholder coordinates. The fallback path covers these.
- **Tests** assume dagre-driven coordinates today. Fixtures + assertions need a small revisit — most just verify node presence and edges, not pixel positions.

### D30 — Per-outcome handles inside decision nodes (TRIED, REVERTED 2026-05-19)

**Status: reverted.** AIC's admin UI lists outcome names (True / False / Allow / etc.) inside the source node body with per-outcome handles. We tried mimicking the pattern (variable node height, named source handles, edge labels dropped). The implementation worked technically — tests passed, layout was correct — but the visual result looked cluttered: the inline-label stack inside a 200 px-wide node, combined with our color stripe, header text, and synthesized terminals, was busier than the labels-on-edges baseline.

**Decision:** stay with mid-edge outcome labels. Fixed `NODE_H = 64`. Single source handle per node on the right edge.

**If we ever revisit this**, the friction wasn't the mechanics — it was the visual density at our current node dimensions. A wider node, a sparser header, or an opt-in toggle ("compact" vs "labeled-edges") could make it work. Not a foundational change worth the complexity right now.

### D29 — Diagram expand-to-tab-width toggle (no fullscreen, no persistence)

Inspector cards have `max-width: 720px` so prose stays readable. The diagram lives inside a card, so on wide tabs the diagram is squeezed even when there's plenty of horizontal space available. Real journeys regularly exceed what fits at 720 px (30+ nodes in LR flow).

A text-labeled button is added to ReactFlow's existing `<Controls>` panel as the **4th button** (after zoom-in / zoom-out / fit-view). The whole `<Controls>` panel is moved to the **top-left** corner of the diagram (`position="top-left"`) — the default bottom-left position would put zoom controls at the very bottom of an expanded diagram, far from where the user's eye starts. Top-left keeps the controls in immediate reach.

**Both added buttons use icons** — small 12×12 inline SVGs that match the visual weight of ReactFlow's built-in zoom/fit-view buttons. The icon **swaps with state** to suggest the click outcome:

| Button | State A icon | State B icon |
|---|---|---|
| Expand / Collapse | Horizontal arrows **outward** (expand) | Horizontal arrows **inward** (collapse) |
| Re-layout / Original layout | Tree-graph (3 dots + 2 branches → "auto-arrange") | Counter-clockwise circular arrow (revert) |

The **hover tooltip + `aria-label`** carry the plain-text label ("Expand" / "Collapse" / "Re-layout" / "Original layout") for accessibility and discoverability. No text inside the button bodies — keeps them visually consistent with the three default ReactFlow Controls buttons (zoom in, zoom out, fit-view).

| State | Width | Height |
|---|---|---|
| Collapsed (default) | Card's `max-width: 720px` | `360px` fixed |
| Expanded | Full tab width (`max-width: none` on the card) | Derived from CSS `aspect-ratio: 16 / 9` of the now-wider container |

Width-to-tab is the primary mechanic. Height uses a **fixed 16:9 aspect ratio** of the width rather than `100vh - X`, because:
- The webview is already vertically scrollable (the inspector card sits in normal page flow with deps + diagram + footer content). Tying height to viewport double-counts that scrolling and produces awkward sizing.
- A ratio scales linearly with width — wider tab → taller diagram, predictably.
- Width is more reliably measurable in a webview than the "available vertical space."

The expand mechanism uses `:has()` on the containing card: `.card:has(.diagram.expanded) { max-width: none }`. Modern Chromium supports `:has()` so this works in VS Code's Electron renderer.

**Not fullscreen.** A real fullscreen mode would need an `IntersectionObserver` for scroll-into-view restoration, focus trapping, and ESC handling. Out of scope for "I want more room to see the flow."

**Not persisted.** Toggle state is `useState` inside `JourneyDiagram` — lives for the lifetime of one inspector tab. Each `previewNode` spawn (per D24) gets a fresh tab + fresh state. No settings, no message protocol, no per-host preference. Same rationale as the no-drag-persistence decision in D26.

**Re-fit on toggle.** ReactFlow doesn't auto-refit on container resize. We capture the instance via `onInit` and call `fitView({ padding: 0.12 })` inside a `requestAnimationFrame` callback in a `useEffect` keyed on `expanded`. Single-frame defer is needed so the DOM has settled to the new size before we measure.

**Drag positions on toggle?** `useNodesState` keeps the same array across the toggle. After the refit, nodes are repositioned by the fitView pan/zoom, not by re-running dagre. If the user wants a re-layout after expanding, they can close + reopen the tab.

**Why hardcode the IDs?** They're stable across every PAIC tenant and every on-prem AM deployment in frodo-lib's fixtures. frodo-lib, PingHub, and the AIC admin UI all do the same. If they ever change (extremely unlikely — would break every customer integration), we'd need a fix anyway. **Lesson:** verify against captured fixtures, never reconstruct UUIDs from memory (see lessons.md 2026-05-18).

## Architecture (M2 target state)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Extension Host (Node.js)                      │
│                                                                       │
│  src/extension.ts ──► activate(): commands + view registration        │
│                                                                       │
│  ┌────────────────┐  ┌──────────────────┐  ┌─────────────────────┐   │
│  │   views/       │  │   resolver/      │  │   tenants/          │   │
│  │   ━━━━━━━     │  │   ━━━━━━━━━━    │  │   ━━━━━━━━━━       │   │
│  │  PaicTreeProv   │←→│ walk.ts          │←→│ registry.ts         │   │
│  │  nodes/        │  │ realm-index.ts   │  │ (settings+secrets)  │   │
│  │   base, conn,  │  │ cache.ts         │  └─────────────────────┘   │
│  │   realm,       │  └────────┬─────────┘                            │
│  │   journey,     │           │ uses                                  │
│  │   script,      │           ▼                                       │
│  │   innerJ       │  ┌──────────────────┐  ┌─────────────────────┐   │
│  └────────────────┘  │   domain/        │  │   paic/              │   │
│         │            │   ━━━━━━━━━━    │  │   ━━━━━━━━━━       │   │
│         │ consumes   │ types only:      │←─│ http.ts             │   │
│         ▼            │  Connection,     │  │ auth.ts (JWT)       │   │
│  ┌────────────────┐  │  Realm, Journey, │  │ client.ts           │   │
│  │   webview/     │  │  Script,         │  │ realm-path.ts       │   │
│  │   panel.ts     │  │  InnerJourney    │  │ pagination.ts       │   │
│  │   ui/ (React)  │  └──────────────────┘  │ concurrency.ts      │   │
│  │   messages.ts  │           ▲             │ errors.ts           │   │
│  └────────────────┘           │             │ mappers.ts          │   │
│         │                     │             └─────────┬───────────┘   │
│         │ postMessage         │ raw→domain            │ HTTPS         │
│         ▼                     │                       │               │
└─────────┼─────────────────────┼───────────────────────┼───────────────┘
          │                     │                       │
          ▼                     │                       ▼
   Sandboxed iframe        (one-way edge)         PAIC tenant
   (React + ReactFlow)                            REST API
```

## Data model

```typescript
// User-owned (persisted)
interface Connection {
  host: string;          // identity
  saId: string;
  name?: string;         // display label
}
// saJwk lives in SecretStorage; never crosses into types directly.

// Resolved graph — produced by resolver, consumed by tree/webview/index
type NodeKind =
  | 'journey' | 'node' | 'script' | 'library-script'
  | 'inner-journey' | 'esv' | 'theme'
  | 'email-template' | 'saml-entity' | 'social-idp';

type EdgeKind =
  | 'contains' | 'calls-inner-tree' | 'invokes-script'
  | 'imports-library' | 'references-esv' | 'uses-theme';

interface GraphNode {
  id: string;            // `${kind}:${stableId}` — composite
  kind: NodeKind;
  label: string;
  raw?: unknown;         // original PAIC JSON, for detail pane
}

interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  via?: string;          // node uuid that connects them, for explainability
}

interface DependencyGraph {
  rootId: string;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
}

// RealmIndex — produced by background scan, consumed by query panel
interface RealmIndex {
  host: string;
  realm: string;
  builtAt: number;                              // epoch ms
  journeys: Map<string, JourneySkeleton>;       // by journey _id
  edges: {
    journeyToScript: Array<{ journey: string; script: string }>;
    journeyToInner:  Array<{ journey: string; inner:  string }>;
  };
  reverse: {
    scriptToJourneys: Map<string, Set<string>>;
    innerToJourneys:  Map<string, Set<string>>;
  };
}
```

## Milestones

Each milestone ships a working, testable user flow. The foundation is laid in M1 such that M2–M7 add capability without redesigning earlier work. The order favors **broadening depth first** (M3 expands dep kinds before any analysis is built), so when the index lands in M4 the graph is already complete.

### M0 — Connection CRUD ✅

Add/edit/remove connections. Settings.json + SecretStorage. LogOutputChannel. Tail-able log file. Test Connection button (mints token via JWT-bearer). **Done.**

### M1 — Forward exploration with detail panel (current target)

**User-facing outcome:** *"I can pick a connection, browse to a realm, open a journey, see its scripts and inner-trees as children, and selecting any item shows basic information in a detail panel on the right."*

Foundation built in this milestone — minimum to ship the slice, shaped to absorb later growth:

**Transport + domain layers**
- `src/paic/auth.ts` ✓ (done)
- `src/paic/errors.ts` — `PaicError` flattening AxiosError fields
- `src/paic/realm-path.ts` — `getRealmPath(realm)` verbatim from frodo
- `src/paic/pagination.ts` — `listAllPaged(fetchPage)` helper
- `src/paic/concurrency.ts` — `mapConcurrent(items, N, fn)` helper
- `src/paic/http.ts` — axios instance per connection, retry, 429 Retry-After, error wrap
- `src/paic/mappers.ts` — raw → domain translation
- `src/paic/client.ts` — `PaicClient` with `listRealms`, `listJourneys`, `getJourney`, `getNode`, `getScript`
- `src/domain/types.ts` — `Connection`, `Realm`, `Journey`, `Script`, `InnerJourneyRef`
- `src/tenants/registry.ts` — extracts connection-listing logic from `extension.ts`

**Tree view (deeper levels + class hierarchy cutover)**
- `views/nodes/base.ts` — abstract `PaicNode` (D12 cutover happens here, not in a later milestone)
- `views/nodes/connection.ts`, `realm.ts`, `journey.ts`, `script.ts`, `inner-journey.ts`
- Lazy `getChildren()` per kind; loading/error states; Refresh command

**Detail panel (D15 trigger — webview framework lands here)**
- `src/webview/inspector/` — single React panel that lives in the editor area (`ViewColumn.Beside`)
- esbuild second entry → `out/webview.js`
- Typed message protocol `src/webview/messages.ts`
- Tree-selection event → `postMessage` with `(kind, id, raw)` → panel renders a basic info card
- Card content per kind:
  - **Connection:** host, saId, name, last-tested timestamp
  - **Realm:** name, journey count
  - **Journey:** id, description, enabled, identityResource, node count, list of scripts referenced, list of inner journeys referenced (each clickable → navigates tree selection)
  - **Script:** id, name, language, outcomes, inputs/outputs (no body content yet — that's M2)
  - **Inner-journey leaf:** same as Journey
- VSCode CSS variables, no component lib yet

**Tests**
- Unit tests for `paic/*` against captured POC fixtures
- Light component tests for the panel — render-with-mock-data smoke tests

**What M1 deliberately does NOT do**
- No script body rendering — only metadata in the panel (M2 adds the body).
- No per-journey node-flow diagram — only metadata (M2 adds it).
- No themes, ESVs, library scripts via `require()` (M3).
- No RealmIndex / background scan (M4).
- No query panel / reverse lookups / orphans (M5).
- No realm-wide graph webview (M6).
- No saved graphs, no diff (M7).
- Connection form stays a template-string webview (rewrite happens whenever it earns it; not coupled to D15 trigger anymore).

### M2 — Fill the detail panel: real content

**User-facing outcome:** *"When I click a script in the tree, its body opens in a real editor tab beside the inspector — full find, fold, themes, syntax highlighting, multi-cursor. When I click a journey, the inspector shows an interactive diagram of its node flow; clicking a node in the diagram navigates the tree to the underlying script."*

Two locked off-the-shelf bets, both with extensibility headroom (see D17, D18):

- **Script body via `FileSystemProvider`** (D17). Register the `paic-script://` scheme; clicking a script (or "Open body in editor" from the inspector / a right-click on a `ScriptNode`) opens the body in a real editor tab via `workspace.openTextDocument`. Read-only enforced at M2 — `writeFile` throws `NoPermissions`. The architecture is write-capable; the flip lives behind D6.
- **Per-journey diagram via ReactFlow + dagre** (D18). Custom node components per AIC kind (M3 widens the set). Click-a-node → posts a `navigate` message → existing cross-nav handler reveals the target tree row and re-renders the inspector. Hover-a-node → tooltip with inputs / outputs / outcomes.
- **Hover tooltips on tree items** — Markdown-formatted metadata via `TreeItem.tooltip = new vscode.MarkdownString(...)`. No webview.
- **Persist tree collapse state** to `globalState` keyed by node `uid` (UX win we lifted from the database-extension audit).
- **"Open in Diff Editor"** — once two `paic-script://` URIs exist for the same script (e.g., across two connections), `vscode.diff` gives us a tenant-vs-tenant diff editor for free (free side-effect of D17).

### M3 — Wider dependency kinds

**User-facing outcome:** *"My tree, diagram, and detail panel show every meaningful dependency: themes, email templates, social IdPs, library scripts (via `require()`), and ESVs (via `&{esv...}` / `systemEnv.X`). When I click a script in the tree, I can drill into its library-script and ESV references."*

Two distinct widenings — node-level (more payload fields → more journey edges) and script-level (parsing the fetched body → script edges).

**Node-level edges added** (per D19's predicate table where applicable)
- `ClientScriptNode` → script
- `ConfigProviderNode` → script
- `SocialProviderHandlerNode` / `SocialProviderHandlerNodeV2` → script *and* social-IdP list (`payload.filteredProviders: string[]`)
- `DeviceMatchNode` → script — **only if `payload.useScript === true`** (D19 conditional pattern)
- `PingOneVerifyCompletionDecisionNode` → script — **only if `payload.useFilterScript === true`** (D19)
- `PageNode` → child nodes (walk `payload.nodes[]` inline) + theme (parse `payload.stage` for `themeId`)
- `EmailSuspendNode` / `EmailTemplateNode` → email template (resolved against IDM managed-templates)
- `SelectIdPNode` → social-IdP list (`payload.filteredProviders`, no script)

**Script-level edges added** (per D20 — regex over fetched bodies)
- script → library-script via `require('<name>')`
- script → ESV via `&{esv.X}` or `systemEnv.X`
- library-script → library-script / ESV (recursive; reuses M1's cycle-guard pattern keyed on `(kind, id)`)

**Tree / inspector / diagram surface grows**
- `ScriptNode` stops being a leaf — gains `loadChildren()` that fetches the script body and emits `LibraryScriptNode` + `EsvNode` children.
- New node classes in `src/views/nodes/`: `library-script.ts`, `esv.ts`, `theme.ts`, `email-template.ts`, `social-idp.ts`.
- New inspector cards: `LibraryScriptCard` (with diagram via reused `JourneyDiagram` patterns? — TBD; library scripts don't have a tree-flow), `EsvCard`, `ThemeCard`, `EmailTemplateCard`, `SocialIdpCard`.
- Diagram replaces the `Other` fallback for `PageNode`, `EmailSuspendNode`, `EmailTemplateNode`, `SocialProviderHandlerNode*`, `SelectIdPNode`, `DeviceMatchNode`, `ConfigProviderNode`, `ClientScriptNode`, `PingOneVerifyCompletionDecisionNode` with proper per-kind components.

**Fetch growth**
- Each journey-expand now also fetches every script body for the journey's referenced scripts. Bounded by `mapConcurrent` (cap 10). Library-script + ESV resolution happens on `ScriptNode` expansion, not on journey expansion — keeps lazy contract.
- New PAIC client methods: `getEmailTemplate`, `getSocialIdp`, `getTheme`, `getEsv` (or `listEsvs` + lookup). Library scripts are scripts where `script.type === "library"` — reuse `getScript`.

**Deferred past M3** (call out so the gap is visible)
- `product-Saml2Node` (SAML entities + circles of trust) — narrower customer segment; needs two-fetch resolution (provider stubs + CoT list). Worth its own slice when SAML flows enter scope.
- `designer-*` custom marketplace nodes — minority of customers; defer until requested.

**Done here on purpose**: ship breadth before the index, so when M4 (RealmIndex) lands the indexable graph already covers every edge kind.

### M4 — Resolver cache + inspector dependency view

**User-facing outcome:** *"When I'm looking at a journey or script card, I can switch the Dependencies section from level-1 view to a Full transitive tree or a Flat deduplicated list — and toggling between Full and Flat is instant after the first compute. A per-card refresh button lets me re-resolve that one root without invalidating everything else."*

Implements D35; lives under `src/resolver/`; isolated from the lazy-tree cache and the realm index per D21.

- `src/resolver/walk.ts` — pure graph builder. Forward BFS over a single root; captures depth, cycle markers, ref counts; returns `{nodes, edges, depth, cycles, durationMs}`.
- `src/resolver/cache.ts` — keyed by `{host, realm, kind, id}`; subscribes to `registry.onDidChange` for per-host invalidation; exposes `dropOne(rootKey)` for per-card refresh and `dropAllForHost(host)` for sidebar refresh + registry events.
- Inspector protocol additions: `resolveFull` / `resolveResult` / `refreshResolved`.
- Card UI: segmented control on Journey/InnerJourney/Script/LibraryScript cards (Direct / Full tree / Flat) + per-card refresh button visible after first resolve.
- Sidebar refresh paths (`paicJourneys.refresh` + `paicJourneys.refreshNode`) also call `resolverCache.dropAllForHost(host)`.

D13's background-scan goal is dropped per D36. M4 no longer does a realm-wide scan; that's M5's job and only on explicit user click.

### M5 — Search page (reverse-dep + name + orphans)

**User-facing outcome:** *"From the sidebar 🔍 icon, a right-click on a connection or realm, or a card portal button, I can open a Search page scoped to one realm. After clicking `Build index`, I can find which journeys reference any entity, search entities by name across kinds, or list orphans. Multiple entry points for the same realm land on the same tab and share the same index."*

Implements D36; lives under `src/realm-index/` (data layer) + `src/webview/search/` (UI bundle); isolated from the lazy-tree cache and the resolver cache per D21.

- `src/realm-index/{types, build, cache, queries}.ts` per D36.
- New webview bundle `out/search.js` from `src/webview/search/{messages, panel, ui/main.tsx, ui/App.tsx}`.
- Title-bar `$(search)` icon (`view/title`); context-menu "Search…" on connection + realm tree items.
- Inspector cards (script, library script, ESV, theme, inner journey) gain a `[🔍 find usages]` button portal.
- `tests/architecture/layer-boundaries.test.ts` enforces D21's import rules.
- `conventions.md` import-section additions per D21.

### M6 — Realm-wide graph webview

**User-facing outcome:** *"From a realm or query result, I can open a graph view showing the realm's dependency graph as nodes-and-edges with ReactFlow."*

- `src/webview/graph/` — third React entry (M1 inspector + M5 query + M6 graph).
- Re-uses ReactFlow already brought in at M2.
- Hierarchical + force-directed layouts toggle.
- Kind-colored nodes, typed edges, filter chips per `NodeKind`.

### M7 — Impact analysis + saved graphs + diff

**User-facing outcome:** *"I can ask 'if I change this library script, what breaks?' and get a chain of affected journeys. I can save a graph snapshot to compare against another tenant or another time."*

- Impact = reverse-reachability over the union of edge kinds.
- Saved graphs: explicit user action writes to `globalStorageUri/cache/<host>/graphs/<timestamp>.json` (the only place we ever write derived data — and only by explicit user choice).
- Diff: side-by-side comparison of two saved graphs.

## Open questions

**Foundation**
- Q-1 — Mapper location: `src/paic/mappers.ts` vs `src/domain/from-paic.ts`?
- Q-2 — Folder name: `domain/` vs `models/` vs `types/`?
- Q-3 — Concurrency primitive: `p-limit` (~3 KB) vs hand-rolled `mapConcurrent` (~25 lines)?
- Q-4 — `X-ForgeRock-TransactionId` value: per session, per request, or per batch?
- Q-5 — 429 strategy: rely on `axios-retry` built-in, or replicate frodo's custom interceptor?
- Q-6 — Concurrency cap value: 10 (POC-tested) vs 20 (~2× faster, untested)?

**Index / queries**
- ~~Q-7~~ — Retired by D36 (standalone Search webview, single instance per `(host, realm)`; not a sidebar view or activity-bar entry).
- ~~Q-8~~ — Retired by D36 (status lives in the Search page's "Realm index:" header; no global indicator since builds are always foreground/user-initiated).
- ~~Q-9~~ — Retired by D36 (no background scan to cancel; user closes the Search tab to abandon a build).

**Frontend**
- Q-10 — Connection form rewrite to React: still a template string after M1 — when does it earn the rewrite?
- Q-11 — React state mgmt: plain React vs Zustand vs Redux Toolkit?
- Q-12 — Hot reload during webview dev: Vite HMR vs `npm run watch` + reload?
- ~~Q-16~~ — Retired by D17 (FileSystemProvider).

**Resolver**
- ~~Q-13~~ — Retired by D20 (regex first, AST upgrade if needed).
- Q-14 — `_action=nextdescendents` bulk-fetch shortcut: viable? (still to POC)
- Q-15 — Import connections from sibling `paicLogSearch.environments`?

## Non-goals

- No write operations to PAIC.
- No alternative auth flows (admin user + 2FA, SSO, basic auth). Service-account JWT-bearer only.
- No support for PingOne, PingFederate, or non-PAIC ForgeRock deployments in v1.
- No telemetry, no analytics, no remote sync.
- No "live diff" between editor changes and tenant state.
- No on-disk cache of derived data (per D8). The lone exception is the *explicit user action* "save graph" in M7.
- No database. Ever. None of our access patterns are DB-shaped (we do graph BFS over small in-memory structures, not SELECT-WHERE-JOIN). Bringing in SQLite would add cross-platform binary headaches and break Settings Sync, with zero query benefit.
