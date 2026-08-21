# Journey Import — Plan & Decision Model (working memo)

> **Status: WORKING DRAFT (2026-06-13).** Captures the UI/decision model for **journey import**
> (cross-env transfer, Batch 3) reached in design discussion. Decisions here are **provisional** —
> several still need POC backing (see *Open research* at the end). Once locked, the key decisions
> graduate to the D-family in [design-plan.md](design-plan.md). Empirical findings live in the
> gitignored `poc/transfer-endpoints/TRACKER.md` (TD-family); this memo references them.

## Scope

How a **journey** (authentication tree) and everything it drags along is presented to the user for
import, and what each decision means. Covers both export depth modes:

- **level1** — the chosen journey only; inner journeys referenced **by name**, assumed pre-existing.
- **allLevels** — the chosen journey **plus** every nested inner journey's full structure.

Leaf + script import (the single-component case) already ships; this memo is the journey layer on
top of it, reusing that pipeline.

## Empirical foundation (already proven — TD-12, TD-13)

Probed live on PAIC sandbox **and** on-prem AM (`poc/transfer-endpoints/inner-journey-dangling-probe.mjs`):

- **A missing inner journey is a HARD constraint, AM-enforced.** `PUT InnerTreeEvaluatorNode {tree:"<absent>"}`
  → `400 "Data validation failed for the attribute, Tree Name"` on both deployments. You cannot create
  the node until its target tree exists.
- **A missing node *type* is a HARD constraint** (`404` — type not in deployment; live catalog confirmed
  TD-14). The bundle carries node references by `_type._id`, not type *definitions*, so we cannot supply a
  missing type → deployment prerequisite. The preflight derives the required types **from the bundle's nodes**
  (`_type._id`) and diffs them against the live `getAllTypes` catalog — never from a meta manifest (PD-18).
- **The dividing line that explains the soft/hard split:**
  - **Structural attribute refs** (a node's `script` UUID, an `InnerTreeEvaluatorNode`'s `tree` name,
    the node *type*) → AM validates them at write time → **HARD**.
  - **Script-body text refs** (`require('lib')`, `esv.foo` inside source) → never statically checked,
    runtime only → **SOFT** (warn, import anyway).
- **The tree-flow PUT is lenient** — it accepts a flow naming node ids that don't exist as instances.
  ⇒ the importer must treat **each node PUT as the real success gate**, not the final `putTree`.
