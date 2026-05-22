import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { EntityKind, RealmIndexEntity, RealmIndexEntry } from "../../domain/realm-index";
import type { BuildProgress } from "../../realm-index/build";
import type { RealmIndexCache } from "../../realm-index/cache";
import { findUnused, findUsagePaths, findUsages, searchByName } from "../../realm-index/queries";
import type { ClientCache } from "../../tenants/client-cache";
import type { Logger } from "../../util/logger";
import type { InspectorFactory } from "../inspector/panel";
import {
  type CacheStatus,
  type ConnectionInfo,
  type E2W,
  type HydratedReverseRef,
  isW2E,
  type SearchPayload,
  type SearchPrefill,
  type W2E,
} from "./messages";

const EMPTY_COUNTS: Record<EntityKind, number> = {
  journey: 0,
  script: 0,
  esv: 0,
  theme: 0,
  emailTemplate: 0,
  socialIdp: 0,
};

/** Min interval between coalesced `buildProgress` posts (~5 Hz). The build
 * emits one progress callback per completed journey (100s of them); the
 * webview only needs a smooth-looking bar, not every tick. */
const PROGRESS_THROTTLE_MS = 200;

/** Options for opening / focusing the Search page. All optional — the
 * sidebar-icon / palette entry passes nothing; right-click + card-portal
 * entries pre-fill what they know. */
export interface SearchSpawnOptions {
  selectedHost?: string;
  selectedRealm?: string;
  prefill?: SearchPrefill;
}

export interface SearchFactoryDeps {
  context: vscode.ExtensionContext;
  cache: ClientCache;
  realmIndexCache: RealmIndexCache;
  /** Result-row clicks open a fresh inspector tab via this factory (D24). */
  inspectorFactory: InspectorFactory;
  /** Current registered connections — read fresh on every spawn / refresh
   * so the connection dropdown reflects the latest registry state. */
  listConnections: () => readonly ConnectionInfo[];
  log: Logger;
}

/**
 * Owns the lifecycle of the (singleton) Search webview. The page picks
 * its `(host, realm)` via in-page dropdowns, so there is exactly one
 * Search tab — re-invoking `spawn()` focuses the existing tab and
 * re-renders it with the new pre-selection / prefill.
 *
 * This supersedes D36's original "single instance per (host, realm)"
 * rule — see the 2026-05-19 redesign note in `docs/design-plan.md` D36.
 */
export class SearchFactory implements vscode.Disposable {
  private tab: SearchTab | null = null;
  private readonly childLog: Logger;

  constructor(private readonly deps: SearchFactoryDeps) {
    this.childLog = deps.log.child({ component: "webview.search.factory" });
  }

  /** Open or focus the (singleton) Search page. */
  spawn(opts: SearchSpawnOptions = {}): SearchTab {
    const payload: SearchPayload = {
      connections: this.deps.listConnections(),
      selectedHost: opts.selectedHost ?? null,
      selectedRealm: opts.selectedRealm ?? null,
      prefill: opts.prefill ?? null,
    };
    if (this.tab) {
      this.tab.refresh(payload);
      this.tab.reveal();
      this.childLog.debug({ event: "factory.spawn.focus" }, "Focused existing Search tab");
      return this.tab;
    }
    this.tab = new SearchTab(
      {
        context: this.deps.context,
        cache: this.deps.cache,
        realmIndexCache: this.deps.realmIndexCache,
        inspectorFactory: this.deps.inspectorFactory,
        log: this.deps.log,
        onClosed: () => {
          this.tab = null;
        },
      },
      payload,
    );
    this.childLog.info({ event: "factory.spawn" }, "Spawned Search tab");
    return this.tab;
  }

  /** Re-render the open tab with the fresh connection list — called when
   * the connection registry mutates so the dropdown stays current. */
  clearRegistry(): void {
    if (!this.tab) return;
    this.tab.refresh({
      connections: this.deps.listConnections(),
      selectedHost: null,
      selectedRealm: null,
      prefill: null,
    });
  }

  dispose(): void {
    this.tab?.dispose();
    this.tab = null;
  }
}

