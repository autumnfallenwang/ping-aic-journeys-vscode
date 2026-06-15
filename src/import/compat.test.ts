import { describe, expect, it } from "vitest";
import { compatFor } from "./compat";
import type { BundleKind } from "./parse";

const ALL_KINDS: BundleKind[] = [
  "journey",
  "script",
  "theme",
  "emailTemplate",
  "socialIdp",
  "variable",
  "secret",
];

describe("compatFor", () => {
  it("a paic target supports every kind", () => {
    for (const k of ALL_KINDS) {
      expect(compatFor(k, "paic")).toBe("ok");
    }
  });

  it("an on-prem target supports the AM-native kinds (auth trees, scripts, IdPs)", () => {
    expect(compatFor("journey", "onprem")).toBe("ok"); // core AM — must be writable on-prem
    expect(compatFor("script", "onprem")).toBe("ok");
    expect(compatFor("socialIdp", "onprem")).toBe("ok");
  });

  it("an on-prem target rejects the IDM/platform leaves", () => {
    for (const k of ["theme", "emailTemplate", "variable", "secret"] as BundleKind[]) {
      expect(compatFor(k, "onprem")).toBe("unsupported");
    }
  });
});
