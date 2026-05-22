import type { RealmIndexEntity, UsagePathNode, UsagePaths } from "../../../domain/realm-index";
import { DISPLAY_KIND_ICON, displayKindOf } from "./grouping";

interface Props {
  paths: UsagePaths;
  onPreview: (entity: RealmIndexEntity) => void;
}

/** Renders a `findUsagePaths` result — the pruned slice of the realm's
 * dependency graph from each journey (or orphan) root down to the
 * searched entity, which is the leaf of every branch. */
export function UsagePathTree({ paths, onPreview }: Props) {
  if (paths.roots.length === 0) {
    return <div className="search-empty">No paths reach this entity.</div>;
  }
  return (
    <ul className="search-tree">
      {paths.roots.map((root) => (
        // Root keys are distinct entities — no index disambiguation needed.
        <TreeNode key={root.key} node={root} targetKey={paths.targetKey} onPreview={onPreview} />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  targetKey,
  onPreview,
}: {
  node: UsagePathNode;
  targetKey: string;
  onPreview: (entity: RealmIndexEntity) => void;
}) {
  const icon = DISPLAY_KIND_ICON[displayKindOf(node.entity)];
  // `via` (how a parent references a child) is shown only on the target
  // leaf — that's the one piece of real signal. Intermediate hops just
  // mark "the path passes through here" (D37).
  const isTarget = node.key === targetKey;
  return (
    <li>
      <div className="search-tree-row">
        <i className={`codicon codicon-${icon}`} aria-hidden />
        <button type="button" className="link" onClick={() => onPreview(node.entity)}>
          {node.entity.displayName}
        </button>
        {node.refCount && node.refCount > 1 ? (
          // One node, N parent edges of the same `via` — same target
          // referenced by N same-type nodes (D37 amendment).
          <span className="search-tree-refcount">({node.refCount} refs)</span>
        ) : null}
        {node.dup ? <span className="search-tree-dup">(cycle)</span> : null}
        {node.orphanRoot ? (
          <span className="search-tree-orphan">⚠ no journey reaches this</span>
        ) : null}
        {node.via && isTarget ? <span className="search-tree-via">via {node.via}</span> : null}
      </div>
      {node.children.length > 0 ? (
        <ul>
          {node.children.map((child, i) => (
            <TreeNode
              // biome-ignore lint/suspicious/noArrayIndexKey: sibling keys can repeat (same entity via two `via`s); the index disambiguates, the list is render-stable
              key={`${child.key}#${i}`}
              node={child}
              targetKey={targetKey}
              onPreview={onPreview}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
