# Changelog

All notable changes to the **PAIC Journeys** extension are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/).

## [4.2.0] — 2026-08-21

The first release combining the realm-level export/import work with the pre-flight
resilience work — the two were developed in parallel and are merged here.

### Added
- **Export every journey in a realm in one step.** An **Export…** button on the realm card, and **Export…** on the right-click menu of any realm in the sidebar, writes every journey in that realm — with its nodes, decision scripts, library scripts, themes, email templates and social IdPs — to a single `all<Realm>Journeys.journey.json` bundle. The file is the same frodo / PAIC-admin-UI-compatible shape a single-journey export produces, so it loads straight into the Transfer page and imports with no extra steps. There is no depth choice, because at realm scope the inner-journey closure is already complete: every journey a bundled journey references is in the file. A progress notification counts the journeys as they're gathered.
- **Select all now covers journey rows.** The plan table's header checkbox previously skipped journeys, so importing a bundle with several inner journeys meant ticking every row by hand — unworkable for a whole realm. It now selects every writable row, journeys included. Rows that are already identical stay locked and are never rewritten.
- **A progress bar during import.** The running count is now a determinate bar showing how far along the import is, which journey or script is being written, and how long it's been going. Larger imports run for a few minutes, and the per-row status column still shows exactly what happened to each component.

### Changed
- **Changing a compare option now resets your row selection** back to the recommended defaults, rather than keeping part of it. Relaxing or tightening a comparison changes which rows count as different, so the plan is recalculated from scratch — the same thing that happens after a fresh comparison.
- **The plan's destination line collapses when importing several journeys**, showing "Import 5 journeys → host / realm" instead of one line per journey.

## [4.1.1] — 2026-08-21

> **Note on versioning.** 4.1.0 was published from a mistyped version bump — the
> intended number was 0.4.1. The Marketplace serves the highest version and does not
> allow deleting the latest one, so the 0.x line could not be resumed. Releases
> continue from 4.x. 4.1.1 carries the same changes as 4.1.0 plus the plan-bar
> refinements below.

### Fixed
- **Import plan checks are no longer flaky on a slow or unreliable connection.** When you picked a target for an import, the extension checked every component against that target all at once. On a congested link some of those checks — most often scripts, whose check downloads the whole script body — would come back with a connection error and show as red rows in the plan. The checks are now paced (at most ten at a time, matching how the rest of the extension talks to a tenant) and a dropped connection is retried over a longer window, so a brief network hiccup no longer surfaces as a failed row.
- **A failed check can no longer let a broken journey be imported.** A component whose check failed was shown as a red row you couldn't select — but Import stayed enabled, and the journey would be written referencing a script that was never imported and may not exist on the target. Import is now blocked while any row's check has failed, and those rows are counted as blocked in the plan summary.

### Added
- **Progress while the import plan is being built.** The plan step now shows which stage it's on, how many components it has checked out of the total, and elapsed time — instead of a static "Checking target…" with no indication of whether it is still working.
- **Recheck failed (N).** When some rows in the plan failed their check, a button appears on the plan summary line — beside the blocked count — that re-runs the check for **just those rows**, keeping your selections and compare options intact. Previously the only way to retry was to switch the realm away and back, which discarded everything you had chosen.

### Changed
- The compare-relaxation checkboxes above the plan are now labelled **Ignore:** rather than "Ignore when comparing:", matching the **Plan:** line directly above them.

## [0.3.0] — 2026-08-12

### Fixed
- **Journeys exported from a tenant with encrypted-secret support could not be imported anywhere.** Ping AM returns some secrets as an encrypted companion field beside a nulled plaintext one (`password` / `password-encrypted`), then rejects any write that carries one — so an affected bundle failed on import with "Request contained encrypted data", even back into the tenant it came from. These companion fields are now dropped on export, on import, and when comparing. Nothing is lost: the value is unreadable, non-transferable between environments, and the plaintext field never contains anything to compare.
- **A journey could read as changed forever, and Overwrite would never settle it.** Two causes, both fixed: the encrypted companion above is re-encrypted on every read, so it never matched twice; and a journey imported by the extension compared as different from the very bundle that created it, because AM reports "no value" inconsistently. Re-importing an unchanged journey now correctly reads **Identical**.

### Added
- **Compare options on the import plan.** Three opt-in checkboxes control what counts as a difference when comparing a journey against the target — **node positions**, **node display names**, and **journey tags**. All are off by default, so comparison stays exact unless you relax it; ticking one re-runs the comparison immediately. Useful when a journey is functionally unchanged but someone has dragged a node, renamed a step, or re-tagged it on the target.
- **The main journey is now a normal row in the plan**, listed first, instead of a fixed header. It shows the same Create / Identical / Keep / Overwrite state as every other row and can be deselected — so you can push an updated script without rewriting the journey's wiring. It still defaults to Overwrite, since it's the journey you chose to import.

