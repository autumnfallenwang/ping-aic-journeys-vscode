/**
 * Typed message protocol between the extension host and the Transfer webview
 * (D42 / TD-6, M9 Phase 4). Direction encoded in the union name:
 *   - `W2E` — webview → extension
 *   - `E2W` — extension → webview
 *
 * Slice A is file-first + **read-only**: the webview asks the extension to
 * open a bundle file (`pickBundle`); the extension reads + parses it and posts
 * back the summarized `ParsedBundle` (`bundleLoaded`) or a friendly error
 * (`bundleError`). The Transfer page is a singleton (TD-6).
 *
 * The parse types are re-exported here so the React sandbox (`ui/*`) imports
 * only from this module — mirroring how the Search UI imports its shared
 * types from `../messages` / `../../domain`.
 */

import type { EntityKind } from "../../domain/realm-index";
import type { ComponentVerdict } from "../../import/compare";
import type { WriteResult } from "../../import/execute";
import type { DriftItem } from "../../import/freeze";
import type { JourneyAction, JourneyUnitPlan } from "../../import/journey-plan";
import type { ParsedBundle } from "../../import/parse";
import type { RequiredDepVerdict } from "../../import/preflight";

// Pure import-layer types re-exported so the React sandbox (`ui/*`) imports
// only from this module (mirrors how the Search UI imports its shared types).
export type { EntityKind } from "../../domain/realm-index";
export type { ComponentStatus, ComponentVerdict } from "../../import/compare";
export type { WriteResult, WriteStatus } from "../../import/execute";
export type { DriftItem } from "../../import/freeze";

// Journey decision model (S5) — the UI renders Create/Overwrite/Keep rows from these.
import type { CompareOptions } from "../../import/journey-compare";

export type { CompareOptions } from "../../import/journey-compare";
export type { JourneyAction, JourneyRole, JourneyUnitPlan } from "../../import/journey-plan";
// The writable-kinds set is the single source of truth for both the panel's
// write gate and the UI's Import button (re-exported here for the sandbox).
export { WRITABLE_KINDS } from "../../import/kinds";
export type { BundleKind, ComponentSummary, ParsedBundle } from "../../import/parse";
export type { RequiredDepVerdict } from "../../import/preflight";

/** A connection the user can target — carried in the embedded payload for the
 * Slice-B target dropdown. Unused in Slice A (read-only preview). */
export interface ConnectionInfo {
  host: string;
  name?: string;
  kind?: "paic" | "onprem";
}

/** Initial state injected into the page on render. */
export interface TransferPayload {
  connections: readonly ConnectionInfo[];
}

/** Which fan-out phase the pre-flight is in (PD-19). Ordered as they run;
 * `journeys` is absent for a leaf bundle. */
export type PreflightPhase = "compare" | "deps" | "journeys";

/** Human label per phase — one definition, so the panel and the UI can't drift. */
export const PREFLIGHT_PHASE_LABEL: Record<PreflightPhase, string> = {
  compare: "comparing components",
  deps: "checking dependencies",
  journeys: "reading journey nodes",
};

export type W2E =
  | { type: "ready" }
  | { type: "pickBundle" }
  | { type: "listRealms"; host: string }
  | { type: "runPreflight"; host: string; realm: string }
  /** PD-20: re-run the pre-flight for ONLY the rows whose check failed
   * (`keys` = `${kind}:${id}`). Targeted so the user's row selection and
   * compare options survive — a full re-plan can't promise that, since its
   * verdicts may legitimately differ. */
  | { type: "recheckFailed"; host: string; realm: string; keys: string[] }
  /** Compare-option toggle. Recomputed from the CACHED target reads — no AM
   * round-trip — so verdicts move live as the user ticks a box. */
  | { type: "setCompareOptions"; host: string; realm: string; options: CompareOptions }
  | {
      type: "execute";
      host: string;
      realm: string;
      /** Selected leaf row keys (`${kind}:${id}`). */
      selected: string[];
      /** Journey-bundle only — per-journey Create/Overwrite/Keep overrides
       * (`id → action`); absent journeys use their `JourneyUnitPlan.defaultAction`. */
      journeyActions?: Record<string, JourneyAction>;
    }
  // ESV apply is tenant-wide → host-scoped, not realm-scoped.
  | { type: "applyEsv"; host: string }
  // PD-17: download the last run's structured JSON report (native save dialog).
  | { type: "downloadReport" }
  // Review affordances (TD-11) — read-only inspection of an overwrite row.
  | {
      type: "openDiff";
      host: string;
      realm: string;
      bundleKey: string;
      /** The target entity's `_id` we'd overwrite (verdict.resolvedTargetId, TD-9). */
      targetScriptId: string;
      language?: string;
    }
  | {
      type: "openFindUsages";
      host: string;
      realm: string;
      targetKey: string;
      targetKind: EntityKind;
    };

