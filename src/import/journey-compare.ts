/**
 * Journey own-scope content compare (PD-5 amendment — "existence-only" → "exists
 * + an own-scope identical/differs refinement"). Pure: no client, no vscode.
 *
 * PD-5 originally made journeys existence-only because a RAW node diff always
 * reads "differs" cross-env — but that's only true without normalization. The
 * own scope of a journey unit is exactly what the writer (`journey-write.ts`)
 * PUTs: its `tree` skeleton + its node bodies. Everything in it lines up between
 * a bundle and the target it was imported into, once we apply the SAME two
 * normalizations the write already relies on:
 *   - node UUIDs / `entryNodeId` / `connections` are written verbatim by id →
 *     they already match (no remap needed);
 *   - inner-tree refs are NAMES (stable) → already match;
 *   - the one field that legitimately differs is a `ScriptedDecisionNode.script`
 *     UUID (a script reconciles to the target's UUID, TD-9) → apply the write's
 *     own `remapNodeScript` to the bundle side before comparing;
 *   - `_rev` / audit / `evaluatorVersion` echoes → `stripMask`;
 *   - `_id` (identity, matched by key) and the server-resolved `_type` echo on a
 *     node body (node-type identity is already compared via the tree's node ref)
 *     → dropped.
 *
 * This is the journey analogue of `compare.ts`'s leaf value-compare. It does NOT
 * recurse into referenced leaf scripts/inner journeys — those are their own plan
 * rows; this judges ONLY the journey's own wiring.
 */

import { stripMask } from "../export/serialize";
import { stripEncrypted } from "../paic/encrypted";
import { dropNullValues, stableStringify } from "./compare";
import { remapNodeScript } from "./remap";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * User-selectable compare relaxations (see `poc/proposals/compare-options.md`).
 *
 * These are OPINIONS, not correctness fixes: each covers a field where reasonable
 * people could disagree about whether a difference is a difference. Everything
 * else in the compare is either structural (never optional) or a correctness
 * normalization applied unconditionally (`*-encrypted`, `null` ≡ absent).
 *
 * Default is EXACT — every option off — so nothing relaxes unless asked.
 */
export interface CompareOptions {
  /** `x`/`y` on tree node refs and on `staticNodes`. Incidental canvas state. */
  ignoreNodePositions: boolean;
  /** `displayName` on tree node refs and on PageNode page-children. Authored
   * labels. Deliberately NOT `_outcomes[*].displayName` — outcomes are
   * behavioural (scripts branch on them via `action.goTo(...)`). */
  ignoreNodeDisplayNames: boolean;
  /** `uiConfig.categories` — the journey's tags ("Tags" in the AIC console).
   * Organisational metadata, often environment-specific. */
  ignoreJourneyTags: boolean;
}

/** Every option off — today's behaviour, and the default everywhere. */
export const EXACT_COMPARE: CompareOptions = {
  ignoreNodePositions: false,
  ignoreNodeDisplayNames: false,
  ignoreJourneyTags: false,
};

/** Strip `x`/`y` (and optionally `displayName`) from one node-ref-ish record. */
function relaxNodeRef(ref: unknown, o: CompareOptions): unknown {
  if (!isRecord(ref)) return ref;
  const out = { ...ref };
  if (o.ignoreNodePositions) {
    delete out.x;
    delete out.y;
  }
  if (o.ignoreNodeDisplayNames) delete out.displayName;
  return out;
}

const mapValues = (m: Record<string, unknown>, f: (v: unknown) => unknown) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, f(v)]));

/**
 * Apply the relaxations that live on the TREE SKELETON: node-ref `x`/`y` +
 * `displayName`, `staticNodes` positions, and `uiConfig.categories`.
 * Never mutates — compare holds both sides at once.
 */
export function relaxTree(
  tree: Record<string, unknown>,
  o: CompareOptions,
): Record<string, unknown> {
  const out = { ...tree };
  if (isRecord(out.nodes)) out.nodes = mapValues(out.nodes, (n) => relaxNodeRef(n, o));
  if (o.ignoreNodePositions && isRecord(out.staticNodes)) {
    out.staticNodes = mapValues(out.staticNodes, (n) => relaxNodeRef(n, o));
  }
  if (o.ignoreJourneyTags && isRecord(out.uiConfig)) {
    const ui = { ...out.uiConfig };
    delete ui.categories;
    // Drop an emptied uiConfig entirely so `{categories:…}` and `{}` both
    // normalize to absent — otherwise the two sides stay asymmetric.
    if (Object.keys(ui).length === 0) delete out.uiConfig;
    else out.uiConfig = ui;
  }
  return out;
}

