import { describe, expect, it } from "vitest";
import { journeyUnitIdentical, targetNodeFetchList } from "./journey-compare";

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
