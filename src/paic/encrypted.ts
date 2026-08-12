/**
 * AM's `<field>-encrypted` companion fields.
 *
 * AM returns some secrets as an encrypted companion key next to a nulled
 * plaintext one — e.g. an `OneTimePasswordSmtpSenderNode` read from PAIC comes
 * back as `{ "password": null, "password-encrypted": "<blob>" }`. The plaintext
 * field is write-only and ALWAYS reads as null; the companion carries the value
 * encrypted with the source deployment's own key.
 *
 * These fields are pure poison for transfer, in three distinct ways:
 *
 *   1. **Unwritable anywhere.** AM rejects ANY payload containing a key ending
 *      in `-encrypted` with `500 "Request contained encrypted data"` — including
 *      a write back into the very tenant that produced it. Empirically confirmed
 *      against AM 7.5.2; a real blob, a masked placeholder, and a fabricated
 *      `bogus-encrypted` key all fail identically. So nothing is lost by
 *      dropping them: there is no destination that would accept one.
 *   2. **Non-portable by construction.** Encrypted with the source deployment's
 *      key, so it is meaningless in a different environment even in principle.
 *   3. **A credential at rest.** Exporting one writes real encrypted credential
 *      material into a bundle file that gets shared and committed.
 *
 * frodo hit the same wall and settled on deleting them before every write
 * ("until we figure out a way to use transport keys in Frodo, we'll have to drop
 * those encrypted attributes" — `NodeApi.ts`, and five sibling API modules).
 *
 * We differ from frodo in one deliberate way: frodo matches the substring
 * `-encrypted` ANYWHERE in the key, which would also eat an unrelated field like
 * `is-encrypted-enabled`. We match only keys that END with `-encrypted`, which
 * is AM's actual convention and every case observed, without the collateral.
 */

const ENCRYPTED_SUFFIX = "-encrypted";

/** Does this key name a `<field>-encrypted` companion? */
export function isEncryptedKey(key: string): boolean {
  return key.endsWith(ENCRYPTED_SUFFIX);
}

/**
 * Deep-clone `value` with every `<field>-encrypted` key removed, at any depth.
 *
 * Never mutates the input — callers pass payloads that are also held elsewhere
 * (compare holds both sides at once). Non-objects pass through untouched;
 * arrays are walked element-wise.
 */
export function stripEncrypted<T>(value: T): T {
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== "object") return value;
  // Preserve non-plain objects (Date, etc.) by reference — node payloads are
  // JSON, so this only guards against surprises.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isEncryptedKey(k)) continue;
    out[k] = strip(v);
  }
  return out;
}
