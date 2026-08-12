import { describe, expect, it, vi } from "vitest";
import { PaicError } from "../paic/errors";
import type { ComponentVerdict } from "./compare";
import type { DiscoveredRef } from "./discover";
import { EXACT_COMPARE } from "./journey-compare";
import type { ImportComponent } from "./parse";
import {
  checkJourneyGates,
  computeIdenticalJourneys,
  discoverDeps,
  findIdenticalJourneys,
  missingDepsNote,
  type PreflightClient,
  type RequiredDepVerdict,
  readJourneyCompareInputs,
  runPreflight,
} from "./preflight";

/** A fake `PreflightClient` — all accessors return `null`/`[]` (absent) unless
 * overridden. Overrides return plain objects (cast through `unknown`). */
function client(over: Record<string, () => Promise<unknown>> = {}): PreflightClient {
  return {
    getRawTheme: async () => null,
    getRawEmailTemplate: async () => null,
    getRawSocialIdp: async () => null,
    getRawScriptByName: async () => null,
    findRawScriptsByName: async () => [],
    // getRawScript throws on 404 (UUID free) by default — the safe-create case.
    getRawScript: () => Promise.reject(new Error("404 not found")),
    getRawEsv: async () => null,
    listVariables: async () => [],
    listSecrets: async () => [],
    getNodeTypes: async () => [],
    listTrees: async () => [],
    // getRawJourney throws a 404 (tree absent → "new") by default.
    getRawJourney: () => Promise.reject(new PaicError("not found", { status: 404 })),
    // getRawNode throws a 404 by default (node absent → not identical).
    getRawNode: () => Promise.reject(new PaicError("not found", { status: 404 })),
    ...over,
  } as unknown as PreflightClient;
}

const comp = (over: Partial<ImportComponent>): ImportComponent => ({
  kind: "theme",
  id: "t",
  displayName: "T",
  raw: {},
  ...over,
});