interface SearchTabDeps {
  context: vscode.ExtensionContext;
  cache: ClientCache;
  realmIndexCache: RealmIndexCache;
  inspectorFactory: InspectorFactory;
  log: Logger;
  onClosed: (tab: SearchTab) => void;
}

export class SearchTab implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly childLog: Logger;

  constructor(
    private readonly deps: SearchTabDeps,
    payload: SearchPayload,
  ) {
    this.childLog = deps.log.child({ component: "webview.search.tab" });
    this.panel = vscode.window.createWebviewPanel(
      "paicJourneys.search",
      "PAIC Search",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(deps.context.extensionUri, "out")],
      },
    );
    this.panel.iconPath = new vscode.ThemeIcon("search");
    this.panel.webview.html = this.renderHtml(this.panel.webview, payload);
    this.panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m));
    this.panel.onDidDispose(() => {
      this.deps.onClosed(this);
      this.childLog.debug({ event: "tab.closed" }, "Search tab disposed");
    });
    this.childLog.info({ event: "tab.opened" }, "Search tab opened");
  }

  dispose(): void {
    this.panel.dispose();
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn, true);
  }

  /** Re-render the page with a fresh payload (new pre-selection / prefill
   * / connection list). The webview reads the embedded payload on mount;
   * re-rendering is simpler than a dedicated `setPayload` E2W message
   * that the App would have to diff against existing state. */
  refresh(payload: SearchPayload): void {
    this.panel.webview.html = this.renderHtml(this.panel.webview, payload);
  }

  // ─── private ─────────────────────────────────────────────────────────────

  private async onMessage(raw: unknown): Promise<void> {
    if (!isW2E(raw)) return;
    const m = raw;
    if (m.type === "ready") {
      this.childLog.debug({ event: "tab.ready" }, "Search webview ready");
      return;
    }
    if (m.type === "listRealms") {
      await this.handleListRealms(m.host);
      return;
    }
    if (m.type === "peek") {
      this.handlePeek(m.host, m.realm);
      return;
    }
    if (m.type === "build") {
      await this.handleBuild(m.host, m.realm);
      return;
    }
    if (m.type === "rescan") {
      this.deps.realmIndexCache.dropOne(m.host, m.realm);
      await this.handleBuild(m.host, m.realm);
      return;
    }
    if (m.type === "listEntities") {
      this.handleListEntities(m.host, m.realm);
      return;
    }
    if (m.type === "query") {
      this.handleQuery(m);
      return;
    }
    if (m.type === "previewByKey") {
      this.handlePreviewByKey(m);
      return;
    }
  }

  private async handleListRealms(host: string): Promise<void> {
    try {
      const client = await this.deps.cache.get(host);
      const realms = await client.listRealms();
      // Hide the platform root realm (D25) — service accounts get 403 on it.
      const usable = realms.filter((r) => !r.isRoot && r.name !== "/").map((r) => r.name);
      this.post({ type: "realmsResult", host, realms: usable });
      this.childLog.debug(
        { event: "tab.listRealms", host, realm_count: usable.length },
        "Listed realms",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.childLog.error(
        { event: "tab.listRealms.failed", host, message },
        "Failed to list realms",
      );
      this.post({ type: "realmsError", host, message });
    }
  }

  private handlePeek(host: string, realm: string): void {
    const entry = this.deps.realmIndexCache.peek(host, realm);
    this.post({ type: "peekResult", host, realm, status: statusFrom(entry) });
  }

  private async handleBuild(host: string, realm: string): Promise<void> {
    this.post({ type: "buildStart", host, realm });
    this.childLog.info({ event: "tab.build.start", host, realm }, "Building realm index");

    // Coalesce per-journey progress callbacks → at most one `buildProgress`
    // post per PROGRESS_THROTTLE_MS, plus an immediate post on every phase
    // change so the bar's label never lags behind the actual phase.
    let lastPhase = "";
    let lastPostAt = 0;
    let pending: BuildProgress | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = (): void => {
      if (!pending) return;
      lastPostAt = Date.now();
      this.post({ type: "buildProgress", host, realm, ...pending });
      pending = null;
    };
    const onProgress = (p: BuildProgress): void => {
      pending = p;
      if (p.phase !== lastPhase) {
        lastPhase = p.phase;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        flush();
        return;
      }
      if (Date.now() - lastPostAt >= PROGRESS_THROTTLE_MS) {
        flush();
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, PROGRESS_THROTTLE_MS);
      }
    };

    try {
      const client = await this.deps.cache.get(host);
      const entry = await this.deps.realmIndexCache.build(host, realm, {
        client,
        log: this.childLog,
        onProgress,
      });
      if (timer) clearTimeout(timer);
      this.post({ type: "buildDone", host, realm, status: statusFrom(entry) });
      this.childLog.info(
        {
          event: "tab.build.done",
          host,
          realm,
          entity_count: Object.keys(entry.entities).length,
          duration_ms: entry.scanDurationMs,
        },
        "Realm index build complete",
      );
    } catch (err) {
      if (timer) clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      this.childLog.error(
        { event: "tab.build.failed", host, realm, message },
        "Realm index build failed",
      );
      this.post({ type: "buildError", host, realm, message });
    }
  }

  private handleListEntities(host: string, realm: string): void {
    const entry = this.deps.realmIndexCache.peek(host, realm);
    const grouped: Record<EntityKind, RealmIndexEntity[]> = {
      journey: [],
      script: [],
      esv: [],
      theme: [],
      emailTemplate: [],
      socialIdp: [],
    };
    if (entry) {
      for (const e of Object.values(entry.entities)) {
        grouped[e.kind].push(e);
      }
      for (const k of Object.keys(grouped) as EntityKind[]) {
        grouped[k].sort((a, b) =>
          a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
        );
      }
    }
    this.post({ type: "listEntitiesResult", host, realm, entitiesByKind: grouped });
  }

  private handleQuery(m: Extract<W2E, { type: "query" }>): void {
    const { host, realm } = m;
    const entry = this.deps.realmIndexCache.peek(host, realm);
    if (!entry) {
      this.post({
        type: "queryError",
        host,
        realm,
        message: "Realm index is not built yet — click Build index first.",
      });
      return;
    }
    if (m.mode === "findUsages") {
      const refs = findUsages(entry, m.targetKey);
      const hydrated: HydratedReverseRef[] = refs.map((ref) => ({
        ref,
        entity: entry.entities[ref.fromKey] ?? null,
      }));
      // The Tree view's path graph — pure, derived from the same entry.
      const paths = findUsagePaths(entry, m.targetKey);
      this.childLog.debug(
        {
          event: "tab.query",
          mode: m.mode,
          target_key: m.targetKey,
          ref_count: hydrated.length,
          root_count: paths.roots.length,
          usage_count: paths.usageCount,
        },
        "Find usages query",
      );
      this.post({
        type: "queryResult",
        host,
        realm,
        mode: "findUsages",
        targetKey: m.targetKey,
        refs: hydrated,
        paths,
      });
      return;
    }
    if (m.mode === "byName") {
      const results = searchByName(entry, m.pattern, m.kinds);
      this.childLog.debug(
        { event: "tab.query", mode: m.mode, pattern: m.pattern, result_count: results.length },
        "By name query",
      );
      this.post({ type: "queryResult", host, realm, mode: "byName", results });
      return;
    }
    // unused
    const results = findUnused(entry, m.kinds);
    this.childLog.debug(
      { event: "tab.query", mode: m.mode, result_count: results.length },
      "Find unused query",
    );
    this.post({ type: "queryResult", host, realm, mode: "unused", results });
  }

  private handlePreviewByKey(m: Extract<W2E, { type: "previewByKey" }>): void {
    this.childLog.info(
      { event: "tab.preview", kind: m.kind, id: m.id },
      "Spawning inspector tab from Search result",
    );
    // Fire-and-forget; the inspector factory logs failures internally.
    void this.deps.inspectorFactory.spawnByDescriptor(m.host, m.realm, {
      kind: m.kind,
      id: m.id,
      displayName: m.displayName,
      ...(m.isLibrary === undefined ? {} : { isLibrary: m.isLibrary }),
      ...(m.esvKind === undefined ? {} : { esvKind: m.esvKind }),
    });
  }

  private post(msg: E2W): void {
    this.panel.webview.postMessage(msg);
  }

  private renderHtml(webview: vscode.Webview, payload: SearchPayload): string {
    const nonce = makeNonce();
    const bundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.context.extensionUri, "out", "search.js"),
    );
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.context.extensionUri, "out", "codicon.css"),
    );
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");
    const payloadAttr = JSON.stringify(payload)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<title>Search</title>
