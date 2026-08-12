import { describe, expect, it } from "vitest";
import { EXACT_COMPARE, journeyUnitIdentical, targetNodeFetchList } from "./journey-compare";

const NO_REMAP = new Map<string, string>();

/** A minimal bundle journey unit: a tree skeleton + one ScriptedDecisionNode. */
function unit(scriptId: string, extraTree: Record<string, unknown> = {}) {
  return {
    tree: {
      _id: "zzz_inner",
      entryNodeId: "n1",
      nodes: { n1: { nodeType: "ScriptedDecisionNode", connections: { true: "success" } } },
      ...extraTree,
    },
    nodes: {
      n1: {
        _id: "n1",
        _type: { _id: "ScriptedDecisionNode" },
        script: scriptId,
        outcomes: ["true"],
      },
    },
    innerNodes: {},
  };
}

describe("journeyUnitIdentical", () => {
  it("is identical when the tree skeleton and node bodies match", () => {
    const u = unit("script-A");
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    expect(journeyUnitIdentical(u, { ...u.tree }, target, NO_REMAP)).toBe(true);
  });

  it("is not identical when the journey is absent on the target (null tree)", () => {
    const u = unit("script-A");
    expect(journeyUnitIdentical(u, null, new Map(), NO_REMAP)).toBe(false);
  });

  it("differs when the tree skeleton differs (rewired connection)", () => {
    const u = unit("script-A");
    const targetTree = {
      ...u.tree,
      nodes: { n1: { nodeType: "ScriptedDecisionNode", connections: { true: "failure" } } },
    };
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    expect(journeyUnitIdentical(u, targetTree, target, NO_REMAP)).toBe(false);
  });

  it("differs when a node body differs (node re-pointed to another script)", () => {
    const u = unit("script-A");
    const target = new Map([["n1", { ...u.nodes.n1, script: "script-B" }]]);
    expect(journeyUnitIdentical(u, { ...u.tree }, target, NO_REMAP)).toBe(false);
  });

  it("differs when a node the bundle writes is missing on the target", () => {
    const u = unit("script-A");
    const target = new Map<string, Record<string, unknown> | null>([["n1", null]]);
    expect(journeyUnitIdentical(u, { ...u.tree }, target, NO_REMAP)).toBe(false);
  });

  it("remaps the bundle's script UUID to the target's before comparing (TD-9)", () => {
    // Bundle node points at the bundle script UUID; the target node holds the
    // reconciled target UUID. With the same remap the writer uses, they match.
    const u = unit("bundle-uuid");
    const target = new Map([["n1", { ...u.nodes.n1, script: "target-uuid" }]]);
    const remap = new Map([["bundle-uuid", "target-uuid"]]);
    expect(journeyUnitIdentical(u, { ...u.tree }, target, remap)).toBe(true);
    // …and WITHOUT the remap the raw UUIDs differ → not identical (the PD-5 trap).
    expect(journeyUnitIdentical(u, { ...u.tree }, target, NO_REMAP)).toBe(false);
  });

  // AM's `<field>-encrypted` companions. A bundle exported BEFORE we started
  // stripping them still carries e.g. `password-encrypted`; a target read today
  // never can, because `getRawNode` strips on read. Without the strip in `canon`
  // that asymmetry makes every affected journey read as changed forever.
  it("is identical when only the bundle carries a `-encrypted` companion (pre-fix bundle)", () => {
    const u = unit("script-A");
    const bundle = {
      ...u,
      nodes: { n1: { ...u.nodes.n1, password: null, "password-encrypted": "AQICblob==" } },
    };
    const target = new Map([["n1", { ...u.nodes.n1, password: null }]]);
    expect(journeyUnitIdentical(bundle, { ...u.tree }, target, NO_REMAP)).toBe(true);
  });

  it("is identical when only the TARGET carries one (bundle exported post-fix)", () => {
    const u = unit("script-A");
    const target = new Map([["n1", { ...u.nodes.n1, "password-encrypted": "AQICblob==" }]]);
    expect(journeyUnitIdentical(u, { ...u.tree }, target, NO_REMAP)).toBe(true);
  });

  it("strips the companion inside the tree skeleton too, not just node bodies", () => {
    const u = unit("script-A");
    const targetTree = { ...u.tree, "somefield-encrypted": "blob" };
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    expect(journeyUnitIdentical(u, targetTree, target, NO_REMAP)).toBe(true);
  });

  // The guard that matters most: the strip must not make genuinely different
  // journeys look the same. A silent false "Identical" is worse than the 500.
  it("STILL detects a real difference when both sides carry companions", () => {
    const u = unit("script-A");
    const bundle = {
      ...u,
      nodes: { n1: { ...u.nodes.n1, hostName: "smtp-dev", "password-encrypted": "AAA" } },
    };
    const target = new Map([
      ["n1", { ...u.nodes.n1, hostName: "smtp-prod", "password-encrypted": "BBB" }],
    ]);
    expect(journeyUnitIdentical(bundle, { ...u.tree }, target, NO_REMAP)).toBe(false);
  });

  it("does not treat a differing plaintext companion as noise", () => {
    // `password` (no suffix) is a real writable field — a difference must surface.
    const u = unit("script-A");
    const bundle = { ...u, nodes: { n1: { ...u.nodes.n1, password: null } } };
    const target = new Map([["n1", { ...u.nodes.n1, password: "set-on-target" }]]);
    expect(journeyUnitIdentical(bundle, { ...u.tree }, target, NO_REMAP)).toBe(false);
  });

  // The round-trip bug: our importer sends the bundle's `password: null`; AM
  // stores nothing and omits the key on read-back. Without null ≡ absent, a
  // journey WE imported never compares Identical against its own bundle, and
  // Overwrite can't settle it (the next write recreates the asymmetry).
  it("is identical when the bundle has a null field the target omits (our own import)", () => {
    const u = unit("script-A");
    const bundle = { ...u, nodes: { n1: { ...u.nodes.n1, password: null } } };
    const target = new Map([["n1", { ...u.nodes.n1 }]]); // AM dropped the key
    expect(journeyUnitIdentical(bundle, { ...u.tree }, target, NO_REMAP)).toBe(true);
  });

  it("is identical in the reverse direction too (target null, bundle omits)", () => {
    const u = unit("script-A");
    const target = new Map([["n1", { ...u.nodes.n1, password: null }]]);
    expect(journeyUnitIdentical(u, { ...u.tree }, target, NO_REMAP)).toBe(true);
  });

  it("STILL differs when the target holds a real value against a bundle null", () => {
    const u = unit("script-A");
    const bundle = { ...u, nodes: { n1: { ...u.nodes.n1, password: null } } };
    const target = new Map([["n1", { ...u.nodes.n1, password: "actually-set" }]]);
    expect(journeyUnitIdentical(bundle, { ...u.tree }, target, NO_REMAP)).toBe(false);
  });

  // ── Compare options (poc/proposals/compare-options.md) ─────────────────────
  // Three opt-in relaxations. Default is EXACT: nothing relaxes unless asked,
  // and each option must relax ONLY its own field.

  const OPT = {
    positions: { ...EXACT_COMPARE, ignoreNodePositions: true },
    names: { ...EXACT_COMPARE, ignoreNodeDisplayNames: true },
    tags: { ...EXACT_COMPARE, ignoreJourneyTags: true },
    all: {
      ignoreNodePositions: true,
      ignoreNodeDisplayNames: true,
      ignoreJourneyTags: true,
    },
  };

  it("defaults to EXACT — a dragged node differs with no options", () => {
    const u = unit("script-A");
    const targetTree = {
      ...u.tree,
      nodes: { n1: { ...u.tree.nodes.n1, x: 99, y: 99 } },
      staticNodes: { startNode: { x: 1, y: 2 } },
    };
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    const bundle = {
      ...u,
      tree: {
        ...u.tree,
        nodes: { n1: { ...u.tree.nodes.n1, x: 10, y: 10 } },
        staticNodes: { startNode: { x: 3, y: 4 } },
      },
    };
    expect(journeyUnitIdentical(bundle, targetTree, target, NO_REMAP)).toBe(false);
    expect(journeyUnitIdentical(bundle, targetTree, target, NO_REMAP, OPT.positions)).toBe(true);
  });

  it("ignoreNodePositions covers staticNodes as well as node refs", () => {
    const u = unit("script-A");
    const bundle = { ...u, tree: { ...u.tree, staticNodes: { startNode: { x: 50.1, y: 80 } } } };
    const targetTree = { ...u.tree, staticNodes: { startNode: { x: 50, y: 80 } } };
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    expect(journeyUnitIdentical(bundle, targetTree, target, NO_REMAP)).toBe(false);
    expect(journeyUnitIdentical(bundle, targetTree, target, NO_REMAP, OPT.positions)).toBe(true);
  });

  it("ignoreNodeDisplayNames covers tree node refs", () => {
    const u = unit("script-A");
    const targetTree = { ...u.tree, nodes: { n1: { ...u.tree.nodes.n1, displayName: "Renamed" } } };
    const bundleTree = {
      ...u.tree,
      nodes: { n1: { ...u.tree.nodes.n1, displayName: "Original" } },
    };
    const bundle = { ...u, tree: bundleTree };
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    expect(journeyUnitIdentical(bundle, targetTree, target, NO_REMAP)).toBe(false);
    expect(journeyUnitIdentical(bundle, targetTree, target, NO_REMAP, OPT.names)).toBe(true);
  });

  it("ignoreNodeDisplayNames ALSO covers PageNode page-children", () => {
    // Both paths matter: cover only the tree skeleton and renaming a page child
    // still reads as drift, which looks like a broken option.
    const u = unit("script-A");
    const page = (label: string) => ({
      _id: "n1",
      _type: { _id: "PageNode" },
      nodes: [{ _id: "c1", nodeType: "UsernameCollectorNode", displayName: label }],
    });
    const bundle = { ...u, nodes: { n1: page("Username Collector") } };
    const target = new Map([["n1", page("Renamed Collector")]]);
    expect(journeyUnitIdentical(bundle, { ...u.tree }, target, NO_REMAP)).toBe(false);
    expect(journeyUnitIdentical(bundle, { ...u.tree }, target, NO_REMAP, OPT.names)).toBe(true);
  });

  it("ignoreNodeDisplayNames must NOT touch _outcomes labels (behavioural)", () => {
    // Scripts branch on outcomes (`action.goTo(...)`), so an outcome change is a
    // real difference. A naive recursive displayName strip would hide it.
    const u = unit("script-A");
    const withOutcome = (label: string) => ({
      ...u.nodes.n1,
      _outcomes: [{ id: "true", displayName: label }],
    });
    const bundle = { ...u, nodes: { n1: withOutcome("True") } };
    const target = new Map([["n1", withOutcome("Yes")]]);
    expect(journeyUnitIdentical(bundle, { ...u.tree }, target, NO_REMAP, OPT.names)).toBe(false);
    expect(journeyUnitIdentical(bundle, { ...u.tree }, target, NO_REMAP, OPT.all)).toBe(false);
  });

  it("ignoreJourneyTags drops uiConfig.categories", () => {
    const u = unit("script-A");
    const bundle = {
      ...u,
      tree: { ...u.tree, uiConfig: { categories: '["Authentication","MFA"]' } },
    };
    const targetTree = { ...u.tree, uiConfig: {} };
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    expect(journeyUnitIdentical(bundle, targetTree, target, NO_REMAP)).toBe(false);
    expect(journeyUnitIdentical(bundle, targetTree, target, NO_REMAP, OPT.tags)).toBe(true);
  });

  it("ignoreJourneyTags equates a tags-only uiConfig with no uiConfig at all", () => {
    const u = unit("script-A");
    const bundle = { ...u, tree: { ...u.tree, uiConfig: { categories: '["X"]' } } };
    const targetTree = { ...u.tree }; // no uiConfig key at all
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    expect(journeyUnitIdentical(bundle, targetTree, target, NO_REMAP, OPT.tags)).toBe(true);
  });

  it("ignoreJourneyTags keeps other uiConfig keys comparable", () => {
    const u = unit("script-A");
    const bundle = { ...u, tree: { ...u.tree, uiConfig: { categories: '["X"]', other: "a" } } };
    const targetTree = { ...u.tree, uiConfig: { categories: '["Y"]', other: "b" } };
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    expect(journeyUnitIdentical(bundle, targetTree, target, NO_REMAP, OPT.tags)).toBe(false);
  });

  it("each option relaxes ONLY its own field", () => {
    const u = unit("script-A");
    const bundle = {
      ...u,
      tree: {
        ...u.tree,
        nodes: { n1: { ...u.tree.nodes.n1, x: 1, displayName: "A" } },
        uiConfig: { categories: '["X"]' },
      },
    };
    const targetTree = {
      ...u.tree,
      nodes: { n1: { ...u.tree.nodes.n1, x: 2, displayName: "B" } },
      uiConfig: { categories: '["Y"]' },
    };
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    const id = (o?: typeof EXACT_COMPARE) =>
      journeyUnitIdentical(bundle, targetTree, target, NO_REMAP, o);
    expect(id(OPT.positions)).toBe(false); // names + tags still differ
    expect(id(OPT.names)).toBe(false); // positions + tags still differ
    expect(id(OPT.tags)).toBe(false); // positions + names still differ
    expect(id(OPT.all)).toBe(true); // all three relaxed → identical
  });

  it("STILL detects a real config difference with every option on", () => {
    // The guard that matters: relaxations must never swallow behaviour.
    const u = unit("script-A");
    const bundle = { ...u, nodes: { n1: { ...u.nodes.n1, hostName: "smtp-dev" } } };
    const target = new Map([["n1", { ...u.nodes.n1, hostName: "smtp-prod" }]]);
    expect(journeyUnitIdentical(bundle, { ...u.tree }, target, NO_REMAP, OPT.all)).toBe(false);
  });

  it("STILL detects rewired connections with every option on", () => {
    const u = unit("script-A");
    const targetTree = {
      ...u.tree,
      nodes: { n1: { ...u.tree.nodes.n1, connections: { true: "failure" } } },
    };
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    expect(journeyUnitIdentical(u, targetTree, target, NO_REMAP, OPT.all)).toBe(false);
  });

  it("does not mutate the inputs it relaxes", () => {
    const u = unit("script-A");
    const bundle = {
      ...u,
      tree: { ...u.tree, nodes: { n1: { ...u.tree.nodes.n1, x: 1, displayName: "A" } } },
    };
    const targetTree = { ...u.tree, uiConfig: { categories: '["X"]' } };
    const target = new Map([["n1", { ...u.nodes.n1 }]]);
    journeyUnitIdentical(bundle, targetTree, target, NO_REMAP, OPT.all);
    expect(bundle.tree.nodes.n1).toHaveProperty("x", 1);
    expect(bundle.tree.nodes.n1).toHaveProperty("displayName", "A");
    expect(targetTree.uiConfig).toEqual({ categories: '["X"]' });
  });

  it("ignores _rev / audit / _type echo noise the target read adds", () => {
    const u = unit("script-A");
    const targetTree = { ...u.tree, _rev: "99", lastModifiedDate: "2026-01-01" };
    const target = new Map([
      [
        "n1",
        {
          ...u.nodes.n1,
          _rev: "7",
          createdBy: "someone",
          _type: { _id: "ScriptedDecisionNode", name: "Scripted Decision", collection: true },
        },
      ],
    ]);
    expect(journeyUnitIdentical(u, targetTree, target, NO_REMAP)).toBe(true);
  });
});