describe("runPreflight", () => {
  it("unsupported (and no fetch) for an IDM leaf on an on-prem target", async () => {
    const getRawTheme = vi.fn(async () => null);
    const v = await runPreflight(client({ getRawTheme }), "root", "onprem", [
      comp({ kind: "theme" }),
    ]);
    expect(v[0].status).toBe("unsupported");
    expect(getRawTheme).not.toHaveBeenCalled();
  });

  it("new when the accessor returns null", async () => {
    const v = await runPreflight(client(), "alpha", "paic", [
      comp({ kind: "theme", raw: { backgroundColor: "#1" } }),
    ]);
    expect(v[0].status).toBe("new");
  });

  it("identical / differs for a value-compared theme", async () => {
    const same = await runPreflight(
      client({ getRawTheme: async () => ({ _id: "z", _rev: "9", backgroundColor: "#1" }) }),
      "alpha",
      "paic",
      [comp({ kind: "theme", id: "t", raw: { _id: "t", backgroundColor: "#1" } })],
    );
    expect(same[0].status).toBe("identical");

    const diff = await runPreflight(
      client({ getRawTheme: async () => ({ backgroundColor: "#2" }) }),
      "alpha",
      "paic",
      [comp({ kind: "theme", raw: { backgroundColor: "#1" } })],
    );
    expect(diff[0].status).toBe("differs");
  });

  it("journey exists when the target tree is present (existence-only)", async () => {
    const getRawJourney = vi.fn(async () => ({ _id: "Login", entryNodeId: "a" }));
    const v = await runPreflight(client({ getRawJourney }), "alpha", "paic", [
      comp({ kind: "journey", id: "Login", displayName: "Login", raw: { tree: {}, nodes: {} } }),
    ]);
    expect(v[0].status).toBe("exists");
    expect(getRawJourney).toHaveBeenCalledWith("alpha", "Login");
  });

  it("journey new when getRawJourney 404s (caught, not surfaced as error)", async () => {
    const v = await runPreflight(
      client({ getRawJourney: () => Promise.reject(new PaicError("nope", { status: 404 })) }),
      "alpha",
      "paic",
      [comp({ kind: "journey", id: "Missing", displayName: "Missing", raw: { tree: {} } })],
    );
    expect(v[0].status).toBe("new");
  });

  it("library script existence via findRawScriptsByName → exists; carries resolved id", async () => {
    const findRawScriptsByName = vi.fn(async () => [{ _id: "target-uuid", name: "lib" }]);
    const v = await runPreflight(client({ findRawScriptsByName }), "alpha", "paic", [
      comp({ kind: "script", id: "bundle-uuid", raw: { name: "lib", context: "LIBRARY" } }),
    ]);
    expect(v[0].status).toBe("exists");
    expect(v[0].resolvedTargetId).toBe("target-uuid"); // TD-9: write reconciles to this
    expect(v[0].targetMatchCount).toBe(1);
    expect(findRawScriptsByName).toHaveBeenCalledWith("alpha", "lib");
  });

  it("decision script value-compares → differs on body (matched by name)", async () => {
    const findRawScriptsByName = vi.fn(async () => [
      { _id: "s", name: "d", script: Buffer.from("// b", "utf8").toString("base64") },
    ]);
    const v = await runPreflight(client({ findRawScriptsByName }), "alpha", "paic", [
      comp({ kind: "script", id: "s", raw: { name: "d", script: JSON.stringify("// a") } }),
    ]);
    expect(v[0].status).toBe("differs");
  });

  it("script absent on target → new, no resolved id", async () => {
    const v = await runPreflight(client(), "alpha", "paic", [
      comp({ kind: "script", id: "s", raw: { name: "d", script: JSON.stringify("// a") } }),
    ]);
    expect(v[0].status).toBe("new");
    expect(v[0].resolvedTargetId).toBeUndefined();
    expect(v[0].targetMatchCount).toBe(0);
  });

  it("dup-named script on target → match count > 1 (first hit drives compare)", async () => {
    const findRawScriptsByName = vi.fn(async () => [
      { _id: "first", name: "d", script: Buffer.from("x", "utf8").toString("base64") },
      { _id: "second", name: "d" },
    ]);
    const v = await runPreflight(client({ findRawScriptsByName }), "alpha", "paic", [
      comp({ kind: "script", id: "s", raw: { name: "d", script: JSON.stringify("x") } }),
    ]);
    expect(v[0].resolvedTargetId).toBe("first");
    expect(v[0].targetMatchCount).toBe(2);
  });

  it("create whose bundle UUID is held by a DIFFERENT-named script → id-collision", async () => {
    // No name match (findRawScriptsByName empty → new), but the bundle UUID is
    // occupied on the target by a differently-named script.
    const getRawScript = vi.fn(async () => ({ _id: "U1", name: "Bar" }));
    const v = await runPreflight(client({ getRawScript }), "alpha", "paic", [
      comp({
        kind: "script",
        id: "U1",
        raw: { _id: "U1", name: "Foo", script: JSON.stringify("x") },
      }),
    ]);
    expect(v[0].status).toBe("id-collision");
    expect(v[0].message).toMatch(/Bar/);
    expect(getRawScript).toHaveBeenCalledWith("alpha", "U1");
  });

  it("create whose bundle UUID is free (getRawScript 404) → stays new", async () => {
    // Default fake's getRawScript throws (404) → UUID free → safe create.
    const v = await runPreflight(client(), "alpha", "paic", [
      comp({
        kind: "script",
        id: "U2",
        raw: { _id: "U2", name: "Foo", script: JSON.stringify("x") },
      }),
    ]);
    expect(v[0].status).toBe("new");
  });

  it("variable/secret discovered-kind mismatch → new", async () => {
    // The bundle is a secret, but getRawEsv discovers a variable of that name.
    const v = await runPreflight(
      client({ getRawEsv: async () => ({ kind: "variable", raw: { _id: "esv-x" } }) }),
      "alpha",
      "paic",
      [comp({ kind: "secret", id: "esv-x", raw: {} })],
    );
    expect(v[0].status).toBe("new");
  });

  it("variable existence when the discovered kind matches → exists", async () => {
    const v = await runPreflight(
      client({ getRawEsv: async () => ({ kind: "variable", raw: { _id: "esv-x" } }) }),
      "alpha",
      "paic",
      [comp({ kind: "variable", id: "esv-x", raw: {} })],
    );
    expect(v[0].status).toBe("exists");
  });

  it("a throwing accessor → error verdict (not a blank plan)", async () => {
    const v = await runPreflight(
      client({ getRawTheme: () => Promise.reject(new Error("boom")) }),
      "alpha",
      "paic",
      [comp({ kind: "theme" })],
    );
    expect(v[0].status).toBe("error");
    expect(v[0].message).toContain("boom");
  });

  it("multi-component bundle → one verdict per component", async () => {
    const v = await runPreflight(client(), "alpha", "paic", [comp({ id: "a" }), comp({ id: "b" })]);
    expect(v).toHaveLength(2);
  });
});

