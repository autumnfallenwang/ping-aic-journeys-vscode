/**
 * D36 — pure query functions over a `RealmIndexEntry`. Slice 2 calls these
 * from the Search page's panel; Slice 1 keeps them isolated and tested in
 * isolation.
 *
 * No I/O, no async. The Search page renders results directly from the
 * shapes returned here.
 */

import type {
  EntityKind,
  RealmIndexEntity,
  RealmIndexEntry,
  ReverseRef,
  UsagePathNode,
  UsagePaths,
} from "../domain/realm-index";

/** Return the inbound references targeting `targetKey`. Empty array when the
 * target is unknown or simply has no incoming refs (i.e. an orphan). */
export function findUsages(entry: RealmIndexEntry, targetKey: string): ReverseRef[] {
  return entry.inboundRefs[targetKey] ?? [];
}

/** Substring match (case-insensitive, locale-aware) against entity
 * `displayName`. `kinds` defaults to all kinds. Results sorted by
 * `displayName` for stable UI. Empty `pattern` returns `[]` — Search input
 * placeholder behaves as a no-op until the user actually types. */
export function searchByName(
  entry: RealmIndexEntry,
  pattern: string,
  kinds?: readonly EntityKind[],
): RealmIndexEntity[] {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return [];
  const needle = trimmed.toLocaleLowerCase();
  const kindFilter = kinds && kinds.length > 0 ? new Set(kinds) : null;

  const out: RealmIndexEntity[] = [];
  for (const e of Object.values(entry.entities)) {
    if (kindFilter && !kindFilter.has(e.kind)) continue;
    if (!e.displayName.toLocaleLowerCase().includes(needle)) continue;
    out.push(e);
  }
  out.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );
  return out;
}

/** Entities with zero inbound references. `kinds` defaults to every kind
 * EXCEPT `journey` — journeys are entry points (a user starts journeys
 * directly) and treating them as "unused" would yield a degenerate result.
 * When the caller passes an explicit `kinds` list that includes `journey`,
 * we honor it (an advanced caller may want raw orphan-set output).
 *
 * Results sorted by `displayName` for stable UI. */
export function findUnused(
  entry: RealmIndexEntry,
  kinds?: readonly EntityKind[],
): RealmIndexEntity[] {
  const kindFilter =
    kinds && kinds.length > 0
      ? new Set(kinds)
      : new Set<EntityKind>(["script", "esv", "theme", "emailTemplate", "socialIdp"]);

  const out: RealmIndexEntity[] = [];
  for (const e of Object.values(entry.entities)) {
    if (!kindFilter.has(e.kind)) continue;
    const refs = entry.inboundRefs[e.key];
    if (refs && refs.length > 0) continue;
    out.push(e);
  }
  out.sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" }),
  );
  return out;
}

function cmpEntityName(a: RealmIndexEntity, b: RealmIndexEntity): number {
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" });
}

/**
 * Build the slice of the realm's forward dependency graph that connects a
 * journey (or orphan) root down to `targetKey` — every path that reaches
 * the searched entity, with everything else pruned away. The target is
 * the leaf of every branch.
 *
 * Pure — derived entirely from `entry.inboundRefs` (the inverted edge
 * map). No I/O.
 *
 * 1. Reverse-reachability BFS from the target → `relevant`: every entity
 *    that transitively reaches it.
 * 2. Forward adjacency restricted to `relevant` (every such edge provably
 *    leads to the target, so there are no dead branches to prune).
 *    Sibling edges sharing `(toKey, via)` collapse into one entry with a
 *    `count` — same target referenced by N same-type nodes (D37 amend.).
 * 3. Roots = relevant entities with no relevant parent. Non-journey roots
 *    are flagged `orphanRoot` (the target is kept alive only by dead
 *    code).
 * 4. Forward DFS render in display order, with a PER-PATH visited set
 *    (the current root-to-node chain). Each root renders as its own
 *    complete part-tree; a subtree shared by several paths is drawn in
 *    full on each. A collapsed edge becomes one node with `refCount: N`.
 *    `dup` collapses ONLY a true cycle — a node already on the current
 *    path. Every non-cycle branch ends at the target (D37).
 * 5. `usageCount` = distinct simple paths from a JOURNEY root down to the
 *    target, counting a `refCount: N` edge as N paths. Cycle-closed
 *    branches and orphan-root paths don't count.
 */
