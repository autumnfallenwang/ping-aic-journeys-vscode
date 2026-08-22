/**
 * Export serializer — turns a raw PAIC REST entity into a frodo / PAIC-UI
 * compatible single-leaf export bundle (D42 / M9 Phase 1). Pure TypeScript:
 * no `vscode`, no network. Consumers (the export command) fetch the raw object
 * and a `meta` block, then call into here.
 */

import type { RawScript } from "../paic/mappers";

/**
 * Provenance + descriptive metadata stamped on every export bundle (D42 / TD-2).
 * The future comparison engine MUST ignore this block when diffing content —
 * `exportDate` etc. churn on every export.
 */
export interface ExportMeta {
  bundleSchemaVersion: string;
  origin: string;
  connectionType: "paic" | "am-onprem";
  realm: string;
  exportedBy?: string;
  exportDate: string;
  exportTool: string;
  exportToolVersion: string;

  // Journey-export only (D42 / TD-5). Undefined for leaf exports.
  /** `"level1"` (selected journey only) or `"allLevels"` (full inner-journey closure).
   * Informational provenance only — the import derives everything from tree content,
   * never from `meta` (PD-18 / D45). The derived fields `requires` /
   * `treesSelectedForExport` / `innerTreesIncluded` are deliberately NOT emitted. */
  depthMode?: "level1" | "allLevels";

  /** Realm-export only (D46). `"realm"` = this bundle is every journey in the realm.
   * Informational provenance, exactly like `depthMode` — the import derives 100% from
   * tree content and reads nothing here (PD-18). Absent for single-journey exports. */
  scope?: "realm";
}

/** Leaf kinds the serializer emits. ESV is already split into variable/secret
 * by the time it reaches here (the export command resolves which one). */
export type ExportLeafKind =
  | "script"
  | "libraryScript"
  | "theme"
  | "emailTemplate"
  | "socialIdp"
  | "variable"
  | "secret";

/** Frodo per-type bundle key per leaf kind (script + libraryScript share the
 * `script` map; socialIdp uses frodo's `idp` key). */
type PerTypeKey = "script" | "theme" | "emailTemplate" | "idp" | "variable" | "secret";
const PER_TYPE_KEY: Record<ExportLeafKind, PerTypeKey> = {
  script: "script",
  libraryScript: "script",
  theme: "theme",
  emailTemplate: "emailTemplate",
  socialIdp: "idp",
  variable: "variable",
  secret: "secret",
};

/**
 * A single-leaf export. Mirrors frodo's per-type export interfaces, e.g.
 * `ScriptExportInterface = { meta, script: Record<id, ScriptSkeleton> }`, so the
 * file imports via `frodo <kind> import` and the PAIC-UI Import. Exactly one of
 * the per-type maps is present per export.
 */
export interface LeafExport {
  meta: ExportMeta;
  script?: Record<string, Record<string, unknown>>;
  theme?: Record<string, Record<string, unknown>>;
  emailTemplate?: Record<string, Record<string, unknown>>;
  idp?: Record<string, Record<string, unknown>>;
  variable?: Record<string, Record<string, unknown>>;
  secret?: Record<string, Record<string, unknown>>;
}

/**
 * Server-managed fields stripped from every exported entity (D42): they are
 * regenerated on import and would otherwise be env-specific diff noise. `_id`
 * is deliberately KEPT — client-chosen UUIDs are preserved on import, so the id
 * is real transferable identity, not noise.
 */
const MASK_FIELDS = [
  "_rev",
  "createdBy",
  "creationDate",
  "lastModifiedBy",
  "lastModifiedDate",
  "evaluatorVersion",
];

export function stripMask(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!MASK_FIELDS.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * Convert an AM script body (base64 on the wire) into the export
 * representation: the decoded source, JSON-stringified. This matches frodo's
 * default form and the captured PAIC-UI export (D42 interop choice). Isolated
 * here so the future Compare pillar can switch to a line-array form if needed.
 */
export function scriptBodyToExport(b64: string): string {
  return JSON.stringify(decodeBase64(b64));
}

function decodeBase64(b64: string): string {
  return Buffer.from(b64, "base64").toString("utf8");
}

/**
 * Serialize one raw leaf entity into a frodo-compatible single-leaf export
 * bundle (`{ meta, <perTypeKey>: { <id>: cleaned } }`). Strips server-managed
 * mask fields, keeps `_id`, and (scripts only) re-encodes the body. The map is
 * keyed by the entity's wire `_id`, falling back to `fallbackId` when absent.
 */
export function serializeLeaf(
  kind: ExportLeafKind,
  raw: Record<string, unknown>,
  meta: ExportMeta,
  fallbackId: string,
): LeafExport {
  const cleaned = stripMask(raw);
  if ((kind === "script" || kind === "libraryScript") && typeof cleaned.script === "string") {
    cleaned.script = scriptBodyToExport(cleaned.script);
  }
  const id = typeof raw._id === "string" && raw._id ? raw._id : fallbackId;
  const bundle: LeafExport = { meta };
  bundle[PER_TYPE_KEY[kind]] = { [id]: cleaned };
  return bundle;
}

/** Convenience wrapper for the common script case (keeps the Slice-1 API). */
export function serializeScript(raw: RawScript, meta: ExportMeta): LeafExport {
  return serializeLeaf("script", raw as unknown as Record<string, unknown>, meta, raw._id);
}
