import type { ResolvedNode } from "../../../../domain/resolved-graph";
import type { SelectPayload, W2E } from "../../../messages";
import { JourneyDiagram } from "../diagram/JourneyDiagram";
import { DepsBlock, type JourneyCardDeps, JourneyFlags } from "./JourneyCard";
import { ResolvedView, type ResolveState } from "./ResolvedView";

interface Props {
  payload: Extract<SelectPayload, { kind: "innerJourney" }>;
  deps: JourneyCardDeps | null;
  resolved: ResolveState;
  onPreview: (uid: string) => void;
  onResolve: () => void;
  onRefresh: () => void;
  onPreviewResolved: (node: ResolvedNode) => void;
  onFindUsages?: (d: Extract<W2E, { type: "findUsages" }>) => void;
}

export function InnerJourneyCard({
  payload,
  deps,
  resolved,
  onPreview,
  onResolve,
  onRefresh,
  onPreviewResolved,
  onFindUsages,
}: Props) {
  const { journey, realmName, host, visited } = payload;
  const nodeCount = Object.keys(journey.nodes).length;
  return (
    <article className="card">
      <header>
        <span className="kind-badge">Inner journey</span>
        <h1>{journey.id}</h1>
      </header>
      <dl>
        <dt>Host</dt>
        <dd>
          <code>{host}</code>
        </dd>
        <dt>Realm</dt>
        <dd>{realmName}</dd>
        <dt>Status</dt>
        <dd>{journey.enabled ? "Enabled" : "Disabled"}</dd>
        {journey.description ? (
          <>
            <dt>Description</dt>
            <dd>{journey.description}</dd>
          </>
        ) : null}
        {journey.identityResource ? (
          <>
            <dt>Identity Resource</dt>
            <dd>
              <code>{journey.identityResource}</code>
            </dd>
          </>
        ) : null}
        <dt>Entry node</dt>
        <dd>
          <code>{journey.entryNodeId}</code>
        </dd>
        <dt>Node count</dt>
        <dd>{nodeCount}</dd>
        <JourneyFlags journey={journey} />
        {visited.length > 0 ? (
          <>
            <dt>Ancestor chain</dt>
            <dd>{visited.join(" → ")}</dd>
          </>
        ) : null}
      </dl>
      {onFindUsages ? (
        <div className="card-actions">
          <button
            type="button"
            className="primary"
            onClick={() =>
              onFindUsages({
                type: "findUsages",
                host,
                realm: realmName,
                kind: "journey",
                id: journey.id,
                displayName: journey.id,
              })
            }
          >
            <i className="codicon codicon-search" aria-hidden />
            Find usages
          </button>
        </div>
      ) : null}
      {deps?.nodeIndex && nodeCount > 0 ? (
        <JourneyDiagram journey={journey} nodeIndex={deps.nodeIndex} onPreview={onPreview} />
      ) : null}
      <ResolvedView
        directContent={<DepsBlock deps={deps} onPreview={onPreview} />}
        resolved={resolved}
        onResolve={onResolve}
        onRefresh={onRefresh}
        onPreviewResolved={onPreviewResolved}
      />
    </article>
  );
}