export function findUsagePaths(entry: RealmIndexEntry, targetKey: string): UsagePaths {
  if (!entry.entities[targetKey]) return { targetKey, roots: [], usageCount: 0 };

  // 1) Reverse-reachability.
  const relevant = new Set<string>([targetKey]);
  const queue: string[] = [targetKey];
  while (queue.length > 0) {
    const k = queue.shift() as string;
    for (const ref of entry.inboundRefs[k] ?? []) {
      if (relevant.has(ref.fromKey)) continue;
      if (!entry.entities[ref.fromKey]) continue; // defensive — unrenderable
      relevant.add(ref.fromKey);
      queue.push(ref.fromKey);
    }
  }

  // 2) Forward adjacency over the relevant sub-DAG (with sibling collapse).
  const { forward, hasRelevantParent } = buildForwardAdjacency(entry, relevant);

  // 3) Roots — relevant entities with no relevant parent — in display order.
  const rootKeys = [...relevant]
    .filter((k) => !hasRelevantParent.has(k))
    .sort((a, b) => cmpEntityName(entry.entities[a], entry.entities[b]));

  // 4) Forward DFS per root. `counter` accumulates `usageCount` across the
  //    whole walk.
  const counter = { usageCount: 0 };
  const roots: UsagePathNode[] = [];
  for (const rk of rootKeys) {
    const rootIsJourney = entry.entities[rk]?.kind === "journey";
    // Roots carry no parent edge: no `via`, refCount 1, multiplier 1.
    const node = buildUsageNode(
      { entry, targetKey, forward, rootIsJourney, counter },
      rk,
      undefined,
      1,
      1,
      new Set(),
    );
    if (!node) continue;
    if (!rootIsJourney) node.orphanRoot = true;
    roots.push(node);
  }
  return { targetKey, roots, usageCount: counter.usageCount };
}

/** One collapsed forward edge: `count` is how many same-`(toKey, via)`
 * sibling edges merged (D37 amendment). */
interface FwdEdge {
  toKey: string;
  via: string;
  count: number;
}

/**
 * Forward adjacency over the relevant sub-DAG. Sibling edges from the same
 * parent sharing `(toKey, via)` — the same target referenced by N
 * same-type journey nodes — collapse into one `FwdEdge` with `count: N`
 * (D37 amendment). Different `via` values stay separate (a different
 * relationship). `hasRelevantParent` is every node with an incoming
 * relevant edge — its complement is the root set.
 */
function buildForwardAdjacency(
  entry: RealmIndexEntry,
  relevant: ReadonlySet<string>,
): { forward: Map<string, FwdEdge[]>; hasRelevantParent: Set<string> } {
  const forward = new Map<string, FwdEdge[]>();
  const hasRelevantParent = new Set<string>();
  for (const toKey of relevant) {
    for (const ref of entry.inboundRefs[toKey] ?? []) {
      if (!relevant.has(ref.fromKey)) continue;
      const list = forward.get(ref.fromKey) ?? [];
      const existing = list.find((e) => e.toKey === toKey && e.via === ref.via);
      if (existing) existing.count += 1;
      else list.push({ toKey, via: ref.via, count: 1 });
      forward.set(ref.fromKey, list);
      hasRelevantParent.add(toKey);
    }
  }
  return { forward, hasRelevantParent };
}

/** Shared, walk-invariant context for the DFS — passed once, unchanged
 * down the recursion (only the per-node args + `onPath` vary). */
interface UsageWalkCtx {
  entry: RealmIndexEntry;
  targetKey: string;
  forward: Map<string, FwdEdge[]>;
  rootIsJourney: boolean;
  counter: { usageCount: number };
}

/**
 * Forward DFS building one `UsagePathNode` subtree. `onPath` is the
 * PER-PATH visited set (the current root-to-node chain) — a subtree shared
 * by several paths renders in full on each; `dup` collapses ONLY a node
 * already on this path (a true cycle), keeping the walk finite.
 *
 * `mult` is the product of the `refCount`s on the edges walked so far: a
 * parent reached the target via M same-type nodes means M distinct paths
 * converge here. `counter.usageCount` gains `mult` each time a non-cycle
 * branch reaches the target — so three nodes hitting the target on one
 * path count as three paths, shown as one badged leaf.
 */
function buildUsageNode(
  ctx: UsageWalkCtx,
  key: string,
  via: string | undefined,
  refCount: number,
  mult: number,
  onPath: ReadonlySet<string>,
): UsagePathNode | null {
  const entity = ctx.entry.entities[key];
  if (!entity) return null;
  const node: UsagePathNode = {
    key,
    entity,
    ...(via ? { via } : {}),
    ...(refCount > 1 ? { refCount } : {}),
    children: [],
  };
  if (onPath.has(key)) {
    // Cycle — the entity is already on the path back to the root.
    node.dup = true;
    return node;
  }
  if (key === ctx.targetKey && ctx.rootIsJourney) ctx.counter.usageCount += mult;
  const nextPath = new Set(onPath).add(key);
  const edges = [...(ctx.forward.get(key) ?? [])].sort((a, b) =>
    cmpEntityName(ctx.entry.entities[a.toKey], ctx.entry.entities[b.toKey]),
  );
  for (const edge of edges) {
    const child = buildUsageNode(
      ctx,
      edge.toKey,
      edge.via,
      edge.count,
      mult * edge.count,
      nextPath,
    );
    if (child) node.children.push(child);
  }
  return node;
}