describe("journeyUnitIdentical — on-prem node shapes (C1)", () => {
  // Mirrors bundles/onprem/zzz_export_test.journey_onprem_all.json: a PageNode
  // (with `_outcomes` + child refs), an InnerTreeEvaluatorNode, a page-child.
  const onpremUnit = () => ({
    tree: {
      _id: "zzz_export_test",
      entryNodeId: "page1",
      nodes: {
        page1: { nodeType: "PageNode", connections: { outcome: "inner1" } },
        inner1: { nodeType: "InnerTreeEvaluatorNode", connections: { true: "success" } },
      },
    },
    nodes: {
      page1: {
        _id: "page1",
        _type: { _id: "PageNode" },
        _outcomes: [{ id: "outcome", displayName: "Outcome" }],
        nodes: [{ _id: "child1", nodeType: "TextInputCollectorNode", displayName: "User" }],
        pageHeader: "Sign in",
      },
      inner1: {
        _id: "inner1",
        _type: { _id: "InnerTreeEvaluatorNode" },
        _outcomes: [{ id: "true", displayName: "True" }],
        tree: "zzz_export_test_inner",
      },
    },
    innerNodes: {
      child1: {
        _id: "child1",
        _type: { _id: "TextInputCollectorNode" },
        identityAttribute: "mail",
      },
    },
  });

  it("is identical when an on-prem journey round-trips cleanly (PageNode/_outcomes/InnerTree)", () => {
    const u = onpremUnit();
    const targetTree = { ...u.tree };
    const target = new Map<string, Record<string, unknown> | null>([
      ["page1", { ...u.nodes.page1 }],
      ["inner1", { ...u.nodes.inner1 }],
      ["child1", { ...u.innerNodes.child1 }],
    ]);
    expect(journeyUnitIdentical(u, targetTree, target, NO_REMAP)).toBe(true);
  });

  it("differs when the InnerTreeEvaluatorNode points at a different inner tree", () => {
    const u = onpremUnit();
    const target = new Map<string, Record<string, unknown> | null>([
      ["page1", { ...u.nodes.page1 }],
      ["inner1", { ...u.nodes.inner1, tree: "some_other_tree" }],
      ["child1", { ...u.innerNodes.child1 }],
    ]);
    expect(journeyUnitIdentical(u, { ...u.tree }, target, NO_REMAP)).toBe(false);
  });
});

describe("targetNodeFetchList", () => {
  it("yields [nodeType, nodeId] pairs from each node's _type._id (page-children + top-level)", () => {
    const raw = {
      tree: {},
      nodes: { n1: { _type: { _id: "ScriptedDecisionNode" } } },
      innerNodes: { c1: { _type: { _id: "TextInputCollectorNode" } } },
    };
    expect(targetNodeFetchList(raw).sort()).toEqual([
      ["ScriptedDecisionNode", "n1"],
      ["TextInputCollectorNode", "c1"],
    ]);
  });

  it("skips a node missing _type._id", () => {
    const raw = { tree: {}, nodes: { n1: { script: "x" } }, innerNodes: {} };
    expect(targetNodeFetchList(raw)).toEqual([]);
  });
});