describe("discoverDeps", () => {
  const libRef: DiscoveredRef = { kind: "script", name: "fraud-helpers" };
  const esvRef: DiscoveredRef = { kind: "esv", name: "esv.threshold" };

  it("returns [] for no refs (and makes no calls)", async () => {
    const listVariables = vi.fn(async () => []);
    expect(await discoverDeps(client({ listVariables }), "alpha", [])).toEqual([]);
    expect(listVariables).not.toHaveBeenCalled();
  });

  it("library ref present on target → present", async () => {
    const findRawScriptsByName = vi.fn(async () => [{ _id: "u", name: "fraud-helpers" }]);
    const r = await discoverDeps(client({ findRawScriptsByName }), "alpha", [libRef]);
    expect(r[0]).toEqual({
      kind: "script",
      name: "fraud-helpers",
      status: "present",
      severity: "advisory",
    });
  });

  it("library ref absent on target → missing", async () => {
    const r = await discoverDeps(client(), "alpha", [libRef]);
    expect(r[0]).toEqual({
      kind: "script",
      name: "fraud-helpers",
      status: "missing",
      severity: "advisory",
    });
  });

  it("dup-named library → present with an N-on-target note", async () => {
    const findRawScriptsByName = vi.fn(async () => [{ _id: "a" }, { _id: "b" }]);
    const r = await discoverDeps(client({ findRawScriptsByName }), "alpha", [libRef]);
    expect(r[0]).toMatchObject({ status: "present", detail: "2 on target" });
  });

  it("esv ref present as a variable → present, kind in detail", async () => {
    const listVariables = vi.fn(async () => [{ kind: "variable", name: "esv.threshold" }]);
    const r = await discoverDeps(client({ listVariables }), "alpha", [esvRef]);
    expect(r[0]).toEqual({
      kind: "esv",
      name: "esv.threshold",
      status: "present",
      detail: "variable",
      severity: "advisory",
    });
  });

  it("esv ref absent → missing; ESV lists fetched once regardless of ref count", async () => {
    const listVariables = vi.fn(async () => []);
    const listSecrets = vi.fn(async () => []);
    const r = await discoverDeps(client({ listVariables, listSecrets }), "alpha", [
      esvRef,
      { kind: "esv", name: "esv.other" },
    ]);
    expect(r.every((x) => x.status === "missing")).toBe(true);
    expect(listVariables).toHaveBeenCalledTimes(1); // index built once, not per-ref
    expect(listSecrets).toHaveBeenCalledTimes(1);
  });
});

describe("missingDepsNote", () => {
  const present: RequiredDepVerdict = { kind: "script", name: "ok-lib", status: "present" };
  const missLib: RequiredDepVerdict = { kind: "script", name: "fraud-helpers", status: "missing" };
  const missEsv: RequiredDepVerdict = { kind: "esv", name: "esv.threshold", status: "missing" };

  it("returns '' when nothing is missing (concatenatable)", () => {
    expect(missingDepsNote([])).toBe("");
    expect(missingDepsNote([present])).toBe("");
  });

  it("warns with the count + names of missing deps", () => {
    const note = missingDepsNote([missLib, present, missEsv]);
    expect(note).toContain("2 referenced dependency");
    expect(note).toContain("fraud-helpers");
    expect(note).toContain("esv.threshold");
    expect(note).toContain("may fail at runtime");
    expect(note).not.toContain("ok-lib"); // present deps aren't named
  });

  it("omits blocking-missing prerequisites (they disable Import, not the modal)", () => {
    const blockingMiss: RequiredDepVerdict = {
      kind: "nodeType",
      name: "PingOneVerifyNode",
      status: "missing",
      severity: "blocking",
    };
    expect(missingDepsNote([blockingMiss])).toBe("");
    expect(missingDepsNote([blockingMiss, missLib])).toContain("fraud-helpers");
    expect(missingDepsNote([blockingMiss, missLib])).not.toContain("PingOneVerifyNode");
  });
});

