# Lessons

Corrections and patterns to avoid repeating. Append entries here whenever a user correction or a failed assumption would otherwise get lost.

## Format

```
## YYYY-MM-DD — Short title
**Context:** what we were doing
**Mistake:** what we assumed or did wrong
**Correction:** what the right thing is
**How to avoid next time:** the rule to apply
```

---

<!-- Entries below, newest first. -->

## 2026-08-21 — The `mapConcurrent` lesson didn't generalize: a *new* subsystem shipped with unbounded `Promise.all`

**Context:** A live import over a degraded link showed 3 of ~13 script rows failing `read ECONNRESET` in the transfer pre-flight, while every journey / theme / node-type row succeeded.
**Mistake:** We fixed unbounded concurrency in the resolver (2026-05-19) by introducing `makeLimiter` and routing `walk.ts` / `build.ts` / `journey-bundle.ts` / the tree expanders through it — and then wrote the entire `src/import/` pre-flight afterwards with bare `Promise.all` over every component, plus a *nested* `Promise.all` (journeys × node bodies) in `readJourneyCompareInputs`. The lesson was recorded as a fix to specific files, not as a rule applied to new fan-out. Scripts took the visible damage only because `findRawScriptsByName` returns full base64 script bodies — the fattest response in the burst — but the burst was the cause, not the scripts.
**Correction:** One shared `makeLimiter(10)` per pre-flight run. Critically, applied by wrapping the **client** (`limited-client.ts`), *not* by threading the limiter through the orchestrating functions — an outer task that holds a slot while awaiting its inner tasks deadlocks once all `n` slots are outer tasks. Limiting only leaf HTTP calls is structurally deadlock-free. See D46 / PD-19.
**How to avoid next time:** Treat "does this fan out over HTTP?" as a checklist item on every new subsystem, not as a bug class already closed. Grep for `Promise.all(` over a client call in any new layer before it ships. And when a limiter must span multiple phases, wrap the **client**, never the phase functions — nested limiter acquisition is a deadlock, and the deadlock only appears under load.

## 2026-08-21 — A transient read error silently downgraded a hard dependency instead of blocking the import

