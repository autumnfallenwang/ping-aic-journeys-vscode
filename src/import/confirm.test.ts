import { describe, expect, it } from "vitest";
import { buildImportConfirmDetail } from "./confirm";

describe("buildImportConfirmDetail", () => {
  it("names the target + lists non-zero actions as bullets; omits Keep when 0", () => {
    const d = buildImportConfirmDetail({ host: "h", realm: "alpha", create: 2, overwrite: 1 });
    expect(d).toContain("Target — h / realm alpha");
    expect(d).toContain("• Create 2");
    expect(d).toContain("• Overwrite 1");
    expect(d).not.toContain("Keep");
    expect(d).toContain("not transactional and cannot be undone");
  });

  it("includes a Keep bullet when > 0 and omits a zero Overwrite line (journey path)", () => {
    const d = buildImportConfirmDetail({ host: "h", realm: "r", create: 1, overwrite: 0, keep: 3 });
    expect(d).toContain("• Create 1");
    expect(d).toContain("• Keep 3");
    expect(d).not.toContain("Overwrite 0");
  });

  it("renders each on its own line: each action a bullet, each caveat a ⚠ line", () => {
    const d = buildImportConfirmDetail({
      host: "h",
      realm: "r",
      create: 1,
      overwrite: 0,
      errorN: 2,
      hasEsv: true,
      missingNote: " ⚠ 1 referenced dependency missing.",
    });
    // Caveats are split out one-per-line (no run-on paragraph).
    expect(d).toContain("\n  ⚠ 2 component(s) couldn't be checked and will be skipped.");
    expect(d).toContain("\n  ⚠ ESV changes require a separate Apply step before they take effect.");
    // The missing-deps note's own leading "⚠ " is normalised, not doubled.
    expect(d).toContain("\n  ⚠ 1 referenced dependency missing.");
    expect(d).not.toContain("⚠ ⚠");
  });

  it("omits all optional caveat lines when not supplied", () => {
    const d = buildImportConfirmDetail({ host: "h", realm: "r", create: 1, overwrite: 1 });
    expect(d).not.toContain("couldn't be checked");
    expect(d).not.toContain("ESV changes");
    expect(d).not.toContain("⚠");
  });
});
