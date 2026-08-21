import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { runEsvApply } from "../../import/apply";
import type { ComponentVerdict } from "../../import/compare";
import { canonScriptBody } from "../../import/compare";
import { buildImportConfirmDetail } from "../../import/confirm";
import { discoverScriptDeps } from "../../import/discover";
import { runExecute, type WritePlanItem, type WriteResult } from "../../import/execute";
import { diffSnapshots, snapshotState } from "../../import/freeze";
import { assembleJourneyImport } from "../../import/journey-assemble";
import { type CompareOptions, EXACT_COMPARE } from "../../import/journey-compare";
import { runJourneyExecute } from "../../import/journey-execute";
import { type JourneyAction, planJourneyUnits } from "../../import/journey-plan";
import { WRITABLE_KINDS } from "../../import/kinds";
import { limitClient } from "../../import/limited-client";
import type { ImportComponent } from "../../import/parse";
import { parseBundle } from "../../import/parse";
import {
  checkJourneyGates,
  computeIdenticalJourneys,
  discoverDeps,
  type JourneyCompareCache,
  journeyCompareReadCount,
  missingDepsNote,
  type PreflightClient,
  type RequiredDepVerdict,
  readJourneyCompareInputs,
  runPreflight,
} from "../../import/preflight";
import { buildImportReport, type ImportReport } from "../../import/report";
import { idpNeedsSecret } from "../../import/write";
import type { PaicBundleContentProvider } from "../../providers/bundle-content-provider";
import { makeScriptUri } from "../../providers/script-fs-provider";
import type { ClientCache } from "../../tenants/client-cache";
import { confirm } from "../../util/dialogs";
import type { Logger } from "../../util/logger";
import type { SearchPrefill } from "../search/messages";
import { COMBOBOX_CSS } from "../shared/combobox-css";
import {
  type ConnectionInfo,
  type E2W,
  isW2E,
  type ParsedBundle,
  type PreflightPhase,
  type TransferPayload,
} from "./messages";

/** Connections read fresh on every spawn so the payload reflects the current
 * registry state (used by the Slice-B target dropdown). */
/** The slice of `SearchFactory` the Transfer page needs (TD-11 Find-usages) —
 * structural to avoid a hard cross-webview import. */
export interface SearchSpawner {
  spawn(opts: { selectedHost?: string; selectedRealm?: string; prefill?: SearchPrefill }): unknown;
}

export interface TransferFactoryDeps {
  context: vscode.ExtensionContext;
  listConnections: () => readonly ConnectionInfo[];
  /** Mints/caches a PaicClient per host — used to list a target's realms. */
  cache: ClientCache;
  /** Connection kind for a host — drives the realm-list root filter. */
  connectionKindOf: (host: string) => "paic" | "onprem" | undefined;
  /** Opens the Search page pre-filled for find-usages (TD-11). */
  searchFactory: SearchSpawner;
  /** Serves the bundle component's source as the Diff right side (TD-11). */
  bundleContent: PaicBundleContentProvider;
  log: Logger;
}

/**
 * Owns the lifecycle of the singleton Transfer webview (TD-6). Re-invoking
 * `spawn()` focuses the existing tab and re-renders it with the fresh
 * connection list. Slice A is read-only: load a bundle file and preview it.
 */
export class TransferFactory implements vscode.Disposable {
  private tab: TransferTab | null = null;
  private readonly childLog: Logger;

  constructor(private readonly deps: TransferFactoryDeps) {
    this.childLog = deps.log.child({ component: "webview.transfer.factory" });
  }

  /** Open or focus the (singleton) Transfer page. */
  spawn(): TransferTab {
    const payload: TransferPayload = { connections: this.deps.listConnections() };
    if (this.tab) {
      this.tab.refresh(payload);
      this.tab.reveal();
      this.childLog.debug({ event: "factory.spawn.focus" }, "Focused existing Transfer tab");
      return this.tab;
    }
    this.tab = new TransferTab(
      {
        context: this.deps.context,
        cache: this.deps.cache,
        connectionKindOf: this.deps.connectionKindOf,
        searchFactory: this.deps.searchFactory,
        bundleContent: this.deps.bundleContent,
        log: this.deps.log,
        onClosed: () => {
          this.tab = null;
        },
      },
      payload,
    );
    this.childLog.info({ event: "factory.spawn" }, "Spawned Transfer tab");
    return this.tab;
  }

  dispose(): void {
    this.tab?.dispose();
    this.tab = null;
  }
}

interface TransferTabDeps {
  context: vscode.ExtensionContext;
  cache: ClientCache;
  connectionKindOf: (host: string) => "paic" | "onprem" | undefined;
  searchFactory: SearchSpawner;
  bundleContent: PaicBundleContentProvider;
  log: Logger;
  onClosed: (tab: TransferTab) => void;
}

export class TransferTab implements vscode.Disposable {
  private readonly panel: vscode.WebviewPanel;
  private readonly childLog: Logger;
  /** The currently-loaded bundle (extension-side). `rawComponents` carries the
   * raw export objects for the compare — never crosses postMessage. Survives a
   * webview remount (`refresh()` / re-`spawn()`); the summary is re-posted on
   * the next `ready`. */
  private loaded: {
    fileName: string;
    bundle: ParsedBundle;
    rawComponents: ImportComponent[];
  } | null = null;

  /** PD-11 freeze baseline: the target snapshot captured at the last successful
   * pre-flight. `executeJourneyImport` re-reads at commit and refuses to write if
   * the target drifted. Reset when a new bundle loads (a stale baseline).
   *
   * `gates` is kept alongside because a PD-20 recheck has to REBUILD this
   * snapshot from the merged verdicts — and `snapshotState` needs the gates that
   * went into the original. Without it an `error → exists` flip would read as
   * drift at commit and refuse a perfectly good import. */
  private preview: {
    host: string;
    realm: string;
    snapshot: ReadonlyMap<string, string>;
    gates: RequiredDepVerdict[];
  } | null = null;