describe("checkJourneyGates", () => {
  const journeyUnit = (id: string, nodes: Record<string, unknown>): ImportComponent => ({
    kind: "journey",
    id,
    displayName: id,
    raw: { tree: { _id: id }, nodes, innerNodes: {} },
  });

  it("node-type gate: present vs missing against the catalog (blocking)", async () => {
    const getNodeTypes = vi.fn(async () => ["PageNode"]);
    const r = await checkJourneyGates(client({ getNodeTypes }), "alpha", [
      journeyUnit("Login", {
        n1: { _type: { _id: "PageNode" } },
        n2: { _type: { _id: "PingOneVerifyNode" } },
      }),
    ]);
    expect(r.filter((v) => v.kind === "nodeType")).toEqual([
      { kind: "nodeType", name: "PageNode", status: "present", severity: "blocking" },
      { kind: "nodeType", name: "PingOneVerifyNode", status: "missing", severity: "blocking" },
    ]);
  });

  it("inner-journey gate: referenced-not-bundled checked vs listTrees (blocking)", async () => {
    const listTrees = vi.fn(async () => [{ _id: "MFA" }]);
    const r = await checkJourneyGates(client({ listTrees }), "alpha", [
      journeyUnit("Login", {
        a: { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "MFA" }, // present on target
        b: { _type: { _id: "InnerTreeEvaluatorNode" }, tree: "Risk" }, // missing
      }),
    ]);
    expect(r.filter((v) => v.kind === "innerJourney")).toEqual([
      { kind: "innerJourney", name: "MFA", status: "present", severity: "blocking" },
      { kind: "innerJourney", name: "Risk", status: "missing", severity: "blocking" },
    ]);
  });

  it("leaf bundle → no gate verdicts, no catalog/tree calls", async () => {
    const getNodeTypes = vi.fn(async () => ["PageNode"]);
    const listTrees = vi.fn(async () => []);
    const r = await checkJourneyGates(client({ getNodeTypes, listTrees }), "alpha", [
      comp({ kind: "script", id: "s", raw: {} }),
    ]);
    expect(r).toEqual([]);
    expect(getNodeTypes).not.toHaveBeenCalled();
    expect(listTrees).not.toHaveBeenCalled();
  });

  it("a catalog-read failure skips the node-type gate (no spurious blockers)", async () => {
    const getNodeTypes = vi.fn(() => Promise.reject(new Error("boom")));
    const r = await checkJourneyGates(client({ getNodeTypes }), "alpha", [
      journeyUnit("Login", { n1: { _type: { _id: "PageNode" } } }),
    ]);
    expect(r.filter((v) => v.kind === "nodeType")).toEqual([]);
  });
});

