/**
 * Import compare engine (D42 / TD-6, M9 Phase 4 Batch 1 Slice B2). Pure.
 * Classifies a bundle component against the target's current version:
 *   - atoms (theme / emailTemplate / socialIdp) → value-compare (identical / differs)
 *   - script / variable / secret → existence-only (new / exists). A secret's
 *     value is never on the wire (permanent); script body-encoding + variable
 *     value-compare land with their write batch (Batch 2).
 * Both sides are normalized identically before equality — otherwise
 * `_rev`/timestamps/identity fields would make everything "differs".
 */

import { stripMask } from "../export/serialize";
import { stripEncrypted } from "../paic/encrypted";
import type { BundleKind } from "./parse";

export type CompareVerdict = "new" | "identical" | "differs" | "exists";

/** Per-component pre-flight status — `classifyCompare`'s output plus the
 * panel-set `unsupported` (compat gate), `error` (the fetch threw), and
 * `id-collision` (scripts: a create whose bundle UUID is already held by a
 * differently-named script on the target — TD-9; blocked, never written). */
export type ComponentStatus = CompareVerdict | "unsupported" | "error" | "id-collision";

export interface ComponentVerdict {
  kind: BundleKind;
  id: string;
  displayName: string;
  status: ComponentStatus;
  message?: string;
  /** Scripts only — the target entity's real `_id` when a name-match resolved
   * one (TD-9). The write reconciles to this UUID instead of the bundle's, so a
   * same-named/different-UUID target is overwritten in place, not duplicated. */
  resolvedTargetId?: string;
  /** Scripts only — count of same-named scripts on the target (AM allows dups).
   * >1 means the name match was ambiguous; the UI shows a `(N on target)` note. */
  targetMatchCount?: number;
}

/** Kinds whose CONTENT we value-compare (the Batch-1 atoms). Everything else
 * is existence-only this slice. */
const VALUE_COMPARED: ReadonlySet<BundleKind> = new Set<BundleKind>([
  "theme",
  "emailTemplate",
  "socialIdp",
]);

export function classifyCompare(
  kind: BundleKind,
  bundleRaw: Record<string, unknown>,
  targetRaw: Record<string, unknown> | null,
): CompareVerdict {
  if (targetRaw === null) return "new";
  // Journeys are existence-only (PD-5): cross-env script UUIDs make a raw node
  // diff always "differs", and the decision is driven by existence + role
  // (Create/Overwrite/Keep), never a value-diff. Explicit so a future
  // `VALUE_COMPARED` edit can't silently flip journeys into value-compare.
  if (kind === "journey") return "exists";
  // Scripts share `kind: "script"` but split by policy (TD-4): a DECISION
  // script value-compares (its body is the artifact); a LIBRARY script is
  // existence-only (existence-checked as part of a closure, not diffed). The
  // bundle object is the authoritative side — it determines what we import.
  if (kind === "script") {
    if (bundleRaw.context === "LIBRARY") return "exists";
    return eq(kind, bundleRaw, targetRaw) ? "identical" : "differs";
  }
  if (!VALUE_COMPARED.has(kind)) return "exists";
  return eq(kind, bundleRaw, targetRaw) ? "identical" : "differs";
}

/** Deep-equal two raw entities after identical normalization. */
function eq(
  kind: BundleKind,
  bundleRaw: Record<string, unknown>,
  targetRaw: Record<string, unknown>,
): boolean {
  return (
    stableStringify(normalizeForCompare(kind, bundleRaw)) ===
    stableStringify(normalizeForCompare(kind, targetRaw))
  );
}

/** Canonicalize a script body to plain source regardless of which side it came
 * from. The bundle carries it JSON-stringified (`serialize.ts:scriptBodyToExport`),
 * the target read carries it as base64 — reduce both to the same source string
 * so encoding/padding differences never read as `differs`. JSON-parse first
 * (the bundle form always starts as a JSON-stringified string), else base64. */
export function canonScriptBody(s: string): string {
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === "string") return parsed;
  } catch {
    // not the bundle's JSON-stringified form — fall through to base64.
  }
  try {
    return Buffer.from(s, "base64").toString("utf8");
  } catch {
    return s;
  }
}

/**
 * Drop top-level keys whose value is `null` — `null` and "key absent" both mean
 * NO VALUE, and AM is not consistent about which it returns.
 *
 * The concrete failure this fixes (empirically confirmed on AM 7.5.2): a node
 * PUT *omitting* `password` reads back as `"password": null`, but the same node
 * PUT with an explicit `"password": null` reads back with the key **gone**. Our
 * importer sends the bundle's `password: null` verbatim, so importing a bundle
 * produces a target that no longer matches THAT SAME BUNDLE — permanent phantom
 * drift, which Overwrite cannot settle because the next write recreates the
 * asymmetry. Both sides mean "no password", so they must compare equal.
 *
 * Top level only, deliberately: a `null` nested inside a value object (an
 * `emailContent` locale map, say) is content, not absence.
 *
 * This is a correctness normalization, NOT one of the user-selectable compare
 * masks (see `poc/proposals/compare-options.md`) — there is no reading under
 * which null and absent are meaningfully different. A field holding a REAL
 * value still differs from a null/absent one; only null-vs-missing collapses.
 */
export function dropNullValues(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

/** Strip identity + server-managed + env-drift fields so two equivalent
 * entities compare equal regardless of where/when they were read. Operates on
 * a fresh object (`stripMask` clones) — never mutates the input. */
export function normalizeForCompare(
  kind: BundleKind,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  // stripEncrypted keeps a PRE-FIX bundle (exported while `<field>-encrypted`
  // still passed through) comparable against a target read today, which strips
  // them on read. See `paic/encrypted.ts`.
  const out = stripEncrypted(stripMask(raw)); // drops _rev + audit fields, keeps _id
  delete out._id; // identity, not content — we already matched by it on fetch
  if (kind === "theme") {
    delete out.linkedTrees; // reverse-ref (which journeys link here), not pushable
    delete out.isDefault; // per-realm UI state, not theme content
  }
  if (kind === "socialIdp") {
    delete out.clientSecret; // redacted on read → never equal across envs
    delete out._type; // server-added provider-type object (identity)
  }
  if (kind === "script") {
    // Bundle body is JSON-stringified source, target body is base64 — reduce
    // both to plain source. Drop the script diff-mask fields (audit churn).
    if (typeof out.script === "string") out.script = canonScriptBody(out.script);
    delete out.description;
    delete out.default;
  }
  // Last: `null` ≡ absent (see `dropNullValues`). After the kind-specific
  // deletes, so a field deleted above can't be resurrected as a null.
  return dropNullValues(out);
}

/** Canonical JSON with recursively sorted keys. Both compared objects come
 * from `JSON.parse` (no `undefined`), so sorted-canonical + `===` is the
 * simplest correct deep equality — no library needed. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
