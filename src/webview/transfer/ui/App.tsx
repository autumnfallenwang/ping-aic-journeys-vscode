import { Fragment, useCallback, useEffect, useState } from "react";
import { Combobox, type ComboboxOption } from "../../shared/combobox";
import type {
  BundleKind,
  ComponentSummary,
  ComponentVerdict,
  ConnectionInfo,
  E2W,
  EntityKind,
  JourneyAction,
  JourneyUnitPlan,
  ParsedBundle,
  RequiredDepVerdict,
  TransferPayload,
  W2E,
  WriteResult,
} from "../messages";
import { WRITABLE_KINDS } from "../messages";
import { kindMeta, sortByKindThenName } from "./kind-meta";

const isWritableVerdict = (v: ComponentVerdict) => v.status === "new" || v.status === "differs";
const isEsvKind = (k: BundleKind) => k === "variable" || k === "secret";
const verdictKey = (v: ComponentVerdict) => `${v.kind}:${v.id}`;

function importButtonLabel(
  running: boolean,
  selectedN: number,
  createN: number,
  overwriteN: number,
  hasAnyWritable: boolean,
): string {
  if (running) return "Importing…";
  // No writable rows at all (everything Identical/Present) → "Nothing to import";
  // writable rows exist but none checked → "Nothing selected" (check one).
  if (selectedN === 0) return hasAnyWritable ? "Nothing selected" : "Nothing to import";
  return `Import ${selectedN} selected · ${createN} create · ${overwriteN} overwrite`;
}

function journeyButtonLabel(
  running: boolean,
  createN: number,
  overwriteN: number,
  keepN: number,
): string {
  if (running) return "Importing…";
  // Nothing will be written (all Identical / Keep) → a disabled "Nothing to import".
  if (createN + overwriteN === 0) return "Nothing to import";
  return `Import journey — ${createN} create · ${overwriteN} overwrite · ${keepN} keep`;
}

/** One-line plan summary above the table (S9a) — omits zero buckets. */
function planSummaryLine(c: {
  create: number;
  overwrite: number;
  keep: number;
  unchanged: number;
  blocked: number;
}): string {
  const parts: string[] = [];
  if (c.create) parts.push(`${c.create} create`);
  if (c.overwrite) parts.push(`${c.overwrite} overwrite`);
  if (c.keep) parts.push(`${c.keep} keep`);
  if (c.unchanged) parts.push(`${c.unchanged} unchanged`);
  if (c.blocked) parts.push(`${c.blocked} blocked`);
  return parts.length > 0 ? `Plan: ${parts.join(" · ")}` : "Plan: nothing to import";
}

/** The Create/Overwrite/Keep action a journey unit will take, given the user's
 * checkbox selection: a New unit is Create; an existing subject is Overwrite; an
 * existing inner is Overwrite when its row is checked, else Keep (the default). */
function journeyActionFor(p: JourneyUnitPlan, selectedKeys: ReadonlySet<string>): JourneyAction {
  if (p.verdict === "new") return "create";
  if (p.verdict === "identical") return "keep"; // own-scope unchanged → no write
  if (p.role === "subject") return "overwrite";
  return selectedKeys.has(`journey:${p.id}`) ? "overwrite" : "keep";
}

/** Subject-header verdict label: a subject is always Created (new) or Overwritten
 * (exists); an `identical` subject is a no-op (own scope already on the target). */
function subjectVerdictLabel(verdict: JourneyUnitPlan["verdict"]): string {
  if (verdict === "new") return "new → Create";
  if (verdict === "identical") return "identical → no change";
  return "⚠ exists → Overwrite";
}

interface VsCodeApi {
  postMessage(msg: W2E): void;
}

interface Props {
  vscode: VsCodeApi;
  payload: TransferPayload;
}

interface LoadedBundle {
  fileName: string;
  bundle: ParsedBundle;
}

/** Per-host realm-list fetch state. */
type RealmsState =
  | { status: "loading" }
  | { status: "ok"; realms: readonly string[] }
  | { status: "err"; message: string };

/** Read-only compare pre-flight state. */
type PreflightState =
  | { status: "idle" }
  | { status: "running" }
  | {
      status: "ok";
      verdicts: readonly ComponentVerdict[];
      /** Discovered info-only dependency refs (libs + ESVs, TD-9) + blocking
       * journey gates (node types / must-exist inner journeys, PD-7). */
      requires: readonly RequiredDepVerdict[];
      /** Per-unit Create/Overwrite/Keep decisions (S5); empty for a leaf bundle. */
      journeyPlans: readonly JourneyUnitPlan[];
    }
  | { status: "err"; message: string };

/** Write (execute) state. */
type ExecuteState =
  | { status: "idle" }
  // PD-16: `running` accumulates per-item results as they land (live rows).
  | { status: "running"; results: readonly WriteResult[]; done: number; total: number }
  | { status: "done"; results: readonly WriteResult[]; summary?: string }
  // A write that wrote nothing — Cancel, "Nothing to import", or a blocked plan.
  // The target is unchanged, so the plan stays valid + editable (NOT locked, no
  // Re-plan/Download); we just surface the reason as a transient note.
  | { status: "noop"; summary?: string };

/** ESV apply state — independent of `execute`, host-scoped (survives a realm
 * change), reset only when the connection changes. */
type ApplyState =
  | { status: "idle" }
  | { status: "running"; host: string; restartStatus: string; elapsedS: number }
  | { status: "done"; host: string; ok: boolean; elapsedS: number; message?: string };

