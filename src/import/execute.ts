/**
 * Import execute (D43, M9 Phase 4 Batch 1 Slice C) — the only code that writes
 * to a tenant. Writes each atom-leaf component (verdict New/Differs) through
 * the injected client and reports a per-component result. **Sequential** (theme
 * writes splice the same `themerealm` doc, so parallel would self-race);
 * attempt-all (one failure doesn't stop the rest; there is no rollback).
 */

import type { PaicClient, WriteOutcome } from "../paic/client";
import { PaicError } from "../paic/errors";
import type { BundleKind, ImportComponent } from "./parse";
import {
  idpNeedsSecret,
  toEmailWrite,
  toIdpWrite,
  toScriptWrite,
  toSecretWrite,
  toThemeWrite,
  toVariableWrite,
} from "./write";
import { putWithRetry } from "./write-retry";

export type WriteStatus = "created" | "overwritten" | "skipped" | "failed";

export interface WriteResult {
  kind: BundleKind;
  id: string;
  displayName: string;
  status: WriteStatus;
  message?: string;
}

export interface WritePlanItem {
  component: ImportComponent;
  /** From the fresh pre-flight — New → create, Differs → overwrite. */
  verdict: "new" | "differs";
  /** Re-supplied secret — idp `clientSecret` (plaintext) or an ESV secret's
   * value (plaintext, base64-encoded by the transform). Collected via
   * `showInputBox`. */
  secret?: string;
  /** Scripts only — the name-matched target's `_id` (TD-9). When set, the write
   * reconciles to this UUID (overwrite in place) instead of the bundle's, so a
   * same-named/different-UUID target isn't duplicated. */
  resolvedTargetId?: string;
}

/** The subset of `PaicClient` the executor writes through. */
export type ExecuteClient = Pick<
  PaicClient,
  | "writeTheme"
  | "writeEmailTemplate"
  | "writeSocialIdp"
  | "writeEsvVariable"
  | "writeEsvSecret"
  | "writeScript"
>;

async function writeOne(
  client: ExecuteClient,
  realm: string,
  item: WritePlanItem,
): Promise<WriteResult> {
  const { component } = item;
  const base = { kind: component.kind, id: component.id, displayName: component.displayName };
  try {
    let outcome: WriteOutcome;
    // Each write carries the G2 "Invalid attribute specified." strip-and-retry
    // (a no-op for endpoints that never emit it; covers the AM-config socialIdp).
    switch (component.kind) {
      case "theme":
        outcome = await putWithRetry(
          (b) => client.writeTheme(realm, b),
          toThemeWrite(component.raw),
        );
        break;
      case "emailTemplate": {
        const { name, body } = toEmailWrite(component.raw);
        outcome = await putWithRetry((b) => client.writeEmailTemplate(name, b), body);
        break;
      }
      case "socialIdp": {
        if (idpNeedsSecret(component.raw) && !item.secret) {
          // Never PUT a blank secret over a working one.
          return { ...base, status: "skipped", message: "no client secret supplied" };
        }
        const { typeId, id, body } = toIdpWrite(component.raw, item.secret);
        outcome = await putWithRetry((b) => client.writeSocialIdp(realm, typeId, id, b), body);
        break;
      }
      case "variable":
        // The variable's value is in the bundle (`valueBase64`) — written directly.
        outcome = await putWithRetry(
          (b) => client.writeEsvVariable(component.id, b),
          toVariableWrite(component.raw),
        );
        break;
      case "script": {
        // Body is in the bundle (no secret prompt). Reconcile to the target's
        // own UUID when the name-match resolved one (TD-9) so a same-named/
        // different-UUID target is overwritten in place; fall back to the bundle
        // UUID only on a true create. Name is the cross-env identity.
        const targetId = item.resolvedTargetId ?? component.id;
        // AM rejects a PUT whose body `_id` differs from the resource id in the
        // URL ("Script resource id and script JSON body id do not match"). On a
        // reconcile the bundle `_id` ≠ targetId, so realign the body `_id`.
        const body = { ...toScriptWrite(component.raw), _id: targetId };
        outcome = await putWithRetry((b) => client.writeScript(realm, targetId, b), body);
        break;
      }
      case "secret": {
        if (!item.secret) {
          return { ...base, status: "skipped", message: "no value supplied" };
        }
        try {
          outcome = await putWithRetry(
            (b) => client.writeEsvSecret(component.id, b),
            toSecretWrite(component.raw, item.secret),
          );
        } catch (err) {
          // Create-only + a TOCTOU race → 400 "already exist(s)". That satisfies
          // intent (the secret is present); report it skipped, not failed. Real
          // validation 400s (bad base64/encoding) fall through to `failed`.
          // `/already exist/i` is wording-tolerant (AM/IDM say "exist", OAuth
          // "exists"); the real AM/IDM message now reaches here via PaicError (PD-14).
          if (
            err instanceof PaicError &&
            err.status === 400 &&
            /already exist/i.test(err.description ?? err.message)
          ) {
            return {
              ...base,
              status: "skipped",
              message: "already present (created concurrently)",
            };
          }
          throw err;
        }
        break;
      }
      default:
        return {
          ...base,
          status: "skipped",
          message: `import not supported for ${component.kind}`,
        };
    }
    return { ...base, status: outcome };
  } catch (err) {
    return { ...base, status: "failed", message: err instanceof Error ? err.message : String(err) };
  }
}

export async function runExecute(
  client: ExecuteClient,
  realm: string,
  items: readonly WritePlanItem[],
  /** Invoked after each item's write lands (in order) — drives determinate
   * progress + live row updates (PD-16). */
  onResult?: (r: WriteResult) => void,
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  for (const item of items) {
    const r = await writeOne(client, realm, item);
    onResult?.(r);
    results.push(r);
  }
  return results;
}