export type E2W =
  | { type: "bundleLoaded"; fileName: string; bundle: ParsedBundle }
  | { type: "bundleError"; message: string }
  | { type: "realmsResult"; host: string; realms: readonly string[] }
  | { type: "realmsError"; host: string; message: string }
  | {
      type: "preflightResult";
      host: string;
      realm: string;
      verdicts: ComponentVerdict[];
      /** Discovered info-only dependency refs (libs + ESVs, TD-9) + the blocking
       * journey gates (node types / must-exist inner journeys, PD-7). */
      requires: RequiredDepVerdict[];
      /** Journey-bundle only — per-unit Create/Overwrite/Keep decisions (S5);
       * empty for leaf bundles. */
      journeyPlans: JourneyUnitPlan[];
    }
  | { type: "preflightError"; host: string; realm: string; message: string }
  /** PD-19 determinate pre-flight progress. Bounding the fan-out makes the
   * pre-flight slower BY DESIGN, so the wait needs a real progress surface
   * (mirrors PD-16's `executeProgress`). `elapsedS` is what makes a stall
   * during a transport retry read as slow rather than hung — a retry itself
   * has no channel to the UI (D46). */
  | {
      type: "preflightProgress";
      host: string;
      realm: string;
      phase: PreflightPhase;
      done: number;
      total: number;
      elapsedS: number;
    }
  /** PD-20: verdicts for the rechecked rows only. The webview MERGES these by
   * key into its existing plan — it must not replace the verdict list, or the
   * un-rechecked rows would vanish. */
  | { type: "verdictsPatched"; host: string; realm: string; verdicts: ComponentVerdict[] }
  /** Journey verdicts recomputed after a compare-option toggle. Only the journey
   * plans change — leaf verdicts, requires and the freeze snapshot are all
   * unaffected, so the webview keeps its leaf selection. */
  | { type: "journeyPlansUpdated"; host: string; realm: string; journeyPlans: JourneyUnitPlan[] }
  | {
      type: "executeResult";
      host: string;
      realm: string;
      results: WriteResult[];
      summary?: string;
    }
  // PD-16 determinate progress: one per item as each write lands (write order),
  // so the table rows flip to their outcome live, before the final result.
  | {
      type: "executeProgress";
      host: string;
      realm: string;
      result: WriteResult;
      done: number;
      total: number;
    }
  | { type: "applyProgress"; host: string; status: string; elapsedS: number }
  | { type: "applyResult"; host: string; ok: boolean; elapsedS: number; message?: string }
  // PD-11 freeze-the-plan: the target drifted between preview and Import — the
  // write is refused and the UI must re-plan (re-run pre-flight).
  | { type: "driftDetected"; host: string; realm: string; drifted: DriftItem[] };

export function isW2E(m: unknown): m is W2E {
  if (!m || typeof m !== "object") return false;
  const t = (m as { type?: unknown }).type;
  return (
    t === "ready" ||
    t === "pickBundle" ||
    t === "listRealms" ||
    t === "runPreflight" ||
    t === "recheckFailed" ||
    t === "setCompareOptions" ||
    t === "execute" ||
    t === "applyEsv" ||
    t === "downloadReport" ||
    t === "openDiff" ||
    t === "openFindUsages"
  );
}

export function isE2W(m: unknown): m is E2W {
  if (!m || typeof m !== "object") return false;
  const t = (m as { type?: unknown }).type;
  return (
    t === "bundleLoaded" ||
    t === "bundleError" ||
    t === "realmsResult" ||
    t === "realmsError" ||
    t === "preflightResult" ||
    t === "preflightError" ||
    t === "preflightProgress" ||
    t === "verdictsPatched" ||
    t === "journeyPlansUpdated" ||
    t === "executeResult" ||
    t === "executeProgress" ||
    t === "applyProgress" ||
    t === "applyResult" ||
    t === "driftDetected"
  );
}
