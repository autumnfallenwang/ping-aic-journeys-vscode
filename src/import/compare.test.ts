import { describe, expect, it } from "vitest";
import { canonScriptBody, classifyCompare, normalizeForCompare, stableStringify } from "./compare";

describe("canonScriptBody", () => {
  const SRC = "// hi\nlogger.message('x');";
  it("parses the bundle's JSON-stringified source to plain source", () => {
    expect(canonScriptBody(JSON.stringify(SRC))).toBe(SRC);
  });
  it("decodes a base64 (target wire) body to plain source", () => {
    expect(canonScriptBody(Buffer.from(SRC, "utf8").toString("base64"))).toBe(SRC);
  });
});

describe("classifyCompare", () => {
  it("new when the target is absent", () => {
    expect(classifyCompare("theme", { _id: "t" }, null)).toBe("new");
  });

  it("theme identical despite differing _id / _rev / linkedTrees / isDefault", () => {
    const bundle = { _id: "t1", backgroundColor: "#111", logo: { en: "x" } };
    const target = {
      _id: "t2",
      _rev: "9",
      backgroundColor: "#111",
      logo: { en: "x" },
      linkedTrees: ["A"],
      isDefault: true,
    };
    expect(classifyCompare("theme", bundle, target)).toBe("identical");
  });

  it("theme differs on a real content field", () => {
    expect(classifyCompare("theme", { backgroundColor: "#111" }, { backgroundColor: "#222" })).toBe(
      "differs",
    );
  });

  it("idp identical despite differing clientSecret / _type / _rev", () => {
    const bundle = { _id: "i", clientId: "c", clientSecret: null, _type: { _id: "oidcConfig" } };
    const target = {
      _id: "i",
      _rev: "2",
      clientId: "c",
      clientSecret: "*****",
      _type: { _id: "oidcConfig", name: "OIDC" },
    };
    expect(classifyCompare("socialIdp", bundle, target)).toBe("identical");
  });

  it("idp differs on a real field (clientId)", () => {
    expect(classifyCompare("socialIdp", { clientId: "a" }, { clientId: "b" })).toBe("differs");
  });

  it("email identical despite _id + _rev", () => {
    const bundle = { _id: "emailTemplate/welcome", subject: { en: "Hi" } };
    const target = { _id: "emailTemplate/welcome", _rev: "4", subject: { en: "Hi" } };
    expect(classifyCompare("emailTemplate", bundle, target)).toBe("identical");
  });

  it("existence-only kinds → exists even when content differs", () => {
    for (const k of ["variable", "secret"] as const) {
      expect(classifyCompare(k, { a: 1 }, { a: 2 })).toBe("exists");
    }
  });

  it("journey is existence-only: new when absent, exists when present (never value-diffed)", () => {
    expect(classifyCompare("journey", { tree: { entryNodeId: "a" } }, null)).toBe("new");
    // present target with a totally different tree → still just "exists" (PD-5).
    expect(
      classifyCompare("journey", { tree: { entryNodeId: "a" } }, { tree: { entryNodeId: "z" } }),
    ).toBe("exists");
  });
});

describe("classifyCompare — scripts", () => {
  const enc = (s: string): string => Buffer.from(s, "utf8").toString("base64");

  it("decision script identical when bodies match across encodings", () => {
    // bundle body = JSON-stringified source; target body = base64.
    const bundle = { _id: "s", name: "d", script: JSON.stringify("// hi") };
    const target = { _id: "s", name: "d", script: enc("// hi") };
    expect(classifyCompare("script", bundle, target)).toBe("identical");
  });

  it("decision script differs on the body", () => {
    const bundle = { script: JSON.stringify("// a") };
    const target = { script: enc("// b") };
    expect(classifyCompare("script", bundle, target)).toBe("differs");
  });

  it("decision script identical despite description / default / _id / _rev drift", () => {
    const bundle = { _id: "s1", name: "d", script: JSON.stringify("x") };
    const target = {
      _id: "s2",
      _rev: "9",
      name: "d",
      script: enc("x"),
      description: "edited",
      default: true,
    };
    expect(classifyCompare("script", bundle, target)).toBe("identical");
  });

  it("decision script with no context key value-compares", () => {
    expect(classifyCompare("script", { script: JSON.stringify("x") }, { script: enc("y") })).toBe(
      "differs",
    );
  });

  it("library script is existence-only (exists even when bodies differ)", () => {
    const bundle = { context: "LIBRARY", script: JSON.stringify("// a") };
    const target = { context: "LIBRARY", script: enc("// b") };
    expect(classifyCompare("script", bundle, target)).toBe("exists");
  });

  it("script is new when the target is absent (decision and library)", () => {
    expect(classifyCompare("script", { script: JSON.stringify("x") }, null)).toBe("new");
    expect(classifyCompare("script", { context: "LIBRARY" }, null)).toBe("new");
  });
});

