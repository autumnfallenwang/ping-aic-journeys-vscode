/**
 * Kind-grouping for Search result lists — the `── <Kind> (N) ──` divider
 * style shared with the inspector cards + sidebar tree. Operates on
 * `RealmIndexEntity` (the Search domain shape); the inspector's
 * `cards/grouping.ts` is the sibling that does the same for `ResolvedNode`
 * in the other bundle.
 */

import type { RealmIndexEntity } from "../../../domain/realm-index";

/** Display kinds — `script` splits into Scripts vs. Library scripts by
 * `RealmIndexEntity.isLibrary`, mirroring the inspector / sidebar. */
export type DisplayKind =
  | "journey"
  | "script"
  | "libraryScript"
  | "esv"
  | "theme"
  | "emailTemplate"
  | "socialIdp";

const KIND_ORDER: readonly DisplayKind[] = [
  "journey",
  "script",
  "libraryScript",
  "esv",
  "theme",
  "emailTemplate",
  "socialIdp",
];

export const DISPLAY_KIND_LABEL: Record<DisplayKind, string> = {
  journey: "Journeys",
  script: "Scripts",
  libraryScript: "Library scripts",
  esv: "ESVs",
  theme: "Themes",
  emailTemplate: "Email templates",
  socialIdp: "Social IdPs",
};

/** Codicon id per display kind — same picks as the inspector cards. */
export const DISPLAY_KIND_ICON: Record<DisplayKind, string> = {
  journey: "type-hierarchy",
  script: "symbol-method",
  libraryScript: "library",
  esv: "symbol-variable",
  theme: "paintcan",
  emailTemplate: "mail",
  socialIdp: "link-external",
};

export function displayKindOf(e: RealmIndexEntity): DisplayKind {
  if (e.kind === "script") return e.isLibrary ? "libraryScript" : "script";
  return e.kind;
}

export type GroupedRow<T> =
  | { row: "divider"; kind: DisplayKind; label: string; count: number }
  | { row: "entity"; item: T };

/** Group `items` by display kind (fixed kind order), alphabetical by
 * `displayName` within each kind, with a divider row before each present
 * kind. Generic over any carrier with an `entity` field — serves
 * Find-usages rows (which also carry `via`) and By-name / Unused rows
 * (bare entities) alike. */
export function groupByKind<T extends { entity: RealmIndexEntity }>(
  items: readonly T[],
): Array<GroupedRow<T>> {
  const byKind = new Map<DisplayKind, T[]>();
  for (const it of items) {
    const k = displayKindOf(it.entity);
    const list = byKind.get(k);
    if (list) list.push(it);
    else byKind.set(k, [it]);
  }
  const out: Array<GroupedRow<T>> = [];
  for (const kind of KIND_ORDER) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    list.sort((a, b) =>
      a.entity.displayName.localeCompare(b.entity.displayName, undefined, {
        sensitivity: "base",
      }),
    );
    out.push({ row: "divider", kind, label: DISPLAY_KIND_LABEL[kind], count: list.length });
    for (const it of list) out.push({ row: "entity", item: it });
  }
  return out;
}
