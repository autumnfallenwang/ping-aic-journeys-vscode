import { describe, expect, it } from "vitest";
import { buildImportConfirmDetail } from "./confirm";

describe("buildImportConfirmDetail", () => {
  it("names the target + lists non-zero actions as bullets; omits Keep when 0", () => {
    const d = buildImportConfirmDetail({ host: "h", realm: "alpha", create: 2, overwrite: 1 });
    expect(d).toContain("h / alpha");
    expect(d).toContain("• Create 2");
    expect(d).toContain("• Overwrite 1");
    expect(d).not.toContain("Keep");
    expect(d).toContain("Not transactional, no undo.");
  });

  it("includes a Keep bullet when > 0 and omits a zero Overwrite line (journey path)", () => {
    const d = buildImportConfirmDetail({ host: "h", realm: "r", create: 1, overwrite: 0, keep: 3 });
    expect(d).toContain("• Create 1");
    expect(d).toContain("• Keep 3");
    expect(d).not.toContain("Overwrite 0");
    // A create-only plan keeps the no-undo half without the overwrite clause.
    expect(d).toContain("Not transactional, no undo.");
    expect(d).not.toContain("Overwrite replaces");
  });

  it("D48: explains the export verb only when the plan overwrites something", () => {
    const withOverwrite = buildImportConfirmDetail({ host: "h", realm: "alpha", create: 0, overwrite: 2 });
    expect(withOverwrite).toContain("Export first saves every journey in alpha");
    const createOnly = buildImportConfirmDetail({ host: "h", realm: "alpha", create: 2, overwrite: 0 });
    expect(createOnly).not.toContain("Export first");
  });

  it("D48: carries no ⚠ caveat block — the plan table behind it already does", () => {
    const d = buildImportConfirmDetail({ host: "h", realm: "r", create: 1, overwrite: 1, keep: 1 });
    expect(d).not.toContain("⚠");
    expect(d).not.toContain("couldn't be checked");
    expect(d).not.toContain("ESV changes");
  });
});