describe("stableStringify", () => {
  it("is key-order independent", () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it("recurses into nested objects (and respects array order)", () => {
    expect(stableStringify({ x: { b: 1, a: 2 }, arr: [3, 1] })).toBe(
      stableStringify({ arr: [3, 1], x: { a: 2, b: 1 } }),
    );
    expect(stableStringify({ arr: [1, 3] })).not.toBe(stableStringify({ arr: [3, 1] }));
  });
});

describe("normalizeForCompare", () => {
  it("drops _id + mask fields for every kind", () => {
    const n = normalizeForCompare("emailTemplate", { _id: "x", _rev: "1", subject: {} });
    expect(n._id).toBeUndefined();
    expect(n._rev).toBeUndefined();
    expect(n).toHaveProperty("subject");
  });

  it("theme drops linkedTrees + isDefault", () => {
    const n = normalizeForCompare("theme", {
      linkedTrees: ["a"],
      isDefault: true,
      primaryColor: "#1",
    });
    expect(n.linkedTrees).toBeUndefined();
    expect(n.isDefault).toBeUndefined();
    expect(n.primaryColor).toBe("#1");
  });

  it("idp drops clientSecret + _type", () => {
    const n = normalizeForCompare("socialIdp", {
      clientSecret: "s",
      _type: { _id: "x" },
      clientId: "c",
    });
    expect(n.clientSecret).toBeUndefined();
    expect(n._type).toBeUndefined();
    expect(n.clientId).toBe("c");
  });

  it("drops `<field>-encrypted` companions for every kind", () => {
    // A pre-fix bundle carries these; a target read today never does (stripped
    // in getRawSocialIdp), so leaving them in would phantom-diff forever.
    const n = normalizeForCompare("socialIdp", {
      clientId: "c",
      clientSecret: null,
      "clientSecret-encrypted": "AQICblob==",
    });
    expect(n).not.toHaveProperty("clientSecret-encrypted");
    expect(n.clientId).toBe("c");
  });

  it("a bundle with a companion equals the same target without one", () => {
    const bundle = normalizeForCompare("socialIdp", {
      _id: "g",
      clientId: "c",
      "clientSecret-encrypted": "AQICblob==",
    });
    const target = normalizeForCompare("socialIdp", { _id: "g", clientId: "c" });
    expect(stableStringify(bundle)).toBe(stableStringify(target));
  });

  it("still separates genuinely different leaves that both carry companions", () => {
    const a = normalizeForCompare("theme", { primaryColor: "#1", "x-encrypted": "AAA" });
    const b = normalizeForCompare("theme", { primaryColor: "#2", "x-encrypted": "BBB" });
    expect(stableStringify(a)).not.toBe(stableStringify(b));
  });

  // `null` ≡ absent. AM returns `"password": null` for a node PUT *without* the
  // key, but omits the key entirely for one PUT with an explicit null — so our
  // own import produces a target that would otherwise never match its bundle.
  it("treats a null-valued field as equal to a missing one", () => {
    const bundle = normalizeForCompare("socialIdp", { clientId: "c", someField: null });
    const target = normalizeForCompare("socialIdp", { clientId: "c" });
    expect(stableStringify(bundle)).toBe(stableStringify(target));
  });

  it("still separates a REAL value from null/absent", () => {
    const nulled = normalizeForCompare("socialIdp", { clientId: "c", someField: null });
    const valued = normalizeForCompare("socialIdp", { clientId: "c", someField: "set" });
    expect(stableStringify(nulled)).not.toBe(stableStringify(valued));
  });

  it("keeps a nested null — that is content, not absence", () => {
    // Only TOP-level nulls mean "no value"; a null inside a value object is data.
    const n = normalizeForCompare("emailTemplate", { subject: { en: null } });
    expect(n.subject).toEqual({ en: null });
  });

  it('keeps falsy-but-present values (0, "", false)', () => {
    const n = normalizeForCompare("theme", { a: 0, b: "", c: false });
    expect(n).toEqual({ a: 0, b: "", c: false });
  });

  it("script canonicalizes the body to plain source + drops description/default", () => {
    const fromBundle = normalizeForCompare("script", {
      script: JSON.stringify("// hi"),
      description: "d",
      default: true,
    });
    const fromTarget = normalizeForCompare("script", {
      script: Buffer.from("// hi", "utf8").toString("base64"),
    });
    expect(fromBundle.script).toBe("// hi");
    expect(fromTarget.script).toBe("// hi");
    expect(fromBundle.description).toBeUndefined();
    expect(fromBundle.default).toBeUndefined();
  });

  it("does not mutate the input", () => {
    const input = { _id: "x", linkedTrees: ["a"] };
    normalizeForCompare("theme", input);
    expect(input._id).toBe("x");
    expect(input.linkedTrees).toEqual(["a"]);
  });
});