  /** PD-17: the last completed run's report, built at execute time so the
   * "Download report" download reflects that run (not a later re-preview).
   * Reset when a new bundle loads. */
  private lastReport: ImportReport | null = null;

  /** Target reads for the own-scope journey compare, cached from the last
   * pre-flight so a compare-option toggle recomputes locally instead of
   * re-hitting AM. Keyed by (host, realm) so a target change invalidates it. */
  private compare: {
    host: string;
    realm: string;
    cache: JourneyCompareCache;
    verdicts: ComponentVerdict[];
  } | null = null;

  /** The user's current compare relaxations. Session state, deliberately NOT
   * persisted to settings — a hidden persisted mask is the problem these
   * options exist to avoid. Reset to exact whenever a new bundle loads. */
  private compareOptions: CompareOptions = EXACT_COMPARE;

  constructor(
    private readonly deps: TransferTabDeps,
    payload: TransferPayload,
  ) {
    this.childLog = deps.log.child({ component: "webview.transfer.tab" });
    this.panel = vscode.window.createWebviewPanel(
      "paicJourneys.transfer",
      "PAIC Transfer",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(deps.context.extensionUri, "out")],
      },
    );
    this.panel.iconPath = new vscode.ThemeIcon("cloud-upload");
    this.panel.webview.html = this.renderHtml(this.panel.webview, payload);
    this.panel.webview.onDidReceiveMessage((m: unknown) => this.onMessage(m));
    this.panel.onDidDispose(() => {
      this.deps.onClosed(this);
      this.childLog.debug({ event: "tab.closed" }, "Transfer tab disposed");
    });
    this.childLog.info({ event: "tab.opened" }, "Transfer tab opened");
  }

  dispose(): void {
    this.panel.dispose();
  }

  reveal(): void {
    this.panel.reveal(this.panel.viewColumn, true);
  }

  /** Re-render with a fresh payload (new connection list). The webview reads
   * the embedded payload on mount — re-rendering is simpler than a dedicated
   * setPayload message. */
  refresh(payload: TransferPayload): void {
    this.panel.webview.html = this.renderHtml(this.panel.webview, payload);
  }

  // ─── private ─────────────────────────────────────────────────────────────

  private async onMessage(raw: unknown): Promise<void> {
    if (!isW2E(raw)) return;
    if (raw.type === "ready") {
      this.childLog.debug({ event: "tab.ready" }, "Transfer webview ready");
      // Re-hydrate the preview after a webview remount (refresh / re-spawn).
      if (this.loaded) {
        this.post({
          type: "bundleLoaded",
          fileName: this.loaded.fileName,
          bundle: this.loaded.bundle,
        });
      }
      return;
    }
    if (raw.type === "listRealms") {
      await this.handleListRealms(raw.host);
      return;
    }
    if (raw.type === "runPreflight") {
      await this.handleRunPreflight(raw.host, raw.realm);
      return;
    }
    if (raw.type === "recheckFailed") {
      await this.handleRecheckFailed(raw.host, raw.realm, raw.keys);
      return;
    }
    if (raw.type === "setCompareOptions") {
      this.handleSetCompareOptions(raw.host, raw.realm, raw.options);
      return;
    }
    if (raw.type === "execute") {
      await this.handleExecute(raw.host, raw.realm, raw.selected, raw.journeyActions);
      return;
    }
    if (raw.type === "applyEsv") {
      await this.handleApplyEsv(raw.host);
      return;
    }
    if (raw.type === "downloadReport") {
      await this.handleDownloadReport();
      return;
    }
    if (raw.type === "openDiff") {
      await this.handleOpenDiff(
        raw.host,
        raw.realm,
        raw.bundleKey,
        raw.targetScriptId,
        raw.language,
      );
      return;
    }
    if (raw.type === "openFindUsages") {
      this.deps.searchFactory.spawn({
        selectedHost: raw.host,
        selectedRealm: raw.realm,
        prefill: { mode: "findUsages", targetKey: raw.targetKey, targetKind: raw.targetKind },
      });
      return;
    }
    if (raw.type === "pickBundle") {
      await this.handlePickBundle();
    }
  }

  /** Apply pending ESV changes — a tenant-wide environment restart (TD-7). The
   * one write here is the restart POST; progress is polled + streamed to the
   * webview (host-keyed, durable). */
  private async handleApplyEsv(host: string): Promise<void> {
    try {
      const client = await this.deps.cache.get(host);
      const ok = await confirm(
        "Apply pending ESV changes?",
        [
          `Target — ${host}`,
          "",
          "Restarts the runtime (~3–10 minutes) and applies ALL pending ESV changes " +
            "tenant-wide — not just the ones you imported.",
          "",
          "  ⚠ No further ESV updates are possible until it finishes.",
          "  ⚠ This can't be undone.",
        ].join("\n"),
        "Apply",
      );
      if (!ok) {
        this.post({ type: "applyResult", host, ok: false, elapsedS: 0, message: "Cancelled." });
        return;
      }
      this.childLog.info({ event: "tab.applyEsv.start", host }, "Applying ESV changes (restart)");
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Applying ESV changes…" },
        (progress) =>
          runEsvApply(client, {
            onProgress: (status, elapsedS) => {
              progress.report({ message: `${status} (${elapsedS}s)` });
              this.post({ type: "applyProgress", host, status, elapsedS });
            },
          }),
      );
      this.post({
        type: "applyResult",
        host,
        ok: result.ok,
        elapsedS: result.elapsedS,
        ...(result.ok ? {} : { message: `final status: ${result.finalStatus}` }),
      });
      this.childLog.info(
        { event: "tab.applyEsv.done", host, ok: result.ok, elapsed_s: result.elapsedS },
        "ESV apply finished",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.childLog.error({ event: "tab.applyEsv.failed", host, message }, "ESV apply failed");
      this.post({ type: "applyResult", host, ok: false, elapsedS: 0, message });
    }
  }

  /** Read-only compare pre-flight: fetch each loaded component's current
   * version on the target and classify it. No writes. */
  /**
   * A compare-option toggle. Recomputes the journey verdicts from the CACHED
   * target reads — no AM round-trip, so the plan updates live. Leaf verdicts,
   * `requires` and the freeze snapshot are untouched: the options only change
   * what counts as an own-scope journey difference.
   *
   * A stale cache (different host/realm, or none yet) is a no-op rather than a
   * silent re-fetch — the webview re-runs pre-flight on a target change anyway.
   */
  private handleSetCompareOptions(host: string, realm: string, options: CompareOptions): void {
    this.compareOptions = options;
    const c = this.compare;
    if (!c || c.host !== host || c.realm !== realm || !this.loaded) return;
    const identicalJourneys = computeIdenticalJourneys(c.cache, options);
    const verdictById = new Map<string, "new" | "exists" | "identical">();
    for (const v of c.verdicts) {
      if (v.kind !== "journey") continue;
      let verdict: "new" | "exists" | "identical" = "exists";
      if (v.status === "new") verdict = "new";
      else if (identicalJourneys.has(v.id)) verdict = "identical";
      verdictById.set(v.id, verdict);
    }
    const journeyPlans = planJourneyUnits(this.loaded.rawComponents, verdictById);
    this.post({ type: "journeyPlansUpdated", host, realm, journeyPlans });
    this.childLog.info(
      {
        event: "tab.setCompareOptions",
        host,
        realm,
        ignore_node_positions: options.ignoreNodePositions,
        ignore_node_display_names: options.ignoreNodeDisplayNames,
        ignore_journey_tags: options.ignoreJourneyTags,
        identical: identicalJourneys.size,
      },
      "Recomputed journey compare",
    );
  }

  /**
   * One bounded client + one progress emitter for a whole pre-flight run
   * (PD-19). The limiter is created HERE, once per run, and shared across every
   * phase — a per-phase limiter would multiply (lessons.md 2026-05-19). The
   * returned `report` stamps elapsed time so a stall inside a transport retry
   * reads as slow rather than hung (D46).
   */
  private preflightRun(
    client: PreflightClient,
    host: string,
    realm: string,
  ): {
    client: PreflightClient;
    report: (phase: PreflightPhase, total: number) => (d: number) => void;
  } {
    const startedAt = Date.now();
    return {
      client: limitClient(client),
      report: (phase, total) => (done) => {
        this.post({
          type: "preflightProgress",
          host,
          realm,
          phase,
          done,
          total,
          elapsedS: Math.round((Date.now() - startedAt) / 1000),
        });
      },
    };
  }

  private async handleRunPreflight(host: string, realm: string): Promise<void> {
    if (!this.loaded) return;
    const targetKind = this.deps.connectionKindOf(host) ?? "paic";
    try {
      const { client, report } = this.preflightRun(await this.deps.cache.get(host), host, realm);
      const verdicts = await runPreflight(
        client,
        realm,
        targetKind,
        this.loaded.rawComponents,
        report("compare", this.loaded.rawComponents.length),
      );
      // TD-9: discover the script's direct dep refs (bundle-only, pure) and
      // existence-check them on the target — info-only "Requires" rows.
      const refs = discoverScriptDeps(this.loaded.rawComponents);
      // PD-7: blocking journey gates (node types / must-exist inner journeys) —
      // empty for a leaf bundle. Merged into `requires` (advisory + blocking).
      // Both are opaque (no per-item callback), so report the phase as a single
      // unit — the UI shows the phase label, and `elapsedS` keeps ticking.
      const depsDone = report("deps", 1);
      const [advisory, gates] = await Promise.all([
        discoverDeps(client, realm, refs),
        checkJourneyGates(client, realm, this.loaded.rawComponents),
      ]);
      depsDone(1);
      const requires = [...advisory, ...gates];
      // PD-5 amendment: of the journeys already on the target, which are
      // own-scope content-identical (tree + nodes) — a locked no-op vs a
      // Keep/Overwrite. Reads node bodies; never touches the raw `verdicts`
      // below (snapshot/drift stay existence-only).
      // Read the target ONCE and keep it: a compare-option toggle then recomputes
      // locally (`computeIdenticalJourneys` is pure) instead of re-hitting AM.
      const compareCache = await readJourneyCompareInputs(
        client,
        realm,
        this.loaded.rawComponents,
        verdicts,
        report("journeys", journeyCompareReadCount(this.loaded.rawComponents, verdicts)),
      );
      this.compare = { host, realm, cache: compareCache, verdicts: [...verdicts] };
      const identicalJourneys = computeIdenticalJourneys(compareCache, EXACT_COMPARE);
      // S5: per-unit Create/Overwrite/Keep decisions (empty for a leaf bundle).
      const verdictById = new Map<string, "new" | "exists" | "identical">();
      for (const v of verdicts) {
        if (v.kind !== "journey") continue;
        let verdict: "new" | "exists" | "identical" = "exists";
        if (v.status === "new") verdict = "new";
        else if (identicalJourneys.has(v.id)) verdict = "identical";
        verdictById.set(v.id, verdict);
      }
      const journeyPlans = planJourneyUnits(this.loaded.rawComponents, verdictById);
      // PD-11: freeze the target snapshot for the commit-time drift check — built
      // from the RAW existence verdicts (not the identical refinement) so a later
      // commit re-read (existence-only) can't read identical→exists as drift.
      this.preview = { host, realm, snapshot: snapshotState(verdicts, gates), gates };
      this.post({ type: "preflightResult", host, realm, verdicts, requires, journeyPlans });
      this.childLog.info(
        {
          event: "tab.runPreflight",
          host,
          realm,
          verdict_count: verdicts.length,
          requires_count: requires.length,
          journey_plans: journeyPlans.length,
        },
        "Ran import pre-flight",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.childLog.error(
        { event: "tab.runPreflight.failed", host, realm, message },
        "Pre-flight failed",
      );
      this.post({ type: "preflightError", host, realm, message });
    }
  }

  /**
   * PD-20 — re-run the pre-flight for ONLY the rows the user asked about
   * (the ones whose check failed). Targeted rather than a full re-plan so the
   * webview keeps its row selection and compare options; a full re-plan can't
   * promise that, because every verdict may legitimately have moved.
   *
   * Bounded like any other pre-flight, and — since the caller is retrying a
   * network failure — this is the path most likely to be exercised on a bad
   * link, so the limiter matters more here than anywhere.
   */
  private async handleRecheckFailed(host: string, realm: string, keys: string[]): Promise<void> {
    if (!this.loaded) return;
    const wanted = new Set(keys);
    const comps = this.loaded.rawComponents.filter((c) => wanted.has(`${c.kind}:${c.id}`));
    if (comps.length === 0) return;
    const targetKind = this.deps.connectionKindOf(host) ?? "paic";
    try {
      const { client, report } = this.preflightRun(await this.deps.cache.get(host), host, realm);
      const verdicts = await runPreflight(
        client,
        realm,
        targetKind,
        comps,
        report("compare", comps.length),
      );
      this.mergeRecheckedVerdicts(host, realm, verdicts);
      this.post({ type: "verdictsPatched", host, realm, verdicts });
      this.childLog.info(
        {
          event: "tab.recheckFailed",
          host,
          realm,
          requested: keys.length,
          resolved: verdicts.filter((v) => v.status !== "error").length,
        },
        "Rechecked failed pre-flight rows",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.childLog.error(
        { event: "tab.recheckFailed.failed", host, realm, message },
        "Recheck failed",
      );
      this.post({ type: "preflightError", host, realm, message });
    }
  }

  /**
   * Fold rechecked verdicts back into the panel's own state: the compare cache
   * (so a later compare-option toggle sees them) and — critically — the PD-11
   * freeze snapshot.
   *
   * Rebuilding the snapshot is not optional. It was frozen with the rechecked
   * rows still at `error`; if a recheck flips one to `exists`, the commit-time
   * re-read would diff against the stale baseline, call it drift, and refuse an
   * import that is in fact fine. Stale state here fails CLOSED and looks like a
   * bug in the drift check, which is why `preview` carries its `gates`.
   */
  private mergeRecheckedVerdicts(
    host: string,
    realm: string,
    fresh: readonly ComponentVerdict[],
  ): void {
    const c = this.compare;
    if (!c || c.host !== host || c.realm !== realm) return;
    const byKey = new Map(fresh.map((v) => [`${v.kind}:${v.id}`, v]));
    const merged = c.verdicts.map((v) => byKey.get(`${v.kind}:${v.id}`) ?? v);
    this.compare = { ...c, verdicts: merged };
    if (this.preview && this.preview.host === host && this.preview.realm === realm) {
      this.preview = {
        ...this.preview,
        snapshot: snapshotState(merged, this.preview.gates),
      };
    }
  }

  /** Execute the import (D43) — the ONLY method that mutates a tenant.
   * Re-validates fresh, confirms, collects idp secrets, writes sequentially,
   * reports per-component, then refreshes the Plan. */
  private async handleExecute(
    host: string,
    realm: string,
    selected: string[],
    journeyActions?: Record<string, JourneyAction>,
  ): Promise<void> {
    if (!this.loaded) return;
    // Journey bundles take the dependency-ordered path (freeze + drift + ordered
    // node/tree writes); leaf bundles keep the original flat-write path.
    if (this.loaded.bundle.kind === "journey") {
      return this.executeJourneyImport(host, realm, selected, journeyActions);
    }
    const targetKind = this.deps.connectionKindOf(host) ?? "paic";
    try {
      const client = await this.deps.cache.get(host);
      // Validate-before-first-write: a FRESH pre-flight, not the shown Plan.
      // Bounded (PD-19) — this is the same fan-out as the preview's, so it has
      // the same failure mode. `readClient` wraps reads only; the writes below
      // stay on the raw client (they're sequential by design, D43).
      const readClient = limitClient(client);
      const [verdicts, gates] = await Promise.all([
        runPreflight(readClient, realm, targetKind, this.loaded.rawComponents),
        checkJourneyGates(readClient, realm, this.loaded.rawComponents), // [] for a leaf bundle
      ]);
      // PD-11 freeze-the-plan parity (S10b): refuse on drift since preview, like journeys.
      if (this.driftStops(host, realm, snapshotState(verdicts, gates))) return;
      const rawByKey = new Map(this.loaded.rawComponents.map((c) => [`${c.kind}:${c.id}`, c]));
      const selectedSet = new Set(selected); // TD-8: honor per-row checkbox selection

      const items: WritePlanItem[] = [];
      for (const v of verdicts) {
        if (v.status !== "new" && v.status !== "differs") continue;
        if (!WRITABLE_KINDS.has(v.kind)) continue; // Slice C = atoms only
        if (!selectedSet.has(`${v.kind}:${v.id}`)) continue; // user deselected this row
        const component = rawByKey.get(`${v.kind}:${v.id}`);
        if (!component) {
          this.childLog.warn(
            { event: "tab.execute.noRaw", kind: v.kind, id: v.id },
            "Verdict has no matching raw component — skipping",
          );
          continue;
        }
        items.push({
          component,
          verdict: v.status,
          // TD-9: write reconciles to the name-matched target's UUID (scripts).
          ...(v.resolvedTargetId ? { resolvedTargetId: v.resolvedTargetId } : {}),
        });
      }
      const createN = items.filter((i) => i.verdict === "new").length;
      const overwriteN = items.filter((i) => i.verdict === "differs").length;
      const errorN = verdicts.filter((v) => v.status === "error").length;

      if (items.length === 0) {
        this.post({
          type: "executeResult",
          host,
          realm,
          results: [],
          summary: "Nothing to import — all components are identical or unsupported.",
        });
        return;
      }

      // TD-9: surface unmet dependency prerequisites at the decision point.
      // Advisory (warn, don't block) — the bundle can't supply a missing lib/ESV.
      const preflightRequires = await discoverDeps(
        client,
        realm,
        discoverScriptDeps(this.loaded.rawComponents),
      );
      const missingNote = missingDepsNote(preflightRequires);

      // Confirm modal — fresh counts, names the exact target, no-undo warning.
      const hasEsv = items.some(
        (i) => i.component.kind === "variable" || i.component.kind === "secret",
      );
      const detail = buildImportConfirmDetail({
        host,
        realm,
        create: createN,
        overwrite: overwriteN,
        errorN,
        hasEsv,
        missingNote,
      });
      const ok = await confirm("Write these components to the tenant?", detail, "Import");
      if (!ok) {
        this.post({ type: "executeResult", host, realm, results: [], summary: "Cancelled." });
        return;
      }

      // Collect re-supplied secrets AFTER the confirm. A cancelled box → that
      // component is skipped by the executor (never a blank write).
      await this.collectSecrets(items);

      this.childLog.info(
        { event: "tab.execute.start", host, realm, create: createN, overwrite: overwriteN },
        "Importing components",
      );
      const total = items.length;
      let done = 0;
      const startedAt = new Date().toISOString();
      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Importing components…" },
        (progress) =>
          runExecute(client, realm, items, (r) => {
            done += 1;
            progress.report({
              increment: 100 / total,
              message: `${r.kind} ${r.displayName} (${done}/${total})`,
            });
            this.post({ type: "executeProgress", host, realm, result: r, done, total });
          }),
      );
      this.captureReport(host, realm, startedAt, results);
      const count = (s: WriteResult["status"]) => results.filter((r) => r.status === s).length;
      const summary = `${count("created")} created · ${count("overwritten")} overwritten · ${count("skipped")} skipped · ${count("failed")} failed`;
      this.post({ type: "executeResult", host, realm, results, summary });
      this.childLog.info(
        { event: "tab.execute.done", host, realm, failed: count("failed") },
        "Import complete",
      );

      // TD-10: the table STAYS in result-state after a run (rows show
      // Created/Overwritten/Skipped/Failed) — we do NOT re-post a pre-flight,
      // which would revert them to Identical. Re-run pre-flight extension-side
      // only as a diagnostic drift check (logs a warning; never reaches the UI).
      const fresh = await runPreflight(readClient, realm, targetKind, this.loaded.rawComponents);
      this.warnOnDrift(results, fresh);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.childLog.error({ event: "tab.execute.failed", host, realm, message }, "Import failed");
      this.post({
        type: "executeResult",
        host,
        realm,
        results: [],
        summary: `Import failed: ${message}`,
      });
    }
  }

  /** Prompt for each write item's re-supplied secret (idp clientSecret / ESV
   * secret value) AFTER the confirm. A cancelled box leaves `secret` unset → the
   * executor skips that component (never a blank write). Shared by both paths. */
  private async collectSecrets(items: readonly WritePlanItem[]): Promise<void> {
    for (const item of items) {
      if (item.component.kind === "socialIdp" && idpNeedsSecret(item.component.raw)) {
        item.secret = await vscode.window.showInputBox({
          password: true,
          ignoreFocusOut: true,
          title: "Re-supply social-IdP client secret",
          prompt: `clientSecret for "${item.component.displayName}" (redacted in the bundle)`,
        });
      } else if (item.component.kind === "secret") {
        item.secret = await vscode.window.showInputBox({
          password: true,
          ignoreFocusOut: true,
          title: "Supply ESV secret value",
          prompt: `Value for ESV secret "${item.component.displayName}" (not in the bundle)`,
        });
      }
    }
  }

  /** Execute a JOURNEY import (D43 / PD-11/13/15) — the dependency-ordered path.
   * Re-validates fresh, refuses on drift (freeze) or a missing blocking
   * prerequisite, confirms, collects leaf secrets, then writes leaves + journeys
   * inner-before-outer via the engine. */
  private async executeJourneyImport(
    host: string,
    realm: string,
    selected: string[],
    journeyActions: Record<string, JourneyAction> | undefined,
  ): Promise<void> {
    const loaded = this.loaded;
    if (!loaded) return;
    const targetKind = this.deps.connectionKindOf(host) ?? "paic";
    try {
      const client = await this.deps.cache.get(host);
      // Fresh re-read at commit: verdicts + blocking gates + advisory deps.
      // Bounded (PD-19): without this the commit-time re-read is a second
      // unbounded fan-out, and an `error` verdict here silently drops a hard
      // script dependency from `assembleJourneyImport` (gap PG2).
      const readClient = limitClient(client);
      const [verdicts, gates, advisory] = await Promise.all([
        runPreflight(readClient, realm, targetKind, loaded.rawComponents),
        checkJourneyGates(readClient, realm, loaded.rawComponents),
        discoverDeps(readClient, realm, discoverScriptDeps(loaded.rawComponents)),
      ]);

      // PD-11 freeze-the-plan: if the target drifted since the previewed plan,
      // refuse to write and make the UI re-plan. (Snapshot uses the RAW
      // existence verdicts — matching the preview's freeze.)
      if (this.driftStops(host, realm, snapshotState(verdicts, gates))) return;

      // PD-5 amendment: own-scope-identical journeys are no-ops here too, so an
      // all-identical re-import writes nothing (rather than pointlessly
      // re-overwriting the subject). Display-only refinement — never fed to the
      // drift snapshot above.
      // Uses the user's CURRENT compare options so the commit honours the plan
      // they actually saw — a row shown Identical must stay a no-op here.
      const identicalJourneys = computeIdenticalJourneys(
        await readJourneyCompareInputs(readClient, realm, loaded.rawComponents, verdicts),
        this.compareOptions,
      );
      const verdictById = new Map<string, "new" | "exists" | "identical">();
      for (const v of verdicts) {
        if (v.kind !== "journey") continue;
        let verdict: "new" | "exists" | "identical" = "exists";
        if (v.status === "new") verdict = "new";
        else if (identicalJourneys.has(v.id)) verdict = "identical";
        verdictById.set(v.id, verdict);
      }
      const journeyPlans = planJourneyUnits(loaded.rawComponents, verdictById);
      const { plan, blockingMissing, counts } = assembleJourneyImport({
        rawComponents: loaded.rawComponents,
        verdicts,
        gates,
        journeyPlans,
        journeyActions,
        selectedLeafKeys: new Set(selected),
      });

      // Defense-in-depth: a missing hard prerequisite (node type / inner journey)
      // would hard-fail the write — refuse cleanly. The UI also disables Import.
      if (blockingMissing.length > 0) {
        this.post({
          type: "executeResult",
          host,
          realm,
          results: [],
          summary: `Blocked — missing prerequisites on the target: ${blockingMissing.join(", ")}.`,
        });
        return;
      }

      if (plan.leaves.length === 0 && plan.journeys.length === 0) {
        this.post({
          type: "executeResult",
          host,
          realm,
          results: [],
          summary: "Nothing to import — every component is Keep or already present.",
        });
        return;
      }

      const hasEsv = plan.leaves.some(
        (i) => i.component.kind === "variable" || i.component.kind === "secret",
      );
      const detail = buildImportConfirmDetail({
        host,
        realm,
        create: counts.create,
        overwrite: counts.overwrite,
        keep: counts.keep,
        hasEsv,
        missingNote: missingDepsNote(advisory),
      });
      const ok = await confirm("Import this journey to the tenant?", detail, "Import");
      if (!ok) {
        this.post({ type: "executeResult", host, realm, results: [], summary: "Cancelled." });
        return;
      }

      await this.collectSecrets(plan.leaves);

      this.childLog.info(
        { event: "tab.executeJourney.start", host, realm, ...counts },
        "Importing journey",
      );
      const total = plan.leaves.length + plan.journeys.length;
      let done = 0;
      const startedAt = new Date().toISOString();
      const results = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Importing journey…" },
        (progress) =>
          runJourneyExecute(client, realm, plan, (r) => {
            done += 1;
            progress.report({
              increment: 100 / total,
              message: `${r.kind} ${r.displayName} (${done}/${total})`,
            });
            this.post({ type: "executeProgress", host, realm, result: r, done, total });
          }),
      );
      this.captureReport(host, realm, startedAt, results);
      const count = (s: WriteResult["status"]) => results.filter((r) => r.status === s).length;
      const summary = `${count("created")} created · ${count("overwritten")} overwritten · ${count("skipped")} skipped · ${count("failed")} failed`;
      this.post({ type: "executeResult", host, realm, results, summary });
      this.childLog.info(
        { event: "tab.executeJourney.done", host, realm, failed: count("failed") },
        "Journey import complete",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.childLog.error(
        { event: "tab.executeJourney.failed", host, realm, message },
        "Journey import failed",
      );
      this.post({
        type: "executeResult",
        host,
        realm,
        results: [],
        summary: `Import failed: ${message}`,
      });
    }
  }

  /** PD-11 freeze-the-plan: compare the commit-time `freshSnapshot` to the
   * snapshot frozen at pre-flight; if the target drifted, post `driftDetected`
   * (the UI re-plans) and return true so the caller refuses to write. Shared by
   * the leaf and journey execute paths. */
  private driftStops(
    host: string,
    realm: string,
    freshSnapshot: ReadonlyMap<string, string>,
  ): boolean {
    if (!this.preview || this.preview.host !== host || this.preview.realm !== realm) return false;
    const drifted = diffSnapshots(this.preview.snapshot, freshSnapshot);
    if (drifted.length === 0) return false;
    this.childLog.warn(
      { event: "tab.execute.drift", host, realm, drift_count: drifted.length },
      "Target drifted since preview — forcing re-plan",
    );
    this.post({ type: "driftDetected", host, realm, drifted });
    return true;
  }

  /** PD-17: build + store the run's report at execute time (so a later
   * re-preview can't make the download stale). `before` is the frozen pre-flight
   * snapshot. */
  private captureReport(
    host: string,
    realm: string,
    startedAt: string,
    results: readonly WriteResult[],
  ): void {
    this.lastReport = buildImportReport({
      host,
      realm,
      bundle: this.loaded?.fileName ?? "(unknown)",
      startedAt,
      finishedAt: new Date().toISOString(),
      results,
      beforeSnapshot: this.preview?.snapshot ?? new Map(),
    });
  }

  /** PD-17: write the last run's report to a user-chosen file (native dialog). */
  private async handleDownloadReport(): Promise<void> {
    if (!this.lastReport) {
      vscode.window.showInformationMessage(
        "Run an import first — there's no report to download yet.",
      );
      return;
    }
    try {
      const base = (this.loaded?.fileName ?? "import").replace(/\.json$/i, "");
      const uri = await vscode.window.showSaveDialog({
        saveLabel: "Save report",
        filters: { JSON: ["json"] },
        defaultUri: vscode.Uri.file(`${base}.import-report.json`),
      });
      if (!uri) return; // cancelled
      const json = JSON.stringify(this.lastReport, null, 2);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(json, "utf8"));
      vscode.window.showInformationMessage("Import report saved.");
      this.childLog.info({ event: "tab.downloadReport", path: uri.fsPath }, "Saved import report");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.childLog.error({ event: "tab.downloadReport.failed", message }, "Report save failed");
      vscode.window.showErrorMessage(`Couldn't save the report: ${message}`);
    }
  }

  /** Warn if a just-written component still reads Differs on the refreshed
   * Plan — a sign the write transform and the compare normalization disagree. */
  private warnOnDrift(results: WriteResult[], fresh: ComponentVerdict[]): void {
    const wrote = new Set(
      results
        .filter((r) => r.status === "created" || r.status === "overwritten")
        .map((r) => `${r.kind}:${r.id}`),
    );
    for (const v of fresh) {
      if (v.status === "differs" && wrote.has(`${v.kind}:${v.id}`)) {
        this.childLog.warn(
          { event: "tab.execute.drift", kind: v.kind, id: v.id },
          "Just-written component still reads Differs — write/compare transform drift",
        );
      }
    }
  }

  /** Open VS Code's native diff for a script overwrite row (TD-11): LEFT = the
   * live target script we'd overwrite (at `targetScriptId`, i.e. the verdict's
   * resolvedTargetId — TD-9), RIGHT = the uploaded bundle script's source. Both
   * as `.js` via the existing `paic-script://` provider + the `paic-bundle://`
   * content provider. Scripts only in v1. */
  private async handleOpenDiff(
    host: string,
    realm: string,
    bundleKey: string,
    targetScriptId: string,
    language?: string,
  ): Promise<void> {
    if (!this.loaded) return;
    const component = this.loaded.rawComponents.find((c) => `${c.kind}:${c.id}` === bundleKey);
    if (!component) {
      this.childLog.warn(
        { event: "tab.openDiff.noComponent", bundleKey },
        "Diff: no such component",
      );
      return;
    }
    const bodyRaw = typeof component.raw.script === "string" ? component.raw.script : "";
    const source = canonScriptBody(bodyRaw);
    const right = this.deps.bundleContent.set(bundleKey, source);
    const left = makeScriptUri(host, realm, targetScriptId, language);
    const title = `${component.displayName}: target ↔ bundle`;
    await vscode.commands.executeCommand("vscode.diff", left, right, title);
    this.childLog.info(
      { event: "tab.openDiff", host, realm, bundle_key: bundleKey },
      "Opened import diff",
    );
  }

  /** List a target connection's realms for the Target dropdown. Mirrors the
   * Search panel: drop the platform root for PAIC (service accounts 403 on it);
   * keep root for on-prem (journeys live there). */
  private async handleListRealms(host: string): Promise<void> {
    try {
      const client = await this.deps.cache.get(host);
      const realms = await client.listRealms();
      const isOnprem = this.deps.connectionKindOf(host) === "onprem";
      const usable = realms
        .filter((r) => (isOnprem ? true : !r.isRoot && r.name !== "/"))
        .map((r) => r.name);
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

  /** Open a file picker, read + parse the chosen bundle, and post the summary
   * back. All read-only and local — no network, no writes (Slice A). */
  private async handlePickBundle(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { "PAIC export bundle": ["json"] },
      openLabel: "Inspect",
    });
    if (!picked || picked.length === 0) {
      this.childLog.debug({ event: "tab.pickBundle.cancelled" }, "Bundle pick cancelled");
      return;
    }
    const uri = picked[0];
    const fileName = uri.path.split("/").pop() ?? uri.path;
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const text = new TextDecoder().decode(bytes);
      const result = parseBundle(text);
      if (!result.ok) {
        this.childLog.warn(
          { event: "tab.pickBundle.parseError", file: fileName },
          "Bundle parse failed",
        );
        this.post({ type: "bundleError", message: result.error });
        return;
      }
      this.loaded = {
        fileName,
        bundle: result.bundle,
        rawComponents: result.rawComponents,
      };
      this.preview = null; // new bundle ⇒ any prior freeze baseline is stale
      this.compare = null; // …and the cached target reads no longer match it
      this.compareOptions = EXACT_COMPARE; // options are per-bundle, never sticky
      this.lastReport = null; // and the prior run's report no longer applies
      this.childLog.info(
        { event: "tab.pickBundle", file: fileName, kind: result.bundle.kind },
        "Loaded bundle for preview",
      );
      this.post({ type: "bundleLoaded", fileName, bundle: result.bundle });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.childLog.error(
        { event: "tab.pickBundle.failed", file: fileName, message },
        "Failed to read bundle file",
      );
      this.post({ type: "bundleError", message: `Couldn't read the file. ${message}` });
    }
  }

  private post(msg: E2W): void {
    this.panel.webview.postMessage(msg);
  }

  private renderHtml(webview: vscode.Webview, payload: TransferPayload): string {
    const nonce = makeNonce();
    const bundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.deps.context.extensionUri, "out", "transfer.js"),
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
<title>Transfer</title>
<link rel="stylesheet" href="${codiconUri.toString()}" />
<style>${TRANSFER_CSS}</style>
</head>
<body>
<div id="root" data-paic-payload="${payloadAttr}"></div>
<script nonce="${nonce}" src="${bundleUri.toString()}"></script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  return randomBytes(16)
    .toString("base64")
    .replace(/[^A-Za-z0-9]/g, "");
}

