/**
 * Realm-level journey-export assembler (D46 / M9 Phase 5). Exports EVERY journey
 * in one realm into a single frodo/PAIC-UI-compatible `{ meta, trees }` bundle —
 * the same envelope a single-journey export produces, just with more trees. Pure:
 * the `PaicClient` is injected, no `vscode`.
 *
 * There is deliberately **no depth toggle** here. A realm's tree listing already
 * includes its `innerTreeOnly` trees, and `InnerTreeEvaluatorNode` refs resolve
 * within the realm, so "every journey in the realm" IS the full closure — a
 * `level1` variant would be meaningless (D46). `meta.depthMode` is stamped
 * `allLevels` and `meta.scope` `realm` as informational provenance only; the
 * import derives everything from tree content (PD-18).
 */

import type { Connection } from "../domain/types";
import type { PaicClient } from "../paic/client";
import type { Logger } from "../util/logger";
import { assembleTree, type JourneyBundle, makeExportCache } from "./journey-bundle";
import { buildExportMeta } from "./meta";
import type { ExportMeta } from "./serialize";

/** Per-tree progress, so the command can drive a determinate notification. */
export type RealmExportProgress = (done: number, total: number, treeId: string) => void;

/**
 * Build the whole-realm journey bundle. Returns `null` when the realm has no
 * journeys at all (the caller surfaces a friendly message rather than writing an
 * empty file).
 *
 * Trees are assembled **sequentially and no limiter is introduced**: each tree's
 * internal `mapConcurrent(…, CONCURRENCY)` then runs on its own, so total
 * in-flight stays at that cap and per-tree pools never coexist (the thing the
 * D46 note warns about). Running trees concurrently would multiply those pools,
 * and threading a shared limiter through `assembleTree`'s nested fan-out would
 * reintroduce the deadlock class fixed in `preflight.ts`. Sequential also makes
 * the per-tree progress below exact.
 *
 * One `ExportFetchCache` spans the whole realm, so a library shared by N trees is
 * fetched once — while every tree still carries its own COPY of that leaf in the
 * output (deliberate frodo/PAIC-UI interop; see `journey-bundle.ts`).
 */
export async function buildRealmBundle(
  client: PaicClient,
  conn: Connection,
  realm: string,
  extensionVersion: string,
  nowIso: string,
  log: Logger,
  onProgress?: RealmExportProgress,
): Promise<JourneyBundle | null> {
  const listed = await client.listTrees(realm);
  if (listed.length === 0) {
    log.info(
      { event: "exportRealmJourneys.empty", realm, count: 0 },
      "Realm has no journeys; nothing to export",
    );
    return null;
  }

  const cache = makeExportCache();
  const trees: JourneyBundle["trees"] = {};
  let done = 0;
  for (const t of listed) {
    const assembled = await assembleTree(client, log, realm, t._id, cache);
    // A tree that vanished between the listing and the fetch is simply skipped —
    // `assembleTree` already logged the miss. Never fail the whole export for one.
    if (assembled) trees[t._id] = assembled.tree;
    done += 1;
    onProgress?.(done, listed.length, t._id);
  }

  if (Object.keys(trees).length === 0) return null;

  const meta: ExportMeta = {
    ...buildExportMeta(conn, realm, extensionVersion, nowIso),
    depthMode: "allLevels",
    scope: "realm",
  };
  log.info(
    {
      event: "exportRealmJourneys.built",
      realm,
      listed: listed.length,
      bundled: Object.keys(trees).length,
    },
    "Built realm journey bundle",
  );
  return { meta, trees };
}
