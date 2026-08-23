/**
 * Import pre-flight (D42 / TD-6, M9 Phase 4 Batch 1 Slice B2). For each bundle
 * component, fetch the target's current version by identity and classify it.
 * Compat gates the fetch (don't REST-call a target that can't accept the kind).
 * The client is injected → unit-testable. Read-only.
 */

import type { PaicClient } from "../paic/client";
import { PaicError } from "../paic/errors";
import { type ComponentVerdict, classifyCompare } from "./compare";
import { compatFor } from "./compat";
import { type DiscoveredRef, discoverJourneyRefs } from "./discover";
import {
  type CompareOptions,
  EXACT_COMPARE,
  journeyUnitIdentical,
  targetNodeFetchList,
} from "./journey-compare";
import type { ImportComponent } from "./parse";
import { buildScriptRemap } from "./remap";

/** The subset of `PaicClient` the pre-flight reads. */
export type PreflightClient = Pick<
  PaicClient,
  | "getRawTheme"
  | "getRawEmailTemplate"
  | "getRawSocialIdp"
  | "getRawScript"
  | "getRawScriptByName"
  | "findRawScriptsByName"
  | "getRawEsv"
  | "listVariables"
  | "listSecrets"
  | "getNodeTypes"
  | "listTrees"
  | "getRawJourney"
  | "getRawNode"
>;

/** Existence verdict for a discovered (info-only) dependency ref — TD-9. The
 * bundle carries no body/value for these, so they're never written; the Plan
 * shows them as "what this script needs on the target". */
export interface RequiredDepVerdict {
  kind: "script" | "esv" | "nodeType" | "innerJourney";
  name: string;
  status: "present" | "missing";
  /** `blocking` — a HARD prerequisite the bundle can't supply (a missing node type
   * or a level1 inner journey): missing → disables Import (S8). `advisory` (the
   * default when absent) — a `require('lib')` / ESV ref: missing only warns. */
  severity?: "blocking" | "advisory";
  /** e.g. "variable" / "secret" for an ESV, or "2 on target" for a dup-name. */
  detail?: string;
}

const asRecord = (o: unknown): Record<string, unknown> | null =>
  o && typeof o === "object" ? (o as Record<string, unknown>) : null;

/** A fetched target version + (scripts only) the cross-env reconcile metadata:
 * the resolved target `_id` to write to and how many same-named hits there were. */
interface TargetFetch {
  raw: Record<string, unknown> | null;
  resolvedTargetId?: string;
  targetMatchCount?: number;
}

/** Fetch the target's current version of one component by identity; `raw` is
 * null when absent (→ "new"). Scripts resolve by NAME (their cross-env identity,
 * TD-9) and also report the matched target's `_id` + same-name count. */
