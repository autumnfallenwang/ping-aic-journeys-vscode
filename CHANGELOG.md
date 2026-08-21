# Changelog

All notable changes to the **PAIC Journeys** extension are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project follows [Semantic Versioning](https://semver.org/).

## [0.4.2] — 2026-08-21

### Fixed
- **Import plan checks are no longer flaky on a slow or unreliable connection.** When you picked a target for an import, the extension checked every component against that target all at once. On a congested link some of those checks — most often scripts, whose check downloads the whole script body — would come back with a connection error and show as red rows in the plan. The checks are now paced (at most ten at a time, matching how the rest of the extension talks to a tenant) and a dropped connection is retried over a longer window, so a brief network hiccup no longer surfaces as a failed row.
- **A failed check can no longer let a broken journey be imported.** A component whose check failed was shown as a red row you couldn't select — but Import stayed enabled, and the journey would be written referencing a script that was never imported and may not exist on the target. Import is now blocked while any row's check has failed, and those rows are counted as blocked in the plan summary.

### Added
- **Progress while the import plan is being built.** The plan step now shows which stage it's on, how many components it has checked out of the total, and elapsed time — instead of a static "Checking target…" with no indication of whether it is still working.
- **Recheck failed (N).** When some rows in the plan failed their check, a button appears on the plan summary line — beside the blocked count — that re-runs the check for **just those rows**, keeping your selections and compare options intact. Previously the only way to retry was to switch the realm away and back, which discarded everything you had chosen.

### Changed
- The compare-relaxation checkboxes above the plan are now labelled **Ignore:** rather than "Ignore when comparing:", matching the **Plan:** line directly above them.

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
