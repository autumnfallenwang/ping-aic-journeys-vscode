import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EntityKind, RealmIndexEntity, UsagePaths } from "../../../domain/realm-index";
import type {
  CacheStatus,
  E2W,
  HydratedReverseRef,
  QueryMode,
  SearchPayload,
  W2E,
} from "../messages";
import { DISPLAY_KIND_ICON, displayKindOf, groupByKind } from "./grouping";
import { UsagePathTree } from "./UsagePathTree";

/** A non-null-entity Find-usages row — the carrier `groupByKind` groups.
 * `refCount` collapses N direct references from one entity via the same
 * `via` into a single row with an `(N refs)` badge — the same rule the
 * Tree view applies to its leaves (D37 amendment), so List and Tree stay
 * one concept. */
interface UsageRow {
  entity: RealmIndexEntity;
  via: string;
  refCount: number;
}

/** Find-usages results have two views — the grouped one-hop list and the
 * journey → … → target path tree. */
type UsagesView = "list" | "tree";

interface VsCodeApi {
  postMessage(msg: W2E): void;
}

interface Props {
  vscode: VsCodeApi;
  payload: SearchPayload;
}

// ─── State shapes ────────────────────────────────────────────────────────

/** Coarse build-phase progress for the in-page bar. Mirrors the
 * `buildProgress` E2W payload minus the routing fields. */
interface BuildProgressInfo {
  phase: "preparing" | "journeys" | "scripts" | "finishing";
  done?: number;
  total?: number;
}

type BuildState =
  | { status: "idle"; cache: CacheStatus }
  | { status: "building"; progress: BuildProgressInfo | null; pct: number }
  | { status: "err"; message: string; cache: CacheStatus };

type QueryState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "err"; message: string }
  | {
      status: "okFindUsages";
      targetKey: string;
      refs: readonly HydratedReverseRef[];
      paths: UsagePaths;
    }
  | { status: "okByName"; results: readonly RealmIndexEntity[] }
  | { status: "okUnused"; results: readonly RealmIndexEntity[] };

/** Per-host realm-list fetch state. */
type RealmsState =
  | { status: "loading" }
  | { status: "ok"; realms: readonly string[] }
  | { status: "err"; message: string };

const ALL_KINDS: readonly EntityKind[] = [
  "journey",
  "script",
  "esv",
  "theme",
  "emailTemplate",
  "socialIdp",
];

const KIND_LABEL: Record<EntityKind, string> = {
  journey: "Journey",
  script: "Script",
  esv: "ESV",
  theme: "Theme",
  emailTemplate: "Email template",
  socialIdp: "Social IdP",
};

const EMPTY_CACHE: CacheStatus = {
  builtAt: null,
  scanDurationMs: null,
  counts: null,
};

// Unused-mode defaults (D36 + queries.ts: exclude journeys by default).
const UNUSED_DEFAULT_KINDS: readonly EntityKind[] = [
  "script",
  "esv",
  "theme",
  "emailTemplate",
  "socialIdp",
];

// ─── Component ───────────────────────────────────────────────────────────

