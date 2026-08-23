import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { Combobox, type ComboboxOption } from "../../shared/combobox";
import type {
  BundleKind,
  CompareOptions,
  ComponentSummary,
  ComponentVerdict,
  ConnectionInfo,
  E2W,
  EntityKind,
  JourneyAction,
  JourneyUnitPlan,
  ParsedBundle,
  PreflightPhase,
  RequiredDepVerdict,
  TransferPayload,
  W2E,
  WriteResult,
} from "../messages";
import { PREFLIGHT_PHASE_LABEL, WRITABLE_KINDS } from "../messages";
import { kindMeta, sortByKindThenName } from "./kind-meta";

const isWritableVerdict = (v: ComponentVerdict) => v.status === "new" || v.status === "differs";
/** Seeded CHECKED by default — a CREATE only. An overwrite (`differs`) is never
 * a default: it clobbers content already on the target, and at realm scale the
 * blast radius of a zero-click mass overwrite is unacceptable. The one exception
 * is the main journey (see `seedJourneyKeys`) — that IS what the user asked to
 * import. Everything else is one click away via the select-all cycle. */
const isSeedableVerdict = (v: ComponentVerdict) => v.status === "new";
/**
 * A row whose target check FAILED — an unknown target state, not a fact about
 * the target. Deliberately excludes `unsupported` (a KNOWN "this target can't
 * take this kind" → safe to skip) and `id-collision` (a known conflict with its
 * own guidance). Only `error` means "we don't know", and only `error` is worth
 * retrying. See PD-20 / lessons.md 2026-08-21.
 */
const isErroredVerdict = (v: ComponentVerdict) => v.status === "error";
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

/** The live "Checking target…" line (PD-19). Elapsed time is what distinguishes
 * a slow run from a hung one: a row inside a transport retry can freeze the
 * counter for ~15 s, and a retry has no channel to the UI (D46). */
function preflightProgressLine(p: PreflightProgressState | undefined): string {
  if (!p) return "Checking target…";
  const label = PREFLIGHT_PHASE_LABEL[p.phase];
  // A single-unit phase (`deps`) has no meaningful count — show the label alone.
  const count = p.total > 1 ? ` ${p.done}/${p.total}` : "";
  return `Checking target — ${label}${count} · ${p.elapsedS}s`;
}

/** One-line plan summary above the table (S9a) — omits zero buckets.
 *
 * `unselected` (D47) counts actionable LEAF rows the user hasn't checked. Before
 * D47 every actionable leaf seeded checked, so the bucket couldn't be non-zero;
 * now that an overwrite is opt-in it's the DEFAULT state, and without its own
 * bucket a plan holding five differing themes would read "nothing to import".
 * Deliberately not folded into `keep`: `keep` is a journey unit's decision, and
 * the confirm modal restates it verbatim (D44) with journey counts only. */
function planSummaryLine(c: {
  create: number;
  overwrite: number;
  keep: number;
  unselected: number;
  unchanged: number;
  blocked: number;
}): string {
  const parts: string[] = [];
  if (c.create) parts.push(`${c.create} create`);
  if (c.overwrite) parts.push(`${c.overwrite} overwrite`);
  if (c.keep) parts.push(`${c.keep} keep`);
  if (c.unselected) parts.push(`${c.unselected} unselected`);
  if (c.unchanged) parts.push(`${c.unchanged} unchanged`);
  if (c.blocked) parts.push(`${c.blocked} blocked`);
  return parts.length > 0 ? `Plan: ${parts.join(" · ")}` : "Plan: nothing to import";
}

/** Journey selection keys implied by a set of plans: the subject seeds CHECKED
 * (its default action is Overwrite — it's the journey the user asked to import);
 * inner journeys stay unchecked (default Keep — they're shared, so overwriting
 * one reaches journeys the user didn't select). `new` and `identical` units are
 * locked rows and carry no key. */
function seedJourneyKeys(plans: readonly JourneyUnitPlan[]): string[] {
  return plans
    .filter((p) => p.role === "subject" && p.verdict === "exists")
    .map((p) => `journey:${p.id}`);
}

