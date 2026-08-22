import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@/domain/types";
import { buildJourneyBundle } from "@/export/journey-bundle";
import type { PaicClient } from "@/paic/client";

const CONN: Connection = { kind: "paic", host: "h", saId: "sa" };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

interface Fixture {
  journeys: Record<string, unknown>;
  nodes: Record<string, unknown>;
  scripts: Record<string, unknown>;
  scriptsByName: Record<string, unknown>;
  themes: Record<string, unknown>;
  emails: Record<string, unknown>;
  idps: Record<string, unknown>;
}

function makeClient(fx: Fixture): PaicClient {
  const find = (m: Record<string, unknown>, k: string, label: string) =>
    m[k] === undefined ? Promise.reject(new Error(`404 ${label} ${k}`)) : Promise.resolve(m[k]);
  return {
    getRawJourney: vi.fn((_r: string, id: string) => find(fx.journeys, id, "journey")),
    getRawNode: vi.fn((_r: string, _t: string, id: string) => find(fx.nodes, id, "node")),
    getRawScript: vi.fn((_r: string, id: string) => find(fx.scripts, id, "script")),
    getRawScriptByName: vi.fn((_r: string, name: string) =>
      Promise.resolve(fx.scriptsByName[name] ?? null),
    ),
    getRawTheme: vi.fn((_r: string, id: string) => Promise.resolve(fx.themes[id] ?? null)),
    getRawEmailTemplate: vi.fn((name: string) => Promise.resolve(fx.emails[name] ?? null)),
    getRawSocialIdp: vi.fn((_r: string, name: string) => Promise.resolve(fx.idps[name] ?? null)),
  } as unknown as PaicClient;
}

const noop = () => undefined;
// biome-ignore lint/suspicious/noExplicitAny: tiny noop logger fake
const log: any = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  child: () => log,
};

function baseFixture(): Fixture {
  return {
    journeys: {
      main: {
        _id: "main",
        _rev: "5",
        entryNodeId: "n1",
        nodes: {
          n1: { nodeType: "PageNode" },
          n2: { nodeType: "InnerTreeEvaluatorNode" },
          n3: { nodeType: "EmailSuspendNode" },
          n4: { nodeType: "SelectIdPNode" },
        },
      },
      inner: {
        _id: "inner",
        entryNodeId: "i1",
        nodes: { i1: { nodeType: "ScriptedDecisionNode" } },
      },
    },
    nodes: {
      n1: {
        _id: "n1",
        _rev: "1",
        _type: { _id: "PageNode" },
        nodes: [{ _id: "c1", nodeType: "ScriptedDecisionNode" }],
        stage: '{"themeId":"t1"}',
      },
      n2: { _id: "n2", _type: { _id: "InnerTreeEvaluatorNode" }, tree: "inner" },
      n3: { _id: "n3", _type: { _id: "EmailSuspendNode" }, emailTemplateName: "welcome" },
      n4: { _id: "n4", _type: { _id: "SelectIdPNode" }, filteredProviders: ["google"] },
      c1: { _id: "c1", _type: { _id: "ScriptedDecisionNode" }, script: "sMain" },
      i1: { _id: "i1", _type: { _id: "ScriptedDecisionNode" }, script: "sInner" },
    },
    scripts: {
      sMain: {
        _id: "sMain",
        _rev: "9",
        name: "decision",
        language: "JAVASCRIPT",
        context: "AUTHENTICATION_TREE_DECISION_NODE",
        script: b64('var lib = require("helpers"); var x = "esv.foo";'),
      },
      sInner: {
        _id: "sInner",
        name: "inner-decision",
        language: "JAVASCRIPT",
        context: "AUTHENTICATION_TREE_DECISION_NODE",
        script: b64("// inner"),
      },
    },
    scriptsByName: {
      helpers: {
        _id: "helpers-id",
        name: "helpers",
        language: "JAVASCRIPT",
        context: "LIBRARY",
        script: b64('var u = require("utils");'),
      },
      utils: {
        _id: "utils-id",
        name: "utils",
        language: "JAVASCRIPT",
        context: "LIBRARY",
        script: b64("// utils"),
      },
    },
    themes: { t1: { _id: "t1", _rev: "2", name: "Theme1" } },
    emails: { welcome: { _id: "emailTemplate/welcome", enabled: true } },
    idps: { google: { _id: "google", _type: { _id: "googleConfig" }, clientSecret: null } },
  };
}