## [0.2.0] — 2026-06-15

### Added
- **Cross-environment transfer (export / import / compare).** A new **Transfer** page (cloud-upload icon in the sidebar) for moving components between tenants.
  - **Export** any component — script, library script, theme, email template, social IdP, ESV — or a whole **journey** (with its dependency closure, level-1 or all-levels) to a portable JSON bundle that's compatible with frodo and the PAIC admin UI. An **Export…** button is on every component card.
  - **Import** a bundle into any connection + realm (PAIC cloud or on-prem AM). Before writing, a read-only **plan** compares each component against the target and shows what's New, Identical, Different, or already Present; a confirmation modal names the exact target and counts; a determinate progress bar reports each write; and a structured **JSON report** can be downloaded afterward.
  - **Journeys** import with their inner trees, decision scripts, and library scripts wired up in dependency order, reconciling scripts by name to the target so references stay valid across tenants. A journey that's unchanged on the target is detected and shown as **Identical** (left alone), not re-written.
  - **ESV** import creates variables and secrets, then offers a separate, explicit **Apply ESV changes** step (a tenant restart) with live progress.
  - **On-prem AM** targets are supported for the AM-native kinds (authentication trees, scripts, social IdPs); cloud-only kinds are flagged as not applicable.
  - Safety throughout: a fresh re-check immediately before writing (refuses the write if the target changed under you), per-row **Compare** and **Find usages**, and one-click **Re-plan** to retry after a partial failure. Writes are never silent and never automatic — every import is gated by a confirmation that states it can't be undone.

## [0.1.1] — 2026-06-10

### Fixed
- On-prem AM journeys all showed as "Disabled" against AM versions that don't return an `enabled` field on authentication trees. A tree is now treated as enabled unless the response explicitly sets `enabled: false` (matching AM's own default — a tree is enabled unless turned off).
- The connection-type selector in the Edit Connection form rendered as empty boxes instead of showing the saved type. The radios now draw correctly — the saved type appears as a greyed-out selected radio (the type isn't editable once a connection is saved).

## [0.1.0] — 2026-06-10

### Added
- **On-prem PingAM / ForgeRock AM support.** Add an "On-prem AM" connection (base URL + admin username/password) alongside PAIC cloud connections, and browse + resolve its journeys, scripts, library scripts, inner journeys, and social IdPs the same way. On-prem connections authenticate with a session token (vs PAIC's service-account JWT-bearer), surface the platform **root** realm in the tree, and derive the AM context path from the base URL (supports WARs deployed under a custom path). Themes, email templates, and ESVs don't appear for on-prem connections — they're PAIC-platform resources a standalone AM doesn't have.

## [0.0.2] — 2026-05-26

### Fixed
- Inspector panel could stay stuck on the "Select a tree node to inspect" placeholder on first open over slow IPC (Remote Desktop / high-latency display). The first `select` message from the extension could arrive at the webview before React mounted and registered its `message` listener; outbound posts are now gated on a `ready` handshake from the webview (with a 5-second timeout fallback so a genuinely broken webview can't wedge the panel silently).
- `paicJourneys.connections` could be written into the workspace `.vscode/settings.json` of whatever folder happened to be open when a connection was added, instead of staying in the per-user (global) settings as designed. Connections are now always read from and written to the user-level settings, and the property is declared `"scope": "application"` so VS Code itself ignores any stray workspace-level entries.
- `paicJourneys.logging.level` and `paicJourneys.logging.fileEnabled` are now also application-scoped (per-user only). Workspace-level overrides for either setting are ignored both by VS Code and by the extension's read path. Consistent with `paicJourneys.connections`: nothing this extension reads can be polluted by a project's `.vscode/settings.json`.

## [0.0.1] — Initial release

First public release on the Visual Studio Code Marketplace.

### Added
- Multi-connection PAIC sidebar with service-account JWT-bearer auth; JWKs stored in VS Code SecretStorage.
- Per-realm journey tree: connection → realm → journey → inner journeys / scripts / library scripts.
- Inline script bodies via the `paic-script://` file-system provider (real editor tabs, full syntax highlighting).
- Script diff across connections.
- Dependency inspector panel (Direct, Full tree, Flat) with a resolver cache.
- Search page: reverse-dependency lookup, search-by-name, orphans, and a realm index.
- Find-usages from any script or inner journey.
- Structured NDJSON logging with configurable level.