- **Scripts are name-unique per realm; UUID is the identifier, name is the cross-env match key (TD-13).**
  A second `PUT` with the same name + a different UUID → `409 Conflict` on both deployments. Precisely:
  this is a **uniqueness constraint**, not "name is the identifier" — the **UUID stays the identifier**
  (the `_id`, the `/scripts/<uuid>` endpoint key, and what every node `script` reference resolves against);
  the **name is a unique alternate key** we use to *match* a bundle script to a target script across
  environments (UUIDs aren't shared cross-env). Consequence: reconcile-by-name + remap — see §6 below.

## Core principle — engine complexity is hidden from the user

The executor writes in a strict dependency order (leaves → inner nodes → nodes → tree; inner trees
before outer trees; frodo's `resolveDependencies` topo-sort). **None of that is surfaced.** The user
sees **one flat, type-sorted plan table** of "what I'll do / what's blocking you" and decides per row.
No phases, no inner/outer language, no nesting/indentation in the UI.

## The decision model

### 1. The chosen journey is the *subject*, not a row

The journey you're importing (e.g. `Login`) is the **header** of the plan
(`Import journey: Login → <host>/<realm>  (exists → Overwrite)`), not a line item sitting among its
own parts. Its own flow + nodes ride along with "import Login"; they are never itemized.

### 2. Ownership decides what gets a row — *private folds in, shared is hoisted*

| Thing | Owned by | Overwrite reaches | In the table? |
|---|---|---|---|
| **Node instance** | exactly ONE journey | only that journey | **folded into** the journey |
| **Script / library** | many journeys (referenced) | every journey using it | **own row** |
| **Theme / email / social IdP / ESV** | shared | everything using it | **own row** |
| **Inner journey** | many callers | every caller | **own row** |
| **Node type** | the deployment | n/a (a check) | **own row** (existence check) |

Rule: **surface a thing only if its overwrite can affect something beyond the journey; fold it in if
it's the journey's private guts.** Nodes are private (their UUIDs aren't shared across trees), so they
fold in. Scripts/themes/IdPs/ESVs/inner-journeys are shared, so each is its own decision.

### 3. Inner journeys are *unit rows* — flat-all, never atomic-subtree

**Every bundled journey gets its own flat row**, regardless of nesting depth — not just the chosen
journey's direct inners, and **not** rolled into their parent. A journey 3 levels deep is just another
flat row (depth never shown; the engine orders the writes). Each inner-journey row carries one decision:

```
                      target HAS it            target LACKS it
   bundled (full)  │  Overwrite ⇄ Keep         Create  (required — its caller needs it)
   referenced only │  Present (= Keep) ✓        Missing ⛔ (hard stop)
   (name, level1)  │
```

- **Overwrite** an inner journey = replace **its own** flow + **its own** nodes on the target (same id,
  preserved node UUIDs, new internals). Every caller (yours and others already on the target) inherits
  the change. *Not* recursive into its own inner journeys (separate rows); *not* its scripts (separate rows).
- **Keep** = don't write it; callers resolve to the target's existing copy.
- **This unifies the two depth modes:** `Keep` ≡ level1 behavior ("use the target's"); `Overwrite` ≡
  allLevels behavior ("write my copy"). level1 is simply "every inner journey forced to Keep".

**Why flat-all and not atomic-subtree:** an inner journey is itself a shared resource (reused by other
journeys on the target). Rolling a deep inner into its parent's overwrite would **silently clobber** a
journey other trees depend on. A separate visible row (with a `Usages` link) makes each overwrite a
deliberate, controllable choice. For a **shallow** bundle (one level of inners) flat-all and atomic
render identically — the extra row only appears when there's real nesting, and when it does it's
protecting the user.

### 4. Shared references are *unioned* — one resource, one row, one decision

A referenced shared thing (script, theme, inner journey, …) is **deduped by identity** across the whole
bundle into a **single** row with a **single** decision, computed once against the target.

This is not merely tidy — it's the only **coherent** model: the target physically holds **one** copy of
each (one `helpers` script, one `DeviceCheck` journey). You cannot import two versions; there's nowhere
to put a second. So three callers of `helpers` → one `helpers` row. Without the union you could express
`helpers(overwrite)` and `helpers(keep)` simultaneously, which is impossible to satisfy.

The shared row's **"is it needed?"** is the union across the journeys actually being imported:
- written if **any active** (Create/Overwrite) journey references it;
- **missing on target + needed by an active journey** → a **required** write (else that journey's node
  fails AM's hard check);
- if every referencing journey is set to **Keep** → not needed → drops out.

### 5. What "overwrite a journey" writes, precisely

```
 Overwrite DeviceCheck
   PUT …/nodes/<type>/<X>   ← replace node X  (incl. its pointer  script:<uuid> — the WIRING, not the body)
   PUT …/nodes/<type>/<Y>   ← replace node Y
   PUT …/trees/DeviceCheck  ← replace the flow
```

- Writes the journey's **flow + its own nodes** (and the nodes' *references* to scripts/inner-trees).
- A node's `script:<uuid>` **pointer** is written, but the script **body** is governed by the separate
  script row. So you can overwrite a journey while leaving a shared script untouched.
- Never writes other journeys, the journey's own inner journeys, or any shared leaf — those are their
  own rows.

### 6. Scripts — UUID-identified, name-matched, references remapped (TD-13)

Scripts are the one component where **the identifier and the cross-env match key differ**, so they need
handling the other kinds don't:

| | journey | script |
|---|---|---|
| identifier (`_id`, endpoint key, what refs use) | the **name** | a **UUID** |
| unique per realm? | yes (id *is* the name) | yes — both uuid **and** name (TD-13) |
| cross-env match key | name | **name** (UUIDs aren't portable) |
| remap needed on import? | no | **yes** |

**The bundle is self-describing.** A node references a script by **UUID only** (`node.script: "<uuid>"`),
but the tree's `scripts` map carries `UUID → { name, body, … }`. So the UUID→name glue is *in the bundle*:
resolve `bundle.scripts[uuid].name`, then search the **target by name** for the existence check (you can't
search the target by the bundle's UUID — it won't match cross-env).

**Mandatory import algorithm (extends TD-9):**

```
 Phase 1 (scripts)  for each script: resolve by NAME against the target
                      ① name exists, SAME uuid       → no remap
                      ② name exists, DIFFERENT uuid  → write body to TARGET's _id; remap   ← common cross-env case
                      ③ name not on target           → create (keep bundle uuid) → no remap
                    build map  bundleUUID → targetUUID
 (rewrite)          remap every node `script` attribute through the map
 Phase 3 (nodes)    write nodes — references now resolve ✓
```

Skip the remap in case ② and the node's `script:<bundleUUID>` points at nothing on the target → the node
PUT fails the hard `400 "…attribute, Script"`. Building the map for *all* scripts and remapping
unconditionally is safe (cases ①/③ are no-ops).

**Scope — only node→script UUID refs are remapped:**

```
 node.script (UUID attribute)          → REMAP    (UUID differs cross-env)
 InnerTreeEvaluatorNode.tree (name)    → no remap  (journeys are name-identified, portable)
 require('lib') (name, in script TEXT) → no remap  (name-based, runtime-resolved)
```

## Plan table (reuses the existing leaf/script grid)

Same 5 columns as today's import plan: **`[✓]` · Type · Status · Name · Review**. Verdict rows
(type-sorted) first, then info-only rows. Example — `allLevels` bundle `Login → MFA → DeviceCheck`,
target has `Login` + `DeviceCheck`, lacks `MFA` + `PingOneVerifyNode`:

```
 Import journey:  Login   →  onprem / root                     (⚠ exists → Overwrite)
 ┌─────┬──────────────────┬──────────────────┬───────────────────────────┬───────────────┐
 │ [✓] │ Type             │ Status           │ Name                      │ Review        │
 ├─────┼──────────────────┼──────────────────┼───────────────────────────┼───────────────┤
 │ [✓] │ Inner journey    │ Create           │ MFA          (+3 nodes)   │               │
 │ [✓] │ Inner journey    │ Overwrite ⇄ Keep │ DeviceCheck  (+2 nodes)   │ Usages        │
 │ [✓] │ Script           │ Overwrite        │ login-decision            │ Diff · Usages │
 │ [✓] │ Script           │ Create           │ risk-check                │               │
 │ [▦] │ Script           │ Identical        │ helpers                   │               │
 │ [✓] │ Theme            │ Create           │ sign-in                   │               │
 │ [✓] │ Social IdP       │ Create           │ google                    │               │
 │     │ Node type        │ Present          │ PageNode                  │               │
 │     │ Node type        │ Missing ⛔       │ PingOneVerifyNode         │               │
 │     │ ESV              │ Missing ⚠        │ esv.api.key               │               │
 └─────┴──────────────────┴──────────────────┴───────────────────────────┴───────────────┘
        ⛔ 1 required item missing — resolve before importing      [ Import Login ] ✗ disabled
```

**Status vocabulary** (one column, three phases as today):
- comparison: `New` / `Differs` / `Identical` / `Present`
- inner-journey unit: `Create` / `Overwrite` / `Keep`
- checks: `Present` / `Missing ⛔ required` / `Missing ⚠ advisory`
- after run: `Created` / `Overwritten` / `Skipped` / `Failed`

**Import gate (PD-7).** Any `⛔` (blocking-missing) → **Import disabled**, with three layers of info so the
user knows *why* and *what to do*:
1. the `⛔` **rows** identify which prerequisites are missing (+ per-row guidance);
2. a **summary line** by the button states the count + reason (`"N required items missing — resolve first"`);
3. the **disabled button** itself.

`⚠` (advisory: missing `require('lib')`/`esv.foo`) **never** blocks — it rides into the D44 confirm modal.
Per-row guidance differs by remedy: **node type** missing → deployment prerequisite ("install on target",
no in-tool fix); **inner journey (level1)** missing → in-tool remedy ("switch to All levels, or import it
first"). Mechanically: extends today's button-disabled logic (`selectedN === 0`) with "**or any blocking
prerequisite unmet**", independent of selection.

## What the user sees vs what the engine handles

The name↔UUID / remap / ordering machinery is **invisible**; the user works in names and intent.

- **Under the hood (never surfaced):** UUID↔name resolution, the `bundleUUID → targetUUID` remap, write
  ordering (leaves → nodes → trees; inner before outer; node-PUT-as-gate), dedup/union of shared refs.
- **The user's actual decisions (the plan table):** Overwrite vs Keep per shared script / inner journey /
  theme; and **re-enter redacted secrets** (social-IdP `clientSecret`, ESV secret values) when those are
  written — the engine can't synthesize them.
- **Blockers only the user can clear (`⛔`, engine correctly refuses to fudge):** missing **node type** →
  install the plugin on the target (deployment prerequisite); missing **inner journey (level1)** → switch
  to All levels, or import it first.
- **Advisory (`⚠`, doesn't block):** missing `require('lib')`/`esv.foo` — imports fine, may fail at runtime
  until added.
- **Honesty caveat — not transactional.** AM has no transaction across these PUTs, so a mid-way failure can
  leave a partially-written journey. The result report shows per-item what landed; re-running is safe (all
  idempotent PUTs).

The user's whole surface: *upload → pick target → review/select Overwrite-or-Keep → supply any secrets →
clear any `⛔` blockers → Import.* Everything else is the engine.

## Mapping to existing code (mostly reuse)

| Row | Today | Change for journey |
|---|---|---|
| Theme / IdP / ESV | `ComponentVerdict` | none |
| Script | `ComponentVerdict` | name-reconcile + remap node→script UUIDs (TD-13; extends TD-9, executor) |
| Inner journey (bundled) | — | new writable unit; `journey` added to `WRITABLE_KINDS`; `Keep` is a new status |
| Inner journey (referenced) / Node type / lib / esv | `RequiredDepVerdict` | extend with `kind: nodeType\|innerJourney`, `severity: blocking\|advisory` |
| Import-button gate | exists | disable on any blocking-missing |
| Node refs → scripts | n/a (leaf import has no nodes) | new `bundleUUID → targetUUID` remap pass between script-reconcile and node-write |

Genuinely new: **`severity`** on the requires rows, **`Keep`** as an inner-journey state, and the
**node→script UUID remap pass** in the executor (the one piece the leaf import never needed).

## Provisional decisions (to lock once researched)

- **PD-1** Hide all engine ordering/phases/inner-outer; one flat type-sorted plan. ✔ agreed
- **PD-2** Chosen journey = header subject, not a row. ✔ agreed
- **PD-3** Ownership rule: private nodes fold into the journey; shared refs hoisted to own rows. ✔ agreed
- **PD-4** Flat-all (every bundled journey its own flat row), not atomic-subtree. ✔ agreed
- **PD-5** Inner-journey states `Create / Overwrite / Keep`; `Keep` = level1, `Overwrite` = allLevels. ✔ agreed
- **PD-6** Union shared refs → one row / one decision (target holds one copy). ✔ agreed
- **PD-7** Blocking vs advisory `severity` drives the Import gate. ✔ agreed
- **PD-8** Scripts: UUID = identifier, name = cross-env match key; reconcile by name + remap node→script
  refs `bundleUUID → targetUUID` (TD-13, extends TD-9). ✔ proven
- **PD-9** Import gate = three layers (rows + summary + per-row guidance); advisory never blocks; guidance
  differs by remedy (deployment-prereq vs in-tool). ✔ agreed
- **PD-10** Engine handles all plumbing (name↔UUID, remap, ordering, dedup) invisibly; the user surface is
  Overwrite/Keep + re-supply secrets + clear `⛔` blockers. Not transactional → per-item result + safe re-run. ✔ agreed
- **PD-11** **Freeze the plan (immutable saved-plan == apply):** snapshot the resolved decisions + the
  `bundleUUID→targetUUID` remap + the **target state** at preview; import runs *exactly* that; if the target
  drifted before commit, **stop and force a re-plan** (never apply stale). Fixes the preview→commit TOCTOU.
  Keep it inspectable (it IS our webview table). ✔ from prior-art (Terraform `plan -out`→`apply`)
- **PD-12** **Pre-write "no source UUID survives" assertion:** last step before each node PUT, assert no
  source-realm UUID remains in the payload → block (a survivor is a remap bug, never a silent dangling write).
  Hardens PD-8. ✔ from prior-art (every tool that skipped this broke — Keycloak #43819, n8n #20049)
- **PD-13** **Overwrite = update-in-place PUT (same id), NEVER delete-then-recreate:** a journey is a LIVE
  auth tree; delete-then-POST opens a window where in-flight logins fail and can cascade unrelated deletes.
  Makes §5 an explicit constraint; if a delete is ever unavoidable, batch ALL deletes before ALL creates,
  never interleave. ✔ from prior-art (Keycloak OVERWRITE = its #1 failure mode)
- **PD-14** **Parse the AM/IDM REST error envelope** (`code`/`reason`/`message`/`detail`) in
  `PaicError.from` so import failures are actionable, and add frodo's **`Invalid attribute specified`
  strip-and-retry**. Fixes a *verified latent bug* (today only the OAuth envelope is parsed → the ESV
  `/already exists/` handler is dead in prod and every failure shows a generic status code). ✔ from execute-phase review (P1)
- **PD-15** **Journey executor is dependency-aware:** a failed prerequisite skips its dependents with a
  clear reason (`skipped: prerequisite "<X>" failed`); a failed node skips its tree (never a half-wired
  tree); the batch never aborts (per-item result). ✔ from execute-phase review
- **PD-16** **Determinate apply progress** (in scope) — notification bar (`N/total` + current item; total
  from the frozen plan) **and** live row-status updates in the table (the durable surface). Replaces the
  indeterminate spinner for the journey series (realm-index build + ESV-apply durable-progress patterns). ✔ in scope
- **PD-17** **Downloadable structured JSON result report** (in scope) — per-item action + `before`/`after`,
  captured at freeze time from the PD-11 snapshot, for success AND partial/stopped-where. Doubles as the
  **rollback baseline**. JSON download is in scope now; **quick rollback is planned future** (time-bounded,
  reverse-precheck-gated — see Apply phase). ✔ in scope (download) · 🔮 future (rollback)
- **PD-18** **Meta is non-load-bearing provenance — the import derives 100% from tree structure (the source
  of truth) and would work with NO meta at all.** No import decision reads `meta`:
  - **subject** journey = the `innerTreeOnly:false` tree (not `treesSelectedForExport`);
  - **required node types** = each node's `_type._id` (not `meta.requires.nodeTypes`);
  - **referenced inner journeys** = `InnerTreeEvaluatorNode.tree` (not `meta.requires.innerJourneys`);
  - **esvs / libs** = script bodies (not `meta.requires.esvs`);
  - **bundled-vs-referenced** (the level1/allLevels distinction) is derived **per inner journey** from
    "is that tree present in `trees`?" — so even `meta.depthMode` is informational.

  Corollary: the journey export **drops the derived meta fields** (`requires`, `treesSelectedForExport`,
  `innerTreesIncluded`); `meta` = pure provenance (origin/dates/who/tool/version/connectionType/realm
  [/depthMode]). This is a small export-side cleanup (and the parse preview must derive its lines from
  content) — sequenced in the dev plan, since journey import is still on paper. ✔ agreed
- **PD-19** **Pre-flight is concurrency-bounded and retry-hardened.** One shared `makeLimiter(10)` per
  pre-flight run, applied by wrapping the **client** — never the orchestrating functions: an outer task
  holding a slot while awaiting inner ones deadlocks once every slot is an outer task. All four phases
  then share a true cap of 10, matching `WALK_CONCURRENCY` / `BUILD_CONCURRENCY`. Transport backoff
  retuned to ~1 s / 2 s / 4 s / 8 s over 4 retries (PG3). Because bounding makes pre-flight **slower by
  design** (~100–150 reads for a 4-journey bundle → 10–15 waves instead of one), it ships together with
  **determinate in-webview progress** (`preflightProgress`: phase + done/total + elapsed), mirroring
  PD-16's live-row pattern. ✔ agreed (2026-08-21)
- **PD-20** **An errored row blocks Import, and "Recheck failed (N)" is the way out.** `error` is an
  *unknown* target state and must gate the write — unlike `unsupported`, which is a *known* skip and keeps
  today's behaviour. The recheck re-runs the pre-flight for **only** the failed rows, preserving row
  selection and compare options (a full re-plan cannot: its verdicts may legitimately differ, so it must
  clear selection). A recheck **must rebuild the PD-11 freeze snapshot** — otherwise an `error → exists`
  flip reads as drift and refuses the commit. Journey-row recheck is out of scope for v1 (it needs
  `readJourneyCompareInputs` + `planJourneyUnits` re-run); journeys fall back to a full re-plan.
  ✔ agreed (2026-08-21)

## Prior-art validation & upgrades (2026-06-14)

A 6-product web investigation (ServiceNow Update Sets · Power Platform/Dataverse Solutions · Keycloak
`partialImport` · Terraform · Salesforce/Gearset · n8n/low-code — full write-up + sources in
`poc/prior-art/01-discovery.md` and `02-lessons.md`) **reinforced ~9 of the 10 decisions above, surfaced no
structural challenge, and showed we already lead the field** on per-object decisions (finer than all six),
truly-disabling hard gates (vs their warn-and-proceed), name-reconcile + remap, and diff + find-usages. It
yielded the three new decisions **PD-11/12/13** above, plus these UI refinements.

### UI refinements (extend existing decisions)

- **Smart default selection** — *refines TD-10 (currently default-OFF).* Pre-set each row to its recommended
  action (New→Create ✓, Differs→Overwrite ✓ / inner-journey→Keep, Identical→locked-skip, missing-but-in-
  bundle→auto-Create) so a zero-blocker plan is correct on a single Import click — review collapses to
  scanning, not deciding. Keep per-row override + tri-state select-all. (If default-OFF is kept deliberately,
  document why against this near-universal "default = recommended" pattern.)
- **Count-summary header** — *extends PD-9.* One line above the table:
  `Plan: N create · M overwrite · K keep · J identical · P blocked`; the D44 confirm restates those exact
  counts + target host + "not transactional, no automatic undo."
- **Concrete per-row reason text** — *extends PD-9.* Each row carries its own sentence, not a generic
  "conflict": e.g. *"PingOneVerifyNode not installed on target — used by MFA; install before importing"* /
  *"target's `helpers` differs — importing replaces its body"* / *"references `require('lib')`, not on
  target — imports anyway, may fail at runtime."* Cheapest high-value win — text we already compute.
- **Blast-radius on Overwrite** — *extends PD-6 / TD-11.* Badge each deduped shared-ref row with a usage
  count ("used by 4 journeys"); extend find-usages to show **downstream casualties on OTHER target journeys**
  outside this import, so the user sees the blast radius before overwriting a shared dependency.
- **Re-plan after partial failure** — *extends PD-10.* After a partial failure, recompute against the
  now-changed target so failed/remaining rows reappear actionable and succeeded rows flip to Identical-skip
  — re-plan IS the recovery UX, not a manual retry list.

### Anti-patterns to avoid (banked from the research)

delete-then-recreate on a live object (PD-13) · writing a surviving source UUID (PD-12) · a single global
conflict policy (we keep per-object) · click-through-able fatal blockers (our `⛔` truly disables) ·
persisting secrets in any saved-plan/log (carry a typed "secret required" placeholder, never a blank) ·
silent skips that drift (Keep/Identical/⚠ stay visible in the result) · out-of-order / easy partial commit
(enforce DAG order; full-graph import is the safe default). Full detail + sources in `poc/prior-art/02-lessons.md`.

### Prioritized backlog (from prior art)

- **P1** — PD-11 freeze-the-plan · PD-12 no-source-UUID assertion.
- **P2** — count header + concrete per-row reasons · re-plan-after-failure · cross-import blast-radius.
- **P3** — auto-include in-bundle prereqs as Create rows · self-suppressing secret step (skip when present on
  target; never re-blank) · filter-to-rows-needing-a-decision.
  *(Dropped the earlier "closure manifest in `meta`" idea — superseded by PD-18: the import derives the closure
  from tree content, never from a meta manifest.)*
- **P4 (consider, not default)** — two-phase Stage→Apply for the most destructive deep-nesting overwrite.

## Apply phase: confirm → progress → report → (future) rollback

The lifecycle after Import is clicked. The confirm + one-line summary exist today (leaf import); determinate
progress and the downloadable JSON report are the journey upgrades (**in scope**); quick rollback is
**planned future** (still on the plan).

```
 Import click
   → CONFIRM modal  (create N · overwrite M · keep K · host · "not transactional, no undo"
                     + secret heads-up + advisory missing-deps)     [have it — upgrade counts; ONE modal, not two]
   → re-supply redacted secrets (showInputBox)                      [have it]
   → FREEZE plan + target snapshot (PD-11)                          [to add]
   → RUN with DETERMINATE progress (PD-16):
        • notification bar: "Phase 1 · script login-decision (3/12)"   (total known from frozen plan)
        • live table: rows flip Created/Overwritten/Failed as each write lands   (durable surface)
   → plan LOCKS into the result report (TD-10)
        • one-line summary at the bottom                            [have it]
        • [ Download report ⤓ ] → structured JSON (PD-17)           [in scope now]
   → (future, planned) [ Rollback ] → reverse-precheck → reverse-order undo   [PD-17 baseline; see below]
```

### Progress (PD-16, in scope)
Replace the indeterminate spinner with determinate progress on **two surfaces**: the Notification bar
(`progress.report({message, increment})`, total = the frozen plan's write count) and **live row-status in the
table** (the durable surface if the notification is dismissed). Reuses the realm-index build pattern + the
ESV-apply durable-in-UI-progress pattern.

### Result report (PD-17, in scope — JSON download now)
On completion (success OR partial/stopped), the locked table gets a **Download report** button → structured
JSON capturing per-item outcome and the pre-write `before` (so it doubles as the rollback baseline):
```jsonc
{
  "meta": { "host", "realm", "bundle", "startedAt", "finishedAt",
            "overallStatus": "success | partial | failed", "stoppedAt": "<item | null>" },
  "plan": { "create": 0, "overwrite": 0, "keep": 0, "identical": 0, "blocked": 0 },
  "items": [ { "type": "script", "name": "login-decision", "sourceId": "...", "targetId": "...",
               "action": "created | overwritten | kept | skipped | failed", "message": "...",
               "before": {}, "after": {}, "timestamp": "..." } ]
}
```
`before` is captured at freeze time from the PD-11 snapshot (never reconstructed later — the target may have
drifted). Success → audit trail; partial → shows exactly where it stopped.

### Quick rollback (FUTURE — planned, still on the plan)
A time-bounded undo powered by the same JSON (`before` per item = the restore source):
```
 import action     rollback action
 created       →   delete it       (only if nothing NEW now references it — usage check)
 overwritten   →   restore `before` (PUT the prior body)
 kept/identical→   nothing
```
- **Why "quick" / time-bounded:** no union source (not git). Rollback must **precheck in reverse** — per item,
  "is it still exactly as our import left it?" If someone edited it after our import, reverting would clobber
  their change → flag/skip, don't blindly restore. As drift accumulates (hours→days) more items fail that
  check, so after ~3 days rollback degrades to mostly no-ops → meaningless.
- **Rollback is itself an import-like write** — its own confirm + progress + report, and **reverse-dependency
  ordering** (delete trees before nodes before leaves; restore in dependency order).
- **Status:** future, but the PD-17 JSON is designed **now** to carry `before` so rollback is buildable later
  without a format change.

## Execute-phase error handling (review, 2026-06-14)

After the plan is fixed (no `⛔` blockers) and Import is clicked, the executor fires a series of writes —
each can return more than a clean 200/201. Review of our path (`src/paic/http.ts`, `src/paic/errors.ts`,
`src/import/execute.ts`, `src/webview/transfer/panel.ts`) vs frodo.

### Solid today
- **Transport (`http.ts`):** retries network / 5xx / 429 + honors `Retry-After`; **401 → re-mint + retry
  once** (self-heal); per-request `X-ForgeRock-TransactionId`; structured logs. PUTs are idempotent → safely retried.
- **Per-item isolation (`execute.ts`):** one failed write → `failed` + message; the batch never aborts.
- **Validate-before-first-write (`panel.ts`):** a fresh preflight at execute time catches plan→click drift.
- **Result report + no-undo confirm.**

### Gaps (ranked)
- **G1 (headline — VERIFIED latent bug) → PD-14.** `PaicError.from` parses only the OAuth envelope
  (`error`/`error_description`); AM/IDM REST returns `{code, reason, message, detail}` (our probes:
  `"Data validation failed for the attribute, Script"`, `"Script with name X already exist"`). We extract
  neither `message` nor `detail` → failures show axios's generic *"Request failed with status code N."*
  Consequences: (a) the ESV `/already exists/` handler **can't fire in prod** (its test hand-injects
  `description` — green test, dead path); (b) every import failure is unactionable; (c) strip-and-retry is
  impossible (no `detail.validAttributes`). Fix: read the AM/IDM envelope (`description ??= message`, keep `detail`).
- **G2 → PD-14.** No `Invalid attribute specified` strip-and-retry. frodo strips the attrs in
  `detail.validAttributes` and retries once (server-managed / cross-version attrs). Needs G1.
- **G3 (journey-specific) → PD-15.** No dependency-aware skip: a failed shared script → N confusing 400s on
  its referencing nodes. Need failed-prereq → dependents skipped with a clear reason; failed node → tree skipped.
- **G4.** Partial-failure recovery is manual → the **re-plan-after-failure** P2 item above is the fix.
- **Minor.** After G1, log the normalized error `description` at `debug` so failures are diagnosable.

### frodo comparison
| case | frodo | us |
|---|---|---|
| network/5xx/429 · 401 | retry · re-auth | ✅ retry + Retry-After · ✅ self-heal + retry once |
| per-item isolation | leaves collect; nodes/tree throw+aggregate | ✅ all per-item, never aborts |
| actionable AM message | ✅ reads `data.message` | ❌ **dropped (G1)** |
| 400 "Invalid attribute" → strip+retry | ✅ | ❌ (G2) |
| dependency-aware skip | implicit (aborts whole journey) | ❌ (G3) |
| 409 conflict | rename-duplicate | name-reconcile (better) — but message dropped (G1) |

**Backlog:** **P1** — G1 (`PaicError.from` AM/IDM envelope + regression test from probe captures) · G2 strip-and-retry.
**P2** — G3 dependency-aware skip (Batch 3 executor) · G4 re-plan-after-failure · debug-log the error description.

## Pre-flight-phase error handling (review, 2026-08-21)

Sibling review to the execute-phase section above, prompted by a live import over a degraded link:
three of ~13 script rows came back `read ECONNRESET` while every journey / theme / node-type row
succeeded. The clustering on scripts is **not** coincidence — the flaky link is the trigger, but our
own code decides who dies.

### Why scripts, specifically

- **Script reads are the fattest requests in the plan.** `findRawScriptsByName` (`src/paic/client.ts`)
  is a `_queryFilter=name eq "…"` query against `/scripts` that returns **full script objects, base64
  bodies included** — not a name→id index. A journey / theme / ESV row is a small GET-by-id. Scripts
  therefore hold the socket open longest and move the most bytes. The error text confirms the mechanism:
  `read ECONNRESET` is Node's message for a reset **on a read** — the socket died mid-response-body, not
  at connect.
- **Scripts are simply most of the rows** (13 of ~20 in the observed bundle), so they take most of the
  hits at any uniform per-request risk.
- **The burst is ours** — see PG1.

### Gaps (ranked)

- **PG1 (root cause) → PD-19.** The import pre-flight is the **only unbounded fan-out left in the
  codebase**. `runPreflight`, `readJourneyCompareInputs` (nested: journeys × node bodies),
  `discoverDeps` and `checkJourneyGates` are all a bare `Promise.all` over their whole input. Every
  other subsystem — `resolver/walk.ts`, `realm-index/build.ts`, `export/journey-bundle.ts`, both tree
  expanders — routes through `mapConcurrent(…, 10)` / `makeLimiter(10)`. This is the exact failure
  recorded in lessons.md **2026-05-19** ("nested `mapConcurrent` multiplies concurrency … the burst was
  overwhelming the tenant"), recurring in the one path that never got that treatment.
- **PG2 (silent breakage — the one that matters) → PD-20.** An errored row is not merely cosmetic. It
  becomes `RowState "blocked"` → unselectable; `importDisabled` weighs only `blockingMissing` (the PD-7
  node-type / inner-journey gates) and **not** errored verdicts, so **Import stays enabled**;
  `buildScriptRemap` skips it (no `resolvedTargetId`) so the journey node keeps the **bundle's** script
  UUID; and `journey-assemble.ts` drops it from the write plan
  (`if (!isWritableLeafStatus(v.status)) continue`). Net: a 300 ms blip on one script → the journey
  imports pointing at a script UUID that may not exist on the target, and nothing blocks it. The
  commit-time re-pre-flight is no safety net — it is a fourth unbounded fan-out with the same failure
  mode, feeding `assembleJourneyImport` directly.
- **PG3 (retry tuned for the wrong failure) → PD-19.** The transport *does* retry ECONNRESET:
  `axiosRetry` at `retries: 3` with `isNetworkOrIdempotentRequestError`, and ECONNRESET is not on
  `is-retry-allowed`'s denylist, so it qualifies as a network error. But the backoff is
  `exponentialDelay` at the default 100 ms factor — ~200 / ~400 / ~800 ms. All four attempts land inside
  ~1.5 s: inside a single congestion window, and inside the burst PG1 creates. Correct for a momentary
  blip, useless for "the link is bad right now."
- **PG4 (no way back) → PD-20.** There is no recheck affordance. The only way to re-run a pre-flight is
  to change the realm and change it back (the `useEffect` in `ui/App.tsx`), which discards both the row
  selection and the compare-option state.
- **Minor (deferred).** No in-flight dedup on the token mint — `src/auth/paic-strategy.ts` checks
  `cached` then awaits `mintToken` with no shared promise, so on a cold token N concurrent requests fire
  N concurrent `/access_token` POSTs on top of the burst. Not the cause observed here (the token is warm
  by pre-flight time), but it amplifies any cold-start burst.
- **Minor (deliberately deferred).** No explicit `httpsAgent`, so Node's `globalAgent` pools sockets
  (keepAlive on by default since Node 19). A pooled socket the tenant's load balancer has already timed
  out gets reused and fails with exactly `read ECONNRESET`. PD-19's limiter should make this rare;
  overriding the agent risks the corporate-proxy handling VS Code does for us, so it stays out until
  there is evidence it is needed.

### Amends the execute-phase "Solid today"

That section credits the transport with "retries network / 5xx / 429". True, but PG3 qualifies it: the
retry *policy* is right and the *timing* is tuned for a momentary blip. PD-19 retunes it in `http.ts`,
so the execute phase inherits the fix for free.

## Open research (before build)

1. ~~Node-type catalog POC~~ ✅ **TD-14** — `nodes?_action=getAllTypes` works (200 both); **PAIC 234 · on-prem
   116 · 108 shared** (126 PAIC-only cloud nodes, 8 legacy on-prem-only). Gate real & load-bearing; the read =
   the `getNodeTypes` client method (folds into S1).
2. ~~Export → import round-trip POC~~ ✅ **TD-15** — wrote our own allLevels export back into a clean
   sb2x/alpha → a **fully wired journey with ZERO field-stripping** (AM accepts the raw export node/tree shape;
   only `_rev` dropped). Ordering confirmed end-to-end. ⇒ executor needs **no routine strip pass**; G2
   strip-and-retry stays a deferred SAFETY NET (S6). Create-path only — overwrite + name-collision remap
   exercised in S5/S6.
3. **Shared-leaf reachability** — exact computation of "needed by an active journey" when some journeys
   are Keep'd (so a Keep doesn't drop a leaf another active journey needs).
4. **Node UUID collision across journeys** — the `id-collision` edge when a bundle node UUID already
   belongs to a *different* target journey (rare with UUID preservation; detect + warn).
5. **`Keep` when target lacks it** — invalid (can't keep what isn't there) → must become Create or a
   hard stop; define the UI affordance.
6. **Label** — "Inner journey" vs "Required journey" for the referenced (level1) prerequisite row.
7. **Name-uniqueness scope for the other UUID-or-name kinds** — library scripts (same `/scripts` endpoint
   → `409` expected), social IdPs (`(type, name)` key), themes (id/name). Confirm the constraint is
   per-realm and whether any need the same name-reconcile + remap treatment as scripts.
8. **Quick rollback (FUTURE — planned, on the plan)** — time-bounded undo from the PD-17 JSON `before`:
   reverse-dependency order; per-item **reverse precheck** ("still exactly as our import left it?" — else
   flag/skip so we never clobber a later edit); created→delete (usage-gated), overwritten→restore. Its own
   confirm + progress + report. The JSON report (PD-17) is shaped now to support it without a later format change.

## Related

- [transfer-endpoints.md](transfer-endpoints.md) — the write contract (leaves proven; structural endpoints).
- `poc/transfer-endpoints/TRACKER.md` §TD-12 (inner-journey HARD constraint) · §TD-13 (script
  name-uniqueness + UUID remap) — live probes, both deployments (gitignored).
- `poc/prior-art/01-discovery.md` (landscape) · `02-lessons.md` (consolidated UX + architecture lessons) ·
  `02-raw-findings.json` (full multi-agent output) — prior-art investigation backing the upgrades above (gitignored).
- [design-plan.md](design-plan.md) — D42/D43 (import), D44 (prompts); D-family is where these graduate.