describe("buildJourneyBundle — level1", () => {
  it("bundles the selected tree with its leaf deps; the inner journey is referenced, not bundled", async () => {
    const bundle = await buildJourneyBundle(
      makeClient(baseFixture()),
      CONN,
      "alpha",
      "main",
      "level1",
      "0.3.0",
      "2026-06-11T00:00:00.000Z",
      log,
    );
    if (!bundle) throw new Error("expected a bundle");

    expect(Object.keys(bundle.trees)).toEqual(["main"]);
    const t = bundle.trees.main;
    expect(Object.keys(t.nodes).sort()).toEqual(["n1", "n2", "n3", "n4"]);
    expect(Object.keys(t.innerNodes)).toEqual(["c1"]); // PageNode child
    // scripts include the decision + transitive libraries (helpers → utils)
    expect(Object.keys(t.scripts).sort()).toEqual(["helpers-id", "sMain", "utils-id"]);
    expect(Object.keys(t.themes)).toEqual(["t1"]);
    expect(Object.keys(t.emailTemplates)).toEqual(["emailTemplate/welcome"]);
    expect(Object.keys(t.socialIdentityProviders)).toEqual(["google"]);

    // level1: the inner journey is referenced (by InnerTreeEvaluatorNode), not bundled.
    expect(bundle.trees.inner).toBeUndefined();
    // meta = provenance + informational depthMode only (PD-18 — no derived manifest).
    expect(bundle.meta.depthMode).toBe("level1");
    expect(bundle.meta).not.toHaveProperty("requires");
    expect(bundle.meta).not.toHaveProperty("treesSelectedForExport");
    expect(bundle.meta).not.toHaveProperty("innerTreesIncluded");
  });

  it("strips mask fields and decodes the script body", async () => {
    const bundle = await buildJourneyBundle(
      makeClient(baseFixture()),
      CONN,
      "alpha",
      "main",
      "level1",
      "0.3.0",
      "2026-06-11T00:00:00.000Z",
      log,
    );
    const t = bundle?.trees.main;
    expect(t?.tree).not.toHaveProperty("_rev");
    expect(t?.nodes.n1).not.toHaveProperty("_rev");
    expect(t?.scripts.sMain).not.toHaveProperty("_rev");
    expect(t?.scripts.sMain.script).toBe(
      JSON.stringify('var lib = require("helpers"); var x = "esv.foo";'),
    );
  });
});

describe("buildJourneyBundle — allLevels", () => {
  it("bundles the inner journey as a sibling tree (allLevels closure)", async () => {
    const bundle = await buildJourneyBundle(
      makeClient(baseFixture()),
      CONN,
      "alpha",
      "main",
      "allLevels",
      "0.3.0",
      "2026-06-11T00:00:00.000Z",
      log,
    );
    if (!bundle) throw new Error("expected a bundle");
    expect(Object.keys(bundle.trees).sort()).toEqual(["inner", "main"]);
    expect(Object.keys(bundle.trees.inner.scripts)).toEqual(["sInner"]);
    // meta = provenance + informational depthMode only (PD-18).
    expect(bundle.meta.depthMode).toBe("allLevels");
    expect(bundle.meta).not.toHaveProperty("requires");
  });

  it("terminates on a cycle (inner → main → inner)", async () => {
    const fx = baseFixture();
    // make the inner journey reference main back via an InnerTreeEvaluatorNode
    (fx.journeys.inner as { nodes: Record<string, unknown> }).nodes.i2 = {
      nodeType: "InnerTreeEvaluatorNode",
    };
    fx.nodes.i2 = { _id: "i2", _type: { _id: "InnerTreeEvaluatorNode" }, tree: "main" };

    const bundle = await buildJourneyBundle(
      makeClient(fx),
      CONN,
      "alpha",
      "main",
      "allLevels",
      "0.3.0",
      "2026-06-11T00:00:00.000Z",
      log,
    );
    expect(Object.keys(bundle?.trees ?? {}).sort()).toEqual(["inner", "main"]); // each once
  });
});

describe("buildJourneyBundle — missing journey", () => {
  it("returns null when the selected journey 404s", async () => {
    const bundle = await buildJourneyBundle(
      makeClient(baseFixture()),
      CONN,
      "alpha",
      "nope",
      "level1",
      "0.3.0",
      "2026-06-11T00:00:00.000Z",
      log,
    );
    expect(bundle).toBeNull();
  });
  it("allLevels fetches a script shared by two trees only once (D46 cache)", () => {
    // The outer tree and its inner tree both reference the same script; the
    // per-export fetch cache collapses that to one request while BOTH trees keep
    // their own copy in the bundle (interop — never dedupe the output).
    const fx = baseFixture();
    // Point the inner tree's decision node at the SAME script as the outer one.
    (fx.nodes.i1 as Record<string, unknown>).script = "sMain";
    const client = makeClient(fx);
    return buildJourneyBundle(client, CONN, "alpha", "main", "allLevels", "1.0.0", "NOW", log).then(
      (bundle) => {
        expect(client.getRawScript).toHaveBeenCalledTimes(1);
        expect(bundle?.trees.main.scripts.sMain).toBeDefined();
        expect(bundle?.trees.inner.scripts.sMain).toBeDefined();
      },
    );
  });
});