/**
 * Transfer page — Slices A + B1 + B2 (file-first, read-only). Choose an
 * exported bundle, preview it (A), pick a target connection/realm (B1), and see
 * the per-component **pre-flight** comparison (B2: New / Identical / Differs /
 * exists / unsupported). The actual writes land in Slice C.
 */
export function App({ vscode, payload }: Props) {
  const [loaded, setLoaded] = useState<LoadedBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedHost, setSelectedHost] = useState<string | null>(null);
  const [selectedRealm, setSelectedRealm] = useState<string | null>(null);
  const [realmsByHost, setRealmsByHost] = useState<Record<string, RealmsState>>({});
  const [preflight, setPreflight] = useState<PreflightState>({ status: "idle" });
  const [execute, setExecute] = useState<ExecuteState>({ status: "idle" });
  const [apply, setApply] = useState<ApplyState>({ status: "idle" });
  // TD-8: per-row checkbox selection (keys = `${kind}:${id}`). Seeded to all
  // writable verdicts when a pre-flight arrives; cleared on a target change.
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(new Set());
  const toggleKey = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // Select-all header (TD-10): add/remove every actionable key at once.
  const toggleAll = useCallback((keys: string[], selectAll: boolean) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (selectAll) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }, []);
  // Re-plan: recompute the plan against the (now-changed) target — drops the
  // result log + re-runs pre-flight (G4 partial-failure recovery + PD-11 drift).
  const replan = useCallback(
    (host: string, realm: string) => {
      setExecute({ status: "idle" });
      setPreflight({ status: "running" });
      vscode.postMessage({ type: "runPreflight", host, realm });
    },
    [vscode],
  );

  // Announce readiness on mount (the panel re-hydrates the bundle on this).
  useEffect(() => {
    vscode.postMessage({ type: "ready" });
  }, [vscode]);

  // Listen for extension replies. Re-subscribes when the target changes so the
  // pre-flight handler can drop stale replies for a target since switched.
  useEffect(() => {
    function onMsg(ev: MessageEvent<E2W>) {
      const m = ev.data;
      if (!m || typeof m !== "object" || !("type" in m)) return;
      if (m.type === "bundleLoaded") {
        setError(null);
        setLoaded({ fileName: m.fileName, bundle: m.bundle });
      } else if (m.type === "bundleError") {
        setLoaded(null);
        setError(m.message);
      } else if (m.type === "realmsResult") {
        setRealmsByHost((prev) => ({ ...prev, [m.host]: { status: "ok", realms: m.realms } }));
      } else if (m.type === "realmsError") {
        setRealmsByHost((prev) => ({ ...prev, [m.host]: { status: "err", message: m.message } }));
      } else if (m.type === "preflightResult") {
        if (m.host !== selectedHost || m.realm !== selectedRealm) return; // stale
        setPreflight({
          status: "ok",
          verdicts: m.verdicts,
          requires: m.requires,
          journeyPlans: m.journeyPlans,
        });
        // Smart-default selection (S9a, refines TD-10): pre-select the
        // recommended action (New→Create, Differs→Overwrite) for the writable
        // leaf rows of BOTH leaf and journey bundles — one consistent model;
        // the user can deselect any row. (Inner journeys default to Keep =
        // unchecked, decided separately.)
        const leafKeys = m.verdicts
          .filter((v) => v.kind !== "journey" && (v.status === "new" || v.status === "differs"))
          .map((v) => `${v.kind}:${v.id}`);
        setSelectedKeys(new Set(leafKeys));
      } else if (m.type === "preflightError") {
        if (m.host !== selectedHost || m.realm !== selectedRealm) return; // stale
        setPreflight({ status: "err", message: m.message });
      } else if (m.type === "executeProgress") {
        if (m.host !== selectedHost || m.realm !== selectedRealm) return; // stale
        // PD-16: append the just-landed result so its row flips live.
        setExecute((prev) =>
          prev.status === "running"
            ? {
                status: "running",
                results: [...prev.results, m.result],
                done: m.done,
                total: m.total,
              }
            : prev,
        );
      } else if (m.type === "executeResult") {
        if (m.host !== selectedHost || m.realm !== selectedRealm) return; // stale
        // No results ⇒ nothing was written (Cancel / "Nothing to import" /
        // blocked). Don't lock the plan into the read-only result state — fall
        // back to the still-valid plan (no Re-plan needed, the target didn't
        // change) and just note why. A real run always carries ≥1 result.
        setExecute(
          m.results.length === 0
            ? { status: "noop", summary: m.summary }
            : { status: "done", results: m.results, summary: m.summary },
        );
      } else if (m.type === "applyProgress") {
        if (m.host !== selectedHost) return; // apply is host-scoped (survives realm change)
        setApply({
          status: "running",
          host: m.host,
          restartStatus: m.status,
          elapsedS: m.elapsedS,
        });
      } else if (m.type === "applyResult") {
        if (m.host !== selectedHost) return;
        setApply({
          status: "done",
          host: m.host,
          ok: m.ok,
          elapsedS: m.elapsedS,
          message: m.message,
        });
      } else if (m.type === "driftDetected") {
        if (m.host !== selectedHost || m.realm !== selectedRealm) return; // stale
        // PD-11: the target changed since the previewed plan — re-plan. The
        // fresh verdicts replace the stale ones automatically.
        replan(m.host, m.realm);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [selectedHost, selectedRealm, vscode, replan]);

  // An apply belongs to a connection — reset it only when the connection
  // changes (NOT on a realm change, unlike the execute log). `selectedHost` is
  // the trigger, not read in the body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset-on-connection-change; selectedHost is the trigger, not a body dependency
  useEffect(() => {
    setApply({ status: "idle" });
  }, [selectedHost]);

  // Fetch the realm list for the selected connection (once per host).
  useEffect(() => {
    if (selectedHost === null) return;
    setRealmsByHost((prev) => {
      if (prev[selectedHost]) return prev; // already fetched / fetching
      vscode.postMessage({ type: "listRealms", host: selectedHost });
      return { ...prev, [selectedHost]: { status: "loading" } };
    });
  }, [selectedHost, vscode]);

  // Run the read-only pre-flight once a bundle + target are both set (journeys
  // included — Batch 3). Re-runs when the bundle or target changes.
  useEffect(() => {
    setExecute({ status: "idle" }); // a new target/bundle invalidates any prior write log
    setSelectedKeys(new Set()); // drop stale selection; re-seeded when the new preflight lands
    if (!loaded || selectedHost === null || selectedRealm === null) {
      setPreflight({ status: "idle" });
      return;
    }
    setPreflight({ status: "running" });
    vscode.postMessage({ type: "runPreflight", host: selectedHost, realm: selectedRealm });
  }, [loaded, selectedHost, selectedRealm, vscode]);

  const onChoose = () => vscode.postMessage({ type: "pickBundle" });
  const onConnectionChange = (host: string) => {
    setSelectedHost(host === "" ? null : host);
    setSelectedRealm(null);
  };
  const onRealmChange = (realm: string) => setSelectedRealm(realm === "" ? null : realm);
  const onExecute = () => {
    if (selectedHost === null || selectedRealm === null) return;
    // Journey decisions: an exists-inner is Overwrite when checked, else Keep.
    // New inners (forced Create) + subjects use the engine's default action.
    const journeyPlans = preflight.status === "ok" ? preflight.journeyPlans : [];
    const journeyActions: Record<string, JourneyAction> = {};
    for (const p of journeyPlans) {
      if (p.role === "subject" || p.verdict === "new") continue;
      journeyActions[p.id] = selectedKeys.has(`journey:${p.id}`) ? "overwrite" : "keep";
    }
    setExecute({ status: "running", results: [], done: 0, total: 0 });
    vscode.postMessage({
      type: "execute",
      host: selectedHost,
      realm: selectedRealm,
      selected: [...selectedKeys],
      ...(Object.keys(journeyActions).length > 0 ? { journeyActions } : {}),
    });
  };
  const onApplyEsv = () => {
    if (selectedHost === null) return;
    setApply({ status: "running", host: selectedHost, restartStatus: "restarting", elapsedS: 0 });
    vscode.postMessage({ type: "applyEsv", host: selectedHost });
  };
  const onReplan = () => {
    if (selectedHost !== null && selectedRealm !== null) replan(selectedHost, selectedRealm);
  };

  return (
    <main>
      <h1>PAIC Transfer</h1>
      <p className="transfer-subtitle">
        Import a journey or component bundle into a connection. Start by choosing an exported bundle
        to inspect.
      </p>
      <div className="transfer-actions">
        <button type="button" onClick={onChoose}>
          Choose bundle…
        </button>
        {loaded ? <span className="transfer-file">{loaded.fileName}</span> : null}
      </div>
      {error ? <div className="transfer-error">{error}</div> : null}
      {loaded ? <SourcePreview bundle={loaded.bundle} /> : null}
      {!loaded && !error ? <p className="transfer-hint">No bundle loaded yet.</p> : null}
      {loaded ? (
        <TargetSection
          connections={payload.connections}
          selectedHost={selectedHost}
          selectedRealm={selectedRealm}
          realms={selectedHost ? (realmsByHost[selectedHost] ?? null) : null}
          onConnectionChange={onConnectionChange}
          onRealmChange={onRealmChange}
        />
      ) : null}
      {loaded && selectedHost !== null && selectedRealm !== null ? (
        <PlanSection
          preflight={preflight}
          bundleKind={loaded.bundle.kind}
          execute={execute}
          onExecute={onExecute}
          apply={apply}
          onApplyEsv={onApplyEsv}
          selectedKeys={selectedKeys}
          host={selectedHost}
          realm={selectedRealm}
          onToggle={toggleKey}
          onToggleAll={toggleAll}
          onReview={(msg) => vscode.postMessage(msg)}
          onDownloadReport={() => vscode.postMessage({ type: "downloadReport" })}
          onReplan={onReplan}
        />
      ) : null}
    </main>
  );
}

// ─── Target ──────────────────────────────────────────────────────────────────

interface TargetSectionProps {
  connections: readonly ConnectionInfo[];
  selectedHost: string | null;
  selectedRealm: string | null;
  realms: RealmsState | null;
  onConnectionChange: (host: string) => void;
  onRealmChange: (realm: string) => void;
}

function realmOptionsFor(
  realms: RealmsState | null,
  selectedRealm: string | null,
): readonly string[] {
  if (realms?.status === "ok") return realms.realms;
  if (selectedRealm) return [selectedRealm];
  return [];
}

function realmPlaceholder(selectedHost: string | null, realms: RealmsState | null): string {
  if (selectedHost === null) return "— Pick a connection first —";
  if (realms?.status === "loading") return "Loading realms…";
  if (realms?.status === "err") return "Failed to load realms";
  return "— Select a realm —";
}

function TargetSection(props: TargetSectionProps) {
  const { connections, selectedHost, selectedRealm, realms } = props;
  const connectionOptions: ComboboxOption[] = connections.map((c) => ({
    value: c.host,
    label: c.name ? `${c.name} (${c.host})` : c.host,
  }));
  const realmComboOptions: ComboboxOption[] = realmOptionsFor(realms, selectedRealm).map((r) => ({
    value: r,
    label: r,
  }));
  const realmDisabled = selectedHost === null || realms?.status !== "ok";

  return (
    <section>
      <div className="transfer-section-title">Target</div>
      {connections.length === 0 ? (
        <p className="transfer-hint">
          No connections configured. Add one from the PAIC Journeys sidebar first.
        </p>
      ) : (
        <div className="transfer-scope">
          <label htmlFor="target-connection" className="field-label">
            Connection
          </label>
          <Combobox
            id="target-connection"
            options={connectionOptions}
            selectedValue={selectedHost ?? ""}
            onSelect={props.onConnectionChange}
            placeholder="Select a connection…"
          />
          <label htmlFor="target-realm" className="field-label">
            Realm
          </label>
          <Combobox
            id="target-realm"
            options={realmComboOptions}
            selectedValue={selectedRealm ?? ""}
            onSelect={props.onRealmChange}
            placeholder={realmPlaceholder(selectedHost, realms)}
            disabled={realmDisabled}
          />
        </div>
      )}
    </section>
  );
}

// ─── Plan (compare pre-flight) ───────────────────────────────────────────────

function PlanSection({
  preflight,
  bundleKind,
  execute,
  onExecute,
  apply,
  onApplyEsv,
  selectedKeys,
  host,
  realm,
  onToggle,
  onToggleAll,
  onReview,
  onDownloadReport,
  onReplan,
}: {
  preflight: PreflightState;
  bundleKind: BundleKind;
  execute: ExecuteState;
  onExecute: () => void;
  apply: ApplyState;
  onApplyEsv: () => void;
  selectedKeys: ReadonlySet<string>;
  host: string;
  realm: string;
  onToggle: (key: string) => void;
  onToggleAll: (keys: string[], selectAll: boolean) => void;
  onReview: (msg: W2E) => void;
  onDownloadReport: () => void;
  onReplan: () => void;
}) {
  const isWritable = WRITABLE_KINDS.has(bundleKind);
  const verdicts = preflight.status === "ok" ? preflight.verdicts : [];
  const requires = preflight.status === "ok" ? preflight.requires : [];
  const journeyPlans = preflight.status === "ok" ? preflight.journeyPlans : [];
  const isLeafBundle = journeyPlans.length === 0;
  const running = execute.status === "running";
  // Per-row outcomes drive the Status column live (running) + final (done).
  const results =
    execute.status === "running" || execute.status === "done" ? execute.results : undefined;
  // TD-10: once an import completes the table locks read-only (the result
  // report) until re-armed by a fresh pre-flight (re-select target / new bundle).
  const locked = execute.status === "done";
  // Checkboxes are frozen DURING a write as well as after (PD-16 live rows).
  const frozen = locked || running;
  // Leaf checkboxes only (journey rows are decided via the journey path). Counts
  // are a live preview of the confirm-modal summary.
  const leafVerdicts = verdicts.filter((v) => v.kind !== "journey");
  const selectedLeaves = leafVerdicts.filter(
    (v) => isWritableVerdict(v) && selectedKeys.has(verdictKey(v)),
  );
  const allActionableKeys = leafVerdicts.filter(isWritableVerdict).map(verdictKey);
  const hasAnyWritable = leafVerdicts.some(isWritableVerdict);
  // Journey action counts (subject always written; new inner = Create; exists
  // inner = Overwrite when checked, else Keep).
  let jCreate = 0;
  let jOverwrite = 0;
  let jKeep = 0;
  let jUnchanged = 0; // identical journeys — own-scope no-op
  for (const p of journeyPlans) {
    if (p.verdict === "identical") {
      jUnchanged += 1;
      continue;
    }
    const a = journeyActionFor(p, selectedKeys);
    if (a === "create") jCreate += 1;
    else if (a === "overwrite") jOverwrite += 1;
    else jKeep += 1;
  }
  const createN = selectedLeaves.filter((v) => v.status === "new").length + jCreate;
  const overwriteN = selectedLeaves.filter((v) => v.status === "differs").length + jOverwrite;
  // A blocking prerequisite (node type / must-exist inner) missing on the target
  // hard-disables Import (PD-7).
  const blockingMissing = requires.filter(
    (d) => d.severity === "blocking" && d.status === "missing",
  );
  // Count-summary buckets (S9a): facts, not selection-driven.
  const unchanged =
    leafVerdicts.filter((v) => v.status === "identical" || v.status === "exists").length +
    jUnchanged;
  const blocked =
    leafVerdicts.filter(
      (v) => v.status === "unsupported" || v.status === "error" || v.status === "id-collision",
    ).length + blockingMissing.length;
  // "Work" = the plan will actually write something (a create or overwrite,
  // across leaves AND journeys). An all-identical / all-Keep plan has none →
  // the button stays visible but DISABLED (greyed), never hidden.
  const hasWork = createN + overwriteN > 0;
  // Always show the Import button for a writable, un-locked bundle — even when
  // there's nothing to do — so the user sees a greyed-out button, not a missing
  // one. `importDisabled` (below) handles the no-work / blocked / running states.
  const showImport = preflight.status === "ok" && isWritable && !locked;
  const importDisabled = execute.status === "running" || blockingMissing.length > 0 || !hasWork;
  const subjects = journeyPlans.filter((p) => p.role === "subject");
  // After an ESV import, offer the separate tenant-wide apply (restart).
  const wroteEsv =
    execute.status === "done" &&
    execute.results.some((r) => isEsvKind(r.kind) && r.status === "created");
  return (
    <section>
      <div className="transfer-section-title">Plan</div>
      {subjects.map((s) => (
        <p key={s.id} className="transfer-subject">
          Import journey: <strong>{s.displayName}</strong> → {host} / {realm} (
          {subjectVerdictLabel(s.verdict)})
        </p>
      ))}
      {preflight.status === "ok" ? (
        <p className="transfer-plan-summary">
          {execute.status === "running"
            ? `Importing… ${execute.done}/${execute.total}`
            : execute.status === "done" && execute.summary
              ? execute.summary
              : planSummaryLine({
                  create: createN,
                  overwrite: overwriteN,
                  keep: jKeep,
                  unchanged,
                  blocked,
                })}
        </p>
      ) : null}
      {preflight.status === "running" ? <p className="transfer-hint">Checking target…</p> : null}
      {preflight.status === "err" ? (
        <div className="transfer-error">{preflight.message}</div>
      ) : null}
      {preflight.status === "ok" ? (
        <PlanTable
          verdicts={verdicts}
          requires={requires}
          journeyPlans={journeyPlans}
          results={results}
          selectedKeys={selectedKeys}
          locked={frozen}
          host={host}
          realm={realm}
          onToggle={onToggle}
          onToggleAll={(selectAll) => onToggleAll(allActionableKeys, selectAll)}
          onReview={onReview}
        />
      ) : null}
      {preflight.status === "ok" && !isWritable ? (
        <p className="transfer-note">Import for {bundleKind} arrives in a later batch.</p>
      ) : null}
      {blockingMissing.length > 0 && !locked ? (
        <p className="transfer-v-bad">
          ⛔ {blockingMissing.length} required prerequisite(s) missing on the target:{" "}
          {blockingMissing.map((d) => d.name).join(", ")} — resolve before importing.
        </p>
      ) : null}
      {locked ? (
        <p className="transfer-hint">
          Import complete — this plan is now read-only. Re-plan to recompute against the target:
          succeeded items show as Identical; any failures reappear ready to retry.
        </p>
      ) : null}
      {locked ? (
        <div className="transfer-actions">
          <button type="button" onClick={onReplan}>
            Re-plan
          </button>
          <button type="button" onClick={onDownloadReport}>
            Download report
          </button>
        </div>
      ) : null}
      {execute.status === "noop" && execute.summary ? (
        <p className="transfer-hint">{execute.summary}</p>
      ) : null}
      {showImport ? (
        <div className="transfer-actions">
          <button type="button" onClick={onExecute} disabled={importDisabled}>
            {isLeafBundle
              ? importButtonLabel(
                  execute.status === "running",
                  selectedLeaves.length,
                  createN,
                  overwriteN,
                  hasAnyWritable,
                )
              : journeyButtonLabel(execute.status === "running", createN, overwriteN, jKeep)}
          </button>
        </div>
      ) : null}
      {wroteEsv ? (
        <p className="transfer-note">
          ESV changes aren't live until applied — use the Apply step below.
        </p>
      ) : null}
      {wroteEsv && apply.status !== "running" ? (
        <div className="transfer-actions">
          <button type="button" onClick={onApplyEsv}>
            Apply ESV changes
          </button>
        </div>
      ) : null}
      <ApplySection apply={apply} />
    </section>
  );
}

// ─── Plan table (TD-8 grid · TD-10 three-phase Status) ───────────────────────

// No Action column. A single Status column tells the whole story across three
// phases: before (comparison) → selected (checked, pre-import) → after (result).
// The checkbox communicates *presence*:
//   "writable" → a live toggle (an opt-out you can make: optional Create / Overwrite)
//   "required" → checked + disabled (will be written, no opt-out — a journey needs it)
//   "present"  → checked + disabled, grey ("already on the target — nothing to do")
//   "blocked"  → unchecked + disabled (can't write / not there)
type RowState = "writable" | "required" | "present" | "blocked";

/** A new SCRIPT in a journey bundle is a HARD dependency — a node references it,
 * so it MUST be created (deselecting it would dangle the node → AM rejects). */
function rowStateOf(v: ComponentVerdict, isJourneyBundle: boolean): RowState {
  if (v.status === "new") {
    return isJourneyBundle && v.kind === "script" ? "required" : "writable";
  }
  if (v.status === "differs") return "writable";
  if (v.status === "unsupported" || v.status === "error" || v.status === "id-collision")
    return "blocked";
  return "present"; // identical | exists — already on the target
}

/** Status PHASE 1 — the comparison fact (before any selection). */
function beforeStatus(v: ComponentVerdict): { text: string; cls: string } {
  switch (v.status) {
    case "new":
      return { text: "New", cls: "transfer-v-new" };
    case "differs":
      return { text: "Differs", cls: "transfer-v-diff" };
    case "identical":
      return { text: "Identical", cls: "transfer-v-muted" }; // no-op → grey (was green)
    case "exists":
      return { text: "Present", cls: "transfer-v-muted" };
    case "unsupported":
      return { text: "Unsupported", cls: "transfer-v-bad" };
    case "error":
      return { text: v.message ?? "Error", cls: "transfer-v-bad" };
    case "id-collision":
      return { text: "ID collision", cls: "transfer-v-bad" };
  }
}

/** Status PHASE 2 — the pending verb shown when an actionable row is checked. */
function selectedStatus(v: ComponentVerdict): { text: string; cls: string } {
  return v.status === "new"
    ? { text: "Create", cls: "transfer-v-ok" }
    : { text: "Overwrite", cls: "transfer-v-diff" };
}

/** Status PHASE 3 — the per-row write outcome after a completed import. */
function afterStatus(r: WriteResult): { text: string; cls: string } {
  switch (r.status) {
    case "created":
      return { text: "Created", cls: "transfer-v-ok" }; // additive → green
    case "overwritten":
      return { text: "Overwritten", cls: "transfer-v-diff" }; // changed existing → amber (was green)
    case "skipped":
      return { text: "Skipped", cls: "transfer-v-muted" };
    case "failed":
      return { text: "Failed", cls: "transfer-v-bad" };
  }
}

/** One row in the unified Plan grid — a writable component (verdict) or an
 * info-only discovered dependency (TD-9). Deps are never selectable (the bundle
 * has no body/value to write); they show what must already exist on the target. */
interface PlanRowData {
  key: string;
  /** Toggle key for selectable rows; null for non-selectable (required/present/blocked). */
  selectKey: string | null;
  rowState: RowState;
  icon: string;
  typeWord: string;
  statusText: string;
  statusCls: string;
  name: string;
  nameNote?: string;
  /** Review affordances on a `differs` row (TD-11): Diff (scripts only) +
   * Find-usages (any kind with an EntityKind). Absent on non-differs rows. */
  review?: ReviewActions;
}

interface ReviewActions {
  diff?: W2E & { type: "openDiff" };
  usages?: W2E & { type: "openFindUsages" };
}

/** Map a transfer BundleKind to a RealmIndex EntityKind (for find-usages).
 * variable/secret → "esv"; journey is not writable here. Returns null when no
 * usage search applies. */
function toEntityKind(kind: BundleKind): EntityKind | null {
  switch (kind) {
    case "script":
    case "theme":
    case "emailTemplate":
    case "socialIdp":
    case "journey":
      return kind;
    case "variable":
    case "secret":
      return "esv";
  }
}

/** Build the Review affordances for a `differs` verdict (TD-11). Diff is
 * scripts-only (JS source); Find-usages applies to any kind with an EntityKind. */
function reviewFor(v: ComponentVerdict, host: string, realm: string): ReviewActions | undefined {
  if (v.status !== "differs") return undefined;
  const actions: ReviewActions = {};
  if (v.kind === "script") {
    actions.diff = {
      type: "openDiff",
      host,
      realm,
      bundleKey: verdictKey(v),
      // The entity we'd actually overwrite (TD-9) — falls back to the bundle id.
      targetScriptId: v.resolvedTargetId ?? v.id,
    };
  }
  const entityKind = toEntityKind(v.kind);
  if (entityKind) {
    // Key by the TARGET's id so it matches the RealmIndex (which is keyed by
    // the target tenant's ids). For scripts the name-match may resolve a
    // different target UUID than the bundle's (TD-9) — use it; other kinds are
    // id/name-identified (name == id) so `v.id` already is the target id.
    actions.usages = {
      type: "openFindUsages",
      host,
      realm,
      targetKey: `${entityKind}:${v.resolvedTargetId ?? v.id}`,
      targetKind: entityKind,
    };
  }
  return actions.diff || actions.usages ? actions : undefined;
}

/** Resolve the three-phase Status for a verdict row. */
function pickStatus(
  v: ComponentVerdict,
  state: RowState,
  checked: boolean,
  result?: WriteResult,
): { text: string; cls: string } {
  if (result) return afterStatus(result); // phase 3
  // The pending verb when checked, or always for a required row (no opt-out).
  if (state === "required" || (state === "writable" && checked)) return selectedStatus(v); // phase 2
  return beforeStatus(v); // phase 1
}

function verdictRowData(
  v: ComponentVerdict,
  checked: boolean,
  host: string,
  realm: string,
  isJourneyBundle: boolean,
  result?: WriteResult,
): PlanRowData {
  const state = rowStateOf(v, isJourneyBundle);
  const { icon, word } = kindMeta(v.kind);
  // Three-phase Status: after-result wins; else the pending verb when checked;
  // else the comparison fact.
  const status = pickStatus(v, state, checked, result);
  return {
    key: verdictKey(v),
    selectKey: state === "writable" ? verdictKey(v) : null, // only live rows toggle
    rowState: state,
    icon,
    typeWord: word,
    statusText: status.text,
    statusCls: status.cls,
    name: v.displayName,
    nameNote: collisionNote(v) ?? matchCountNote(v),
    review: reviewFor(v, host, realm),
  };
}

function matchCountNote(v: ComponentVerdict): string | undefined {
  return v.targetMatchCount && v.targetMatchCount > 1
    ? `(${v.targetMatchCount} on target)`
    : undefined;
}

function collisionNote(v: ComponentVerdict): string | undefined {
  return v.status === "id-collision"
    ? `— ${v.message ?? "UUID already in use on target"}`
    : undefined;
}

/** A row for one INNER journey unit (subjects are the header, not rows). New →
 * forced Create; exists → a checkbox that toggles Overwrite (checked) / Keep
 * (unchecked, the default). Three-phase Status mirrors the leaf rows. */
function journeyRowData(p: JourneyUnitPlan, checked: boolean, result?: WriteResult): PlanRowData {
  const { icon } = kindMeta("journey");
  const isNew = p.verdict === "new";
  const isIdentical = p.verdict === "identical";
  let status: { text: string; cls: string };
  if (result) status = afterStatus(result);
  else if (isNew) status = { text: "Create", cls: "transfer-v-ok" };
  else if (isIdentical) status = { text: "Identical", cls: "transfer-v-muted" };
  else if (checked) status = { text: "Overwrite", cls: "transfer-v-diff" };
  else status = { text: "Keep", cls: "transfer-v-muted" };
  // New inner = required (forced write); identical inner = present (locked no-op,
  // like an identical leaf); existing-but-not-identical = a live Keep⇄Overwrite.
  let rowState: RowState = "writable";
  if (isNew) rowState = "required";
  else if (isIdentical) rowState = "present";
  return {
    key: `journey:${p.id}`,
    selectKey: isNew || isIdentical ? null : `journey:${p.id}`,
    rowState,
    icon,
    typeWord: "Inner journey",
    statusText: status.text,
    statusCls: status.cls,
    name: p.displayName,
    // Warn that overwriting a SHARED inner journey reaches other journeys (only
    // when it's actually a Keep/Overwrite choice).
    nameNote: isNew || isIdentical ? undefined : "shared — Overwrite affects other journeys",
  };
}

const DEP_META: Record<RequiredDepVerdict["kind"], { icon: string; word: string }> = {
  script: { icon: kindMeta("script").icon, word: "Library" },
  esv: { icon: kindMeta("variable").icon, word: "ESV" },
  nodeType: { icon: kindMeta("journey").icon, word: "Node type" },
  innerJourney: { icon: kindMeta("journey").icon, word: "Inner journey" },
};

/** A one-line reason for a dependency/gate row (S9a): present → the existing
 * detail note; missing → why it's here + what to do. */
function depReason(d: RequiredDepVerdict): string | undefined {
  if (d.status === "present") return d.detail ? `(${d.detail})` : undefined;
  switch (d.kind) {
    case "nodeType":
      return "not installed on the target — install before importing";
    case "innerJourney":
      return "not on the target and not in this bundle — import it first";
    default: // library script / ESV — advisory
      return "referenced by a bundled script; add it or imports may fail at runtime";
  }
}

function depRowData(d: RequiredDepVerdict): PlanRowData {
  const meta = DEP_META[d.kind];
  const present = d.status === "present";
  // A missing BLOCKING prerequisite (node type / must-exist inner) hard-disables
  // Import (PD-7) → ⛔; advisory misses (lib/ESV) only warn → ⚠.
  const blocking = d.severity === "blocking";
  const missingText = blocking ? "Missing ⛔" : "Missing ⚠";
  // present = grey · ⛔ blocking = red (hard stop) · ⚠ advisory = amber (warn only).
  let statusCls = "transfer-v-diff";
  if (present) statusCls = "transfer-v-muted";
  else if (blocking) statusCls = "transfer-v-bad";
  return {
    key: `dep:${d.kind}:${d.name}`,
    selectKey: null, // info-only — never importable
    // Present prerequisite → checked-grey "we have it"; missing → blocked.
    rowState: present ? "present" : "blocked",
    icon: meta.icon,
    typeWord: meta.word,
    statusText: present ? "Present" : missingText,
    statusCls,
    name: d.name,
    nameNote: depReason(d),
  };
}

function PlanTable({
  verdicts,
  requires,
  journeyPlans,
  results,
  selectedKeys,
  locked,
  host,
  realm,
  onToggle,
  onToggleAll,
  onReview,
}: {
  verdicts: readonly ComponentVerdict[];
  requires: readonly RequiredDepVerdict[];
  journeyPlans: readonly JourneyUnitPlan[];
  /** Per-row write outcomes after a run (drives Phase-3 Status + lock). */
  results?: readonly WriteResult[];
  selectedKeys: ReadonlySet<string>;
  /** True once an import has completed — table is read-only until re-armed. */
  locked: boolean;
  host: string;
  realm: string;
  onToggle: (key: string) => void;
  onToggleAll: (selectAll: boolean) => void;
  onReview: (msg: W2E) => void;
}) {
  const resultByKey = new Map((results ?? []).map((r) => [`${r.kind}:${r.id}`, r]));
  // Inner-journey rows (subjects are the header) first, then leaf components
  // (journey verdicts excluded — they're decided via journeyPlans), then the
  // info-only dependency / gate rows — all in one aligned grid.
  const rows: PlanRowData[] = [
    ...journeyPlans
      .filter((p) => p.role === "inner")
      .map((p) =>
        journeyRowData(p, selectedKeys.has(`journey:${p.id}`), resultByKey.get(`journey:${p.id}`)),
      ),
    ...sortByKindThenName(verdicts.filter((v) => v.kind !== "journey")).map((v) =>
      verdictRowData(
        v,
        selectedKeys.has(verdictKey(v)),
        host,
        realm,
        journeyPlans.length > 0, // journey bundle → new scripts are required
        resultByKey.get(verdictKey(v)),
      ),
    ),
    ...requires.map(depRowData),
  ];
  // Tri-state select-all over actionable LEAF rows only — the import checkboxes.
  // Inner-journey Overwrite/Keep is a deliberate per-row choice, not bulk-toggled.
  const actionable = rows.filter((r) => r.rowState === "writable" && !r.key.startsWith("journey:"));
  const checkedCount = actionable.filter((r) => selectedKeys.has(r.selectKey ?? "")).length;
  const allChecked = actionable.length > 0 && checkedCount === actionable.length;
  const someChecked = checkedCount > 0 && !allChecked;
  return (
    <PlanGrid
      rows={rows}
      selectedKeys={selectedKeys}
      locked={locked}
      onToggle={onToggle}
      onReview={onReview}
      headerCheckbox={{
        hasActionable: actionable.length > 0,
        allChecked,
        someChecked,
        onToggleAll,
      }}
    />
  );
}

function PlanGrid({
  rows,
  selectedKeys,
  locked,
  onToggle,
  onReview,
  headerCheckbox,
}: {
  rows: readonly PlanRowData[];
  selectedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  onReview: (msg: W2E) => void;
  locked: boolean;
  headerCheckbox: {
    hasActionable: boolean;
    allChecked: boolean;
    someChecked: boolean;
    onToggleAll: (selectAll: boolean) => void;
  };
}) {
  return (
    <div className="transfer-plan">
      <div className="transfer-plan-head">
        <span className="plan-check">
          {headerCheckbox.hasActionable ? (
            <input
              type="checkbox"
              aria-label="Select all"
              checked={headerCheckbox.allChecked}
              disabled={locked}
              ref={(el) => {
                if (el) el.indeterminate = headerCheckbox.someChecked;
              }}
              onChange={() => headerCheckbox.onToggleAll(!headerCheckbox.allChecked)}
            />
          ) : null}
        </span>
        <span className="plan-col-head">Type</span>
        <span className="plan-col-head">Status</span>
        <span className="plan-col-head">Name</span>
        <span className="plan-col-head">Review</span>
        <span className="plan-col-head">Notes</span>
      </div>
      {rows.map((row) => (
        <PlanRow
          key={row.key}
          row={row}
          checked={row.selectKey !== null && selectedKeys.has(row.selectKey)}
          locked={locked}
          onToggle={onToggle}
          onReview={onReview}
        />
      ))}
    </div>
  );
}

function PlanRow({
  row,
  checked,
  locked,
  onToggle,
  onReview,
}: {
  row: PlanRowData;
  checked: boolean;
  locked: boolean;
  onToggle: (key: string) => void;
  onReview: (msg: W2E) => void;
}) {
  const writable = row.rowState === "writable";
  // "present" (already on target) renders grey; "required"/"present" are
  // checked+disabled (will-be / is on the target); "blocked" is unchecked+disabled.
  const checkedLocked = row.rowState === "required" || row.rowState === "present";
  let rowCls = "transfer-plan-row";
  if (row.rowState === "present") rowCls += " is-noop";
  else if (row.rowState === "blocked") rowCls += " is-blocked";
  return (
    <div className={rowCls}>
      <span className="plan-check">
        {/* The checkbox = "will this be on the target after import":
            live (writable) · checked+disabled (required / already present) ·
            unchecked+disabled (blocked / not there). */}
        <input
          type="checkbox"
          checked={writable ? checked : checkedLocked}
          disabled={!writable || locked}
          aria-label={`Import ${row.name}`}
          onChange={() => row.selectKey && onToggle(row.selectKey)}
        />
      </span>
      <span className="plan-type">
        <i className={`codicon codicon-${row.icon}`} aria-hidden /> {row.typeWord}
      </span>
      <span className={`plan-status ${row.statusCls}`}>{row.statusText}</span>
      <span className="plan-name">{row.name}</span>
      <span className="plan-review">
        {/* Read-only inspect actions — live even when the table is locked. */}
        {row.review?.diff ? (
          <button
            type="button"
            className="plan-review-btn"
            onClick={() => onReview(row.review?.diff as W2E)}
          >
            <i className="codicon codicon-git-compare" aria-hidden /> Compare
          </button>
        ) : null}
        {row.review?.usages ? (
          <button
            type="button"
            className="plan-review-btn"
            onClick={() => onReview(row.review?.usages as W2E)}
          >
            <i className="codicon codicon-search" aria-hidden /> Usages
          </button>
        ) : null}
      </span>
      {/* Notes (last) — the per-row reason / warning / collision message. */}
      <span className="plan-notes">{row.nameNote}</span>
    </div>
  );
}

function ApplySection({ apply }: { apply: ApplyState }) {
  if (apply.status === "running") {
    return (
      <p className="transfer-hint">
        Applying ESV changes… {apply.restartStatus} ({apply.elapsedS}s) — a tenant-wide restart,
        usually a few minutes.
      </p>
    );
  }
  if (apply.status === "done") {
    return apply.ok ? (
      <p className="transfer-v-ok">✓ ESV changes applied ({apply.elapsedS}s)</p>
    ) : (
      <p className="transfer-v-bad">
        ✗ ESV apply didn't complete — {apply.message ?? "see logs"} ({apply.elapsedS}s)
      </p>
    );
  }
  return null;
}

// ─── Source preview (Slice A) ────────────────────────────────────────────────

function SourcePreview({ bundle }: { bundle: ParsedBundle }) {
  const { meta, label, components, inventory } = bundle;
  return (
    <section className="transfer-source">
      <div className="transfer-chip">{label}</div>
      {meta ? (
        <MetaBlock meta={meta} />
      ) : (
        <p className="transfer-hint">No metadata block in this bundle.</p>
      )}
      {inventory.length > 0 ? (
        <ul className="transfer-inventory">
          {inventory.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <div className="transfer-components-header">Components ({components.length})</div>
      <ul className="transfer-components">
        {components.map((c) => (
          <ComponentRow key={`${c.kind}:${c.id}`} component={c} />
        ))}
      </ul>
    </section>
  );
}

function ComponentRow({ component }: { component: ComponentSummary }) {
  return (
    <li>
      <span>{component.displayName}</span>
      {component.detail ? <span className="transfer-comp-detail">{component.detail}</span> : null}
    </li>
  );
}

function MetaBlock({ meta }: { meta: NonNullable<ParsedBundle["meta"]> }) {
  const toolLine =
    meta.exportTool && meta.exportToolVersion
      ? `${meta.exportTool} ${meta.exportToolVersion}`
      : meta.exportTool;
  const rows: Array<[string, string | undefined]> = [
    ["Origin", meta.origin],
    ["Realm", meta.realm],
    ["Type", meta.connectionType],
    ["Exported", meta.exportDate],
    ["Tool", toolLine],
  ];
  return (
    <dl className="transfer-meta">
      {rows
        .filter(([, v]) => v)
        .map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
    </dl>
  );
}