export function App({ vscode, payload }: Props) {
  // Scope — connection + realm. Both picked via the in-page dropdowns;
  // pre-filled from the embedded payload when opened from a tree-context
  // / card-portal entry. The rest of the page renders only once BOTH are
  // selected.
  const [selectedHost, setSelectedHost] = useState<string | null>(payload.selectedHost);
  const [selectedRealm, setSelectedRealm] = useState<string | null>(payload.selectedRealm);
  const [realmsByHost, setRealmsByHost] = useState<Record<string, RealmsState>>({});

  const [build, setBuild] = useState<BuildState>({ status: "idle", cache: EMPTY_CACHE });
  const [mode, setMode] = useState<QueryMode>(payload.prefill?.mode ?? "findUsages");
  const [query, setQuery] = useState<QueryState>({ status: "idle" });

  // Find usages: target dropdown lazily populated via listEntities W2E.
  const [entitiesByKind, setEntitiesByKind] = useState<Record<
    EntityKind,
    readonly RealmIndexEntity[]
  > | null>(null);
  const [usagesKind, setUsagesKind] = useState<EntityKind>(payload.prefill?.targetKind ?? "script");
  const [usagesTargetKey, setUsagesTargetKey] = useState<string>(payload.prefill?.targetKey ?? "");

  // By name + Unused: kind filter chips.
  const [byNamePattern, setByNamePattern] = useState<string>(payload.prefill?.namePattern ?? "");
  const [byNameKinds, setByNameKinds] = useState<readonly EntityKind[]>(ALL_KINDS);
  const [unusedKinds, setUnusedKinds] = useState<readonly EntityKind[]>(UNUSED_DEFAULT_KINDS);

  // Find-usages results: List (grouped one-hop) vs. Tree (journey-paths).
  const [usagesView, setUsagesView] = useState<UsagesView>("list");

  const scopeReady = selectedHost !== null && selectedRealm !== null;
  // The search panel is only meaningful with a built realm index — it
  // gates ModeSwitcher / QueryControls / Results.
  const indexReady = build.status === "idle" && build.cache.builtAt !== null;

  // Bootstrap on mount.
  useEffect(() => {
    vscode.postMessage({ type: "ready" });
  }, [vscode]);

  // Fetch the realm list for the selected connection (once per host).
  useEffect(() => {
    if (selectedHost === null) return;
    setRealmsByHost((prev) => {
      if (prev[selectedHost]) return prev; // already fetched / fetching
      vscode.postMessage({ type: "listRealms", host: selectedHost });
      return { ...prev, [selectedHost]: { status: "loading" } };
    });
  }, [selectedHost, vscode]);

  // When the (host, realm) scope is complete, peek the realm-index cache.
  useEffect(() => {
    if (selectedHost === null || selectedRealm === null) return;
    setBuild({ status: "idle", cache: EMPTY_CACHE });
    setQuery({ status: "idle" });
    setEntitiesByKind(null);
    vscode.postMessage({ type: "peek", host: selectedHost, realm: selectedRealm });
  }, [selectedHost, selectedRealm, vscode]);

  // Listen for E2W messages. Stale results (a reply for a (host, realm)
  // the user has since navigated away from) are dropped.
  useEffect(() => {
    function onMsg(ev: MessageEvent<E2W>) {
      const m = ev.data;
      if (!m || typeof m !== "object" || !("type" in m)) return;
      if (m.type === "realmsResult") {
        setRealmsByHost((prev) => ({
          ...prev,
          [m.host]: { status: "ok", realms: m.realms },
        }));
        return;
      }
      if (m.type === "realmsError") {
        setRealmsByHost((prev) => ({
          ...prev,
          [m.host]: { status: "err", message: m.message },
        }));
        return;
      }
      // Everything below is (host, realm)-scoped — drop stale replies.
      if (m.host !== selectedHost || m.realm !== selectedRealm) return;
      switch (m.type) {
        case "peekResult":
          setBuild({ status: "idle", cache: m.status });
          return;
        case "buildStart":
          setBuild({ status: "building", progress: null, pct: 0 });
          return;
        case "buildProgress":
          setBuild((prev) => {
            const progress = { phase: m.phase, done: m.done, total: m.total };
            const raw = progressPercent(progress);
            // Clamp monotonically — the script phase's `total` grows as
            // library scripts surface, which could otherwise tick the bar
            // backward by a hair. A progress bar never retreats.
            const prevPct = prev.status === "building" ? prev.pct : 0;
            return { status: "building", progress, pct: Math.max(raw, prevPct) };
          });
          return;
        case "buildDone":
          setBuild({ status: "idle", cache: m.status });
          setEntitiesByKind(null);
          return;
        case "buildError":
          setBuild({ status: "err", message: m.message, cache: EMPTY_CACHE });
          return;
        case "listEntitiesResult":
          setEntitiesByKind(m.entitiesByKind);
          return;
        case "queryResult":
          if (m.mode === "findUsages") {
            setQuery({
              status: "okFindUsages",
              targetKey: m.targetKey,
              refs: m.refs,
              paths: m.paths,
            });
          } else if (m.mode === "byName") {
            setQuery({ status: "okByName", results: m.results });
          } else {
            setQuery({ status: "okUnused", results: m.results });
          }
          return;
        case "queryError":
          setQuery({ status: "err", message: m.message });
          return;
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [selectedHost, selectedRealm]);

  // Lazy-load the entity-by-kind list when Find usages is active, the
  // index is built, and the list hasn't been loaded yet.
  useEffect(() => {
    if (
      scopeReady &&
      mode === "findUsages" &&
      entitiesByKind === null &&
      build.status === "idle" &&
      build.cache.builtAt
    ) {
      vscode.postMessage({
        type: "listEntities",
        host: selectedHost as string,
        realm: selectedRealm as string,
      });
    }
  }, [scopeReady, selectedHost, selectedRealm, mode, entitiesByKind, build, vscode]);

  const onBuild = useCallback(() => {
    if (selectedHost === null || selectedRealm === null) return;
    vscode.postMessage({ type: "build", host: selectedHost, realm: selectedRealm });
  }, [selectedHost, selectedRealm, vscode]);
  const onRescan = useCallback(() => {
    if (selectedHost === null || selectedRealm === null) return;
    vscode.postMessage({ type: "rescan", host: selectedHost, realm: selectedRealm });
  }, [selectedHost, selectedRealm, vscode]);

  const onSearch = useCallback(() => {
    if (selectedHost === null || selectedRealm === null) return;
    const host = selectedHost;
    const realm = selectedRealm;
    if (mode === "findUsages") {
      if (!usagesTargetKey) return;
      setQuery({ status: "running" });
      setUsagesView("list"); // each new query resets to the List view
      vscode.postMessage({
        type: "query",
        host,
        realm,
        mode: "findUsages",
        targetKey: usagesTargetKey,
      });
      return;
    }
    if (mode === "byName") {
      if (byNamePattern.trim().length === 0) return;
      setQuery({ status: "running" });
      vscode.postMessage({
        type: "query",
        host,
        realm,
        mode: "byName",
        pattern: byNamePattern.trim(),
        kinds: byNameKinds,
      });
      return;
    }
    setQuery({ status: "running" });
    vscode.postMessage({ type: "query", host, realm, mode: "unused", kinds: unusedKinds });
  }, [
    selectedHost,
    selectedRealm,
    mode,
    usagesTargetKey,
    byNamePattern,
    byNameKinds,
    unusedKinds,
    vscode,
  ]);

  const onPreview = useCallback(
    (entity: RealmIndexEntity) => {
      if (selectedHost === null || selectedRealm === null) return;
      vscode.postMessage({
        type: "previewByKey",
        host: selectedHost,
        realm: selectedRealm,
        kind: entity.kind,
        id: entity.id,
        displayName: entity.displayName,
        ...(entity.isLibrary === undefined ? {} : { isLibrary: entity.isLibrary }),
        ...(entity.esvKind === undefined ? {} : { esvKind: entity.esvKind }),
      });
    },
    [selectedHost, selectedRealm, vscode],
  );

  // One-shot prefill auto-run: when the page opens via the card-portal
  // [🔍 Find usages] button, the prefill carries mode=findUsages +
  // targetKey. Auto-fire once the scope is set + the index is built.
  const autoRanPrefillRef = useRef(false);
  useEffect(() => {
    if (autoRanPrefillRef.current) return;
    if (!payload.prefill || payload.prefill.mode !== "findUsages") return;
    if (!payload.prefill.targetKey) return;
    if (!scopeReady) return;
    if (build.status !== "idle" || build.cache.builtAt === null) return;
    if (mode !== "findUsages" || usagesTargetKey !== payload.prefill.targetKey) return;
    autoRanPrefillRef.current = true;
    onSearch();
  }, [payload.prefill, scopeReady, build, mode, usagesTargetKey, onSearch]);

  const onConnectionChange = useCallback((host: string) => {
    setSelectedHost(host === "" ? null : host);
    setSelectedRealm(null);
  }, []);
  const onRealmChange = useCallback((realm: string) => {
    setSelectedRealm(realm === "" ? null : realm);
  }, []);

  return (
    <main>
      <h1>PAIC Search</h1>
      <p className="search-subtitle">
        Reverse-dependency lookups, by-name search, and orphan detection over a realm index.
      </p>
      <ScopeSelector
        connections={payload.connections}
        selectedHost={selectedHost}
        selectedRealm={selectedRealm}
        realms={selectedHost ? (realmsByHost[selectedHost] ?? null) : null}
        onConnectionChange={onConnectionChange}
        onRealmChange={onRealmChange}
      />
      {scopeReady ? (
        <>
          <Header status={build} onBuild={onBuild} onRescan={onRescan} />
          {indexReady ? (
            <>
              <ModeSwitcher mode={mode} onChange={setMode} />
              <QueryControls
                mode={mode}
                entitiesByKind={entitiesByKind}
                usagesKind={usagesKind}
                usagesTargetKey={usagesTargetKey}
                byNamePattern={byNamePattern}
                byNameKinds={byNameKinds}
                unusedKinds={unusedKinds}
                onUsagesKindChange={setUsagesKind}
                onUsagesTargetChange={setUsagesTargetKey}
                onByNamePatternChange={setByNamePattern}
                onByNameKindsChange={setByNameKinds}
                onUnusedKindsChange={setUnusedKinds}
                onSearch={onSearch}
                // The panel only renders once the index is built (idle),
                // so a build is never in flight here.
                disableSearch={false}
              />
              <Results
                query={query}
                usagesView={usagesView}
                onUsagesViewChange={setUsagesView}
                onPreview={onPreview}
              />
            </>
          ) : (
            // No realm index yet — the search panel is meaningless until
            // one is built, so gate it behind a clear prompt rather than
            // showing dead/empty controls.
            <p className="search-hint">
              {build.status === "building"
                ? "Building the realm index…"
                : "Build the realm index first to search this realm."}
            </p>
          )}
        </>
      ) : (
        <p className="search-hint">
          {payload.connections.length === 0
            ? "No connections configured. Add one from the PAIC Journeys sidebar first."
            : "Pick a connection and realm to begin."}
        </p>
      )}
    </main>
  );
}

// ─── ScopeSelector ───────────────────────────────────────────────────────

interface ScopeSelectorProps {
  connections: SearchPayload["connections"];
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
  // The loaded list, or just the pre-selected realm as a fallback while
  // the list is still in flight.
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

function ScopeSelector(props: ScopeSelectorProps) {
  const { connections, selectedHost, selectedRealm, realms } = props;
  const realmOptions = realmOptionsFor(realms, selectedRealm);
  const connectionOptions: ComboboxOption[] = connections.map((c) => ({
    value: c.host,
    label: c.name ? `${c.name} (${c.host})` : c.host,
  }));
  const realmComboOptions: ComboboxOption[] = realmOptions.map((r) => ({
    value: r,
    label: r,
  }));
  const realmDisabled = selectedHost === null || realms?.status !== "ok";
  return (
    <section className="search-scope">
      <label htmlFor="scope-connection" className="field-label">
        Connection
      </label>
      <Combobox
        id="scope-connection"
        options={connectionOptions}
        selectedValue={selectedHost ?? ""}
        onSelect={props.onConnectionChange}
        placeholder="Select a connection…"
      />
      <label htmlFor="scope-realm" className="field-label">
        Realm
      </label>
      <Combobox
        id="scope-realm"
        options={realmComboOptions}
        selectedValue={selectedRealm ?? ""}
        onSelect={props.onRealmChange}
        placeholder={realmPlaceholder(selectedHost, realms)}
        disabled={realmDisabled}
      />
    </section>
  );
}

// ─── Header ──────────────────────────────────────────────────────────────

interface HeaderProps {
  status: BuildState;
  onBuild: () => void;
  onRescan: () => void;
}

function Header({ status, onBuild, onRescan }: HeaderProps) {
  // While building, the progress bar takes the full header width.
  if (status.status === "building") {
    return (
      <section className="search-header">
        <ProgressBar progress={status.progress} pct={status.pct} />
      </section>
    );
  }
  return (
    <section className="search-header">
      <div className="search-status">
        <div>{renderHeaderStatus(status)}</div>
        <div className="search-actions">{renderHeaderAction(status, onBuild, onRescan)}</div>
      </div>
    </section>
  );
}

function renderHeaderStatus(status: Extract<BuildState, { status: "idle" | "err" }>): JSX.Element {
  if (status.status === "err") {
    return <span className="search-error">Build failed: {status.message}</span>;
  }
  if (status.cache.builtAt === null) {
    return (
      <span className="search-counts">
        Realm index: <em>Not built</em>
      </span>
    );
  }
  return <RealmIndexCounts cache={status.cache} />;
}

function renderHeaderAction(
  status: Extract<BuildState, { status: "idle" | "err" }>,
  onBuild: () => void,
  onRescan: () => void,
): JSX.Element {
  if (status.cache.builtAt === null) {
    return (
      <button type="button" className="primary" onClick={onBuild}>
        Build index
      </button>
    );
  }
  return (
    <button type="button" className="secondary" onClick={onRescan}>
      ↻ Rescan
    </button>
  );
}

// ─── ProgressBar ─────────────────────────────────────────────────────────

/** Overall percentage across contiguous, monotonically-increasing phase
 * bands — preparing 0–5, journeys 5–78, scripts 78–98, finishing 98–100.
 * Both determinate phases (journeys, scripts) interpolate within their
 * band by `done / total`, so the bar moves smoothly the whole build; the
 * bands abut so no phase transition jumps the bar backward. The scripts
 * `total` is the layer-1 frontier estimate — deeper library layers push
 * `done` past it, hence the `min(1, …)` clamp. */
function bandFraction(done: number | undefined, total: number | undefined): number {
  if (!total || total <= 0) return 0;
  return Math.min(1, (done ?? 0) / total);
}

function progressPercent(p: BuildProgressInfo | null): number {
  if (!p || p.phase === "preparing") return 3;
  if (p.phase === "journeys") {
    return Math.round(5 + 73 * bandFraction(p.done, p.total));
  }
  if (p.phase === "scripts") {
    return Math.round(78 + 20 * bandFraction(p.done, p.total));
  }
  return 99; // finishing
}

function progressLabel(p: BuildProgressInfo | null): string {
  if (!p || p.phase === "preparing") return "Preparing…";
  if (p.phase === "journeys") {
    return `Scanning journeys — ${p.done ?? 0} / ${p.total ?? 0}`;
  }
  if (p.phase === "scripts") {
    // Same `X / Y` shape as the journey phase. `total` grows as the BFS
    // surfaces library scripts, but `done` always chases it and the phase
    // ends at `N / N`.
    if (!p.total) return "Resolving scripts…";
    return `Resolving scripts — ${p.done ?? 0} / ${p.total}`;
  }
  return "Finishing…";
}

function ProgressBar({ progress, pct }: { progress: BuildProgressInfo | null; pct: number }) {
  return (
    <div className="search-progress">
      <div className="search-progress-label">{progressLabel(progress)}</div>
      <div className="search-progress-row">
        <div className="search-progress-track">
          <div className="search-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="search-progress-pct">{pct}%</span>
      </div>
    </div>
  );
}

function RealmIndexCounts({ cache }: { cache: CacheStatus }) {
  if (!cache.counts) return null;
  const parts: string[] = [];
  for (const k of ALL_KINDS) {
    const n = cache.counts[k];
    if (!n) continue;
    parts.push(`${n} ${KIND_LABEL[k].toLowerCase()}${n === 1 ? "" : "s"}`);
  }
  const builtAgo =
    cache.builtAt === null
      ? ""
      : new Date(cache.builtAt).toLocaleTimeString(undefined, { hour12: false });
  return (
    <span className="search-counts">
      Realm index: <span className="count">{parts.join(" · ")}</span>{" "}
      <span className="meta">· built at {builtAgo}</span>
    </span>
  );
}

// ─── ModeSwitcher ────────────────────────────────────────────────────────

interface ModeSwitcherProps {
  mode: QueryMode;
  onChange: (m: QueryMode) => void;
}

function ModeSwitcher({ mode, onChange }: ModeSwitcherProps) {
  const modes: Array<{ value: QueryMode; label: string }> = [
    { value: "findUsages", label: "Find usages" },
    { value: "byName", label: "By name" },
    { value: "unused", label: "Unused / orphans" },
  ];
  return (
    <div className="query-mode-control" role="radiogroup" aria-label="Query mode">
      {modes.map((m) => (
        // biome-ignore lint/a11y/useSemanticElements: button[role=radio] is the standard segmented-control idiom (M4 D35)
        <button
          key={m.value}
          type="button"
          role="radio"
          aria-checked={mode === m.value}
          className={mode === m.value ? "active" : ""}
          onClick={() => onChange(m.value)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

// ─── QueryControls ───────────────────────────────────────────────────────

interface QueryControlsProps {
  mode: QueryMode;
  entitiesByKind: Record<EntityKind, readonly RealmIndexEntity[]> | null;
  usagesKind: EntityKind;
  usagesTargetKey: string;
  byNamePattern: string;
  byNameKinds: readonly EntityKind[];
  unusedKinds: readonly EntityKind[];
  onUsagesKindChange: (k: EntityKind) => void;
  onUsagesTargetChange: (key: string) => void;
  onByNamePatternChange: (p: string) => void;
  onByNameKindsChange: (k: readonly EntityKind[]) => void;
  onUnusedKindsChange: (k: readonly EntityKind[]) => void;
  onSearch: () => void;
  disableSearch: boolean;
}

function QueryControls(props: QueryControlsProps) {
  if (props.mode === "findUsages") {
    return <FindUsagesControls {...props} />;
  }
  if (props.mode === "byName") {
    return <ByNameControls {...props} />;
  }
  return <UnusedControls {...props} />;
}

/** One selectable option in a `Combobox`. `value` is the stable identity
 * the caller stores; `label` is the displayed + filtered-on text. */
interface ComboboxOption {
  value: string;
  label: string;
}

/**
 * Type-to-filter dropdown — the single dropdown primitive for every
 * webview `<select>` (D38). An input + an HTML-drawn popup: because the
 * popup is our own markup it honors the VS Code theme (dark in dark
 * mode), unlike a native `<select>` whose open list the OS draws. Typing
 * narrows the popup by case-insensitive substring on `label` (the same
 * matcher the By-name query uses); empty input shows every option.
 *
 * `id` must be unique per instance on the page — it scopes the
 * `aria-controls` / option ids.
 */
function Combobox({
  id,
  options,
  selectedValue,
  onSelect,
  placeholder = "Type to filter…",
  disabled = false,
}: {
  id: string;
  options: readonly ComboboxOption[];
  selectedValue: string;
  onSelect: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // Keep the input text in sync when the selection changes from outside
  // (a dependent dropdown clears it, a card-portal prefill sets it).
  const selectedLabel = options.find((o) => o.value === selectedValue)?.label ?? "";
  useEffect(() => {
    setText(selectedLabel);
  }, [selectedLabel]);

  const matches = useMemo(() => {
    const needle = text.trim().toLocaleLowerCase();
    if (needle.length === 0) return options;
    return options.filter((o) => o.label.toLocaleLowerCase().includes(needle));
  }, [options, text]);

  // Close the popup on an outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (ev: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const choose = (o: ComboboxOption) => {
    onSelect(o.value);
    setText(o.label);
    setOpen(false);
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === "Escape") {
      setOpen(false);
      return;
    }
    if (!open && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
      setOpen(true);
      return;
    }
    if (ev.key === "ArrowDown") {
      ev.preventDefault();
      setActive((i) => Math.min(i + 1, matches.length - 1));
    } else if (ev.key === "ArrowUp") {
      ev.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (ev.key === "Enter" && open && matches[active]) {
      ev.preventDefault();
      choose(matches[active]);
    }
  };

  // Active option id for `aria-activedescendant` — in the ARIA combobox
  // pattern focus stays on the input; the highlighted option is announced
  // by id rather than being tab-focusable itself.
  const optId = (value: string) => `${id}-opt-${value}`;
  const activeId = open && matches[active] ? optId(matches[active].value) : undefined;

  return (
    <div className={`entity-combobox${open ? " open" : ""}`} ref={rootRef}>
      {/* Field wrapper — the chevron is positioned against THIS box only,
          not the whole combobox (which grows tall when the popup opens). */}
      <div className="entity-combobox-field">
        <input
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={`${id}-listbox`}
          aria-activedescendant={activeId}
          autoComplete="off"
          placeholder={placeholder}
          disabled={disabled}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(0);
            if (e.target.value.trim() === "") onSelect("");
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        <i
          className={`codicon codicon-chevron-${open ? "up" : "down"} entity-combobox-chevron`}
          aria-hidden
        />
      </div>
      {open && !disabled ? (
        // Generic `div`s carry the listbox/option roles — focus stays on
        // the input (ARIA combobox pattern), so the options are not
        // tab-focusable; `aria-activedescendant` announces the highlight.
        <div id={`${id}-listbox`} className="entity-combobox-list" role="listbox">
          {matches.length === 0 ? (
            <div className="entity-combobox-empty">No entity matches</div>
          ) : (
            matches.map((o, i) => (
              // biome-ignore lint/a11y/useFocusableInteractive: ARIA combobox pattern — focus stays on the input; the option is announced via aria-activedescendant, not tab-focused
              <div
                key={o.value}
                id={optId(o.value)}
                role="option"
                aria-selected={o.value === selectedValue}
                className={`entity-combobox-option${i === active ? " active" : ""}`}
                onMouseDown={(ev) => {
                  // mousedown, not click — fires before the input blur.
                  ev.preventDefault();
                  choose(o);
                }}
              >
                {o.label}
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

function FindUsagesControls(props: QueryControlsProps) {
  const entities = props.entitiesByKind?.[props.usagesKind] ?? [];
  const kindOptions: ComboboxOption[] = ALL_KINDS.map((k) => ({
    value: k,
    label: KIND_LABEL[k],
  }));
  const targetOptions: ComboboxOption[] = entities.map((e) => ({
    value: e.key,
    label: e.displayName,
  }));
  return (
    <>
      <div className="query-controls">
        <label htmlFor="usages-kind">Kind</label>
        <Combobox
          id="usages-kind"
          options={kindOptions}
          selectedValue={props.usagesKind}
          onSelect={(v) => {
            // Kind is a fixed enum — ignore the empty value the combobox
            // emits when its input is cleared; only react to a real pick.
            if (v === "") return;
            props.onUsagesKindChange(v as EntityKind);
            props.onUsagesTargetChange("");
          }}
        />
        <label htmlFor="usages-target">Target</label>
        <Combobox
          id="usages-target"
          options={targetOptions}
          selectedValue={props.usagesTargetKey}
          onSelect={props.onUsagesTargetChange}
        />
      </div>
      <div className="query-submit">
        <button
          type="button"
          onClick={props.onSearch}
          disabled={props.disableSearch || !props.usagesTargetKey}
        >
          Search
        </button>
      </div>
    </>
  );
}

function ByNameControls(props: QueryControlsProps) {
  return (
    <>
      <div className="query-controls">
        <label htmlFor="name-pattern">Pattern</label>
        <input
          id="name-pattern"
          type="text"
          value={props.byNamePattern}
          placeholder="Substring of name"
          onChange={(e) => props.onByNamePatternChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !props.disableSearch && props.byNamePattern.trim()) {
              props.onSearch();
            }
          }}
        />
        <span className="field-label">Kinds</span>
        <KindChips selected={props.byNameKinds} onChange={props.onByNameKindsChange} />
      </div>
      <div className="query-submit">
        <button
          type="button"
          onClick={props.onSearch}
          disabled={props.disableSearch || props.byNamePattern.trim().length === 0}
        >
          Search
        </button>
      </div>
    </>
  );
}

function UnusedControls(props: QueryControlsProps) {
  return (
    <>
      <div className="query-controls">
        <span className="field-label">Kinds</span>
        <KindChips selected={props.unusedKinds} onChange={props.onUnusedKindsChange} />
      </div>
      <div className="query-submit">
        <button type="button" onClick={props.onSearch} disabled={props.disableSearch}>
          Find unused
        </button>
      </div>
    </>
  );
}

function KindChips({
  selected,
  onChange,
}: {
  selected: readonly EntityKind[];
  onChange: (k: readonly EntityKind[]) => void;
}) {
  const set = useMemo(() => new Set(selected), [selected]);
  function toggle(k: EntityKind) {
    if (set.has(k)) onChange(selected.filter((x) => x !== k));
    else onChange([...selected, k]);
  }
  return (
    <div className="kind-chips">
      {ALL_KINDS.map((k) => (
        <button
          key={k}
          type="button"
          className={set.has(k) ? "active" : ""}
          onClick={() => toggle(k)}
        >
          {KIND_LABEL[k]}
        </button>
      ))}
    </div>
  );
}

// ─── Results ─────────────────────────────────────────────────────────────

interface ResultsProps {
  query: QueryState;
  usagesView: UsagesView;
  onUsagesViewChange: (v: UsagesView) => void;
  onPreview: (entity: RealmIndexEntity) => void;
}

/** A `── Label (N) ──` group header row. */
function ResultDivider({ label, count }: { label: string; count: number }) {
  return (
    <li className="search-divider">
      ── {label} ({count}) ──
    </li>
  );
}

/** One result row — codicon + clickable name + optional `→ via`. The kind
 * label lives in the group divider, so the row shows only the name. */
function EntityRow({
  entity,
  via,
  refCount,
  onPreview,
}: {
  entity: RealmIndexEntity;
  via?: string;
  refCount?: number;
  onPreview: (e: RealmIndexEntity) => void;
}) {
  return (
    <li className="search-row">
      <i className={`codicon codicon-${DISPLAY_KIND_ICON[displayKindOf(entity)]}`} aria-hidden />
      <button type="button" className="link" onClick={() => onPreview(entity)}>
        {entity.displayName}
      </button>
      {refCount && refCount > 1 ? (
        // N direct references from this entity via the same `via` — same
        // `(N refs)` badge the Tree view uses on collapsed leaves.
        <span className="search-tree-refcount">({refCount} refs)</span>
      ) : null}
      {via ? <span className="meta">→ via {via}</span> : null}
    </li>
  );
}

/** Kind-grouped result list — `── Kind (N) ──` dividers + entity rows. */
function GroupedList<T extends { entity: RealmIndexEntity }>({
  items,
  viaOf,
  refCountOf,
  onPreview,
}: {
  items: readonly T[];
  viaOf?: (item: T) => string;
  refCountOf?: (item: T) => number;
  onPreview: (e: RealmIndexEntity) => void;
}) {
  const rows = groupByKind(items);
  return (
    <ul className="search-results-list">
      {rows.map((r, i) =>
        r.row === "divider" ? (
          <ResultDivider key={`d:${r.kind}`} label={r.label} count={r.count} />
        ) : (
          <EntityRow
            // biome-ignore lint/suspicious/noArrayIndexKey: entity keys can repeat across rows (one journey → a script via two node types); the index disambiguates, rows are render-stable
            key={`e:${r.item.entity.key}#${i}`}
            entity={r.item.entity}
            via={viaOf?.(r.item)}
            refCount={refCountOf?.(r.item)}
            onPreview={onPreview}
          />
        ),
      )}
    </ul>
  );
}

/** List | Tree segmented control for Find-usages results. */
function UsagesViewToggle({
  view,
  onChange,
}: {
  view: UsagesView;
  onChange: (v: UsagesView) => void;
}) {
  const opts: Array<{ value: UsagesView; label: string }> = [
    { value: "list", label: "List" },
    { value: "tree", label: "Tree" },
  ];
  return (
    <div className="query-mode-control" role="radiogroup" aria-label="Usages view">
      {opts.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: button[role=radio] segmented-control idiom
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={view === o.value}
          className={view === o.value ? "active" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Results({ query, usagesView, onUsagesViewChange, onPreview }: ResultsProps) {
  if (query.status === "idle") {
    return (
      <section className="search-results">
        <div className="search-results-header">No query yet.</div>
      </section>
    );
  }
  if (query.status === "running") {
    return (
      <section className="search-results">
        <div className="search-pending">Running query…</div>
      </section>
    );
  }
  if (query.status === "err") {
    return (
      <section className="search-results">
        <div className="search-error">{query.message}</div>
      </section>
    );
  }
  if (query.status === "okFindUsages") {
    return (
      <FindUsagesResults
        query={query}
        usagesView={usagesView}
        onUsagesViewChange={onUsagesViewChange}
        onPreview={onPreview}
      />
    );
  }
  // okByName or okUnused
  const results = query.results;
  if (results.length === 0) {
    return (
      <section className="search-results">
        <div className="search-empty">
          {query.status === "okUnused" ? "No unused entities." : "No matches."}
        </div>
      </section>
    );
  }
  return (
    <section className="search-results">
      <div className="search-results-header">{results.length} result(s)</div>
      <GroupedList items={results.map((e) => ({ entity: e }))} onPreview={onPreview} />
    </section>
  );
}

/**
 * Find-usages result body — the `List | Tree` pair. Both views render the
 * SAME concept (direct references to the target); List shows them at
 * depth 1, Tree expands them along every root path. They share the
 * `(N refs)` collapse rule and the "references" header noun so toggling
 * reads as a zoom level, not a different report (D37 amendment).
 */
function FindUsagesResults({
  query,
  usagesView,
  onUsagesViewChange,
  onPreview,
}: {
  query: Extract<QueryState, { status: "okFindUsages" }>;
  usagesView: UsagesView;
  onUsagesViewChange: (v: UsagesView) => void;
  onPreview: (e: RealmIndexEntity) => void;
}) {
  if (query.refs.length === 0) {
    return (
      <section className="search-results">
        <div className="search-results-header">No usages found.</div>
      </section>
    );
  }
  // Collapse direct refs into one row per `(entity, via)` — N same-`via`
  // references from one entity become one row with `refCount: N`,
  // mirroring the Tree's leaf collapse. Defensive: drop refs whose
  // from-entity is missing.
  const rowByKey = new Map<string, UsageRow>();
  for (const r of query.refs) {
    if (r.entity === null) continue;
    const key = `${r.entity.key}|${r.ref.via}`;
    const existing = rowByKey.get(key);
    if (existing) existing.refCount += 1;
    else rowByKey.set(key, { entity: r.entity, via: r.ref.via, refCount: 1 });
  }
  const usageRows: UsageRow[] = [...rowByKey.values()];
  // `referenceCount` — the count of direct node references to the target —
  // is a property of the target itself, identical across both views, so
  // both headers LEAD with it as the shared anchor. Each header's SECOND
  // number is the one countable in that specific view: List → journey
  // rows; Tree → `★` leaves (one per path). The Tree's `N references
  // reached on M paths` states the 11→20 reconciliation in one phrase —
  // same references, more routes (D37 amendment).
  const referenceCount = usageRows.reduce((n, r) => n + r.refCount, 0);
  const journeyCount = new Set(usageRows.map((r) => r.entity.key)).size;
  const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const refLabel = plural(referenceCount, "reference");
  const headerCount =
    usagesView === "list"
      ? `${refLabel} in ${plural(journeyCount, "journey")}`
      : `${refLabel} reached on ${plural(query.paths.usageCount, "path")}`;
  return (
    <section className="search-results">
      <div className="search-results-header">{headerCount}</div>
      <UsagesViewToggle view={usagesView} onChange={onUsagesViewChange} />
      {usagesView === "list" ? (
        <GroupedList
          items={usageRows}
          viaOf={(it) => it.via}
          refCountOf={(it) => it.refCount}
          onPreview={onPreview}
        />
      ) : (
        <UsagePathTree paths={query.paths} onPreview={onPreview} />
      )}
    </section>
  );
}