describe("findIdenticalJourneys (PD-5 amendment)", () => {
  const innerComp = (scriptId: string): ImportComponent => ({
    kind: "journey",
    id: "zzz_inner",
    displayName: "zzz_inner",
    raw: {
      tree: {
        _id: "zzz_inner",
        entryNodeId: "n1",
        nodes: { n1: { nodeType: "ScriptedDecisionNode", connections: {} } },
      },
      nodes: { n1: { _id: "n1", _type: { _id: "ScriptedDecisionNode" }, script: scriptId } },
      innerNodes: {},
    },
  });
  const existsJourney: ComponentVerdict = {
    kind: "journey",
    id: "zzz_inner",
    displayName: "zzz_inner",
    status: "exists",
  };

  it("marks a present journey identical when its tree + node bodies match", async () => {
    const comp = innerComp("script-A");
    const c = client({
      getRawJourney: async () => comp.raw.tree,
      getRawNode: async () => (comp.raw.nodes as Record<string, unknown>).n1,
    });
    const set = await findIdenticalJourneys(c, "alpha", [comp], [existsJourney]);
    expect(set.has("zzz_inner")).toBe(true);
  });

  it("does NOT mark identical when a node body differs on the target", async () => {
    const comp = innerComp("script-A");
    const c = client({
      getRawJourney: async () => comp.raw.tree,
      getRawNode: async () => ({ _id: "n1", _type: { _id: "ScriptedDecisionNode" }, script: "B" }),
    });
    const set = await findIdenticalJourneys(c, "alpha", [comp], [existsJourney]);
    expect(set.has("zzz_inner")).toBe(false);
  });

  it("applies the name→UUID script remap so a reconciled journey still reads identical", async () => {
    const comp = innerComp("bundle-uuid"); // bundle node points at the bundle script UUID
    const c = client({
      getRawJourney: async () => comp.raw.tree,
      // target node holds the reconciled target UUID (TD-9)
      getRawNode: async () => ({
        _id: "n1",
        _type: { _id: "ScriptedDecisionNode" },
        script: "target-uuid",
      }),
    });
    const scriptVerdict: ComponentVerdict = {
      kind: "script",
      id: "bundle-uuid",
      displayName: "dec",
      status: "differs",
      resolvedTargetId: "target-uuid",
    };
    const set = await findIdenticalJourneys(c, "alpha", [comp], [existsJourney, scriptVerdict]);
    expect(set.has("zzz_inner")).toBe(true);
  });

  it("ignores 'new' journeys — only existing ones are refined", async () => {
    const comp = innerComp("script-A");
    const newJourney: ComponentVerdict = { ...existsJourney, status: "new" };
    const c = client({
      getRawJourney: async () => comp.raw.tree,
      getRawNode: async () => (comp.raw.nodes as Record<string, unknown>).n1,
    });
    expect((await findIdenticalJourneys(c, "alpha", [comp], [newJourney])).size).toBe(0);
  });

  // ── read/compute split: the caching prerequisite for live option toggling ──
  describe("readJourneyCompareInputs + computeIdenticalJourneys", () => {
    /** A journey whose target differs from the bundle ONLY by node position. */
    const posComp = (x: number): ImportComponent => ({
      kind: "journey",
      id: "zzz_inner",
      displayName: "zzz_inner",
      raw: {
        tree: {
          _id: "zzz_inner",
          entryNodeId: "n1",
          nodes: { n1: { nodeType: "ScriptedDecisionNode", connections: {}, x } },
        },
        nodes: { n1: { _id: "n1", _type: { _id: "ScriptedDecisionNode" }, script: "s" } },
        innerNodes: {},
      },
    });

    it("reads the target ONCE, then recomputes locally for each option set", async () => {
      const bundle = posComp(10);
      const target = posComp(99);
      let journeyReads = 0;
      let nodeReads = 0;
      const c = client({
        getRawJourney: () => {
          journeyReads += 1;
          return Promise.resolve(target.raw.tree);
        },
        getRawNode: () => {
          nodeReads += 1;
          return Promise.resolve((target.raw.nodes as Record<string, unknown>).n1);
        },
      });

      const cache = await readJourneyCompareInputs(c, "alpha", [bundle], [existsJourney]);
      expect(journeyReads).toBe(1);
      expect(nodeReads).toBe(1);

      // Two different verdicts from the SAME cache — no further target reads.
      expect(computeIdenticalJourneys(cache, EXACT_COMPARE).has("zzz_inner")).toBe(false);
      expect(
        computeIdenticalJourneys(cache, {
          ...EXACT_COMPARE,
          ignoreNodePositions: true,
        }).has("zzz_inner"),
      ).toBe(true);
      expect(journeyReads).toBe(1); // ← the whole point: no re-fetch on toggle
      expect(nodeReads).toBe(1);
    });

    it("computeIdenticalJourneys defaults to EXACT when no options are passed", async () => {
      const c = client({
        getRawJourney: async () => posComp(99).raw.tree,
        getRawNode: async () => (posComp(99).raw.nodes as Record<string, unknown>).n1,
      });
      const cache = await readJourneyCompareInputs(c, "alpha", [posComp(10)], [existsJourney]);
      expect(computeIdenticalJourneys(cache).size).toBe(0);
    });

    it("omits a journey whose target read fails — never a false identical", async () => {
      const c = client({
        getRawJourney: () => Promise.reject(new Error("boom")),
        getRawNode: () => Promise.resolve({}),
      });
      const cache = await readJourneyCompareInputs(c, "alpha", [posComp(10)], [existsJourney]);
      expect(cache.inputs).toHaveLength(0);
      expect(computeIdenticalJourneys(cache, EXACT_COMPARE).size).toBe(0);
    });

    it("findIdenticalJourneys honours options passed through to the compute half", async () => {
      const c = client({
        getRawJourney: async () => posComp(99).raw.tree,
        getRawNode: async () => (posComp(99).raw.nodes as Record<string, unknown>).n1,
      });
      const relaxed = await findIdenticalJourneys(c, "alpha", [posComp(10)], [existsJourney], {
        ...EXACT_COMPARE,
        ignoreNodePositions: true,
      });
      expect(relaxed.has("zzz_inner")).toBe(true);
    });
  });
});
