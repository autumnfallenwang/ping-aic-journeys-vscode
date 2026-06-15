/**
 * Import compatibility gate (D42 / TD-6, M9 Phase 4 Batch 1; journey added in
 * Batch 3). Pure. Can a component of a given `BundleKind` be written to a target
 * of a given deployment kind? On-prem is bare AM — it natively holds
 * authentication **trees (journeys)**, **scripts**, and **social IdPs**; the
 * IDM/platform leaves (theme, email template, ESV variable/secret) have no
 * endpoint there. PAIC supports all.
 *
 * B2's pre-flight reuses `compatFor` to gate its compare fetch (don't fetch a
 * target version for a component the target can't accept).
 */

import type { BundleKind } from "./parse";

export type CompatVerdict = "ok" | "unsupported";

/** Kinds an on-prem AM target can accept (AM-native): auth trees, scripts, IdPs.
 * Journeys are core AM — omitting them (the original leaf-only set) made an
 * on-prem journey import mark every tree `unsupported`; that status then
 * coerced to `exists` in the plan → the inner tree was silently Kept (never
 * written) → the outer's InnerTreeEvaluatorNode failed "Tree Name" validation. */
const ONPREM_SUPPORTED: ReadonlySet<BundleKind> = new Set<BundleKind>([
  "journey",
  "script",
  "socialIdp",
]);

export function compatFor(kind: BundleKind, targetKind: "paic" | "onprem"): CompatVerdict {
  if (targetKind === "paic") return "ok";
  return ONPREM_SUPPORTED.has(kind) ? "ok" : "unsupported";
}