/**
 * The S9a smart defaults — the ONE place row selection is seeded (D46). Leaf
 * rows start checked only when they're a CREATE (`new`); `differs` leaves start
 * unchecked because an overwrite is opt-in. The sole default overwrite is a
 * `subject + exists` journey; inner journeys stay unchecked (default Keep) and
 * identical/blocked rows are never selectable.
 *
 * Used by BOTH `preflightResult` and `journeyPlansUpdated`, because a
 * compare-option toggle is a RE-PLAN: it changes what counts as a difference,
 * hence each row's Status, hence what is actionable — so it returns the whole
 * table to these defaults rather than preserving a selection made against the
 * previous comparison. (It resets TO the defaults, not to an empty table: only
 * the user's manual deviations are discarded.)
 */
function seedSelection(
  verdicts: readonly ComponentVerdict[],
  plans: readonly JourneyUnitPlan[],
): Set<string> {
  return new Set([
    ...verdicts.filter((v) => v.kind !== "journey" && isSeedableVerdict(v)).map(verdictKey),
    ...seedJourneyKeys(plans),
  ]);
}

const sameKeys = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((k) => b.includes(k));

/** The header checkbox is a 3-step CYCLE (D46 amendment): `default` → `none` →
 * `all` → `default`. Three steps, not two, because the smart default stopped
 * being reachable by a binary toggle once overwrites became opt-in — and it's
 * exactly the state a user wants back after an over-broad select-all.
 *
 * The box still RENDERS from the live selection (mixed → indeterminate), so a
 * hand-edited table reads honestly. A mixed selection sits where `default` sits
 * in the cycle, so its next step is `none` — same as clicking from the default.
 *
 * `scope` = every actionable key (all the header may touch); `defaults` = its
 * seeded subset. Returns the keys to hold selected WITHIN `scope`. */
type SelectAllStep = "default" | "none" | "all";
const SELECT_ALL_CYCLE: readonly SelectAllStep[] = ["default", "none", "all"];

function selectAllStepKeys(
  step: SelectAllStep,
  scope: readonly string[],
  defaults: readonly string[],
): string[] {
  if (step === "all") return [...scope];
  if (step === "none") return [];
  return [...defaults];
}

/** Where the live selection sits in the cycle. A mixed selection — the seeded
 * default, or any hand-edited table — reads as `default`, so its next step is
 * `none`, exactly as clicking from the untouched default would be. */
function selectAllStepOf(inScope: readonly string[], scope: readonly string[]): SelectAllStep {
  if (scope.length > 0 && inScope.length === scope.length) return "all";
  if (inScope.length === 0) return "none";
  return "default";
}

function nextSelectAllKeys(
  selected: ReadonlySet<string>,
  scope: readonly string[],
  defaults: readonly string[],
): string[] {
  const inScope = scope.filter((k) => selected.has(k));
  const from = SELECT_ALL_CYCLE.indexOf(selectAllStepOf(inScope, scope));
  // Walk forward, skipping any step that changes nothing — a plan whose smart
  // default already IS every actionable row (or none of them) would otherwise
  // spend the first click doing nothing visible.
  for (let i = 1; i <= SELECT_ALL_CYCLE.length; i += 1) {
    const step = SELECT_ALL_CYCLE[(from + i) % SELECT_ALL_CYCLE.length] ?? "none";
    const keys = selectAllStepKeys(step, scope, defaults);
    if (!sameKeys(keys, inScope)) return keys;
  }
  return [];
}

/** Every option off — today's exact compare, and the default for every bundle. */
const EXACT_COMPARE_OPTIONS: CompareOptions = {
  ignoreNodePositions: false,
  ignoreNodeDisplayNames: false,
  ignoreJourneyTags: false,
};

/** The three user-selectable compare relaxations, in the order they're shown.
 * Wording follows the platform: AIC's console labels `uiConfig.categories`
 * "Tags (optional)", so we say "journey tags" rather than "categories". */
const COMPARE_OPTION_DEFS: ReadonlyArray<{
  key: keyof CompareOptions;
  label: string;
  title: string;
}> = [
  {
    key: "ignoreNodePositions",
    label: "node positions",
    title:
      "Node x/y coordinates and the start/success/failure marker positions — canvas layout only.",
  },
  {
    key: "ignoreNodeDisplayNames",
    label: "node display names",
    title:
      "Node display names (displayName) — the label on each node. Outcome labels are NOT ignored.",
  },
  {
    key: "ignoreJourneyTags",
    label: "journey tags",
    title: "Journey tags (uiConfig.categories) — organisation and searchability, not behaviour.",
  },
];

