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
import { stableStringify } from "./compare";
import { remapNodeScript } from "./remap";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Canonical form for equality: drop server-managed (`_rev`/audit via stripMask),
 * identity (`_id`, matched by key), and — for node bodies — the `_type` echo
 * (node-type identity is compared via the tree skeleton, not the node body). */
function canon(raw: Record<string, unknown>, dropType: boolean): string {
  const out = stripMask(raw); // fresh shallow clone — drops _rev + audit fields
  delete out._id;
  if (dropType) delete out._type;
  return stableStringify(out);
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
): boolean {
  if (!targetTree) return false;
  const bundleTree = isRecord(bundleRaw.tree) ? bundleRaw.tree : {};
  if (canon(bundleTree, false) !== canon(targetTree, false)) return false;

  const nodes = isRecord(bundleRaw.nodes) ? bundleRaw.nodes : {};
  const innerNodes = isRecord(bundleRaw.innerNodes) ? bundleRaw.innerNodes : {};
  const bundleNodes = { ...innerNodes, ...nodes };
  for (const [nodeId, raw] of Object.entries(bundleNodes)) {
    const bundleNode = isRecord(raw) ? raw : {};
    const targetNode = targetNodesById.get(nodeId);
    if (!isRecord(targetNode)) return false; // missing on target
    if (canon(remapNodeScript(bundleNode, scriptRemap), true) !== canon(targetNode, true)) {
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
