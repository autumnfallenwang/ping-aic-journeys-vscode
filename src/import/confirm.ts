/**
 * Import confirm-modal detail text (M9 Phase 4 Batch 3, S9a). Pure. One builder
 * for BOTH the leaf and journey paths so the modal restates the same count
 * vocabulary (`create · overwrite · keep`) the plan's count-summary header shows
 * (D44 — the confirm echoes the plan). No vscode.
 */

export interface ConfirmDetailOpts {
  host: string;
  realm: string;
  create: number;
  overwrite: number;
  /** Journeys only — Keep'd inner journeys (omitted from the text when 0). */
  keep?: number;
  /** Components that couldn't be checked at pre-flight (will be skipped). */
  errorN?: number;
  /** The plan writes an ESV (variable/secret) → mention the separate Apply step. */
  hasEsv?: boolean;
  /** Advisory missing-deps note (from `missingDepsNote`); "" when none. */
  missingNote?: string;
}

/**
 * Build the confirm-modal detail string — the same wording + count vocabulary
 * (Create · Overwrite · Keep) the plan's count-summary header shows, but laid
 * out as a scannable block instead of one run-on paragraph. VS Code's modal
 * `detail` honours `\n`, so we use a target line, a bulleted plan (one line per
 * non-zero action), the stand-alone no-undo warning, then one `⚠` line per
 * caveat — each on its own line so they don't pile up (D44).
 */
export function buildImportConfirmDetail(opts: ConfirmDetailOpts): string {
  const { host, realm, create, overwrite, keep = 0, errorN = 0, hasEsv = false } = opts;

  const lines: string[] = [`Target — ${host} / realm ${realm}`, "", "Plan"];
  // One bullet per non-zero action — an empty plan never reaches the confirm,
  // so at least one of these is > 0.
  if (create > 0) lines.push(`  • Create ${create}`);
  if (overwrite > 0) lines.push(`  • Overwrite ${overwrite}`);
  if (keep > 0) lines.push(`  • Keep ${keep}`);

  lines.push(
    "",
    "Overwrite replaces the target's current version entirely. " +
      "This is not transactional and cannot be undone.",
  );

  // Caveats — each on its own ⚠ line. The missing-deps note arrives prefixed
  // with " ⚠ "; normalise it so every caveat reads the same.
  const caveats: string[] = [];
  if (errorN > 0) caveats.push(`${errorN} component(s) couldn't be checked and will be skipped.`);
  if (hasEsv) caveats.push("ESV changes require a separate Apply step before they take effect.");
  const missing = (opts.missingNote ?? "").trim().replace(/^⚠\s*/, "");
  if (missing) caveats.push(missing);
  if (caveats.length > 0) {
    lines.push("");
    for (const caveat of caveats) lines.push(`  ⚠ ${caveat}`);
  }

  return lines.join("\n");
}