/**
 * Apply the relaxations that live on a NODE BODY. Only the PageNode
 * `nodes[]` page-children carry `displayName` here; `_outcomes[*].displayName`
 * is deliberately untouched (behavioural — see `ignoreNodeDisplayNames`).
 */
export function relaxNodeBody(
  node: Record<string, unknown>,
  o: CompareOptions,
): Record<string, unknown> {
  if (!o.ignoreNodeDisplayNames || !Array.isArray(node.nodes)) return node;
  return {
    ...node,
    nodes: node.nodes.map((child) => {
      if (!isRecord(child)) return child;
      const c = { ...child };
      delete c.displayName;
      return c;
    }),
  };
}

/** Canonical form for equality: drop server-managed (`_rev`/audit via stripMask),
 * identity (`_id`, matched by key), — for node bodies — the `_type` echo
 * (node-type identity is compared via the tree skeleton, not the node body), and
 * AM's `<field>-encrypted` companions.
 *
 * The `-encrypted` strip is what keeps a PRE-FIX bundle (exported while we still
 * passed those through) comparing Identical against a target read today, which
 * strips them in `getRawNode`. Without it the bundle side carries an extra key
 * the target side cannot have, and every affected journey reads as changed
 * forever. Note this loses no signal: the plaintext companion always reads
 * `null`, so a password difference was never detectable here to begin with. */
function canon(raw: Record<string, unknown>, dropType: boolean): string {
  const out = stripEncrypted(stripMask(raw)); // fresh clone — drops _rev + audit fields
  delete out._id;
  if (dropType) delete out._type;
  // `null` ≡ absent. Without this, a journey imported BY US never compares
  // Identical against the bundle that created it: we send `password: null`, AM
  // stores nothing and omits the key on read-back. See `dropNullValues`.
  return stableStringify(dropNullValues(out));
}

/** The decomposed bundle journey unit (`parse.ts` — `{ tree, nodes, innerNodes }`). */
export interface JourneyUnitRaw {
  tree?: unknown;
  nodes?: unknown;
  innerNodes?: unknown;
}

/**
 * Is the bundle journey unit content-identical to the target it would overwrite?
 * Compares the tree skeleton and every node body (page-children + top-level),
 * with the bundle's `script` refs remapped to their target UUIDs. `targetNodesById`
 * is keyed by node UUID (a `null`/absent entry = the node is missing on the
 * target → not identical). A null `targetTree` (journey absent) → not identical.
 */
export function journeyUnitIdentical(
  bundleRaw: JourneyUnitRaw,
  targetTree: Record<string, unknown> | null,
  targetNodesById: ReadonlyMap<string, Record<string, unknown> | null>,
  scriptRemap: ReadonlyMap<string, string>,
  // Explicit, never a module-level default: a caller must not be able to
  // silently inherit a relaxation it didn't ask for.
  options: CompareOptions = EXACT_COMPARE,
): boolean {
  if (!targetTree) return false;
  const bundleTree = isRecord(bundleRaw.tree) ? bundleRaw.tree : {};
  const rt = (t: Record<string, unknown>) => canon(relaxTree(t, options), false);
  if (rt(bundleTree) !== rt(targetTree)) return false;

  const nodes = isRecord(bundleRaw.nodes) ? bundleRaw.nodes : {};
  const innerNodes = isRecord(bundleRaw.innerNodes) ? bundleRaw.innerNodes : {};
  const bundleNodes = { ...innerNodes, ...nodes };
  const rb = (n: Record<string, unknown>) => canon(relaxNodeBody(n, options), true);
  for (const [nodeId, raw] of Object.entries(bundleNodes)) {
    const bundleNode = isRecord(raw) ? raw : {};
    const targetNode = targetNodesById.get(nodeId);
    if (!isRecord(targetNode)) return false; // missing on target
    if (rb(remapNodeScript(bundleNode, scriptRemap)) !== rb(targetNode)) {
      return false;
    }
  }
  return true;
}

/** The (nodeType, nodeId) pairs to read from the target — derived from the
 * bundle unit's own node inventory (write preserves node UUIDs, so the target
 * holds the same ids). Skips any node missing a `_type._id`. */
export function targetNodeFetchList(bundleRaw: JourneyUnitRaw): Array<[string, string]> {
  const nodes = isRecord(bundleRaw.nodes) ? bundleRaw.nodes : {};
  const innerNodes = isRecord(bundleRaw.innerNodes) ? bundleRaw.innerNodes : {};
  const out: Array<[string, string]> = [];
  for (const [nodeId, raw] of Object.entries({ ...innerNodes, ...nodes })) {
    const node = isRecord(raw) ? raw : {};
    const type = isRecord(node._type) ? node._type._id : undefined;
    if (typeof type === "string" && type) out.push([type, nodeId]);
  }
  return out;
}
