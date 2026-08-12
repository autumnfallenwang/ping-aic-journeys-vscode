import { describe, expect, it } from "vitest";
import type { E2W, W2E } from "@/webview/transfer/messages";
import { isE2W, isW2E } from "@/webview/transfer/messages";

/**
 * Exhaustiveness anchors. `Record<W2E["type"], true>` makes the COMPILER reject
 * this file if a message variant is added to the union without being listed —
 * and the tests below then prove the runtime guard accepts each listed type.
 *
 * Why this exists: the guards are hand-maintained `t === "..."` allowlists whose
 * return type is an assertion (`m is W2E`), so a missing arm is invisible to
 * TypeScript. Adding `setCompareOptions`/`journeyPlansUpdated` to the unions
 * without adding them to the guards silently dropped both messages at runtime —
 * the feature was fully built and simply never fired. Together these two checks
 * make that impossible: forget the guard → this test fails; forget the record →
 * typecheck fails.
 */
const ALL_W2E: Record<W2E["type"], true> = {
  ready: true,
  pickBundle: true,
  listRealms: true,
  runPreflight: true,
  setCompareOptions: true,
  execute: true,
  applyEsv: true,
  downloadReport: true,
  openDiff: true,
  openFindUsages: true,
};

const ALL_E2W: Record<E2W["type"], true> = {
  bundleLoaded: true,
  bundleError: true,
  realmsResult: true,
  realmsError: true,
  preflightResult: true,
  preflightError: true,
  journeyPlansUpdated: true,
  executeResult: true,
  executeProgress: true,
  applyProgress: true,
  applyResult: true,
  driftDetected: true,
};

describe("transfer message guards — exhaustiveness", () => {
  it("isW2E accepts EVERY type in the W2E union", () => {
    for (const type of Object.keys(ALL_W2E)) {
      expect(isW2E({ type }), `isW2E rejected "${type}"`).toBe(true);
    }
  });

  it("isE2W accepts EVERY type in the E2W union", () => {
    for (const type of Object.keys(ALL_E2W)) {
      expect(isE2W({ type }), `isE2W rejected "${type}"`).toBe(true);
    }
  });
});

describe("transfer message guards", () => {
  it("isW2E accepts every W2E variant incl. applyEsv", () => {
    for (const m of [
      { type: "ready" },
      { type: "pickBundle" },
      { type: "listRealms", host: "h" },
      { type: "runPreflight", host: "h", realm: "r" },
      { type: "execute", host: "h", realm: "r", selected: ["theme:t"] },
      { type: "applyEsv", host: "h" },
      { type: "downloadReport" },
      { type: "openDiff", host: "h", realm: "r", bundleKey: "script:s", targetScriptId: "u" },
      {
        type: "openFindUsages",
        host: "h",
        realm: "r",
        targetKey: "script:s",
        targetKind: "script",
      },
    ]) {
      expect(isW2E(m)).toBe(true);
    }
  });

  it("isE2W accepts applyProgress + applyResult + driftDetected", () => {
    expect(isE2W({ type: "applyProgress", host: "h", status: "restarting", elapsedS: 1 })).toBe(
      true,
    );
    expect(isE2W({ type: "applyResult", host: "h", ok: true, elapsedS: 1 })).toBe(true);
    expect(isE2W({ type: "driftDetected", host: "h", realm: "r", drifted: [] })).toBe(true);
    expect(
      isE2W({
        type: "executeProgress",
        host: "h",
        realm: "r",
        result: { kind: "theme", id: "t", displayName: "t", status: "created" },
        done: 1,
        total: 2,
      }),
    ).toBe(true);
  });

  it("rejects unknown / malformed messages", () => {
    expect(isW2E({ type: "nope" })).toBe(false);
    expect(isE2W({ type: "nope" })).toBe(false);
    expect(isW2E(null)).toBe(false);
    expect(isE2W("x")).toBe(false);
  });
});
