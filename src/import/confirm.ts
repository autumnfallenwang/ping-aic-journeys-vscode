/**
 * Import confirm-modal detail text (M9 Phase 4 Batch 3, S9a; trimmed by D48).
 * Pure. One builder for BOTH the leaf and journey paths so the modal restates
 * the same count vocabulary (`create · overwrite · keep`) the plan's
 * count-summary header shows (D44 — the confirm echoes the plan). No vscode.
 *
 * D48 removed the `⚠` caveat block (missing deps · ESV apply · un-checkable
 * rows). Every one of those is already on the page behind the modal — dep rows
 * carry their own reason text plus the PD-7 banner, ESV rows show "pending
 * apply" beside the Apply button, and PD-20 disables Import outright while any
 * row's check failed — so restating them only crowded the one decision the
 * modal exists for.
 */

export interface ConfirmDetailOpts {
  host: string;
  realm: string;
  create: number;
  overwrite: number;
  /** Journeys only — Keep'd inner journeys (omitted from the text when 0). */
  keep?: number;
}

/**
 * Build the confirm-modal detail string: the target, one line per non-zero
 * action, and the no-undo warning. When the plan overwrites anything, a second
 * sentence explains the `Export target realm…` verb the caller adds (D48) — the
 * button's own label carries the rest, and the export's exclusions deliberately
 * live in the docs rather than here (a modal has one job).
 */
export function buildImportConfirmDetail(opts: ConfirmDetailOpts): string {
  const { host, realm, create, overwrite, keep = 0 } = opts;

  const lines: string[] = [`${host} / ${realm}`, ""];
  // One bullet per non-zero action — an empty plan never reaches the confirm,
  // so at least one of these is > 0.
  if (create > 0) lines.push(`  • Create ${create}`);
  if (overwrite > 0) lines.push(`  • Overwrite ${overwrite}`);
  if (keep > 0) lines.push(`  • Keep ${keep}`);

  // The overwrite clause only earns its place when something is overwritten; a
  // create-only plan still gets the no-undo half (we never delete, either).
  lines.push(
    "",
    overwrite > 0
      ? "Overwrite replaces the target's version. Not transactional, no undo."
      : "Not transactional, no undo.",
  );
  if (overwrite > 0) {
    lines.push(`Export first saves every journey in ${realm} to a re-importable file.`);
  }

  return lines.join("\n");
}
