/**
 * Inverse-serializer transforms (D43, M9 Phase 4 Batch 1 Slice C). Pure. Turn a
 * bundle's raw atom-leaf export object into the client write payload, mirroring
 * the POC-proven write bodies (`poc/transfer-endpoints/`):
 *   - email strips `_id` (the server derives it from the URL),
 *   - idp keeps `_id`, drops the server-added `_type`, carries a re-supplied
 *     `clientSecret`,
 *   - theme drops the non-pushable `linkedTrees` reverse-ref (`isDefault` is
 *     handled in `client.writeTheme` per create/overwrite).
 */

function drop(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out;
}

/** Whitelist — keep only the listed keys (so server-managed fields never leak
 * into a write body). */
function pick(raw: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in raw) out[k] = raw[k];
  return out;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Bare template name from the bundle key/`_id` (`emailTemplate/<name>`). The
 * single source of truth for the prefix-strip (parse + preflight reuse it). */
export function emailTemplateName(id: string): string {
  return id.replace(/^emailTemplate\//, "");
}

export function toEmailWrite(raw: Record<string, unknown>): {
  name: string;
  body: Record<string, unknown>;
} {
  return { name: emailTemplateName(str(raw._id) ?? ""), body: drop(raw, "_id") };
}

export function toIdpWrite(
  raw: Record<string, unknown>,
  clientSecret: string | undefined,
): { typeId: string; id: string; body: Record<string, unknown> } {
  const typeObj = raw._type;
  const typeId =
    typeObj && typeof typeObj === "object"
      ? (str((typeObj as Record<string, unknown>)._id) ?? "")
      : "";
  const body = drop(raw, "_type");
  // On-prem AM validates `scopeDelimiter` as REQUIRED ("Values for Scope
  // Delimiter is required."); PAIC tolerates an empty one. An empty delimiter is
  // meaningless when scopes exist, so default it to a single space — OAuth2/OIDC's
  // standard separator and AM's own default. (No-op when the bundle already set it.)
  if (body.scopeDelimiter === "") body.scopeDelimiter = " ";
  if (clientSecret !== undefined) body.clientSecret = clientSecret;
  return { typeId, id: str(raw._id) ?? "", body };
}

export function toThemeWrite(raw: Record<string, unknown>): Record<string, unknown> {
  return drop(raw, "linkedTrees");
}

/** A social IdP needs a re-supplied secret iff the bundle object carries a
 * `clientSecret` key (redacted on read). Key-based providers don't, so we
 * never over-prompt them. */
export function idpNeedsSecret(raw: Record<string, unknown>): boolean {
  return "clientSecret" in raw;
}

/** ESV variable write body — the variable's `valueBase64` is carried verbatim
 * in the bundle (the exact raw API field), so we write it directly. Whitelist
 * the writable fields; server fields (`_id`, `lastChange*`, `loaded`) are
 * dropped (`_id` is URL-derived). */
export function toVariableWrite(raw: Record<string, unknown>): Record<string, unknown> {
  return pick(raw, "valueBase64", "expressionType", "description");
}

/** ESV secret write body — the value is never in the bundle (write-only), so
 * the user re-supplies it (plaintext); base64-encode it exactly once and keep
 * the bundle's `encoding` verbatim. */
export function toSecretWrite(
  raw: Record<string, unknown>,
  plaintext: string,
): Record<string, unknown> {
  return {
    ...pick(raw, "encoding", "useInPlaceholders", "description"),
    valueBase64: Buffer.from(plaintext, "utf8").toString("base64"),
  };
}

/** Inverse of `serialize.ts:scriptBodyToExport` — the bundle carries the script
 * body as JSON-stringified decoded source (`JSON.stringify(decodedSource)`),
 * but the AM scripts endpoint wants base64. Parse back to plain source, then
 * base64-encode. Must change in lockstep with `scriptBodyToExport`. */
export function scriptBodyToWire(bundleBody: string): string {
  return Buffer.from(JSON.parse(bundleBody) as string, "utf8").toString("base64");
}

/** Script / library-script write body. Keeps `_id` (the URL UUID, preserved on
 * import — `PUT …/scripts/<uuid>`), `name`, `language`, `context` ("LIBRARY"
 * round-trips for library scripts), plus the writable `description`/`default`.
 * Drops server-managed audit fields, and re-encodes the body to base64. A
 * non-string `script` is left untouched — the API surfaces the error rather
 * than this pure transform throwing. */
export function toScriptWrite(raw: Record<string, unknown>): Record<string, unknown> {
  const out = drop(
    raw,
    "_rev",
    "createdBy",
    "creationDate",
    "lastModifiedBy",
    "lastModifiedDate",
    "evaluatorVersion",
  );
  if (typeof out.script === "string") out.script = scriptBodyToWire(out.script);
  return out;
}
