/**
 * Concurrency-bounded wrapper around a `PreflightClient` (D46 / PD-19).
 *
 * The import pre-flight fans out over HTTP in four phases (`runPreflight`,
 * `readJourneyCompareInputs`, `discoverDeps`, `checkJourneyGates`), and one of
 * them nests (journeys → node bodies). Every other subsystem in the codebase
 * bounds its fan-out — `resolver/walk.ts`, `realm-index/build.ts`,
 * `export/journey-bundle.ts`, the tree expanders — but the pre-flight shipped
 * with bare `Promise.all`, which is what makes a degraded link surface as
 * `read ECONNRESET` rows in the plan (see lessons.md 2026-08-21).
 *
 * **Why wrap the client and not the phase functions.** Threading a shared
 * `Limiter` through the ORCHESTRATING functions deadlocks: the per-journey task
 * in `readJourneyCompareInputs` holds a slot while awaiting its own node-body
 * fan-out, so once all `n` slots are held by outer tasks, no inner task can ever
 * start. Wrapping the client means only LEAF HTTP calls take a slot — an outer
 * task holds nothing while it waits — which is structurally deadlock-free and
 * leaves `preflight.ts` untouched.
 *
 * Pure: no vscode, no axios.
 */

import { type Limiter, makeLimiter } from "../paic/concurrency";
import type { PreflightClient } from "./preflight";

/** Total in-flight pre-flight requests. Matches `WALK_CONCURRENCY` /
 * `BUILD_CONCURRENCY` — one tenant-facing budget, one number. */
export const PREFLIGHT_CONCURRENCY = 10;

/** Every method of `PreflightClient`. Listed explicitly (rather than derived at
 * runtime from the object) so adding a read to `PreflightClient` without
 * bounding it is a TYPE error here, not a silent unbounded call in production. */
const PREFLIGHT_METHODS = [
  "getRawTheme",
  "getRawEmailTemplate",
  // biome-ignore lint/security/noSecrets: PaicClient method name, not a secret
  "getRawSocialIdp",
  "getRawScript",
  // biome-ignore lint/security/noSecrets: PaicClient method name, not a secret
  "getRawScriptByName",
  // biome-ignore lint/security/noSecrets: PaicClient method name, not a secret
  "findRawScriptsByName",
  "getRawEsv",
  "listVariables",
  "listSecrets",
  "getNodeTypes",
  "listTrees",
  "getRawJourney",
  "getRawNode",
] as const satisfies ReadonlyArray<keyof PreflightClient>;

// Compile-time completeness: if a key is added to `PreflightClient` and not to
// `PREFLIGHT_METHODS`, `AllMethodsCovered` resolves to `never` and this fails to
// typecheck — an unbounded read can't reach production unnoticed.
type Covered = (typeof PREFLIGHT_METHODS)[number];
type AllMethodsCovered = keyof PreflightClient extends Covered ? true : never;
const methodsAreComplete: AllMethodsCovered = true;
void methodsAreComplete;

/**
 * Return a `PreflightClient` whose every read goes through `limit`. Pass ONE
 * limiter across all four pre-flight phases so the cap is total in-flight, not
 * per-phase (nested/sequential `makeLimiter` calls would multiply — the
 * 2026-05-19 lesson).
 */
export function limitClient(
  client: PreflightClient,
  limit: Limiter = makeLimiter(PREFLIGHT_CONCURRENCY),
): PreflightClient {
  const out: Record<string, unknown> = {};
  for (const name of PREFLIGHT_METHODS) {
    const fn = client[name] as (...args: never[]) => Promise<unknown>;
    out[name] = (...args: never[]) => limit.run(() => fn.apply(client, args));
  }
  return out as PreflightClient;
}
