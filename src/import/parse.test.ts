import { describe, expect, it } from "vitest";
import { parseBundle } from "./parse";

const META = {
  bundleSchemaVersion: "1.0",
  origin: "openam-tenant.example.forgeblocks.com",
  connectionType: "paic",
  realm: "alpha",
  exportDate: "2026-06-11T00:00:00.000Z",
  exportTool: "paic-journeys-vscode",
  exportToolVersion: "0.1.1",
};

/** Build a bundle JSON string from an object. */
const j = (o: unknown): string => JSON.stringify(o);

describe("parseBundle — leaf bundles", () => {
  it("recognizes a theme bundle and uses the object name as display name", () => {
    const r = parseBundle(
      j({
        meta: META,
        theme: { zzzexporttesttheme: { _id: "zzzexporttesttheme", name: "zzz theme" } },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.kind).toBe("theme");
    expect(r.bundle.label).toBe("Theme");
    expect(r.bundle.components).toEqual([
      { kind: "theme", id: "zzzexporttesttheme", displayName: "zzz theme" },
    ]);
    expect(r.bundle.meta?.realm).toBe("alpha");
  });

  it("strips the emailTemplate/ prefix from the display name", () => {
    const r = parseBundle(
      j({ meta: META, emailTemplate: { "emailTemplate/zzzTpl": { _id: "emailTemplate/zzzTpl" } } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.kind).toBe("emailTemplate");
    expect(r.bundle.components[0]).toEqual({
      kind: "emailTemplate",
      id: "emailTemplate/zzzTpl",
      displayName: "zzzTpl",
    });
  });

  it("maps the `idp` key to socialIdp and surfaces the provider type", () => {
    const r = parseBundle(
      j({ meta: META, idp: { zzz_idp: { _id: "zzz_idp", _type: { _id: "oidcConfig" } } } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.kind).toBe("socialIdp");
    expect(r.bundle.label).toBe("Social IdP");
    expect(r.bundle.components[0].detail).toBe("oidcConfig");
  });

  it("labels a library script via its context", () => {
    const r = parseBundle(
      j({ meta: META, script: { id1: { _id: "id1", name: "lib", context: "LIBRARY" } } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.kind).toBe("script");
    expect(r.bundle.components[0]).toEqual({
      kind: "script",
      id: "id1",
      displayName: "lib",
      detail: "library script",
    });
  });

  it("recognizes ESV variable and secret bundles", () => {
    const v = parseBundle(j({ meta: META, variable: { "esv-x": { _id: "esv-x" } } }));
    const s = parseBundle(j({ meta: META, secret: { "esv-y": { _id: "esv-y" } } }));
    expect(v.ok && v.bundle.kind).toBe("variable");
    expect(s.ok && s.bundle.kind).toBe("secret");
  });

  it("tolerates a missing meta block", () => {
    const r = parseBundle(j({ theme: { t: { _id: "t", name: "T" } } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.meta).toBeNull();
    expect(r.bundle.kind).toBe("theme");
  });
});

describe("parseBundle — journey bundles", () => {
  const tree = (over: Record<string, unknown> = {}) => ({
    tree: { _id: "t" },
    nodes: { n1: {}, n2: {} },
    innerNodes: { i1: {} },
    scripts: { s1: { context: "AUTHENTICATION_TREE_DECISION_NODE" }, s2: { context: "LIBRARY" } },
    themes: { th: {} },
    emailTemplates: {},
    socialIdentityProviders: { idp: {} },
    ...over,
  });

  it("summarizes a level-1 journey from content; ignores meta.requires (PD-18)", () => {
    const r = parseBundle(
      j({
        meta: {
          ...META,
          depthMode: "level1",
          // PD-18: even if a (legacy) bundle carries meta.requires, the preview must NOT surface it.
          requires: { innerJourneys: ["inner_j"], esvs: ["esv.x"], nodeTypes: [] },
        },
        trees: { main_j: tree() },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.kind).toBe("journey");
    expect(r.bundle.label).toBe("Journey bundle (1 tree)");
    expect(r.bundle.components).toEqual([{ kind: "journey", id: "main_j", displayName: "main_j" }]);
    expect(r.bundle.inventory).toContain("Depth: level1");
    expect(r.bundle.inventory).toContain("Scripts: 2 (1 library)");
    expect(r.bundle.inventory.some((l) => l.startsWith("Requires"))).toBe(false);
  });

  it("summarizes an all-levels journey from content; ignores meta.innerTreesIncluded (PD-18)", () => {
    const r = parseBundle(
      j({
        meta: { ...META, depthMode: "allLevels", innerTreesIncluded: ["inner_j"] },
        trees: { main_j: tree(), inner_j: tree({ socialIdentityProviders: {} }) },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.label).toBe("Journey bundle (2 trees)");
    expect(r.bundle.components.map((c) => c.id)).toEqual(["main_j", "inner_j"]);
    // aggregate counts across both trees (content-derived: 4 scripts, 2 library)
    expect(r.bundle.inventory).toContain("Scripts: 4 (2 library)");
    expect(r.bundle.inventory.some((l) => l.startsWith("Inner trees included"))).toBe(false);
  });

  it("decomposes a journey into rawComponents: a journey unit per tree (nodes folded) + leaves", () => {
    const r = parseBundle(j({ meta: META, trees: { main_j: tree() } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byKind = (k: string) => r.rawComponents.filter((c) => c.kind === k);
    // one journey unit; its nodes/innerNodes fold into raw (PD-3) — no `node` components.
    const journeys = byKind("journey");
    expect(journeys.map((c) => c.id)).toEqual(["main_j"]);
    expect(Object.keys(journeys[0].raw.nodes as Record<string, unknown>)).toEqual(["n1", "n2"]);
    expect(Object.keys(journeys[0].raw.innerNodes as Record<string, unknown>)).toEqual(["i1"]);
    expect(journeys[0].raw.tree).toEqual({ _id: "t" });
    expect(byKind("node")).toEqual([]);
    // shared leaves extracted as their own components.
    expect(
      byKind("script")
        .map((c) => c.id)
        .sort(),
    ).toEqual(["s1", "s2"]);
    expect(byKind("theme").map((c) => c.id)).toEqual(["th"]);
    expect(byKind("socialIdp").map((c) => c.id)).toEqual(["idp"]);
  });

  it("dedups a leaf shared across trees into one component (PD-6)", () => {
    // both trees carry scripts s1/s2 — the allLevels closure → still one component each.
    const r = parseBundle(j({ meta: META, trees: { main_j: tree(), inner_j: tree() } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rawComponents.filter((c) => c.kind === "journey").map((c) => c.id)).toEqual([
      "main_j",
      "inner_j",
    ]);
    expect(
      r.rawComponents
        .filter((c) => c.kind === "script")
        .map((c) => c.id)
        .sort(),
    ).toEqual(["s1", "s2"]);
  });

  it("first-seen-wins when two trees carry the SAME leaf id (D46 realm bundle)", () => {
    // A realm export bundles every tree from ONE realm, so a given id resolves to
    // exactly one entity — both copies are byte-identical and first-seen-wins is
    // therefore lossless. This pins that assumption: if a future bundle ever mixed
    // realms (or merged two exports), the dedupe would silently drop the second
    // copy, and this test is where that shows up.
    const treeA = tree({ scripts: { s1: { _id: "s1", name: "shared", script: '"A"' } } });
    const treeB = tree({ scripts: { s1: { _id: "s1", name: "shared", script: '"B"' } } });
    const r = parseBundle(j({ meta: META, trees: { a_j: treeA, b_j: treeB } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const scripts = r.rawComponents.filter((c) => c.kind === "script");
    expect(scripts).toHaveLength(1);
    expect(scripts[0].raw.script).toBe('"A"'); // the FIRST tree's copy wins
  });

  it("surfaces referenced (not-bundled) inner journeys from content (PD-18)", () => {
    const withInnerRef = tree({
      nodes: { e1: { _id: "e1", tree: "MFA", _type: { _id: "InnerTreeEvaluatorNode" } } },
    });
    // level1: MFA referenced but not bundled → a preview line.
    const lvl1 = parseBundle(j({ meta: META, trees: { main_j: withInnerRef } }));
    expect(lvl1.ok).toBe(true);
    if (!lvl1.ok) return;
    expect(lvl1.bundle.inventory).toContain(
      "References inner journeys (must exist on target): MFA",
    );
    // allLevels: MFA bundled → no "references" line.
    const all = parseBundle(j({ meta: META, trees: { main_j: withInnerRef, MFA: tree() } }));
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.bundle.inventory.some((l) => l.startsWith("References inner journeys"))).toBe(false);
  });
});

describe("parseBundle — errors", () => {
  it("rejects invalid JSON", () => {
    const r = parseBundle("{ not json");
    expect(r).toEqual({ ok: false, error: expect.stringContaining("valid JSON") });
  });

  it("rejects an unrecognized shape", () => {
    const r = parseBundle(j({ meta: META, somethingElse: { x: {} } }));
    expect(r.ok).toBe(false);
  });

  it("rejects a bundle mixing multiple component types", () => {
    const r = parseBundle(j({ theme: { t: {} }, script: { s: {} } }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("multiple component types");
  });
});

describe("parseBundle — rawComponents (extension-side compare payload)", () => {
  it("carries the raw leaf object + identity for each component", () => {
    const raw = { _id: "tid", name: "T", backgroundColor: "#1" };
    const r = parseBundle(j({ meta: META, theme: { tid: raw } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rawComponents).toEqual([{ kind: "theme", id: "tid", displayName: "T", raw }]);
  });

  it("extracts every entry of a multi-component leaf bundle", () => {
    const r = parseBundle(j({ script: { a: { name: "a" }, b: { name: "b" } } }));
    expect(r.ok && r.rawComponents.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("decomposes a journey bundle into a journey unit (nodes folded in raw)", () => {
    const r = parseBundle(j({ trees: { a: { tree: { _id: "a" }, nodes: {}, innerNodes: {} } } }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rawComponents).toEqual([
      {
        kind: "journey",
        id: "a",
        displayName: "a",
        raw: { tree: { _id: "a" }, nodes: {}, innerNodes: {} },
      },
    ]);
  });
});

describe("parseBundle — ESV preview", () => {
  it("decodes the variable value for the preview", () => {
    // "ZXhwb3J0LXRlc3Q=" === base64("export-test")
    const r = parseBundle(
      j({ meta: META, variable: { "esv-x": { _id: "esv-x", valueBase64: "ZXhwb3J0LXRlc3Q=" } } }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundle.components[0].detail).toBe("value: export-test");
  });

  it("marks a secret as supplied-at-import (no value in the bundle)", () => {
    const r = parseBundle(j({ meta: META, secret: { "esv-s": { _id: "esv-s" } } }));
    expect(r.ok && r.bundle.components[0].detail).toBe("value supplied at import");
  });
});