**Context:** Investigating the ECONNRESET rows above, tracing what an `error` verdict actually does downstream.
**Mistake:** We modelled `error` as just another non-writable status and let it share the `blocked` row state with `unsupported`. But the two are opposites: `unsupported` is a **known** fact (the target can't take this kind → safe to skip), while `error` is an **unknown** target state. Because `importDisabled` weighed only `blockingMissing` (the PD-7 gates), Import stayed enabled; `buildScriptRemap` skipped the errored script (no `resolvedTargetId`), so the journey node kept the *bundle's* UUID; and `journey-assemble.ts` dropped it from the write plan. A 300 ms network blip therefore produced a journey imported with a dangling script reference, with no warning anywhere.
**Correction:** `error` gates Import (PD-20), with a targeted "Recheck failed (N)" as the escape hatch. `unsupported` keeps its skip semantics.
**How to avoid next time:** When adding a status to a state enum, ask "is this a fact about the target, or an absence of knowledge about the target?" Absence-of-knowledge must never be routed into the same bucket as a known-safe skip — especially where a *hard dependency* can be quietly dropped from a write plan. Trace every new status all the way to the write, not just to the renderer.

## 2026-06-15 — Modal button order (incl. "Cancel last") is an OS convention VS Code enforces — not overridable

**Context:** Asked to make Cancel the last button in the export-depth modal (and all confirm modals).
**Mistake:** Assumed the button order — and Cancel's position — was ours to control. Tried switching `dialogs.ts` to the `MessageItem[]` overload with an explicit trailing `{title:"Cancel", isCloseAffordance:true}`. Zero visible effect on Linux.
**Correction:** VS Code's modal renderer fixes the button order **per OS**: Windows = `Primary · … · Cancel` (Cancel last); **Linux/Mac = `…others · Cancel · Primary`** — the **primary/affirmative action is rightmost**, Cancel to its left. The rightmost slot is reserved for the primary, so **Cancel can never be last on Linux**, regardless of array order. `isCloseAffordance` only sets which button Esc triggers, NOT its left-right position. Reverted the change (it was a no-op).
**How to avoid next time:** Don't try to control native-modal button order or Cancel placement from an extension — it's OS-determined and correct as-is (it matches every native dialog on that platform). The only real lever is **which item is the primary** (first item = the rightmost, highlighted default). Refs: vscode#151874, #21148, #71251.

## 2026-06-15 — On-prem compat matrix omitted `journey` → a "supported" kind read `unsupported` → silent Keep → broken wire-up

**Context:** Cross-env C1 test — importing a journey bundle to on-prem AM. The compat gate (`compatFor`/`ONPREM_SUPPORTED`) decides which `BundleKind`s an on-prem target accepts.
**Mistake:** `ONPREM_SUPPORTED` was authored during the **leaf** batch as `{script, socialIdp}` and never updated when journey import (Batch 3) landed — so `compatFor("journey","onprem")` returned `unsupported`. Worse, that status didn't fail loudly: the journey `verdictById` mapping only special-cases `"new"`, so an `unsupported`/`error` journey **coerces to `exists`** → `planJourneyUnits` makes the subject Overwrite but the inner **Keep (not written)** → the subject's `InnerTreeEvaluatorNode` then failed `400 "Data validation failed for the attribute, Tree Name"` because the inner tree was never created. The real cause (compat) was two steps removed from the symptom (a node write error).
**Correction:** Journeys are **core AM** (auth trees) — add `"journey"` to `ONPREM_SUPPORTED`. Both subject + inner become `new` → Create, executor writes inner-before-outer → resolves.
**How to avoid next time:** When you add a new importable `BundleKind`, update **every** capability matrix (`compat.ts`), not just the write/preflight path. And treat a non-writable verdict (`unsupported`/`error`) as **not** a silent `exists` in the journey plan — coercing "I couldn't classify it" into "it's already there, Keep it" hides the failure.

## 2026-06-15 — On-prem AM validates social-IdP `scopeDelimiter` as required; PAIC tolerates empty

**Context:** Same C1 run — the bundled social IdP failed on-prem with `"Values for Scope Delimiter is required."`
**Mistake:** `toIdpWrite` passed the bundle's `scopeDelimiter: ""` (empty — what PAIC stored) straight through. On-prem AM enforces a non-empty value; PAIC does not.
**Correction:** Default an empty `scopeDelimiter` to a single space `" "` in `toIdpWrite` — OAuth2/OIDC's standard scope separator and AM's own default (an empty delimiter is meaningless when scopes exist). No-op when the bundle already set it.
**How to avoid next time:** Cross-env writes hit **stricter** validation on the target than the source enforced. A field the source left empty/defaulted may be required downstream — normalize to the protocol default at write time rather than assuming round-trip fidelity. Expect more such fields on first cross-env transfer of a kind.

## 2026-06-12 — "Create" by name can silently overwrite a different script that holds the same UUID

**Context:** Script import matches the target by name (cross-env identity). On a create (no name match) it falls back to writing the bundle's `_id` (UUID) — to preserve cross-env script identity so journey node `script` refs stay valid.
**Mistake:** Checking only the *name* before a create, then `PUT /scripts/<bundleUUID>`. AM's PUT overwrites whatever entity already lives at that UUID — which may be a **differently-named** script. Realistic trigger isn't random UUID collision (astronomically unlikely) but **rename-after-copy**: `Foo`@U1 exported → imported to target (UUID preserved) → renamed to `Bar` on the target → re-importing `Foo` finds no name match → "create" → overwrites `Bar`, reported as a clean `created`. Two independent axes (name says new, UUID says occupied) were conflated into one "new" verdict.
**Correction:** On the create path, pre-flight also GETs the bundle UUID (`getRawScript(realm, bundleId)`): 404 → safe create; 200 → a different script holds that UUID → a distinct **`id-collision`** verdict (blocked, non-selectable), naming the occupant. Never silently overwrite; never re-mint a fresh UUID (that would trade a rare silent-clobber for a guaranteed silent reference-break — UUID stability is the whole point). User resolves manually.
**How to avoid next time:** When the match key (name) and the write key (UUID) are different axes, validate BOTH before a write — a "not found by key A" verdict does not imply "key B is free." Especially when the platform's write is an idempotent PUT-by-id that overwrites silently.

## 2026-06-12 — Script import compares by NAME but writes by UUID — a same-named/different-UUID target can be mis-judged

**Context:** Building the script/library-script write path for cross-env import (M9 Phase 4 Batch 2). Pre-flight fetches the target version via `getRawScriptByName(realm, name)` (scripts have no name→one-id guarantee); the write addresses `PUT …/scripts/<uuid>` using the **bundle's `_id` (UUID)** to preserve cross-env script identity so node `script` refs stay valid.
**Mistake:** Treating "compare target" and "write target" as the same entity. AM allows **duplicate script names** — name is not unique. So if the destination realm already has a script with the same *name* but a *different* UUID, pre-flight value-compares against script-A (the name hit) while `writeScript` creates/overwrites script-B (the bundle UUID). The plan can say "identical/differs" about one entity while the write touches a different one — and a create can silently produce a second same-named script.
**Correction:** Shipped the *write* slice with the gap documented, then **resolved it the next slice (TD-9)** once we'd articulated the identity model (UUID in-env, **name cross-env** for scripts). Pre-flight now captures the name-matched target's `_id` (`findRawScriptsByName` → `resolvedTargetId` + `targetMatchCount` on the verdict) and `execute` writes to *that* UUID (overwrite in place), falling back to the bundle UUID only on a true create. Dup-name (>1 hit) is surfaced with a `(N on target)` note rather than silently picking. **Status: RESOLVED** (the platform still can't say *which* of N same-named scripts is canonical — we pick-first and flag it, which is the honest maximum).
**How to avoid next time:** When a component is matched for compare by one key (name) but addressed for write by another (UUID), they diverge whenever the match key isn't unique. Reconcile the write target to the entity the compare actually resolved (carry the resolved id through preflight→execute), and surface the ambiguity when the match isn't 1:1. Don't assume `getRaw…ByName` returns the entity you're about to PUT — and decide *up front* which key is the identity (here: name, cross-env).

## 2026-05-26 — Webview-bound `postMessage` must wait for the React-mount handshake, not just panel creation

**Context:** Users on RDP reported the inspector frequently showing "Select a tree node to inspect." after clicking a tree node; clicking away and back often (but not always) made the card appear. On dev machines, the bug was never reproducible.
**Mistake:** `InspectorTab`'s constructor created the webview panel, set HTML, registered `onDidReceiveMessage`, and immediately called `render(node)` — which awaits `buildSelectPayload()` and then `panel.webview.postMessage({ type: "select", … })`. The webview already posts `{ type: "ready" }` from `main.tsx` after `createRoot(...).render(...)`, but the extension only logged it and didn't wait for it. VS Code buffers messages from extension→webview only during the *initial* load; once the webview is alive, messages are delivered to `window` immediately and dropped on the floor if no `message` listener is attached yet. On RDP, the renderer's CPU is under heavy load from remote display encoding, so the gap between "webview alive" and "React mounted + listener attached" stretches from microseconds to hundreds of milliseconds — long enough for the extension's `select` post (preceded only by a fast cached `buildSelectPayload`) to land before the listener exists.
**Correction:** Gate every outbound `post()` on a `webviewReady` promise that resolves when the webview posts `{ type: "ready" }`. Include a 5s timeout fallback so a genuinely broken webview can't wedge the inspector silently. The webview-side change is zero — it already sends `ready` after React mounts. Only the extension changed (`src/webview/inspector/panel.ts`). The fix is symmetric with the patterns in `frodo-cli`'s message-channel helpers and several VS Code samples that show "wait for handshake" as the canonical pattern.
**How to avoid next time:** Any extension→webview `postMessage` posted before the webview signals readiness can be dropped. If your webview has a `message` listener attached in a `useEffect` (i.e. after React mounts), the extension cannot rely on `createWebviewPanel` + `webview.html = …` being enough — those events fire long before React parses, compiles, and runs. The "I never see this on my dev machine" pattern is a hallmark of latency-sensitive races: if you can't make it reproduce locally, add an explicit `setTimeout` in the webview bootstrap to expand the race window deterministically (we used 1500ms inside `main.tsx` to confirm). Repro first, then fix.

## 2026-05-19 — Nested `mapConcurrent` multiplies concurrency; multi-phase walks need ONE shared limiter

**Context:** The M5 realm-index build (`src/realm-index/build.ts`) used `mapConcurrent(…, 10)` at each fan-out point — `scanJourney` 10-wide, and each `scanJourney` fanning out `getNode` 10-wide. A live sb3 `alpha` build was measured at 108 s for ~2,300 HTTP calls.
**Mistake:** `mapConcurrent` caps *its own* pool, not global in-flight. Nested calls multiply: 10 journeys × 10 nodes = up to ~100 concurrent requests hitting the tenant. Log analysis showed per-`getNode` latency at **2,485 ms avg** — the burst was overwhelming the tenant and responses queued server-side, *inflating* the latency it was trying to beat. This is exactly what D16 warned against ("cap at ~10 … on 1,000-call scans"). Separately, the script-body phase `await`ed its per-script `getScriptByName` lookups *inside a `for` loop over the layer*, collapsing effective concurrency to ~4 (58 s for 950 fast calls).
**Correction:** For a multi-phase walk, create **one shared limiter** (`makeLimiter(n)` in `src/paic/concurrency.ts`) per walk invocation and route every HTTP call through it — total in-flight is then a true `n`. Replace nested `mapConcurrent` with `Promise.all(items.map(i => limit.run(() => fn(i))))`. And never `await` a fan-out inside a `for` loop over a sibling collection — collect the work across the whole layer, dedupe, then one batched `Promise.all`.
**How to avoid next time:** When you see `mapConcurrent` (or `Promise.all` over a bounded pool) called *inside* a function that is itself run through `mapConcurrent`, the concurrency caps multiply — that's a global-limiter smell. One limiter instance per logical operation, threaded through. Check effective concurrency from logs: `total_calls × avg_latency / wall_time` should be ≈ your intended cap, not far above (burst) or far below (accidental serialization).

## 2026-05-19 — Card data preparation needs ONE source of truth (`buildSelectPayload`), not pre-population from each producer

**Context:** During M4 Slice 6 the user reported that a script clicked from the Full / Flat resolved view rendered an "id-only" card (just Script ID + UUID title), while the SAME script clicked from the sidebar or Direct deps list rendered the full D23 metadata (name / language / context / lastModified / etc.).

**Mistake:** Several PaicNode subclasses carry rich data on an OPTIONAL constructor param (`ScriptNode.resolved?: Script`, `ThemeNode.resolved?: Theme`, `EsvNode.resolved?: Esv` + `EsvNode.kind?`). The inspector's `buildSelectPayload` in `src/webview/inspector/panel.ts` READS these fields directly without a fallback fetch. The architecture relied on a hidden contract: *"every producer of `<Node>` must pre-fetch the rich data and pass it to the constructor."* `src/views/nodes/journey-expand.ts` honors the contract (it pre-fetches every script for tree-label naming and stashes the result); `src/views/nodes/script-expand.ts` honors it for ESVs. But any NEW producer (my Slice 6 `handlePreviewResolved` for Full/Flat row clicks; future M5 Search-page card spawns; potentially others) that doesn't pre-populate gets a deficient card. The audit also caught two LATENT versions of the same bug: clicking a Theme or ESV hyperlink from a card spawned via `previewResolved` would have produced id-only cards too (`ThemeNode` and `EsvNode` are constructed without `resolved`).

**Correction:** Treat **`buildSelectPayload` as the SINGLE source of truth** for "the card has the rich data it needs to render." It already does this defensively for `EmailTemplateNode` / `SocialIdpNode` (no optional `resolved` field; fetch always happens inside the `instanceof` branch). The same pattern needs to apply to `ScriptNode`, `LibraryScriptNode`, `ThemeNode`, `EsvNode` — read `node.resolved` if present (fast path for sidebar's pre-warmed nodes), otherwise fetch via `cache.get(node.host).then(client => client.getScript(realm, id))` or similar.

**How to avoid next time:** When designing a domain object that flows into a renderer:
1. Either make the rich data REQUIRED on the constructor (forces every producer to fetch — Library scripts work this way today: `name` + `body` are required) — OR —
2. Make the rich data OPTIONAL, but have the FINAL consumer always populate it before rendering. Never split the responsibility between producer and consumer.
3. Watch for "hidden contracts" where a side-effect (`journey-expand` happens to pre-fetch as a side-effect of tree expansion) is what keeps a downstream renderer healthy. Side-effect contracts break the moment a new producer is added.
4. Optional fields on a constructor are a flag for "consumer must have a defensive path." Audit when you add a new field — does every consumer either fetch on null OR have its producers reliably pre-warm? If not, refactor before the bug surfaces.

## 2026-05-18 — AIC platform terminal-node IDs: verify against fixtures, never reconstruct from memory

**Context:** Implementing D28 (synthesize Success/Failure terminals). I wrote the constants by recalling the UUIDs from earlier in the session and reading my own prior code.
**Mistake:** The Failure UUID I committed was `e301438c-0bd0-429c-ab0c-4b8d48aa5b41`. Correct value from frodo-lib captures + real AIC wire payloads is `e301438c-0bd0-429c-ab0c-66126501069a`. Same first segment, fabricated last segment. Also missed that AIC's `staticNodes` has a *third* entry — `startNode` (literal string key) — that AIC's admin UI renders as the visual "Start" pill before the entry node. Both bugs were caught by a real-tenant smoke test on the user's simplest journey (`aaron_test_login` showed no Failure terminal and no Start pill).
**Correction:** The full set of platform-static node IDs is:
- `"startNode"` (literal string) — synthetic start, always implicit before `entryNodeId`
- `"70e691a5-1e33-4ac3-a356-e7b6d60d92e0"` — Success
- `"e301438c-0bd0-429c-ab0c-66126501069a"` — Failure

All three appear under `staticNodes` on the wire. `startNode` is connected to `entryNodeId` implicitly (no edge in `nodes` references it); Success/Failure are targets of edges from real decision/data-store nodes.
**How to avoid next time:** When defining "stable" platform constants (UUIDs, well-known IDs, magic strings), grep them out of captured fixtures or `ref/frodo-lib/` before adding to source. Never type a UUID from memory. A `grep -rn '<first-segment>' ref/frodo-lib/src` takes 2 seconds and would have caught both bugs immediately.

## 2026-05-18 — `/openidm/config/ui/themerealm` uses `realm` (singular), value is the theme array directly

**Context:** Implementing `client.getTheme(realm, themeId)` for the M3 theme leaf + card. Initial code looked under `json.realms[realm].themes` (plural, with `.themes` wrapper).
**Mistake:** Assumed the response wrapper shape. Code silently returned `null` for every theme lookup; ThemeCard showed only the UUID. Surfaced during a smoke-test session against sb3 — user noticed the heading was a UUID and asked "is there a name field?"
**Correction:** The actual wire shape is `{ _id: "ui/themerealm", realm: { <realmName>: RawTheme[] } }` — **singular** `realm`, and the per-realm value is the theme array **directly** (no `.themes` wrapper). Each theme has ~80+ fields including `name`, `isDefault`, `linkedTrees` (journey IDs that link to this theme — free reverse-lookup baked into the response), plus extensive branding/color fields.
**How to avoid next time:** Always probe the actual response shape against a live tenant during initial implementation. A tiny `poc/<resource>-probe.mjs` that dumps `Object.keys` of the first result is cheap insurance. Applies to any AIC resource. The original frodo-lib reference can be wrong / out-of-date for newer endpoints.

## 2026-05-17 — `PreToolUse` Bash hooks fire **before** the shell command runs

**Context:** Built `check-secrets.sh` to scan staged files before `git commit`.
**Mistake:** Used `grep -qE '^git (commit|push)'` and trusted that the hook would see the staging area populated. Tested with `git add danger.txt && git commit -m "..."` — the compound command went through unscathed.
**Correction:** Two distinct bugs:
1. `^git (commit|push)` only matches when the command *starts* with `git commit`/`git push`. Compound commands beginning with `git add` (or anything else) fail the regex.
2. Even with the anchor removed, the hook fires *before* the Bash command runs. When staging happens inside the same chain (`git add X && git commit`), the staging area is empty at scan time — secrets sneak through.
**Fix shipped:** Hook now refuses any single Bash invocation containing **both** `git add` and `git commit`/`git push`, forcing them into separate calls so the second one sees a populated staging area.
**How to avoid next time:** When designing a `PreToolUse:Bash` security gate, ask: *if the user does X and Y in one compound command, will the gate's view of the system reflect post-X state or pre-X state?* It's pre-X. Either refuse compound commands or reason about post-X state explicitly.

## 2026-05-15 — `F5` is not a usable dev shortcut on Mac

**Context:** Initial dev-loop instructions told the user to press F5 to launch the Extension Development Host.
**Mistake:** Assumed F5 was free. On Mac it's commonly captured by Dictation or the function-key overlay.
**Correction:** Use `Cmd+Shift+P` → "Debug: Start Debugging" instead. Fn+F5 also works.
**How to avoid next time:** When recommending VS Code shortcuts, prefer Command Palette names over keybindings; users' chord configs and OS-level shortcuts vary.

## 2026-05-15 — `LogOutputChannel` log file path is not where the docs imply

**Context:** Wrote a `dev-tail.sh` helper to follow the extension's log file from a terminal.
**Mistake:** Assumed the file lived under `output_logging_<ts>/<n>-PAIC Journeys.log`. That's where some Output channels go.
**Correction:** `LogOutputChannel`s created with `{ log: true }` write to `<session>/window<N>/exthost/<publisher>.<extension>/<channel-name>.log` — a per-extension directory, not the shared `output_logging_*` folder.
**How to avoid next time:** The disk path differs between `OutputChannel` and `LogOutputChannel`. Always verify the actual file location with `find` after triggering at least one log line; don't infer it from docs.

## 2026-05-15 — Cookie name on PAIC tenants is per-tenant random, not `iPlanetDirectoryPro`

**Context:** Attempted to replay HAR-captured calls using a copied session cookie.
**Mistake:** Used `iPlanetDirectoryPro` as the cookie header name. Got 401.
**Correction:** Each PAIC tenant has a random cookie name visible at `GET /am/json/serverinfo/*` → `cookieName` field. On the captured tenant it was `9ed2dc164aff213`.
**How to avoid next time:** Never hardcode AM session cookie names. Discover them at runtime — and for any scripted client, prefer service-account JWT-bearer over cookie replay anyway.

## 2026-05-15 — The `id_token` in a HAR's oauth2/authorize redirect is NOT usable for AM REST

**Context:** Tried to use the `id_token` captured from a `/am/oauth2/authorize?prompt=none&client_id=idmAdminClient&response_type=id_token` redirect to replay AM REST calls.
**Mistake:** Assumed any bearer token from the admin UI's auth flow would work on AM endpoints.
**Correction:** That token is scoped `fr:idm:*` and audience `idmAdminClient` — it's for IDM-side calls only. AM REST endpoints under `/am/json/.../realm-config/...` rejected it with 401. The UI's actual AM auth is the per-tenant session cookie, not this token.
**How to avoid next time:** Decode any token (`jwt.io`-style) and check `scope` + `aud` before assuming it works against a given endpoint. Auth flows for AM and IDM in PAIC are not the same.

## 2026-06-11 — Adding a webview surface means touching BOTH tsconfigs

**Context:** Added a 4th React webview surface (`src/webview/transfer/ui`) for the import Transfer page.
**Mistake:** Created the files + added `tsconfig.webview.json` `include`, but the base `tsconfig.json` typecheck (`tsc --noEmit`, first half of `npm run typecheck`) then failed on the new `.tsx` with "Cannot use JSX / Cannot find name 'window'" — because the base config (node, `lib: ["ES2022"]`, no jsx) was now checking the DOM/jsx files.
**Correction:** The base `tsconfig.json` `exclude` list **enumerates each surface's `src/webview/<name>/ui/**` + `tests/webview/<name>/ui/**`** so those are left to `tsconfig.webview.json` (DOM lib + jsx). A new surface must be added to the base `exclude` AND the webview `include`.
**How to avoid next time:** When adding a webview surface, update three config spots together: `tsconfig.json` exclude, `tsconfig.webview.json` include, and `package.json` `build:`/`watch:` scripts (+ the `build` chain). The per-surface `ui` editor diagnostics (JSX/window/`MessageEvent` not generic) are config-association false positives — only `tsc -p tsconfig.webview.json` is authoritative.

## 2026-06-11 — Extracting a shared webview component must move its CSS + parametrize hard-coded copy

**Context:** Extracted the `Combobox` from `search/ui/App.tsx` into `src/webview/shared/combobox.tsx` so the Transfer page could reuse it (D38).
**Mistake (caught in planning + by a test):** (1) The component's styles (`.entity-combobox*` + the base `input` rules) lived **inline in `search/panel.ts`'s `SEARCH_CSS` template string**, not with the component — extracting just the `.tsx` would render an unstyled, mispositioned dropdown in the new surface. (2) The component hard-coded the empty-state text `"No entity matches"`, which a Search test asserts on; the shared default `"No matches"` broke that test.
**Correction:** Each webview panel hand-rolls its own `<style>` string (no CSS-sharing mechanism), so a shared component needs a companion shared **CSS const** (`combobox-css.ts` → `COMBOBOX_CSS`) that every consuming panel concatenates into its CSS. And consumer-specific copy must become a **prop** (`emptyLabel`), with the original consumer passing its exact string to stay byte-identical.
**How to avoid next time:** When extracting any webview UI component, extract THREE things together: the component, its CSS (from the panel's inline `*_CSS` string), and any consumer-specific text → props. Also: a new shared dir under `src/webview/` with JSX must be added to the base `tsconfig.json` `exclude` (DOM/jsx live in `tsconfig.webview.json`). CSS regressions aren't test-caught → verify the original consumer's dropdowns still render in EDH.

## 2026-06-12 — IDM whole-doc config PUTs (themerealm) need `If-Match: <_rev>`, not a plain PUT

**Context:** Implementing `writeTheme` (D43) — themes have no per-theme endpoint, so a write is a read-modify-write of the shared `/openidm/config/ui/themerealm` doc (every realm's themes in one document).
**Mistake (caught in planning vs the POC):** The first design did "GET → splice → drop `_rev` → plain PUT." That silently clobbers concurrent edits to the *whole* doc — including other realms' themes — if anything changed between the GET and the PUT.
**Correction:** Strip `_rev` from the body but send it back as an **`If-Match: <_rev>` header** (the proven `poc/transfer-endpoints/theme-crud.mjs` payload). A stale `_rev` then fails with **412 Precondition Failed** instead of overwriting; handle 412 by re-GET → re-splice → retry once. Keep the doc `_id` (`ui/themerealm`) in the body. (Email templates have no `_rev` → plain PUT is fine there — it's a per-endpoint fact, not general.)
**How to avoid next time:** For any IDM `/openidm/config/*` whole-document write, mirror the POC's exact payload (`*-crud.mjs`), not just the endpoint+verb — concurrency headers (`If-Match`), which fields stay in the body (`_id`), and per-endpoint `_rev` presence are all load-bearing and only visible in the captured request. Read-modify-write of a shared doc is a clobber risk; gate it with the optimistic-concurrency header.

## 2026-06-12 — Don't assume an import value needs re-supply — the export is the faithful raw wire object

**Context:** Designing ESV import value-supply. I drafted an AskUserQuestion treating the *variable* value as the "source env's value" that might need a prompt or transform (the env-specific concern).
**Mistake:** I conflated the *compare* rule (ESV values are env-specific → compare existence-only) with the *write* path. The user stopped me: a variable's value travels in the bundle as `valueBase64` — the **exact raw PAIC API field** the PUT accepts — so there's nothing to re-derive or prompt for; you just write it back.
**Correction:** Every export comes from the `getRaw*` accessors (the faithful unmapped wire object); `stripMask` only drops `_rev`/audit (keeps `_id` + content). So before assuming any import field needs a prompt/transform, check whether the bundle already carries the exact wire field. The genuine prompts are only for fields the API **never returns** (write-only) — ESV secret value, social-IdP `clientSecret` — not for readable ones (variable `valueBase64`).
**How to avoid next time:** "Existence-only compare" ≠ "can't write the value." Separate the compare policy from the write payload. For each import field ask: did the read API return it (then it's in the bundle, write it) or is it write-only (then prompt)? Verify against `mappers.ts` `Raw*` + an actual exported sample before designing a prompt.

## 2026-06-15 — AM script PUT requires body `_id` == URL resource id (TD-9 reconcile bug, caught live)

**Context:** Live-testing cross-env script import (A3): a bundle script name-matches an existing target script with a **different UUID**, so the write reconciles to the target's UUID (TD-9 `resolvedTargetId`). The write failed with `400 "Script resource id and script JSON body id do not match"`.
**Mistake (shipped; unit test passed):** `writeOne` set the **URL** resource id to `resolvedTargetId` but left the body `_id` as the bundle's (`toScriptWrite` keeps `_id`). AM validates that a script PUT's body `_id` equals the URL resource id, so on any reconcile (bundle UUID ≠ target UUID) the two disagree → rejected. This broke the core cross-env script-overwrite case (leaf **and** journey shared scripts — both go through `writeOne`). The existing reconcile test asserted only the **URL** id (`...calls[0][1]`), never the body `_id`, so it sailed past the bug.
**Correction:** Realign the body before the PUT: `const body = { ...toScriptWrite(raw), _id: targetId }` where `targetId = resolvedTargetId ?? component.id`. Strengthened the test to assert `body._id === "target-uuid"`.
**How to avoid next time:** When a write reconciles the **URL** id to a target id (PUT-by-id endpoints), realign the body `_id` too — AM enforces body-id == resource-id for scripts (likely others). When a test reconciles an id, assert it on **both** the URL arg and the body, not just the URL. Round-trip/CRUD probes that only test same-UUID create/overwrite won't surface a reconcile mismatch — exercise the different-UUID name-match path.
