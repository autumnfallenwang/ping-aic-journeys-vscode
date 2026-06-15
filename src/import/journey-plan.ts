/**
 * Inner-journey unit decision model for journey import (PD-3/4/5/6, model §3).
 * Pure: no client, no vscode.
 *
 * Every bundled tree is a flat unit (PD-4). Its decision is `Create / Overwrite
 * / Keep` (PD-5), driven by two facts:
 *   - **role** — `subject` (a root the user is importing) vs `inner` (referenced
 *     by some `InnerTreeEvaluatorNode.tree` of another bundled tree). Derived
 *     structurally from the bundle, never from meta (PD-18).
 *   - **verdict** — `new` (target lacks the tree) vs `exists` (target has it),
 *     from the pre-flight (`runPreflight` → existence-only, PD-5).
 *
 * Decision matrix:
 *   subject + new    → Create   (only action; you're importing it)
 *   subject + exists → Overwrite(only action; Keep = import nothing)
 *   inner   + new    → Create   (only action; caller needs it, can't Keep an absent tree)
 *   inner   + exists → Keep     (default; or Overwrite — pushing your copy clobbers
 *                                a shared journey, so Keep is the safe default)
 *
 * These are the smart DEFAULTS (TD-10) the UI (S8) seeds from and the executor
 * (S6) orders writes by; the user may switch an `inner + exists` row to Overwrite.
 */

import { discoverJourneyRefs } from "./discover";
import type { ImportComponent } from "./parse";

export type JourneyAction = "create" | "overwrite" | "keep";
export type JourneyRole = "subject" | "inner";

/** One bundled journey unit's role, verdict, and Create/Overwrite/Keep decision. */
export interface JourneyUnitPlan {
  /** Tree name — the cross-env identity and the bundle/preflight key. */
  id: string;
  displayName: string;
  role: JourneyRole;
  /** `identical` (PD-5 amendment) = present AND own-scope content-equal to the
   * bundle (tree + nodes, script-remapped) → a locked no-op, like an identical
   * leaf. `exists` = present but content unknown/differing → Keep/Overwrite. */
  verdict: "new" | "exists" | "identical";
  /** The zero-touch default (TD-10). */
  defaultAction: JourneyAction;
  /** Actions the user may pick in the plan table (S8). */
  allowedActions: JourneyAction[];
}

function decide(
  role: JourneyRole,
  verdict: "new" | "exists" | "identical",
): { defaultAction: JourneyAction; allowedActions: JourneyAction[] } {
  if (verdict === "new") return { defaultAction: "create", allowedActions: ["create"] };
  // Already on the target AND identical → nothing to do; locked (no opt-in to a
  // pointless re-write of the same bytes), mirroring an identical leaf.
  if (verdict === "identical") return { defaultAction: "keep", allowedActions: [] };
  if (role === "subject") return { defaultAction: "overwrite", allowedActions: ["overwrite"] };
  return { defaultAction: "keep", allowedActions: ["overwrite", "keep"] };
}

/**
 * Build the decision plan for every journey unit in a bundle. `verdictById` maps
 * each tree name to its pre-flight existence verdict (`new`/`exists`); an absent
 * entry defaults to `new` (treat as not-on-target). Non-journey components are
 * ignored, so a leaf bundle yields `[]`.
 */
export function planJourneyUnits(
  rawComponents: readonly ImportComponent[],
  verdictById: ReadonlyMap<string, "new" | "exists" | "identical">,
): JourneyUnitPlan[] {
  const referenced = new Set(discoverJourneyRefs(rawComponents).referencedInnerTrees);
  const out: JourneyUnitPlan[] = [];
  for (const comp of rawComponents) {
    if (comp.kind !== "journey") continue;
    const role: JourneyRole = referenced.has(comp.id) ? "inner" : "subject";
    const verdict = verdictById.get(comp.id) ?? "new";
    out.push({
      id: comp.id,
      displayName: comp.displayName,
      role,
      verdict,
      ...decide(role, verdict),
    });
  }
  return out;
}