const TRANSFER_CSS = `
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
  .transfer-subtitle {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
    margin-bottom: 16px;
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
  /* Disabled (e.g. Import while a blocking ⛔ prerequisite is unmet, B1) reads as
     greyed-out + non-clickable — VS Code's native disabled convention. The hover
     override stops a disabled button from lighting up on mouse-over. */
  button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  button:disabled:hover {
    background: var(--vscode-button-background);
  }
  button:focus-visible {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .transfer-actions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 12px;
  }
  .transfer-file {
    color: var(--vscode-descriptionForeground);
    font-size: 0.9em;
  }
  .transfer-hint {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    padding: 12px 0;
  }
  .transfer-error {
    color: var(--vscode-errorForeground);
    border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
    background: var(--vscode-inputValidation-errorBackground, transparent);
    border-radius: 4px;
    padding: 10px 14px;
    margin-bottom: 12px;
  }
  .transfer-source {
    border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-radius: 4px;
    padding: 14px 16px;
  }
  .transfer-chip {
    display: inline-block;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 0.85em;
    font-weight: 600;
    border-radius: 10px;
    padding: 2px 10px;
    margin-bottom: 12px;
  }
  .transfer-meta {
    display: grid;
    grid-template-columns: 90px 1fr;
    gap: 4px 12px;
    margin: 0 0 12px 0;
    font-size: 0.9em;
  }
  .transfer-meta dt {
    color: var(--vscode-descriptionForeground);
    font-weight: 600;
  }
  .transfer-meta dd {
    margin: 0;
    word-break: break-all;
  }
  .transfer-inventory {
    list-style: none;
    margin: 0 0 12px 0;
    padding: 0;
    font-size: 0.9em;
    color: var(--vscode-foreground);
  }
  .transfer-inventory li {
    padding: 2px 0;
  }
  .transfer-components-header {
    color: var(--vscode-descriptionForeground);
    font-size: 0.82em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    padding-bottom: 2px;
    margin-bottom: 4px;
  }
  .transfer-components {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .transfer-components li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 3px 0;
  }
  .transfer-comp-detail {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .transfer-section-title {
    font-weight: 600;
    margin: 18px 0 6px;
  }
  .transfer-note {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    padding: 12px 0;
  }
  .transfer-subject {
    margin: 4px 0 8px;
    padding: 6px 10px;
    border-left: 3px solid var(--vscode-focusBorder);
    background: var(--vscode-textBlockQuote-background);
  }
  .transfer-plan-summary {
    margin: 4px 0 8px;
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
  }
  /* PD-20 recheck — inline on the summary line, beside the blocked count.
     Nudged left of baseline-normal so the button box sits optically centred
     against 600-weight text rather than hanging below it. */
  .transfer-plan-summary .transfer-recheck {
    margin-left: 8px;
    vertical-align: 1px;
    font-weight: 400;
  }
  /* One line, matching the Plan: summary directly above it — label inline with
     its content, not stacked above it. Wraps only when the panel is too narrow
     to hold the row. */
  .transfer-compare-options {
    display: flex;
    align-items: baseline;
    flex-wrap: wrap;
    gap: 6px 18px;
    margin: 8px 0 6px;
    color: var(--vscode-descriptionForeground);
  }
  .transfer-compare-options .transfer-co-boxes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 18px;
  }
  .transfer-compare-options label {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
    white-space: nowrap;
  }
  .transfer-scope {
    display: grid;
    grid-template-columns: 110px 1fr;
    gap: 8px 12px;
    align-items: center;
    border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border-radius: 4px;
    padding: 12px 16px;
  }
  .transfer-scope .field-label {
    font-weight: 600;
    font-size: 0.9em;
  }
  .transfer-compat {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    font-size: 0.92em;
  }
  .transfer-compat li {
    padding: 3px 0;
  }
  /* Status colour system — green=add · amber=change/overwrite · red=stop ·
     grey=no-op · neutral=fact. Three signal colours, restrained. */
  .transfer-v-ok {
    /* additive (Create / Created) — "added", tracks the editor's git colour */
    color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-testing-iconPassed, var(--vscode-foreground)));
  }
  .transfer-v-new {
    color: var(--vscode-foreground); /* neutral fact (New) */
  }
  .transfer-v-diff {
    /* change / overwrite / advisory (Differs · Overwrite · Overwritten · Missing ⚠) */
    color: var(--vscode-editorWarning-foreground, var(--vscode-foreground));
  }
  .transfer-v-muted {
    color: var(--vscode-descriptionForeground); /* no-op (Identical · Present · Keep · Skipped) */
  }
  .transfer-v-bad {
    color: var(--vscode-errorForeground); /* hard stop (Unsupported · Error · ID-collision · Failed · Missing ⛔) */
  }
  /* TD-8 Plan table — one CSS grid; each row is display:contents so its cells
     join the parent grid (no nested grids). Columns: ☑ · Action · Type · Status · Name. */
  .transfer-plan {
    display: grid;
    /* ☑ · Type · Status · Name (fit) · Review (buttons) · Notes (message, flexible) */
    grid-template-columns: 28px minmax(120px, max-content) 110px minmax(140px, max-content) max-content 1fr;
    align-items: center;
    column-gap: 12px;
    margin-top: 12px;
    font-size: 0.92em;
    border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    border-radius: 4px;
    padding: 4px 12px 8px;
  }
  .transfer-plan-head,
  .transfer-plan-row {
    display: contents;
  }
  .transfer-plan-head > span {
    color: var(--vscode-descriptionForeground);
    font-size: 0.82em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    padding: 4px 0;
  }
  .transfer-plan-row > span {
    padding: 4px 0;
  }
  .transfer-plan-row.is-noop > span {
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
  }
  .transfer-plan-row.is-blocked .plan-action {
    color: var(--vscode-errorForeground);
  }
  .plan-check {
    display: flex;
    justify-content: center;
  }
  .plan-check input {
    cursor: pointer;
  }
  .plan-check input:disabled {
    cursor: default;
  }
  .plan-action {
    font-weight: 600;
  }
  .plan-type .codicon {
    vertical-align: text-bottom;
    margin-right: 2px;
    color: var(--vscode-descriptionForeground);
  }
  .plan-name {
    word-break: break-word;
  }
  /* Review column = inspect actions only. */
  .plan-review {
    display: flex;
    gap: 6px;
    white-space: nowrap;
  }
  /* Notes column (last) = the per-row reason / warning / collision message. */
  .plan-notes {
    color: var(--vscode-descriptionForeground);
    font-size: 0.92em;
  }
  .plan-review-btn {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 1px 6px;
    font-size: 0.85em;
    background: transparent;
    color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border));
    border-radius: 3px;
    cursor: pointer;
  }
  .plan-review-btn:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }
  .plan-review-btn .codicon {
    font-size: 1em;
  }
  ${COMBOBOX_CSS}
`;