async function fetchTarget(
  client: PreflightClient,
  realm: string,
  comp: ImportComponent,
): Promise<TargetFetch> {
  switch (comp.kind) {
    case "theme":
      return { raw: asRecord(await client.getRawTheme(realm, comp.id)) };
    case "emailTemplate":
      return {
        raw: asRecord(await client.getRawEmailTemplate(comp.id.replace(/^emailTemplate\//, ""))),
      };
    case "socialIdp": {
      // Look up by the raw object's `_id` — `getRawSocialIdp` filters on `_id`,
      // which can differ from the display name.
      const idpId = typeof comp.raw._id === "string" ? comp.raw._id : comp.id;
      return { raw: asRecord(await client.getRawSocialIdp(realm, idpId)) };
    }
    case "script": {
      const name = typeof comp.raw.name === "string" ? comp.raw.name : "";
      if (!name) return { raw: null };
      // Name is the cross-env identity; AM allows dup names so collect all hits.
      const hits = await client.findRawScriptsByName(realm, name);
      const first = hits[0];
      return {
        raw: asRecord(first ?? null),
        resolvedTargetId: typeof first?._id === "string" ? first._id : undefined,
        targetMatchCount: hits.length,
      };
    }
    case "variable":
    case "secret": {
      // `getRawEsv` discovers the kind by which endpoint resolves — only a
      // matching kind counts as the same entity.
      const r = await client.getRawEsv(comp.id);
      return { raw: r && r.kind === comp.kind ? asRecord(r.raw) : null };
    }
    case "journey":
      // Existence-only (PD-5): the tree's presence on the target decides
      // Create vs Overwrite/Keep. `getRawJourney` throws on 404, so catch it →
      // null (= "new"); any other error propagates to `verdictFor`'s catch.
      try {
        return { raw: asRecord(await client.getRawJourney(realm, comp.id)) };
      } catch (err) {
        if (err instanceof PaicError && err.status === 404) return { raw: null };
        throw err;
      }
  }
}

async function verdictFor(
  client: PreflightClient,
  realm: string,
  targetKind: "paic" | "onprem",
  comp: ImportComponent,
): Promise<ComponentVerdict> {
  const base = { kind: comp.kind, id: comp.id, displayName: comp.displayName };
  if (compatFor(comp.kind, targetKind) === "unsupported") {
    return { ...base, status: "unsupported" };
  }
  try {
    const { raw, resolvedTargetId, targetMatchCount } = await fetchTarget(client, realm, comp);
    const status = classifyCompare(comp.kind, comp.raw, raw);
    // Script create path (no name match → `new`): the write would fall back to
    // the bundle UUID, but that UUID may already be held by a DIFFERENTLY-NAMED
    // script (rename-after-copy). AM's PUT-by-id would silently overwrite it, so
    // guard here and block instead (TD-9). Name match (resolvedTargetId set) is
    // already handled by reconciliation — only check on a true create.
    if (comp.kind === "script" && status === "new") {
      const collision = await scriptIdCollision(client, realm, comp);
      if (collision) {
        return { ...base, status: "id-collision", message: collision };
      }
    }
    return {
      ...base,
      status,
      ...(resolvedTargetId ? { resolvedTargetId } : {}),
      ...(targetMatchCount === undefined ? {} : { targetMatchCount }),
    };
  } catch (err) {
    return { ...base, status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** On a script create, is the bundle UUID already occupied on the target by a
 * differently-named script? Returns a human message naming the occupant, or
 * null when the UUID is free (404) — the safe-to-create case. */
async function scriptIdCollision(
  client: PreflightClient,
  realm: string,
  comp: ImportComponent,
): Promise<string | null> {
  const bundleId = typeof comp.raw._id === "string" ? comp.raw._id : comp.id;
  if (!bundleId) return null;
  let existing: Record<string, unknown> | null;
  try {
    existing = asRecord(await client.getRawScript(realm, bundleId));
  } catch {
    return null; // 404 (or any fetch failure) → treat the UUID as free
  }
  if (!existing) return null;
  const occupantName = typeof existing.name === "string" ? existing.name : "(unnamed)";
  return `UUID ${bundleId} is already used by a different script "${occupantName}" on the target`;
}

/**
 * Progress reporter for a fan-out phase (PD-19). Invoked once per completed
 * unit of work, with the running done-count. Optional everywhere: the pure
 * layer never requires a UI.
 */
export type PreflightProgress = (done: number) => void;

/** Run the read-only pre-flight for every component. Each runs independently
 * (one fetch failure → that component's `error`, not a blank plan).
 *
 * Concurrency is the CLIENT's concern, not ours — pass a `limitClient`-wrapped
 * client to bound the fan-out (PD-19). Bounding here instead would deadlock the
 * nested read in `readJourneyCompareInputs`; see `limited-client.ts`. */
export function runPreflight(
  client: PreflightClient,
  realm: string,
  targetKind: "paic" | "onprem",
  rawComponents: readonly ImportComponent[],
  onProgress?: PreflightProgress,
): Promise<ComponentVerdict[]> {
  let done = 0;
  return Promise.all(
    rawComponents.map((c) =>
      verdictFor(client, realm, targetKind, c).then((v) => {
        onProgress?.(++done);
        return v;
      }),
    ),
  );
}

/**
 * PD-5 amendment: refine which already-present journeys are content-IDENTICAL to
 * the bundle (own-scope: tree + node bodies, script-remapped). Reads each
 * existing journey's tree + the node bodies it would write (same UUIDs) and
 * compares via the pure `journeyUnitIdentical`. Returns the set of identical tree
 * names; callers map those to the `identical` verdict (a locked no-op row).
 *
 * Kept SEPARATE from `runPreflight` (which stays existence-only) so the freeze
 * snapshot + drift check keep keying journeys on raw `new`/`exists` — the
 * refinement is a display concern, never a drift signal (a journey at preview
 * `identical` and at commit `exists` must NOT read as drift).
 */
/**
 * Everything read from the target for one journey's own-scope compare. Cached by
 * the panel so a compare-option toggle can recompute LOCALLY — the fetch does
 * not change when the options do, and `journeyUnitIdentical` is pure. Without
 * this, every toggle would be a fresh round-trip to AM and the live-update UI
 * would collapse into a Refresh button.
 */
export interface JourneyCompareInput {
  id: string;
  bundleRaw: Record<string, unknown>;
  targetTree: Record<string, unknown>;
  targetNodesById: Map<string, Record<string, unknown> | null>;
}

/** The cached target reads plus the script remap they were resolved against. */
export interface JourneyCompareCache {
  inputs: JourneyCompareInput[];
  scriptRemap: ReadonlyMap<string, string>;
}

/**
 * Read (once) everything the own-scope journey compare needs from the target.
 * Journeys whose read fails are simply omitted — a missing input can never
 * produce a false `identical`, so the row stays a Keep/Overwrite.
 */
export async function readJourneyCompareInputs(
  client: PreflightClient,
  realm: string,
  rawComponents: readonly ImportComponent[],
  verdicts: readonly ComponentVerdict[],
  onProgress?: PreflightProgress,
): Promise<JourneyCompareCache> {
  const scriptRemap = buildScriptRemap(verdicts.filter((v) => v.kind === "script"));
  const existing = verdicts.filter((v) => v.kind === "journey" && v.status === "exists");
  const inputs: JourneyCompareInput[] = [];
  let done = 0;
  const tick = () => onProgress?.(++done);
  await Promise.all(
    existing.map(async (v) => {
      const comp = rawComponents.find((c) => c.kind === "journey" && c.id === v.id);
      if (!comp) return;
      try {
        const targetTree = asRecord(await client.getRawJourney(realm, v.id));
        tick();
        if (!targetTree) return; // unreadable → omit → stays Keep/Overwrite
        const targetNodesById = new Map<string, Record<string, unknown> | null>();
        await Promise.all(
          targetNodeFetchList(comp.raw).map(async ([nodeType, nodeId]) => {
            try {
              targetNodesById.set(
                nodeId,
                asRecord(await client.getRawNode(realm, nodeType, nodeId)),
              );
            } catch {
              targetNodesById.set(nodeId, null); // 404 / fetch failure → node absent
            } finally {
              tick();
            }
          }),
        );
        inputs.push({ id: v.id, bundleRaw: comp.raw, targetTree, targetNodesById });
      } catch {
        // Any read failure → omitted → stays `exists` (Keep/Overwrite).
        tick();
      }
    }),
  );
  return { inputs, scriptRemap };
}

/**
 * How many reads `readJourneyCompareInputs` will issue for these verdicts — the
 * determinate total for its progress bar. Pure (mirrors the function's own
 * traversal: one tree read per existing journey, plus one per node body).
 *
 * Counts the OPTIMISTIC path: a journey whose tree read fails skips its node
 * reads, so the real count can come in under this. Progress therefore only ever
 * finishes early, never overruns.
 */
export function journeyCompareReadCount(
  rawComponents: readonly ImportComponent[],
  verdicts: readonly ComponentVerdict[],
): number {
  let total = 0;
  for (const v of verdicts) {
    if (v.kind !== "journey" || v.status !== "exists") continue;
    const comp = rawComponents.find((c) => c.kind === "journey" && c.id === v.id);
    if (!comp) continue;
    total += 1 + targetNodeFetchList(comp.raw).length;
  }
  return total;
}

/** Pure: which cached journeys are own-scope identical under `options`. Cheap —
 * safe to re-run on every compare-option toggle. */
export function computeIdenticalJourneys(
  cache: JourneyCompareCache,
  options: CompareOptions = EXACT_COMPARE,
): Set<string> {
  const identical = new Set<string>();
  for (const i of cache.inputs) {
    if (
      journeyUnitIdentical(i.bundleRaw, i.targetTree, i.targetNodesById, cache.scriptRemap, options)
    ) {
      identical.add(i.id);
    }
  }
  return identical;
}

/**
 * PD-5 amendment: refine which already-present journeys are content-IDENTICAL to
 * the bundle (own-scope: tree + node bodies, script-remapped). Convenience
 * read-then-compute wrapper; the panel uses the two halves separately so it can
 * recompute on an option toggle without re-reading the target.
 *
 * Kept SEPARATE from `runPreflight` (which stays existence-only) so the freeze
 * snapshot + drift check keep keying journeys on raw `new`/`exists` — the
 * refinement is a display concern, never a drift signal (a journey at preview
 * `identical` and at commit `exists` must NOT read as drift).
 */
export async function findIdenticalJourneys(
  client: PreflightClient,
  realm: string,
  rawComponents: readonly ImportComponent[],
  verdicts: readonly ComponentVerdict[],
  options: CompareOptions = EXACT_COMPARE,
): Promise<Set<string>> {
  const cache = await readJourneyCompareInputs(client, realm, rawComponents, verdicts);
  return computeIdenticalJourneys(cache, options);
}

/**
 * Existence-check the discovered (info-only) dependency refs against the target
 * — TD-9. Library refs resolve by name; ESV refs match against the tenant's
 * variable + secret lists fetched ONCE (mirrors `walk.ts:ensureEsvIndex`, never
 * per-ref). Read-only; a fetch failure for one ref yields `missing`, not a throw.
 */
export async function discoverDeps(
  client: PreflightClient,
  realm: string,
  refs: readonly DiscoveredRef[],
): Promise<RequiredDepVerdict[]> {
  if (refs.length === 0) return [];

  // Build the dotted-name → kind ESV index once, only if any ESV ref exists.
  let esvIndex: Map<string, "variable" | "secret"> | null = null;
  const needEsv = refs.some((r) => r.kind === "esv");
  if (needEsv) {
    esvIndex = new Map();
    const [vars, secrets] = await Promise.all([
      client.listVariables(realm).catch(() => []),
      client.listSecrets(realm).catch(() => []),
    ]);
    for (const v of vars) esvIndex.set(v.name, "variable");
    for (const s of secrets) esvIndex.set(s.name, "secret");
  }

  const verdicts = await Promise.all(
    refs.map(async (ref): Promise<RequiredDepVerdict> => {
      if (ref.kind === "esv") {
        const k = esvIndex?.get(ref.name);
        return k
          ? { kind: "esv", name: ref.name, status: "present", detail: k }
          : { kind: "esv", name: ref.name, status: "missing" };
      }
      // Library reference — existence by name (the cross-env identity, TD-9).
      try {
        const hits = await client.findRawScriptsByName(realm, ref.name);
        if (hits.length === 0) return { kind: "script", name: ref.name, status: "missing" };
        return {
          kind: "script",
          name: ref.name,
          status: "present",
          ...(hits.length > 1 ? { detail: `${hits.length} on target` } : {}),
        };
      } catch {
        return { kind: "script", name: ref.name, status: "missing" };
      }
    }),
  );
  // lib / ESV refs are advisory — the bundle can't supply them; a missing one only warns.
  return verdicts.map((v) => ({ ...v, severity: "advisory" as const }));
}

/**
 * The HARD journey-import prerequisites the bundle can't supply (PD-7), checked
 * against the target: every node **type** the journeys use must be installed
 * (`getNodeTypes` catalog — TD-14), and every inner journey referenced but not
 * bundled must already exist (`listTrees` — TD-12). Both are `severity:"blocking"`.
 * A leaf bundle (no journey units) yields `[]`. Each catalog read is isolated: a
 * fetch failure skips that gate's verdicts rather than blocking spuriously (the
 * write would surface the real cause via `PaicError`). Read-only.
 */
export async function checkJourneyGates(
  client: PreflightClient,
  realm: string,
  rawComponents: readonly ImportComponent[],
): Promise<RequiredDepVerdict[]> {
  const { nodeTypes, innerJourneys } = discoverJourneyRefs(rawComponents);
  if (nodeTypes.length === 0 && innerJourneys.length === 0) return [];
  const out: RequiredDepVerdict[] = [];

  if (nodeTypes.length > 0) {
    const catalog = await client
      .getNodeTypes(realm)
      .then((types) => new Set(types))
      .catch(() => null);
    if (catalog) {
      for (const name of nodeTypes) {
        out.push({
          kind: "nodeType",
          name,
          status: catalog.has(name) ? "present" : "missing",
          severity: "blocking",
        });
      }
    }
  }

  if (innerJourneys.length > 0) {
    const present = await client
      .listTrees(realm)
      .then((trees) => new Set(trees.map((t) => t._id)))
      .catch(() => null);
    if (present) {
      for (const name of innerJourneys) {
        out.push({
          kind: "innerJourney",
          name,
          status: present.has(name) ? "present" : "missing",
          severity: "blocking",
        });
      }
    }
  }

  return out;
}
