import type { ResolvedNode } from "../../../../domain/resolved-graph";
import type { NodeRef, SelectPayload, W2E } from "../../../messages";
import { ResolvedView, type ResolveState } from "./ResolvedView";

export interface ScriptCardDeps {
  libraryScripts: NodeRef[];
  esvs: NodeRef[];
}

interface Props {
  payload: Extract<SelectPayload, { kind: "script" }>;
  deps?: ScriptCardDeps | null;
  resolved: ResolveState;
  /** Card-internal hyperlink clicks (deps-list library + ESV links) go
   * through here per D24 — opens the target's card in the preview panel
   * beside; main inspector + tree stay put. */
  onPreview?: (uid: string) => void;
  onResolve: () => void;
  onRefresh: () => void;
  onPreviewResolved: (node: ResolvedNode) => void;
  onOpenBody?: (host: string, realm: string, scriptId: string, language?: string) => void;
  onFindUsages?: (d: Extract<W2E, { type: "findUsages" }>) => void;
}

export function ScriptCard({
  payload,
  deps,
  resolved,
  onPreview,
  onResolve,
  onRefresh,
  onPreviewResolved,
  onOpenBody,
  onFindUsages,
}: Props) {
  const { scriptId, host, realmName, script } = payload;
  return (
    <article className="card">
      <header>
        <span className="kind-badge">Script</span>
        <h1>{script?.name ?? scriptId}</h1>
      </header>
      <dl>
        <dt>Host</dt>
        <dd>
          <code>{host}</code>
        </dd>
        <dt>Realm</dt>
        <dd>{realmName}</dd>
        <dt>Script ID</dt>
        <dd>
          <code>{scriptId}</code>
        </dd>
        {script?.language ? (
          <>
            <dt>Language</dt>
            <dd>{script.language}</dd>
          </>
        ) : null}
        {script?.context ? (
          <>
            <dt>Context</dt>
            <dd>
              <code>{script.context}</code>
            </dd>
          </>
        ) : null}
        {script?.description ? (
          <>
            <dt>Description</dt>
            <dd>{script.description}</dd>
          </>
        ) : null}
        {script?.isDefault === undefined ? null : (
          <>
            <dt>Default (OOTB)</dt>
            <dd>{String(script.isDefault)}</dd>
          </>
        )}
        {script?.evaluatorVersion ? (
          <>
            <dt>Evaluator version</dt>
            <dd>
              <code>{script.evaluatorVersion}</code>
            </dd>
          </>
        ) : null}
        {script?.lastModifiedBy ? (
          <>
            <dt>Last modified by</dt>
            <dd>
              <code>{script.lastModifiedBy}</code>
            </dd>
          </>
        ) : null}
        {script?.lastModifiedDate === undefined ? null : (
          <>
            <dt>Last modified</dt>
            <dd>
              <code>{new Date(script.lastModifiedDate).toISOString()}</code>
            </dd>
          </>
        )}
      </dl>
      {onOpenBody || onFindUsages ? (
        <div className="card-actions">
          {onOpenBody ? (
            <button
              type="button"
              className="primary"
              onClick={() => onOpenBody(host, realmName, scriptId, script?.language)}
            >
              Open body in editor
            </button>
          ) : null}
          {onFindUsages ? (
            <button
              type="button"
              className="primary"
              onClick={() =>
                onFindUsages({
                  type: "findUsages",
                  host,
                  realm: realmName,
                  kind: "script",
                  id: scriptId,
                  displayName: script?.name ?? scriptId,
                })
              }
            >
              <i className="codicon codicon-search" aria-hidden />
              Find usages
            </button>
          ) : null}
        </div>
      ) : null}
      <ResolvedView
        directContent={<ScriptDepsBlock deps={deps ?? null} onPreview={onPreview} />}
        resolved={resolved}
        onResolve={onResolve}
        onRefresh={onRefresh}
        onPreviewResolved={onPreviewResolved}
      />
    </article>
  );
}

interface ScriptDepsProps {
  deps: ScriptCardDeps | null;
  onPreview?: (uid: string) => void;
}

/** Shared deps block — reused by `LibraryScriptCard` too. Renders the
 * library-script + ESV lists discovered by parsing the script body.
 * Uses the same divider + codicon style as Full / Flat for parity. */
export function ScriptDepsBlock({ deps, onPreview }: ScriptDepsProps) {
  if (!deps) {
    return (
      <section className="deps-loading">
        <em>Resolving script-body dependencies…</em>
      </section>
    );
  }
  if (deps.libraryScripts.length === 0 && deps.esvs.length === 0) {
    return (
      <section className="deps-empty">
        <em>No library scripts or ESVs referenced.</em>
      </section>
    );
  }
  // Split ESVs by their D22 sub-kind so the Direct view matches the
  // sidebar / Full / Flat grouping (ESV Variables, ESV Secrets, ESVs
  // (missing), and an unclassified-fallback ESVs bucket).
  const esvVariables = deps.esvs.filter((e) => e.esvKind === "variable");
  const esvSecrets = deps.esvs.filter((e) => e.esvKind === "secret");
  const esvMissing = deps.esvs.filter((e) => e.esvKind === "missing");
  const esvUnclassified = deps.esvs.filter((e) => e.esvKind === undefined);
  const sections: Array<{ label: string; icon: string; items: NodeRef[] }> = [
    { label: "Library scripts", icon: "library", items: deps.libraryScripts },
    { label: "ESV Variables", icon: "symbol-variable", items: esvVariables },
    { label: "ESV Secrets", icon: "lock", items: esvSecrets },
    { label: "ESVs (missing)", icon: "warning", items: esvMissing },
    { label: "ESVs", icon: "symbol-variable", items: esvUnclassified },
  ];
  const populated = sections.filter((s) => s.items.length > 0);
  const sortByLabel = (xs: readonly NodeRef[]) =>
    [...xs].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
  return (
    <section className="deps">
      <ul className="deps-flat">
        {populated.flatMap((s) => [
          <li key={`d:${s.label}`} className="deps-flat-divider">
            ── {s.label} ({s.items.length}) ──
          </li>,
          ...sortByLabel(s.items).map((i) => (
            <li key={i.uid} className="deps-flat-row">
              <button
                type="button"
                className="link"
                onClick={() => onPreview?.(i.uid)}
                disabled={!onPreview}
              >
                <i className={`codicon codicon-${s.icon} deps-icon`} aria-hidden />
                <span className="deps-name"> {i.label}</span>
              </button>
            </li>
          )),
        ])}
      </ul>
    </section>
  );
}
