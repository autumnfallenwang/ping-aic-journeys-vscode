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

### D6 — Read-only (AMENDED 2026-06-12 by D43)

No pull, no push, no promote. If anyone wants those, they use paic-pipeline. We stay focused on analysis.

**Amendment (D43):** the import feature now writes the **3 atom leaves** (theme, email template, social IdP) **and ESVs** (variable + secret, create-only, with a separate tenant-wide apply/restart step) to a tenant, gated by a modal confirm + a fresh validate-before-write pre-flight. Journeys (Batch 3) and any bulk/promote flow stay out; everything else stays read-only. See D43.

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

**Full-component index enumeration — BUILT (2026-06-13).** The RealmIndex previously covered only **journey-referenced** scripts + email templates (theme/social-IdP/ESV were already enumerated), so an orphan component (e.g. a freshly-imported script wired into no journey) was invisible to Search/by-name/Unused. Now it enumerates **every** component in the realm. Endpoints (live-verified on sb3): scripts via **`GET /am/json/<realmPath>/scripts?_queryFilter=true`** — returns all (1164 on sb3 alpha) in one unpaged call **with bodies included**, so the `require()`/esv closure walk is in-memory (no per-script fetch — the original eval's "+500 body fetches" fear was wrong); email templates via **`GET /openidm/config?_queryFilter=true`** filtered to `_id` `^emailTemplate/` (81 on sb3 — the "no list endpoint" blocker was false). Implementation: `client.listScripts(realm)` + `client.listEmailTemplates()`; two **best-effort, isolated** build phases. `scanAllScripts` lists every script (bodies included) and builds **all** script→lib/esv edges in-memory (require() resolves against the in-memory name→script map) — it **replaced the old journey-closure BFS** (`scanScripts`/`fetchScript` deleted), removing the per-script `getScript` + per-lib `getScriptByName` HTTP that the BFS did; journey→script edges are still built by the journey scan, and the "scripts" phase now reports determinate X/Y over the full list. `scanAllEmailTemplates` adds leaf entities. **Net cost ≈ +1 list call, and FEWER calls than before** (no BFS fetches). Live-verified on sb3 alpha: 1164 scripts / 521 require() edges / 886 esv edges / 1144 journey-node edges, all resolved without the BFS. **Zero changes** to the index model, the three query modes, or the Search UI — they already handled zero-inbound-edge entities. **Consumer compatibility (verified):** orphan entities open the right inspector card via `spawnByDescriptor` (journey-independent); an orphan script that references an esv/lib correctly appears in that target's find-usages **flagged `orphanRoot` ("⚠ no journey reaches this") and excluded from `usageCount`** (the D37 design already anticipated non-journey roots). **Intended behavior shift:** **Unused** is now a true tenant-wide dead-code detector (broader results). **Non-regressive:** the index has exactly **one consumer (the Search page)**; a throwing `listScripts`/`listEmailTemplates` degrades to the prior journey-referenced index (best-effort try/catch/warn).

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

### D41 — On-prem PingAM / ForgeRock AM support: extend in place behind an auth-strategy seam

**Goal.** Point the same tool at a self-managed **on-prem PingAM / ForgeRock AM** host, not just PAIC cloud, and get the same journey dependency-graph functionality — browse realms, open journeys, resolve their transitive script / inner-journey / social-IdP tree.

**Audit (2026-06-10, validated against a live AM 7.5.2 bed — `poc/onprem-am/`).** Probed every endpoint the journey code calls. They split three ways on-prem:
- **Tier A — AM-native, byte-identical to PAIC:** realms (`global-config/realms`), journeys (`…/authenticationtrees/trees`), node payloads (`…/nodes/{type}/{id}`), scripts (by id + `_queryFilter=name eq`), social IdPs (`SocialIdentityProviders` `_action=nextdescendents`). Same URLs, same `Accept-API-Version`, same response shapes, same mappers. **Works on-prem unchanged.**
- **Tier B — IDM (themes `/openidm/.../themerealm`, email templates `/openidm/.../emailTemplate`):** 404 — a standalone AM has no IDM webapp. PAIC bundles IDM; we don't.
- **Tier C — IDC platform (ESVs `/environment/variables|secrets`):** 404 — a PAIC-cloud management API, no on-prem equivalent.
- **Auth:** PAIC's `/am/oauth2/access_token` JWT-bearer flow 404s on-prem ("No OAuth2 provider"). On-prem auth is a **session token**: `POST /am/json/realms/root/authenticate` with `X-OpenAM-Username/Password` → `tokenId`, sent as a cookie (name discovered via `/am/json/serverinfo/*`).

The resolver already treats Tier-B/C lookups as best-effort (miss → `null`, logged), so the core journey graph fully resolves on-prem — it just omits theme / email / ESV children. Full inventory + reproducible probe in `poc/onprem-am/ENDPOINT-AUDIT.md` + `audit-endpoints.sh`.

**Rejected — a standalone `src/onprem/` module tree.** The audit shows the only real difference is **auth**; the entire data layer (client, mappers, realm-path, pagination, resolver walk) and every consumer (tree, inspector, search) are shared, identical code. A parallel tree would duplicate ~90% of the codebase to vary one seam — guaranteeing divergence and double-maintenance. Rejected.

**Decision.** **Extend in place behind a single auth-strategy seam.** One shared client / resolver / UI, parameterized by `(authStrategy, basePath, capabilityFlags)`.

- `Connection` becomes a **`kind`-discriminated union** (`paic` | `onprem`). A stored connection with no `kind` normalizes to `paic` — existing users' configs keep working untouched.
  - `paic`: `{ host, saId, name? }` (unchanged) — secret = JWK.
  - `onprem`: `{ baseUrl, username, name? }` — secret = password.
- New `src/auth/` — the only new sub-area, a plug-in not a fork:
  - `strategy.ts` — `interface AuthStrategy { applyAuthHeaders(headers, { forceRefresh? }): Promise<void> }`.
  - `paic-strategy.ts` — wraps existing `mintToken` + token cache (lifted from `client-cache.ts`) → `Authorization: Bearer`.
  - `onprem-strategy.ts` — `authenticate` + cookie-name discovery + session cache → `Cookie: <name>=<token>`.
- `paic/http.ts` takes an `AuthStrategy` instead of `getToken: () => string`; its 401 self-heal calls with `forceRefresh`. The only behavioral change to the shared transport.
- `paic/client.ts` parameterized (config, not branches): the `/am` context path is derived from the connection (on-prem WARs can deploy under any path); on-prem capability flags short-circuit the Tier-B/C methods to `null`/`[]` so we don't pay 404 round-trips. On-prem realm default = root (no forced `alpha`/`bravo`).
- Connection form splits by kind (toggle → two field groups, per-kind Test Connection); `tenants/registry.ts` generalizes the secret key `saJwk.<host>` → `secret.<id>` (reads the old key for existing PAIC connections).
- `src/paic/` is now really "the AM REST client" — an optional later rename to `src/am/` reads truer but is cosmetic churn; defer.

**Supersedes the prior non-goals** "no non-PAIC ForgeRock deployments" and "service-account JWT-bearer only" (those were v1 scoping; self-managed on-prem AM with session auth is now in scope). Still out: PingOne, PingFederate, and 2FA/SSO/basic-auth login flows.

**Implementation order (= M8 slices):**
1. Connection model — `kind` union + normalize helper (back-compat default `paic`).
2. Auth-strategy seam — `src/auth/` + `http.ts` takes a strategy + `client-cache.ts` picks by kind.
3. Shared-client parameterization — injected base path + Tier-B/C capability short-circuit + on-prem root-realm default.
4. Connection form + registry — kind toggle, two field groups, per-kind Test Connection, generalized secret storage + `package.json` schema.
5. Tests — `onprem-strategy`, `client-cache` kind-branch, form payload, registry round-trip; live test behind `PAIC_LIVE=1` against the `poc/onprem-am/` bed.

### D42 — Cross-environment transfer (export / import / compare): initiative, phased roadmap, bundle format, Phase-1 leaf export

**New initiative (scoping 2026-06).** Extend the tool from read-only analysis toward moving and comparing journeys + components **across connections (environments)**. Validated by a live endpoint-CRUD POC against a PAIC sandbox tenant + the on-prem AM bed; the confirmed endpoints, status codes, diff masks, and gotchas are the committed [transfer-endpoints.md](transfer-endpoints.md) reference.

**Relationship to D6 (read-only).** Export and Compare are **read-only** and stay fully within D6. Only **Import (write)** lifts D6 — when it lands it gets its own decision amending D6 + the "No write operations" non-goal. **Phase 1 (leaf export) is export-only → no D6 change.**

**Phased roadmap (risk-staged):**
1. **Leaf export** (read-only) — Export button on each leaf card → frodo-compatible per-type JSON. ← M9 first slice
2. **Journey export** — `{meta, trees}` bundle (tree + nodes + leaf closure), depth toggle.
3. **Compare** — diff two bundles (file↔file, file↔live). Still read-only; rides on the export serializer.
4. **Import** (write — amends D6) — ordered PUTs (scripts→nodes→tree) with pre-flight validation; no rollback in AM, so validate-before-first-write. The careful, isolated phase.
5. **Transfer page** — centralized from→to UI over the proven engine.

**Bundle format — adopt frodo / PAIC-UI shapes verbatim (interop):**
- **Journey bundle** = frodo `MultiTreeExportInterface`: `{ meta, trees: { <name>: SingleTreeExportInterface } }`.
- **Single-leaf export** = frodo per-type interface: `{ meta, <kind>: { <id>: <raw entity> } }` (`script` / `theme` / `emailTemplate` / `variable` / `secret` / `idp`).
- **Interop contract:** our bundles must import via `frodo` and the PAIC-UI "Import"; verify by round-trip (export-ours → import-theirs). Emit the **stringified-string** script-body form (what PAIC-UI uses; frodo also accepts it) and quarantine all extra fields inside `meta` so a `trees`-only reader is unaffected.

**Export options — two orthogonal axes (journey export):**
- **Content axis: leaf contents are ALWAYS bundled.** No skeleton/reference-only *import* path — comparison and conflict detection are impossible without the bodies, and a contents-less bundle is self-unverifiable (produces broken-journey 404s). frodo's `--no-deps` is unsafe for cross-env import (structure-preview / same-env only).
- **Depth axis: inner-journey depth is a deliberate TOGGLE** (`Level 1 only` default / `All levels` closure). Always-deep is an *integrity hazard* (importing the full closure overwrites shared sub-journeys; ~21× blast radius), not a win.
- **Unbundled deps → a `requires` manifest** (inner journeys when shallow + ESVs + custom node types) for import pre-flight.

**Metadata block** (`meta`, on by default, opt-out): provenance + version-skew + self-describing depth. **The comparison engine never diffs `meta`** (timestamps churn). Strip server-managed diff-mask fields at export (`_rev`, `createdBy`/`creationDate`, `lastModifiedBy`/`lastModifiedDate`, `evaluatorVersion`, per-leaf `loaded`/`lastChange*`/`_type`) — but **keep `_id`** (UUIDs are preserved on import → real transferable identity). Fields: `bundleSchemaVersion`, `origin`, `originAmVersion`, `connectionType`, `realm`, `exportedBy`, `exportDate`, `exportTool` (`"paic-journeys-vscode"`), `exportToolVersion`, + journey-only `depthMode` (informational). **Refined by D45/PD-18 — the derived fields (`requires`, `treesSelectedForExport`, `innerTreesIncluded`) are NOT emitted: `meta` is non-load-bearing provenance; the import derives everything from tree content.** (Future: a scrub-provenance option for external sharing.)

**Per-leaf transfer surface (POC-confirmed — endpoints, masks, gotchas; full reference in [transfer-endpoints.md](transfer-endpoints.md)).** All 7 leaves round-trip full CRUD on PAIC; the 3 AM-native leaves are **identical** on bare AM (no per-leaf deployment branch — only auth + base path differ); the 4 IDM/platform leaves are N/A on on-prem.

| Leaf | Match | Deploy | Endpoint (C/R/U/D) | Notes |
|---|---|---|---|---|
| Script / library script | UUID / name | both | `PUT(201)/GET/PUT/DELETE /am/json/<realm>/scripts/<id>` | **client-chosen UUID preserved**; lib resolves via `_queryFilter=name eq "<n>"` |
| Social IdP | (type, id) | both | `…/SocialIdentityProviders/<typeId>/<id>` | **clientSecret redacted on read** (re-supply on import) |
| Email template | name | PAIC | `/openidm/config/emailTemplate/<name>` | diff mask = `_id` only |
| ESV variable | name | PAIC | `/environment/variables/<hyphen-id>` | value readable; dotted↔hyphen id |
| ESV secret | name | PAIC | `/environment/secrets/<hyphen-id>` (+ `/versions?_action=create`) | **value write-only** → import prompts |
| Theme | id / name | PAIC | whole-doc splice on `/openidm/config/ui/themerealm` | never a per-theme PUT |

**Phase-1 leaf-export architecture (the only new code; ~75% reuses the card/message/command stack):**
- **Raw-fetch path** — `PaicClient` returns *mapped domain* types; export needs the **raw REST** object → add a raw passthrough accessor (sibling to `buildSelectPayload`).
- **Serializer** — `src/export/serialize.ts` (pure TS, no vscode): frodo per-type shape + `meta` + strip mask fields + string body.
- **Command + save** — `paicJourneys.exportComponent`: raw-fetch → serialize → `vscode.window.showSaveDialog` → write. Webview never touches FS/network.
- **Card buttons** — mirror the existing `ScriptCard.onOpenBody` button → `messages.ts` gains an `exportComponent` W2E variant → `panel.ts:onMessage` routes it to the command (same shape as `openScriptBody`).

**Script-dependency closure + comparison depth (TD-3 / TD-4).**
- **Script deps are captured FLAT, never nested.** A script's `require('<lib>')` / `esv.<X>` edges live as text in the JS body, so a single-script object can't represent the `script → lib → lib → esv` closure. When depth is needed (journey export / Compare), transitively-required libs are added **side-by-side in the same `script` map** (deduped by id) and ESVs go in the `requires` manifest — *not* a new nested format (matches frodo/PAIC-UI; the D20 transitive-`require()` resolver already produces the closure). A **single-leaf** script export stays a **single object** (matches `frodo script export -i`) — no closure bundled.
- **Comparison depth:** value-compare the **entity you select to transfer**; **existence-check its dependency closure** (libs + ESVs = the `requires` pre-flight). **ESV values are never value-compared** (env-specific by design; secrets unreadable). **Library scripts** are existence-checked **+ an optional non-blocking "lib body differs" note** (libs are code — "exists but different" silently changes behavior, and we already have the bodies). **Secret values / custom node types** are existence-only (unreadable).

**Journey / sub-journey export — depth representation + UI (TD-5).**
- **One envelope, no structural fork.** Level-1 and All-levels are both `{ meta, trees }` (proven by the PAIC-UI captures). The depth is carried by **content**: Level-1 → only the selected journey is in `trees` (inner journeys referenced by name); All-levels → the selected journey **+ the full transitive inner-journey closure** as sibling trees. The JSON is self-describing **from content alone** (D45/PD-18): per inner journey, *bundled* = its tree is present in `trees`, *referenced-but-not-bundled* = it isn't — the import preflight reads this from content, never from `meta`. `meta.depthMode` is informational only. Do **not** invent a second JSON shape.
- **UI:** the only choice is inner-journey depth (contents always bundled, TD-1) → an **Export… button on `JourneyCard` + `InnerJourneyCard`** → a 2-item **QuickPick** (`Level 1 only` *(default)* / `All levels`, each with a consequence `detail`) → `showSaveDialog`. All-levels runs the **D35 resolver** closure walk under `withProgress`. The "would touch N journeys" blast-radius count is deferred to **import** (read-only export only costs file size).
- **Engine:** reuse the D35 resolver + Slice-2 leaf serializers + meta builder; the one new piece is a per-tree `SingleTreeExportInterface` assembler.

**Import (write — P4; amends D6) — design (TD-6).** Dedicated `src/webview/transfer/` page (4th React entry — **peer to Search, reuses the framework but NOT the Search surface**: read-vs-write boundary, a source+target *pair* scope, its own singleton). **File-first** workflow — ① Source (upload → `meta` + detected type, zero-network) → ② Target (connection + realm) → ③ Plan/compat → ④ Resolve (secret re-supply) → ⑤ Execute — reveal-on-complete; chosen over connection-first because the file is the subject and one bundle is often evaluated against N targets. Per-component **compatibility gate** vs the *target's* capability matrix (on-prem = script/lib/idp only → **hard-block** a sole unsupported artifact, **skip-with-warn** an incidental dep). **Three-tier compare** — value-compare the primary (journey/tree + its decision scripts) · **non-blocking** library-body-diff note (we already hold the bodies, TD-3/TD-4) · existence-only for ESV / secret-value / custom-node-type — run over **fresh REST by identity, NOT the metadata-only & staleness-prone RealmIndex** (reuse the export accessors + serializer `stripMask`/normalize on *both* sides). Redacted `clientSecret` / secret values **re-supplied** via one shared prompt. **Validate-before-first-write** (AM has no rollback) → ordered leaf-first PUTs + per-component log, no fake atomicity. **Risk-staged in 3 batches:** B1 atoms (theme/email/idp — CRUD-proven, build-ready) · B2 ESV + script/lib (stringified→base64 body [POC-proven] + write-only re-supply + name→UUID lib reuse) · B3 journey wiring (node→tree order, inner-tree-first — the one remaining POC). Full form: TD-6.

**Import Plan-table layout (TD-8 — refines TD-6's Plan/Resolve steps; applies to script/lib import AND journey import).** The Plan section renders as **one CSS-grid row set (NOT an HTML `<table>`)** so the same template is reused by leaf, script-closure, and journey imports — VS Code-idiomatic (Source Control / Testing panels are grid rows), keeps the existing flex markup as a small `display:grid` edit, makes the action + checkbox columns trivial, and themes/resizes cleanly. Locked sub-decisions:
- **Two sections, clean split of labor.** **Source** shows only the bundle's **top-level subject** (metadata block + the primary component name) — a single-leaf bundle physically contains only that object; the lib/ESV closure isn't in the file. The **flat closure** (script → libs → ESVs, deduped by the D20/D35 walk) appears **only in the Plan view**, never duplicated in Source.
- **Source rows = name + type only, no detail.** Drop `leafDetail` from the Source preview so every kind renders identically (type icon + type name + name), consistent across all atoms. **The earlier ESV-variable decoded-value exception is removed** — the value still travels in the bundle and is used on write, just not surfaced in Source. (Information loss to accept: the social-IdP provider-type detail, which wasn't derivable from the kind.)
- **Plan column order: ☑ · Action · Type · Status · Name.** **Status** is a read-only fact about the target (New / Differs / Identical / Present / Unsupported, set by the compare). **Action** is the *reactive consequence* of the checkbox (Create / Overwrite / Skip / Blocked) — the verb flips live as the user toggles. Two distinct columns on purpose: status = what *is*, action = what *will happen*.
- **Status uses text + the existing `transfer-v-*` color classes, NO new icon set** — words the user already knows (Differs/New/Identical/…), color (green/yellow/red) the only added signal. **Type column = codicon + type word** (`⚙ Script`, `📄 Library`, `{} ESV var`, `🔒 ESV secret`, `⬡ Node type`) — the only place library-vs-decision is distinguished now that the detail is gone.
- **Per-row checkbox + ONE final button — no per-row write buttons.** Preserves D43's single-modal-confirm safety model (one ordered batch naming host+realm+counts). Bottom button summarizes the verbs (`Import N selected · 1 create · 2 overwrite`) = a live preview of the confirm-modal summary.
- **Checkbox state is status-driven, three row-states.** Writable (New/Differs) → live checkbox, default checked, reactive verb. **No-op (Identical / ESV Present) → checkbox disabled + greyed (muted row), Action locked to `Skip`** — overwriting an identical entity is a no-op, and ESV import is create-only by design (never clobber an env-specific value), so the locked checkbox is the honest UI. Unsupported → no checkbox (`—`), Action `Blocked` (red). (This supersedes the earlier "Identical optionally-writable" idea — Identical is now a locked Skip, removing the force-overwrite foot-gun.)
- **Table sorted by type, reusing the existing flat-view `KIND_ORDER`** (`src/webview/inspector/ui/cards/grouping.ts`, itself mirroring the sidebar D33 order): innerJourney → script → libraryScript → theme → emailTemplate → socialIdp → esvVariable → esvSecret → esvMissing; within a bucket, `localeCompare(..., {sensitivity:"base"})` by name. Status does NOT affect sort (an Identical lib sits inside the Library bucket where its name sorts, not floated to the bottom). **Resolved (built):** divider rows **dropped** — a full-width divider breaks the grid alignment, and the Type column (codicon + word) makes grouping self-evident. **Built** in `src/webview/transfer/ui/{App.tsx,kind-meta.ts}` — one CSS grid via `display:contents` rows; `display:contents` precludes a row-hover background, accepted; library-vs-decision both show "Script" (the verdict carries no `context` — a future `isLibrary` flag could split them). Per-row checkbox selection threads to `panel.ts:handleExecute` via the `execute` message's `selected: string[]`.

**Script cross-env identity + import closure discovery (TD-9 — refines TD-3/TD-4; the script half of import).** Settled while designing script-dependency discovery. Locked sub-decisions:
- **Identity model — UUID in-env, NAME cross-env.** A script's stable identity *within* one tenant is its **UUID** (`_id`) — every REST/tree/resolver/index/export site keys on it. But the SAME logical script has a **different UUID in each tenant**, and `require('<lib>')` binds **by name** (AM resolves `require()` by name at runtime). So **across environments the NAME is the identity** — two scripts named `fraud-helpers` are interchangeable to every caller regardless of UUID. This is the one component whose name ≠ id (audit-confirmed: journey/email/socialIdp/ESV all have name == id; theme is UUID but isn't name-looked-up in the closure). Consequence: cross-env script matching is **by name** (`getRawScriptByName`), inheriting AM's non-unique-name reality → surface the dup-name case, never pretend it away.
- **Write reconciliation (fixes the Seam-2 gap).** Because name is the cross-env identity, the import write must **overwrite the name-matched target entity**: pre-flight captures the resolved target's `_id` (+ same-name hit count); execute writes to that **`resolvedTargetId`**, falling back to the bundle UUID only on a true create. Blindly PUTting the bundle UUID (the prior behavior) is inconsistent with the name-identity model and could create a duplicate / overwrite the wrong same-named script. Dup-name (>1 hit) → pick-first + a `(N on target)` note in the Plan; the platform doesn't define which of N is canonical, so we don't auto-pick silently.
- **Create-path UUID-collision guard.** A subtle corollary of the above: on a **create** (no name match), the write falls back to the bundle's `_id` — but that UUID may **already be occupied by a *differently-named* script** on the target (e.g. `Foo`@`U1` was exported, imported to B, then renamed to `Bar`; re-importing `Foo` finds no name match → "create" → `PUT /scripts/U1` would silently overwrite `Bar` and mislabel it `created`). AM's `PUT` overwrites whatever lives at the UUID. So pre-flight, on the create path, also checks whether the bundle UUID is occupied (`getRawScript(realm, bundleId)`): **404 → safe create**; **200 → a different script holds that UUID → verdict `id-collision` (blocked, not selectable)**, naming the occupant. We **do not** silently overwrite, and we **do not** re-mint a fresh UUID (that would break cross-env reference stability — the reason we preserve UUIDs); the user resolves the collision manually. Only applies when the bundle UUID matches AND the name does not (a name match is already handled by reconciliation above).
- **Closure discovery is bundle-only, depth-1, existence-only.** The bundle is **self-contained** (TD-2/TD-6) — it carries only the top-level script, NOT its libs' bodies; import is **file-first** with **no source connection** and **must not phone home** to the origin tenant (a recipient may only hold the target conn). So we discover deps by running the pure `extractScriptBodyRefs` (`src/util/script-body-parser.ts`, the D20 extractor) on the **bundle script's own body** → its direct `require()` libs + `esv.*` refs. We **cannot** recurse `lib→lib` (no lib body to read; a missing lib is **name-terminal** — no UUID resolvable anywhere), so this is **level-1, existence-only** — exactly TD-4's "existence-check the dependency closure." NOT `walkRoot` (it needs a live tenant holding every body). Discovered deps are **info-only** ("what this script needs on the target": present / missing), never importable rows, rendered in a read-only **"Requires"** subsection (honest label — direct refs, not a full closure). ESV refs existence-check against the tenant ESV lists fetched once per pre-flight (mirror `walk.ts:ensureEsvIndex`), not per-ref.
- **Missing-dependency policy = warn, don't block (advisory).** A referenced dep absent on the target is an **unmet environment prerequisite** the bundle can't supply (no body/value), so an imported script may fail at runtime until the user adds it. We **do not hard-block** — discovery is depth-1, name-based and regex-driven, so a false "missing" must not refuse a legitimate import, and the platform itself permits saving a script that references a not-yet-present lib. Instead the **confirm modal** names the missing deps (`missingDepsNote`, `src/import/preflight.ts`) so the consequence is unmissable at the decision point, but Import stays enabled. (Hard-block reserved for a future locked-down promote-to-prod flow, if one is added.)

**Plan-table semantics — single three-phase Status column + opt-in selection + lock-after-import (TD-10 — refines/supersedes parts of TD-8).** The Plan grid is one table (deps folded in per the post-TD-9 decision). **There is NO separate Action column** — a single **Status** column tells the whole story across **three phases**, its text driven by the checkbox + run state. Columns: **☑ · Type · Status · Name**. **Checkbox** = "accept the suggested action?", **default OFF**, opt-in row by row, with a tri-state **select-all** header checkbox over the actionable rows only. **After a completed import the entire table LOCKS read-only** (checkboxes + Import button disabled) — it becomes the final result report. It re-arms only on a fresh pre-flight: **re-selecting the target (connection/realm, even the same realm) or choosing a new bundle**. This makes the table itself the result surface — **no separate post-import message/log section**.

Three-phase Status mapping (the source of truth — implement to this):

| Row type | **Phase 1 — before** (preflight) | **Phase 2 — selected** (checked, pre-import) | **Phase 3 — after** (import done) | Checkbox |
|---|---|---|---|---|
| Component absent | `New` | `Create` | `Created` (or `Failed`) | ☐ selectable, default off |
| Component differs | `Differs` | `Overwrite` | `Overwritten` (or `Failed`) | ☐ selectable, default off |
| Component identical | `Identical` | — (can't select) | `Identical` | disabled |
| ESV/secret present | `Present` | — | `Present` | disabled |
| Unsupported on target | `Unsupported` | — | `Unsupported` | disabled |
| Pre-flight error | `Error` | — | `Error` | disabled |
| Dep (lib/ESV) missing | `Missing` | — | `Missing` | disabled |
| Dep (lib/ESV) present | `Present` | — | `Present` | disabled |

Checkbox column is uniform: **every non-actionable row shows a disabled, unchecked checkbox** (no `—` placeholder) — only New/Differs rows have a live checkbox. Phase rules: Phase-2 text appears only for a **checked** actionable row (uncheck → reverts to Phase-1 `New`/`Differs`). Phase-3 is set per-row from the `WriteResult`: a selected New→`Created`, selected Differs→`Overwritten`, either on error→`Failed`; an actionable row left **unchecked** that the run skipped → `Skipped`. Status color tracks the phase (`Create`/`Created` green-ish, `Overwrite`/`Overwritten` warn, `Failed`/`Missing`/`Unsupported`/`Error` error, `Identical`/`Present`/`Skipped` muted). The verb is **Overwrite**→**Overwritten** (the confirm modal also says "overwrite"). The Import button summarizes the checked actionable rows (`Import N selected · X create · Y overwrite`, disabled at 0); once the import completes the button + all checkboxes are disabled until re-armed. **Status: re-designed (supersedes TD-8's reactive-Action-verb + default-checked, and the earlier TD-10 two-phase + static-Action-column draft).**

**Overwrite-evidence affordances — per-row Diff + Find-usages (TD-11 — extends TD-10).** Overwriting a script silently replaces a *shared* dependency: the new body affects **every journey on the target that references it**, and the user can't weigh "overwrite?" without seeing (a) *what* changed and (b) *what it affects*. Our posture stays **inform, don't auto-fix** (no merge, no duplicate-on-import, no auto-remint — consistent with TD-9/missing-deps): we give the user the evidence and leave the decision theirs. The Plan table gains a 5th **Review** column (☑ · Type · Status · Name · **Review** — named "Review", not "Actions", since the buttons are read-only inspection that never mutate) with two buttons, shown on **every `differs` row** (checked or not — inspect *before* deciding), and empty on New / no-op / dep / blocked rows:

- **⇆ Diff** — opens VS Code's native diff editor. **LEFT** = the target's current version (the entity we'd actually overwrite — for scripts fetched live via the existing `paic-script://` FS provider at the **`resolvedTargetId`**, not the bundle UUID, per TD-9); **RIGHT** = the uploaded bundle's component. **Scripts-first (v1):** both sides shown as **`.js` source** (decoded — not the JSON wrapper). Other kinds (theme/email/idp/ESV) would diff as single-component **JSON** (not the whole bundle / whole `themerealm` doc) — **deferred** past v1. The one net-new piece is a small **`TextDocumentContentProvider`** (`paic-bundle://`) serving the in-memory bundle component's text as a diff side; the left side fully reuses `paic-script://`. Buttons stay live even when the table is locked (read-only for *selection*; inspecting a completed import is still useful).
- **🔍 Find usages** — opens the **Search page pre-filled** (`SearchFactory.spawn({ selectedHost, selectedRealm, prefill: { mode:"findUsages", targetKey:`${kind}:${id}`, targetKind } })`) and auto-runs the reverse-dependency query against the **target**, so the user sees which journeys reference the script they're about to overwrite. Near-100% reuse of the existing Search/`findUsages`/RealmIndex feature. The **RealmIndex build is the Search page's concern** — if the target isn't indexed it shows its own "Build index" affordance; the import flow neither builds it nor blocks on it (so no synchronous target-scan cost on the import path). **Opt-in by construction** — the cost is only paid when the user clicks.

**Built (TD-11):** `src/providers/bundle-content-provider.ts` (`PaicBundleContentProvider` / `paic-bundle://`, the diff right side) · `canonScriptBody` exported from `compare.ts` · `openDiff`/`openFindUsages` W2E messages + `panel.ts:handleOpenDiff` (left = `makeScriptUri(host, realm, targetScriptId, language)`, right = `bundleContent.set(...)`) + find-usages handler · `SearchFactory` + the bundle provider injected into `TransferFactory` (structural `SearchSpawner` type to avoid a cross-webview import) · UI `reviewFor`/`toEntityKind` + the **Review** column/buttons (scripts→both, theme/email/idp→Find-usages only). Buttons live even when the table is locked.

**Decision register.** Running sub-decisions originated in the gitignored `poc/transfer-endpoints/DESIGN-DECISIONS.md` (TD-1 export options · TD-2 metadata · TD-3 script closure · TD-4 comparison depth · TD-5 journey export · TD-6 import design · TD-7 ESV import + apply · TD-8 import Plan-table layout · TD-9 script cross-env identity + closure discovery · TD-10 Plan-table Action/Status/selection semantics · TD-11 overwrite-evidence Diff + Find-usages affordances); promoted into the committed record as D42 (export/compare/import design) + D43 (the write phase), with the empirical endpoint contract in [transfer-endpoints.md](transfer-endpoints.md).

### D43 — Import write phase (atom leaves + ESVs) — amends D6

**Lifts D6 for a bounded write surface** (M9 Phase 4 — Batch 1 Slice C + Batch 2 ESV slices). The Transfer page may now **write the 3 atom leaves** — theme, email template, social IdP — **and ESVs** (variable + secret) to a target tenant. Scripts/library scripts (Batch 2 other half), journeys (Batch 3), and any bulk/promote flow remain out. Every endpoint is empirically confirmed — see the committed [transfer-endpoints.md](transfer-endpoints.md) reference. Locked sub-decisions:

- **Semantics:** Execute writes verdict ∈ {New→create, Differs→overwrite}, skips Identical. "Overwrite" replaces the target's version entirely (no merge).
- **Safety gate:** a single `showWarningMessage({modal:true})` confirm naming **host + realm** + create/overwrite counts + "cannot be undone", after a **fresh validate-before-write pre-flight** (re-run compare immediately before writing; the modal shows the fresh counts). No setting-gate.
- **Secrets:** the redacted social-IdP `clientSecret` is re-supplied via extension-side `showInputBox({password:true})` — **never** in the webview. Collected **after** the confirm; cancelling skips that idp (never writes a blank secret).
- **Write mechanics:** **sequential** (theme writes splice the shared `themerealm` doc → parallel self-races), attempt-all, **no rollback**, per-component result log. Theme splice uses **`If-Match: <_rev>`** (412 → re-GET/re-splice once); preserves siblings; never changes the realm's default (`isDefault` preserved on overwrite, `false` on create). Email PUT strips `_id` (URL-derived); idp PUT keeps `_id`, drops server-added `_type`. Capability guard is a **throw** in the write methods (a silent skip would falsely report success). Never log secret values / `valueBase64` / full bodies.
- **ESV import + apply (Batch 2 ESV half):** ESVs (variable + secret) are **existence-only compare** (values are env-specific by design — dev `API_KEY` ≠ prod — and secrets are unreadable), so the verdict is only ever `new` or `exists`, never `differs` → ESV import is **create-only** (creates the absent, skips the present, never clobbers an env-specific value). **Value supply is asymmetric:** a variable bundle carries `valueBase64` verbatim (the exact raw PAIC field), so the variable write uses it **directly** — no prompt — and the Source preview decodes + shows it for transparency (never logged); a secret's value is **never on the wire** → the one `showInputBox({password:true})` prompt at write time (same pattern as the idp `clientSecret`). **Apply is a SEPARATE step, not auto-chained:** ESV writes land `loaded:false` (pending) and don't take effect until a **tenant-wide environment restart** (~3 min observed, ≤10 min). A distinct **"Apply ESV changes" button** → confirm modal (warns the restart applies *all* pending ESVs and blocks further ESV updates) → `POST /environment/startup?_action=restart` → poll `GET /environment/startup` until `ready`, with **durable host-keyed in-UI progress** that survives a realm change. The restart POST is **not retried** (non-idempotent) — on throw, re-GET status: `restarting` means it started anyway (continue), `ready` means it genuinely failed (rethrow); token re-mints during the restart are tolerated as ≤N consecutive poll errors. Apply mechanism + per-leaf ESV endpoints: [transfer-endpoints.md §2/§7/§8](transfer-endpoints.md).
- **Architecture:** `src/paic/http.ts` gains `put`; `src/paic/client.ts` gains `writeTheme`/`writeEmailTemplate`/`writeSocialIdp` + `writeEsvVariable`/`writeEsvSecret` + `getStartupStatus`/`applyEsvUpdates`; pure transforms in `src/import/write.ts`; client-injected orchestration in `src/import/execute.ts` (sequential writes) and `src/import/apply.ts` (`runEsvApply`, injectable sleep/now/onProgress) — both mirror `preflight.ts`. Full form: the Slice C + ESV slice plans + TD-6 / TD-7.

### D44 — One prompt surface: native modal for every decision; minimal physically-necessary exceptions

**Problem.** As the tool grew, user-decision prompts drifted across mechanisms: import + ESV-apply confirm via a **native modal** (`showWarningMessage({modal:true})`), but remove-connection confirms via a **YES/NO QuickPick** and export-depth picks via a **QuickPick** — two different idioms (and visual weights) for the same "the tool needs a decision" job. A QuickPick (the Command-Palette dropdown from the top, no dimming) reads far lighter than a modal (centered, dims the editor, blocks) — wrong for a tool whose defining actions are irreversible tenant writes.

**Decision — one prompt surface.** Use the **`window.show{Information,Warning,Error}Message` API for every prompt**, with the `{modal:true}` flag as the only dial:

- **Needs a decision/choice** (confirm a write/import, confirm ESV apply, confirm remove-connection, pick export depth, acknowledge something critical) → **native modal** `showWarningMessage({modal:true, detail}, "<Verb>"…)`. Buttons carry the choices; `detail` carries the explanation. Every decision looks and behaves identically.
- **Just informing** (non-blocking error / optional success) → the **same API without `modal`** → a toast.

**Why modal as the default (not QuickPick).** The most consequential category — confirming irreversible cross-environment writes — *must* be right, and the centered, blocking modal is VS Code's official confirmation idiom (the "Save changes before closing?" / "Are you sure you want to delete?" dialog). It also absorbs small N-way choices (export depth = two buttons + a `detail`) and acknowledgments. QuickPick is the natural alternative but is the wrong *weight* for destructive confirms and has **no documented confirmation pattern** in the VS Code UX guidelines. Verified against the official [Notifications](https://code.visualstudio.com/api/ux-guidelines/notifications), [Quick Picks](https://code.visualstudio.com/api/ux-guidelines/quick-picks), and [Webviews](https://code.visualstudio.com/api/ux-guidelines/webviews) guidance.

**The only exceptions — each because a modal physically can't do the job:**

| Exception | Why it can't be a modal | Where |
|---|---|---|
| `withProgress` | a modal can't show a running progress bar | import / ESV apply / export |
| `showInputBox` | a modal can't capture typed text | the 2 secret-entry fields |

A **webview** is *not* a prompt mechanism — it's the persistent app surface (Search, the Transfer plan, the connection form). Per the official "webviews only when absolutely necessary," we never render confirm-modals inside a webview; confirmation always uses the native modal.

**Deliberate deviation from the letter of the guideline.** The Notifications page suggests destructive-confirm modals offer an *Always/Never* "don't ask again." We **omit it for the tenant writes** (import / ESV apply): those are irreversible and high-blast-radius, so per-action friction is intentional. The Always/Never pattern targets *repetitive, non-critical* confirms; if we ever add it, the local-and-reversible remove-connection confirm is the only fair candidate.

**Mechanism.** All confirmations route through one shared helper (e.g. `confirm(title, detail, verb): Promise<boolean>` in `src/util/` or a webview-side equivalent) so the shape is guaranteed identical and there's a single place to evolve wording/behavior. `QuickPick` is retired from the codebase.

### D45 — Journey import (Batch 3) + cross-lifecycle upgrades: model, prior-art validation, apply lifecycle

Full working design lives in **`docs/journey-import-model.md`** (PD-1..PD-17). Empirical backing:
`poc/transfer-endpoints/TRACKER.md` §TD-12/§TD-13. Prior-art validation: `poc/prior-art/`. This entry is the
committed pointer + the locked themes; the dev sequence is in `docs/progress.md` (M9 Phase 4 Batch 3).

**Plan/decision model (PD-1..6).** One flat, type-sorted plan table — engine ordering / phases / inner-outer
are hidden. The chosen journey is the **header subject**, not a row; its **private nodes fold into it**, while
**shared refs (scripts/themes/IdPs/ESVs/inner journeys) are hoisted to their own deduped rows** (one resource
→ one decision; the target holds one physical copy). Every bundled journey is its own **flat unit row**
regardless of nesting depth (flat-all, not atomic-subtree), each with **Create / Overwrite / Keep** (Keep =
"use the target's" = level1 behavior; Overwrite = write my copy = allLevels).

**Amendment — journey own-scope identical compare (supersedes PD-5 "existence-only").** PD-5 originally made
journeys existence-only (verdict ∈ {new, exists}) because a **raw** node diff always reads "differs" cross-env.
That holds only *without* normalization. A journey unit's **own scope** is exactly what `journey-write.ts`
PUTs — its `tree` skeleton + node bodies — and everything in it lines up between a bundle and the target it was
imported into, once we apply the **same two normalizations the write already uses**: (1) `remapNodeScript` the
bundle's `ScriptedDecisionNode.script` UUID → its reconciled target UUID (TD-9), and (2) `stripMask` the
`_rev`/audit echoes (plus drop `_id`, matched by key, and the node-body `_type` echo, since node-type identity
is compared via the tree's node ref). Node UUIDs / `connections` / `entryNodeId` are written verbatim and
inner-tree refs are names → they already match. So `runPreflight` stays existence-only, but a **separate
display refinement** (`findIdenticalJourneys` → pure `journeyUnitIdentical`, reading the target's node bodies by
the bundle's own node ids) upgrades an existing journey to a third verdict, **`identical`** — a **locked no-op
row** (grey "Identical", like an identical leaf; not overwritable). It does **not** recurse into referenced
leaf scripts/inner journeys — those are their own rows; this judges only the journey's wiring. Critically the
refinement is **never fed to the freeze snapshot / drift check** (those keep keying journeys on raw
`new`/`exists`), so a preview-`identical` vs commit-`exists` can't read as false drift. Net effect: after a
clean import, a re-plan shows the just-written journeys as **Identical** instead of an ambiguous Keep/Overwrite.

**Empirical hard constraints (TD-12/TD-13).** A missing **inner journey** (level1) and a missing **node type**
are HARD — AM rejects the node write (`400 "…attribute, Tree Name"` / `404`) — so they're preflight blockers,
not soft warnings (unlike `require('lib')`/ESV text refs, which are runtime-only → advisory). Scripts are
**name-unique per realm** (`409` on dup name): the **UUID is the identifier**, the **name is the cross-env
match key** → reconcile by name + **remap node→script refs `bundleUUID→targetUUID`** (libs/themes/IdPs may
need the same — open).

**Prior-art-validated upgrades (PD-11..13).** A 6-product investigation (Terraform · ServiceNow · Power
Platform · Keycloak · Salesforce/Gearset · low-code) reinforced ~9/10 decisions and added: **freeze the plan**
(snapshot decisions + remap + target state at preview; import runs exactly that; drift → re-plan — kills the
preview→commit TOCTOU); a **pre-write "no source UUID survives" assertion** (every tool that skipped the remap
broke); and **Overwrite = update-in-place PUT, never delete-then-recreate** (a live auth journey must never
have a missing-tree window — Keycloak's #1 failure).

**Error handling (PD-14/15).** Parse the **AM/IDM REST error envelope** (`code/reason/message/detail`) so
import failures are actionable, + frodo's `Invalid attribute specified` strip-and-retry — *also fixes a
verified latent bug in shipping leaf-import code*. The journey executor is **dependency-aware** (a failed
prerequisite skips its dependents with a clear reason; the batch never aborts; per-item result).

**Apply lifecycle (PD-16/17).** confirm (have) → **determinate progress** (bar + live row updates) →
**downloadable JSON result report** (per-item before/after from the frozen snapshot; success + partial). The
report is shaped now to power a **future quick rollback** (time-bounded, reverse-precheck-gated — drift makes
it meaningless after a few days; no union source, unlike git).

**Source of truth (PD-18).** `meta` is **non-load-bearing provenance** — the import derives **100% from tree
structure** and would work with no `meta` at all. No import decision reads `meta`: subject = the
`innerTreeOnly:false` tree; required node types = each node's `_type._id`; referenced inner journeys =
`InnerTreeEvaluatorNode.tree`; esvs/libs = script bodies; bundled-vs-referenced (level1/allLevels) is derived
**per inner journey** from "is that tree present in `trees`?" (so even `depthMode` is informational).
**Amends D42**: the journey export drops the derived meta fields (`requires`, `treesSelectedForExport`,
`innerTreesIncluded`); `meta` = pure provenance.

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

### M8 — On-prem PingAM / ForgeRock AM support

**User-facing outcome:** *"I can add an **On-prem AM** connection (base URL + admin username/password, instead of a service account + JWK) and browse / resolve its journeys exactly like a PAIC tenant — realms, journeys, scripts, inner journeys, social IdPs. Themes / email templates / ESVs simply don't appear (they're PAIC-platform-only)."*

Implements D41; reuses the entire data layer and every consumer unchanged — the only new code is the auth strategy + the form variant. Validated against the `poc/onprem-am/` bed (AM 7.5.2 + a seeded journey graph exercising every on-prem-available edge).

- **Slice 1 — connection model:** `kind`-discriminated union; normalize legacy configs → `paic`.
- **Slice 2 — auth seam:** `src/auth/{strategy,paic-strategy,onprem-strategy}.ts`; `http.ts` consumes an `AuthStrategy`; `client-cache.ts` selects by kind.
- **Slice 3 — shared-client parameterization:** injected AM context path; on-prem short-circuits Tier-B/C resource methods; root-realm default.
- **Slice 4 — form + storage:** connection form split by kind; `registry.ts` generalized secret storage; `package.json` settings schema for the union.
- **Slice 5 — tests:** `onprem-strategy`, `client-cache` kind-branch, form payload, registry round-trip; live tests behind `PAIC_LIVE=1` against the bed.

### M9 — Cross-environment transfer (export / import / compare)

**User-facing outcome (Phase 1):** *"I can click **Export** on any leaf component's card — script, library script, theme, email template, social IdP, ESV — and save a frodo / PAIC-UI-compatible JSON file to disk."*

Implements **D42**. Read-only export → no D6 change. Phased: **P1 leaf export** (this milestone's first slice) → P2 journey export → P3 compare → P4 import (will amend D6) → P5 transfer page.

- **Phase 1 — leaf export:** raw-fetch accessor + `src/export/serialize.ts` (frodo per-type shape + `meta`, per D42) + `paicJourneys.exportComponent` command + save dialog + an Export button on all six leaf cards. ~75% reuses the existing card→message→command plumbing (`openScriptBody` is the template); the only new code is the raw accessor + serializer + save dialog.
- Endpoint surface + diff masks validated by the `poc/transfer-endpoints/` CRUD POC (all 7 leaves on PAIC; the 3 AM-native leaves identical on the on-prem bed).
- **Phase 4 / Batch 3 — journey import + cross-lifecycle upgrades:** fully designed in **D45** + `docs/journey-import-model.md`; structural constraints proven (TD-12/TD-13) and prior-art-validated (`poc/prior-art/`). The base→apply upgrades the research surfaced (actionable errors, freeze-the-plan, determinate progress, JSON report, future rollback) are sequenced as a series of dev slices in `docs/progress.md` (M9 Phase 4 Batch 3).

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

- Write operations are limited to the **import of the 3 atom leaves** (theme / email template / social IdP), gated by a modal confirm (**D43**, amends D6). Browse, analysis, and **export** stay read-only; scripts/ESVs/journeys are not yet writable; no bulk/promote flow.
- No alternative auth flows (2FA, SSO, basic auth). PAIC = service-account JWT-bearer; on-prem AM = admin username/password → session token (D41). Nothing else.
- No support for PingOne or PingFederate. (Self-managed on-prem PingAM / ForgeRock AM **is** now in scope — see D41 / M8.)
- No telemetry, no analytics, no remote sync.
- No "live diff" between editor changes and tenant state.
- No on-disk cache of derived data (per D8). The lone exception is the *explicit user action* "save graph" in M7.
- No database. Ever. None of our access patterns are DB-shaped (we do graph BFS over small in-memory structures, not SELECT-WHERE-JOIN). Bringing in SQLite would add cross-platform binary headaches and break Settings Sync, with zero query benefit.