/** The compare-option checkboxes: always visible for a journey bundle, directly
 * above the grid they qualify. Toggling re-runs the compare live (the extension
 * recomputes from cached target reads) — deliberately no Refresh button, since a
 * button would let the boxes and the rows disagree until clicked. */
/**
 * Determinate import progress (D46). A realm import is ~500 sequential writes over
 * 1–3 minutes, and a bare `47/180` reads as stalled — the moving bar plus the name
 * of the item currently landing is what shows it's alive. The per-row Status column
 * remains the richer signal (it shows WHAT happened); this is the "how far".
 *
 * Deliberately **elapsed, not ETA**: write costs aren't uniform (a theme splice
 * rewrites the whole `themerealm` doc, a script is one PUT), so an estimate would
 * jump around, and a jumpy estimate is worse than none. No cancel — an abort
 * mid-batch leaves a half-written realm; D43's attempt-all + Re-plan covers it.
 */
function ImportProgress({
  done,
  total,
  lastItem,
  elapsedS,
}: {
  done: number;
  total: number;
  lastItem?: string;
  elapsedS: number;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const mins = Math.floor(elapsedS / 60);
  const elapsed = mins > 0 ? `${mins}m ${elapsedS % 60}s` : `${elapsedS}s`;
  return (
    <div className="transfer-progress">
      <div className="transfer-progress-label">
        Importing {done}/{total}
        {lastItem ? ` · ${lastItem}` : ""} — {elapsed} elapsed
      </div>
      <div className="transfer-progress-row">
        <div className="transfer-progress-track">
          <div className="transfer-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="transfer-progress-pct">{pct}%</span>
      </div>
    </div>
  );
}

function CompareOptionsRow({
  options,
  disabled,
  onChange,
}: {
  options: CompareOptions;
  disabled: boolean;
  onChange: (next: CompareOptions) => void;
}) {
  return (
    <div className="transfer-compare-options">
      <span className="transfer-co-label">Ignore:</span>
      <div className="transfer-co-boxes">
        {COMPARE_OPTION_DEFS.map((d) => (
          <label key={d.key} title={d.title}>
            <input
              type="checkbox"
              checked={options[d.key]}
              disabled={disabled}
              aria-label={`Ignore ${d.label}`}
              onChange={() => onChange({ ...options, [d.key]: !options[d.key] })}
            />
            {d.label}
          </label>
        ))}
      </div>
    </div>
  );
}

/** The Create/Overwrite/Keep action a journey unit will take, given the user's
 * checkbox selection. Uniform across roles: a New unit is Create (forced), an
 * `identical` unit is Keep (locked no-op), anything else is Overwrite when its
 * row is checked else Keep. Role only decides the SEEDED default — the subject
 * starts checked, an inner starts unchecked (see `journey-plan.ts:decide`). */
function journeyActionFor(p: JourneyUnitPlan, selectedKeys: ReadonlySet<string>): JourneyAction {
  if (p.verdict === "new") return "create";
  if (p.verdict === "identical") return "keep"; // own-scope unchanged → no write
  return selectedKeys.has(`journey:${p.id}`) ? "overwrite" : "keep";
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

/** Live pre-flight progress (PD-19). Absent until the first tick lands, so the
 * hint degrades gracefully to a bare "Checking target…" on the first frame. */
interface PreflightProgressState {
  phase: PreflightPhase;
  done: number;
  total: number;
  elapsedS: number;
}

/** Read-only compare pre-flight state. */
type PreflightState =
  | { status: "idle" }
  | { status: "running"; progress?: PreflightProgressState }
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
  // Latest pre-flight verdicts, mirrored for the message handler: its effect deps
  // are [selectedHost, selectedRealm, vscode, replan], so reading `preflight` from
  // that closure would be stale. `journeyPlansUpdated` carries only journeyPlans,
  // and it needs the verdicts to re-seed the leaf half of the selection.
  const verdictsRef = useRef<readonly ComponentVerdict[]>([]);
  // Compare relaxations. Session state only — never persisted, and reset to
  // exact whenever a new bundle or target lands.
  const [compareOptions, setCompareOptions] = useState<CompareOptions>(EXACT_COMPARE_OPTIONS);
  // PD-20: a recheck is in flight. The plan stays on screen throughout (that's
  // the point of a targeted recheck), so without this the button would look
  // inert for as long as the retry ladder runs — the same "is it hung?" problem
  // the pre-flight progress line solves.
  const [rechecking, setRechecking] = useState(false);
  const toggleKey = useCallback((key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // Select-all header (TD-10, D46 amendment): rewrite the selection WITHIN the
  // actionable scope. Keys outside that scope — a `required` new script, locked
  // checked — are never touched, so no cycle step can silently drop a forced write.
  const applySelection = useCallback((scope: readonly string[], next: readonly string[]) => {
    setSelectedKeys((prev) => {
      const out = new Set(prev);
      for (const k of scope) out.delete(k);
      for (const k of next) out.add(k);
      return out;
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

  // PD-20: re-check ONLY the failed rows. Unlike `replan` this keeps the plan
  // on screen (and the user's selection with it) — the reply patches rows in.
  const recheckFailed = useCallback(
    (host: string, realm: string, keys: string[]) => {
      setRechecking(true);
      vscode.postMessage({ type: "recheckFailed", host, realm, keys });
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
        // Smart-default selection (S9a, refines TD-10) — see `seedSelection`.
        verdictsRef.current = m.verdicts;
        setSelectedKeys(seedSelection(m.verdicts, m.journeyPlans));
        setCompareOptions(EXACT_COMPARE_OPTIONS); // a fresh plan starts exact
        setRechecking(false); // a full re-plan supersedes any in-flight recheck
      } else if (m.type === "journeyPlansUpdated") {
        if (m.host !== selectedHost || m.realm !== selectedRealm) return; // stale
        // D46: a compare-option toggle is a RE-PLAN, so the WHOLE table returns to
        // the smart defaults — leaves included. Previously the journey keys were
        // re-seeded while leaf choices were preserved; that asymmetry is invisible
        // and confusing now that select-all spans journey rows (click select-all →
        // toggle an option → journeys silently uncheck, leaves stay checked, header
        // checkbox stuck indeterminate). Leaf verdicts themselves don't move on a
        // toggle, so `verdictsRef` is still current.
        setPreflight((prev) =>
          prev.status === "ok" ? { ...prev, journeyPlans: m.journeyPlans } : prev,
        );
        setSelectedKeys(seedSelection(verdictsRef.current, m.journeyPlans));
      } else if (m.type === "preflightProgress") {
        if (m.host !== selectedHost || m.realm !== selectedRealm) return; // stale
        // Only meaningful while running. A tick arriving after the plan landed
        // (a recheck's last tick racing its `verdictsPatched`) must not knock
        // the table back into the running state.
        setPreflight((prev) =>
          prev.status === "running"
            ? {
                status: "running",
                progress: {
                  phase: m.phase,
                  done: m.done,
                  total: m.total,
                  elapsedS: m.elapsedS,
                },
              }
            : prev,
        );
      } else if (m.type === "verdictsPatched") {
        if (m.host !== selectedHost || m.realm !== selectedRealm) return; // stale
        setRechecking(false);
        // PD-20: MERGE by key — replacing the list would drop every row that
        // wasn't rechecked. Selection and compare options are untouched by
        // design; that's the whole point of a targeted recheck.
        const byKey = new Map(m.verdicts.map((v) => [`${v.kind}:${v.id}`, v]));
        const patch = (list: readonly ComponentVerdict[]) =>
          list.map((v) => byKey.get(`${v.kind}:${v.id}`) ?? v);
        setPreflight((prev) =>
          prev.status === "ok" ? { ...prev, verdicts: patch(prev.verdicts) } : prev,
        );
        // Keep the D46 mirror in step with the patch: `journeyPlansUpdated` re-seeds
        // the leaf half of the selection from `verdictsRef`, so leaving it stale
        // would replay the pre-recheck verdicts and undo the recovery.
        verdictsRef.current = patch(verdictsRef.current);
        // A row that recovered into a writable state needs its smart default
        // back — it had none while it was errored (it wasn't selectable).
        setSelectedKeys((prev) => {
          const next = new Set(prev);
          for (const v of m.verdicts) {
            if (isSeedableVerdict(v)) next.add(`${v.kind}:${v.id}`);
          }
          return next;
        });
      } else if (m.type === "preflightError") {
        if (m.host !== selectedHost || m.realm !== selectedRealm) return; // stale
        setRechecking(false); // a recheck reports its failure on this channel too
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
  // A compare-option toggle. Optimistic locally (the checkbox flips at once);
  // the extension recomputes from its cached target reads and answers with
  // `journeyPlansUpdated`, so no AM round-trip and no Refresh button.
  const onCompareOptions = (next: CompareOptions) => {
    setCompareOptions(next);
    if (selectedHost === null || selectedRealm === null) return;
    vscode.postMessage({
      type: "setCompareOptions",
      host: selectedHost,
      realm: selectedRealm,
      options: next,
    });
  };
  const onExecute = () => {
    if (selectedHost === null || selectedRealm === null) return;
    // Journey decisions: any existing unit (subject or inner) is Overwrite when
    // checked, else Keep. New units are forced Create — leave them to the
    // engine's default rather than sending a redundant action.
    const journeyPlans = preflight.status === "ok" ? preflight.journeyPlans : [];
    const journeyActions: Record<string, JourneyAction> = {};
    for (const p of journeyPlans) {
      if (p.verdict === "new") continue;
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
  const onExportRealm = () => {
    if (selectedHost === null || selectedRealm === null) return;
    vscode.postMessage({ type: "exportTargetRealm", host: selectedHost, realm: selectedRealm });
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
          onExportRealm={onExportRealm}
          exportDisabled={execute.status === "running"}
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
          onApplySelection={applySelection}
          onReview={(msg) => vscode.postMessage(msg)}
          onDownloadReport={() => vscode.postMessage({ type: "downloadReport" })}
          onReplan={onReplan}
          onRecheckFailed={(keys) => recheckFailed(selectedHost, selectedRealm, keys)}
          rechecking={rechecking}
          compareOptions={compareOptions}
          onCompareOptions={onCompareOptions}
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
  /** D48 — export every journey in the selected target realm. */
  onExportRealm: () => void;
  /** A write is in flight; the realm read would only add noise. */
  exportDisabled: boolean;
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
          {/* D48 — a standing realm export, on the row of the thing it acts on.
              Not the plan-summary bar (plan state + the one control that clears
              the Import gate, replaced by the result summary after a run) and not
              below the table (off-screen at realm scale — PD-21's own argument).
              PD-21's rule for a permanent control holds: a realm export is always
              executable, so it is never dead chrome. Same icon + "Export…" label
              as `RealmCard` / `JourneyCard` — one export idiom everywhere. */}
          <div className="transfer-realm-row">
            <Combobox
              id="target-realm"
              options={realmComboOptions}
              selectedValue={selectedRealm ?? ""}
              onSelect={props.onRealmChange}
              placeholder={realmPlaceholder(selectedHost, realms)}
              disabled={realmDisabled}
            />
            <button
              type="button"
              className="plan-review-btn transfer-export-realm"
              disabled={realmDisabled || selectedRealm === null || props.exportDisabled}
              title={
                selectedRealm
                  ? `Export every journey in ${selectedRealm} to a file`
                  : "Select a realm first"
              }
              onClick={props.onExportRealm}
            >
              <i className="codicon codicon-export" aria-hidden /> Export…
            </button>
          </div>
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
  onApplySelection,
  onReview,
  onDownloadReport,
  onReplan,
  onRecheckFailed,
  rechecking,
  compareOptions,
  onCompareOptions,
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
  onApplySelection: (scope: readonly string[], next: readonly string[]) => void;
  onReview: (msg: W2E) => void;
  onDownloadReport: () => void;
  onReplan: () => void;
  onRecheckFailed: (keys: string[]) => void;
  rechecking: boolean;
  compareOptions: CompareOptions;
  onCompareOptions: (next: CompareOptions) => void;
}) {
  const isWritable = WRITABLE_KINDS.has(bundleKind);
  const verdicts = preflight.status === "ok" ? preflight.verdicts : [];
  const requires = preflight.status === "ok" ? preflight.requires : [];
  const journeyPlans = preflight.status === "ok" ? preflight.journeyPlans : [];
  const isLeafBundle = journeyPlans.length === 0;
  const running = execute.status === "running";
  // Elapsed seconds for the import progress bar. Local to the render — the write
  // itself is extension-side, so there's nothing to persist; resets whenever a run
  // starts or stops. (Elapsed, never ETA — see `ImportProgress`.)
  const [elapsedS, setElapsedS] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsedS(0);
      return;
    }
    const startedAt = Date.now();
    setElapsedS(0);
    const id = setInterval(() => setElapsedS(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [running]);
  // Per-row outcomes drive the Status column live (running) + final (done).
  const results =
    execute.status === "running" || execute.status === "done" ? execute.results : undefined;
  // TD-10: once an import completes the table locks read-only (the result
  // report) until re-armed by a fresh pre-flight (re-select target / new bundle).
  const locked = execute.status === "done";
  // Checkboxes are frozen DURING a write as well as after (PD-16 live rows).
  const frozen = locked || running;
  // Counts are a live preview of the confirm-modal summary.
  const leafVerdicts = verdicts.filter((v) => v.kind !== "journey");
  const selectedLeaves = leafVerdicts.filter(
    (v) => isWritableVerdict(v) && selectedKeys.has(verdictKey(v)),
  );
  // D46: select-all spans leaves AND journey rows. Only `exists` journeys take a
  // key — `new` is written unconditionally (never gated on a checkbox) and
  // `identical` is a locked no-op. Leaves go through `rowStateOf` — the SAME
  // predicate `PlanTable` derives the checkbox's checked/indeterminate state
  // from. A mismatch leaves the box stuck indeterminate and (worse) lets a
  // deselect step strip a `required` new script whose row still shows checked.
  const allActionableKeys = [
    ...leafVerdicts
      .filter((v) => rowStateOf(v, journeyPlans.length > 0) === "writable")
      .map(verdictKey),
    ...journeyPlans.filter((p) => p.verdict === "exists").map((p) => `journey:${p.id}`),
  ];
  // The cycle's `default` step: the seeded subset of the actionable scope.
  const seededKeys = seedSelection(verdicts, journeyPlans);
  const defaultActionableKeys = allActionableKeys.filter((k) => seededKeys.has(k));
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
  // D47: actionable leaves left unchecked — the default for every `differs` row
  // now that an overwrite is opt-in. Uses the actionable scope (not
  // `isWritableVerdict`) so a `required` new script never lands here.
  const unselectedN = allActionableKeys.filter(
    (k) => !k.startsWith("journey:") && !selectedKeys.has(k),
  ).length;
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
  // PD-20 — a failed check is an UNKNOWN target state, so it must gate the
  // write. Without this the plan happily imports a journey whose script check
  // errored: the script is dropped from the write plan (`journey-assemble.ts`)
  // and never remapped (`buildScriptRemap` has no `resolvedTargetId` for it), so
  // the journey lands pointing at a bundle UUID the target may not have.
  // `unsupported` deliberately does NOT gate — that's a known-safe skip.
  const erroredVerdicts = verdicts.filter(isErroredVerdict);
  const importDisabled =
    execute.status === "running" ||
    blockingMissing.length > 0 ||
    erroredVerdicts.length > 0 ||
    !hasWork;
  const subjects = journeyPlans.filter((p) => p.role === "subject");
  // After an ESV import, offer the separate tenant-wide apply (restart).
  const wroteEsv =
    execute.status === "done" &&
    execute.results.some((r) => isEsvKind(r.kind) && r.status === "created");
  return (
    <section>
      <div className="transfer-section-title">Plan</div>
      {/* Destination only — each subject's verdict and Keep/Overwrite choice lives
          in its own "Main journey" row in the grid. One line per subject reads fine
          for a single-journey bundle but not for a realm one (D46: many subjects),
          so 2+ collapse to a count. */}
      {subjects.length === 1 ? (
        <p className="transfer-subject">
          Import journey: <strong>{subjects[0].displayName}</strong> → {host} / {realm}
        </p>
      ) : subjects.length > 1 ? (
        <p className="transfer-subject">
          Import <strong>{subjects.length} journeys</strong> → {host} / {realm}
        </p>
      ) : null}
      {preflight.status === "ok" && execute.status === "running" ? (
        <ImportProgress
          done={execute.done}
          total={execute.total}
          lastItem={execute.results[execute.results.length - 1]?.displayName}
          elapsedS={elapsedS}
        />
      ) : null}
      {preflight.status === "ok" && execute.status !== "running" ? (
        <p className="transfer-plan-summary">
          {/* No `running` branch: D46 renders <ImportProgress/> instead and this
              paragraph is gated on `execute.status !== "running"`. */}
          {execute.status === "done" && execute.summary
            ? execute.summary
            : planSummaryLine({
                create: createN,
                overwrite: overwriteN,
                keep: jKeep,
                unselected: unselectedN,
                unchanged,
                blocked,
              })}
          {/* PD-20 — sits with the `blocked` count it acts on, ABOVE the table:
              below it, the one control that clears the Import gate is off-screen
              on a long plan. Conditional by design — a permanently-visible button
              that's inert whenever the plan is healthy is dead chrome. */}
          {erroredVerdicts.length > 0 && !locked ? (
            <button
              type="button"
              className="plan-review-btn transfer-recheck"
              disabled={rechecking}
              onClick={() => onRecheckFailed(erroredVerdicts.map(verdictKey))}
            >
              <i className="codicon codicon-refresh" aria-hidden />{" "}
              {rechecking ? "Rechecking…" : `Recheck failed (${erroredVerdicts.length})`}
            </button>
          ) : null}
        </p>
      ) : null}
      {/* Journey bundles only — the three relaxations are all journey fields, so
          they'd be inert (and confusing) on a leaf-only bundle. */}
      {preflight.status === "ok" && journeyPlans.length > 0 ? (
        <CompareOptionsRow options={compareOptions} disabled={frozen} onChange={onCompareOptions} />
      ) : null}
      {preflight.status === "running" ? (
        <p className="transfer-hint">{preflightProgressLine(preflight.progress)}</p>
      ) : null}
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
          onCycleSelectAll={() =>
            onApplySelection(
              allActionableKeys,
              nextSelectAllKeys(selectedKeys, allActionableKeys, defaultActionableKeys),
            )
          }
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

/** A row for ONE journey unit — subject or inner, same shape. New → forced
 * Create; identical → locked no-op; exists → a checkbox toggling Overwrite
 * (checked) / Keep. Role changes only the type word, the seeded default, and
 * the shared-inner warning. Three-phase Status mirrors the leaf rows. */
function journeyRowData(p: JourneyUnitPlan, checked: boolean, result?: WriteResult): PlanRowData {
  const isSubject = p.role === "subject";
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
    typeWord: isSubject ? "Main journey" : "Inner journey",
    statusText: status.text,
    statusCls: status.cls,
    name: p.displayName,
    // Warn that overwriting a SHARED inner journey reaches other journeys (only
    // when it's actually a Keep/Overwrite choice). A subject isn't shared by
    // definition — deselecting it just means "don't write the wiring".
    nameNote:
      isSubject || isNew || isIdentical ? undefined : "shared — Overwrite affects other journeys",
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
  onCycleSelectAll,
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
  onCycleSelectAll: () => void;
  onReview: (msg: W2E) => void;
}) {
  const resultByKey = new Map((results ?? []).map((r) => [`${r.kind}:${r.id}`, r]));
  // Inner-journey rows (subjects are the header) first, then leaf components
  // (journey verdicts excluded — they're decided via journeyPlans), then the
  // info-only dependency / gate rows — all in one aligned grid.
  const journeyRow = (p: JourneyUnitPlan) =>
    journeyRowData(p, selectedKeys.has(`journey:${p.id}`), resultByKey.get(`journey:${p.id}`));
  const rows: PlanRowData[] = [
    // Subject first — it's the journey the user asked to import — then inners.
    ...journeyPlans.filter((p) => p.role === "subject").map(journeyRow),
    ...journeyPlans.filter((p) => p.role === "inner").map(journeyRow),
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
  // D46: every writable row, journeys included (reverses the earlier "inner-journey
  // Overwrite/Keep is a deliberate per-row choice, not bulk-toggled" exclusion — a
  // referenced journey defaults to Keep, so at realm scale per-row clicking is
  // untenable). Must match `allActionableKeys` in `PlanSection`.
  const actionable = rows.filter((r) => r.rowState === "writable");
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
        onCycle: onCycleSelectAll,
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
    onCycle: () => void;
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
              title="Cycle selection — smart default · none · all"
              checked={headerCheckbox.allChecked}
              disabled={locked}
              ref={(el) => {
                if (el) el.indeterminate = headerCheckbox.someChecked;
              }}
              onChange={headerCheckbox.onCycle}
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