<link rel="stylesheet" href="${codiconUri.toString()}" />
<style>${SEARCH_CSS}</style>
</head>
<body>
<div id="root" data-paic-payload="${payloadAttr}"></div>
<script nonce="${nonce}" src="${bundleUri.toString()}"></script>
</body>
</html>`;
  }
}

function statusFrom(entry: RealmIndexEntry | null): CacheStatus {
  if (!entry) {
    return { builtAt: null, scanDurationMs: null, counts: null };
  }
  return {
    builtAt: entry.builtAt,
    scanDurationMs: entry.scanDurationMs,
    counts: { ...EMPTY_COUNTS, ...entry.counts },
  };
}

function makeNonce(): string {
  return randomBytes(16)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "");
}

const SEARCH_CSS = `
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px 24px;
    margin: 0;
  }
  h1 {
    font-size: 1.2em;
    margin: 0 0 4px 0;
    font-weight: 600;
  }
  .search-subtitle {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    margin-bottom: 16px;
  }
  .search-scope {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 8px 12px;
    align-items: center;
    border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-radius: 4px;
    padding: 12px 16px;
    margin-bottom: 16px;
  }
  .search-scope .field-label {
    font-weight: 600;
    font-size: 0.9em;
  }
  .search-hint {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    padding: 16px 0;
  }
  .search-header {
    border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-radius: 4px;
    padding: 12px 16px;
    margin-bottom: 16px;
  }
  .search-status {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .search-counts {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  .search-counts .count {
    color: var(--vscode-foreground);
    font-weight: 600;
  }
  .search-progress-label {
    font-size: 0.9em;
    margin-bottom: 6px;
  }
  .search-progress-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .search-progress-track {
    flex: 1;
    height: 6px;
    background: var(--vscode-panel-border, var(--vscode-editorWidget-border));
    border-radius: 3px;
    overflow: hidden;
  }
  .search-progress-fill {
    height: 100%;
    background: var(--vscode-progressBar-background, var(--vscode-button-background));
    border-radius: 3px;
    transition: width 0.2s ease;
  }
  .search-progress-pct {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    min-width: 3.2em;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .search-actions {
    display: flex;
    gap: 8px;
  }
  button {
    padding: 4px 12px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    cursor: pointer;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  button:hover {
    background: var(--vscode-button-hoverBackground);
  }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  button:focus-visible {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .query-mode-control {
    display: inline-flex;
    border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    overflow: hidden;
    margin-bottom: 12px;
  }
  .query-mode-control button {
    border: none;
    border-radius: 0;
    background: transparent;
    color: var(--vscode-foreground);
    padding: 4px 12px;
  }
  .query-mode-control button.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .query-mode-control button:not(:last-child) {
    border-right: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
  }
  .query-controls {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 8px 12px;
    align-items: start;
    margin-bottom: 12px;
  }
  /* Labels align to the top of their cell. The Target cell can be tall
     (it hosts the combobox plus its absolutely-positioned popup), so
     align-items:start keeps the label on the input's row instead of
     floating to the cell's middle. The top pad visually centers it on
     the input box (input is 4px padding + 1px border + text). */
  .query-controls label,
  .query-controls .field-label {
    font-weight: 600;
    font-size: 0.9em;
    padding-top: 5px;
  }
  /* All dropdowns are the custom Combobox (D38) — no native <select>
     remains, so these rules style <input> only (the By-name pattern
     field + every combobox's text input). */
  input {
    padding: 4px 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    width: 100%;
    box-sizing: border-box;
  }
  input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .entity-combobox {
    position: relative;
  }
  /* The field box — the chevron anchors HERE, not to .entity-combobox
     (which grows tall when the popup opens, dragging the chevron down). */
  .entity-combobox-field {
    position: relative;
  }
  /* Chevron — the affordance that makes the input read as a dropdown,
     not a text field. Sits inside the box, on the right, like a native
     <select>. */
  .entity-combobox-chevron {
    position: absolute;
    right: 6px;
    top: 0;
    bottom: 0;
    display: flex;
    align-items: center;
    pointer-events: none;
    font-size: 14px;
    color: var(--vscode-foreground);
    opacity: 0.8;
  }
  .entity-combobox-field input {
    /* room for the chevron */
    padding-right: 24px;
  }
  /* When the popup is open, square the input's bottom corners so the
     box + list visually fuse into one dropdown. */
  .entity-combobox.open input {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
  }
  /* Popup sits FLUSH under the input (overlapping its 1px border) and
     uses the native dropdown's own widget colours + a subtle shadow —
     so the box + list read as one control, like a native <select>. */
  .entity-combobox-list {
    position: absolute;
    z-index: 10;
    left: 0;
    right: 0;
    top: 100%;
    margin-top: -1px;
    max-height: 280px;
    overflow-y: auto;
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
    border: 1px solid var(--vscode-focusBorder);
    border-top-color: var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
    border-radius: 0 0 4px 4px;
    box-shadow: 0 3px 8px rgba(0, 0, 0, 0.36);
  }
  .entity-combobox-option {
    padding: 5px 10px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .entity-combobox-option:hover,
  .entity-combobox-option.active {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
  }
  .entity-combobox-empty {
    padding: 5px 10px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
  .kind-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .kind-chips button {
    padding: 2px 8px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    font-size: 0.85em;
  }
  .kind-chips button.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
  }
  .query-submit {
    margin-bottom: 12px;
  }
  .search-results {
    border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    padding-top: 12px;
  }
  .search-results-header {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    margin-bottom: 8px;
  }
  .search-results-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .search-divider {
    color: var(--vscode-descriptionForeground);
    font-size: 0.82em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 12px 0 2px 0;
    padding-bottom: 2px;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
  }
  .search-divider:first-child {
    margin-top: 0;
  }
  .search-row {
    padding: 4px 0;
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
  }
  .search-row .codicon {
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground);
  }
  .search-row button.link {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    padding: 0;
    font-size: inherit;
    font-family: inherit;
    text-align: left;
  }
  .search-row button.link:hover {
    color: var(--vscode-textLink-activeForeground);
    text-decoration: underline;
  }
  .search-row button.link:focus-visible {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  .search-row .meta {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .search-empty {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    padding: 12px 0;
  }
  .search-error {
    color: var(--vscode-errorForeground);
    padding: 12px 0;
  }
  .search-pending {
    color: var(--vscode-descriptionForeground);
    padding: 12px 0;
  }
  .search-tree, .search-tree ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .search-tree ul {
    margin-left: 9px;
    padding-left: 12px;
    border-left: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
  }
  .search-tree-row {
    padding: 3px 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .search-tree-row .codicon {
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground);
  }
  .search-tree-row button.link {
    background: none;
    border: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    padding: 0;
    font-size: inherit;
    font-family: inherit;
    text-align: left;
  }
  .search-tree-row button.link:hover {
    color: var(--vscode-textLink-activeForeground);
    text-decoration: underline;
  }
  .search-tree-row button.link:focus-visible {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  .search-tree-via {
    color: var(--vscode-descriptionForeground);
    font-size: 0.82em;
    margin-left: auto;
    padding-left: 12px;
  }
  .search-tree-dup {
    color: var(--vscode-descriptionForeground);
    font-size: 0.82em;
    font-style: italic;
  }
  .search-tree-refcount {
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    font-size: 0.78em;
    border-radius: 8px;
    padding: 0 6px;
  }
  .search-tree-orphan {
    color: var(--vscode-editorWarning-foreground, var(--vscode-descriptionForeground));
    font-size: 0.82em;
  }
`;
