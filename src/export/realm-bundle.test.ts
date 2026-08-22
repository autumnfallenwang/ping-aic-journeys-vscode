import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@/domain/types";
import { buildRealmBundle } from "@/export/realm-bundle";
import type { PaicClient } from "@/paic/client";

const CONN: Connection = { kind: "paic", host: "h", saId: "sa" };
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

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

interface Fixture {
  /** Drives `listTrees` — realm listing order. */
  trees: string[];
  journeys: Record<string, unknown>;
  nodes: Record<string, unknown>;
  scripts: Record<string, unknown>;
  scriptsByName?: Record<string, unknown>;
}

function makeClient(fx: Fixture) {
  const getRawScript = vi.fn((_r: string, id: string) =>
    fx.scripts[id] === undefined
      ? Promise.reject(new Error(`404 script ${id}`))
      : Promise.resolve(fx.scripts[id]),
  );
  const getRawNode = vi.fn((_r: string, _t: string, id: string) =>
    fx.nodes[id] === undefined
      ? Promise.reject(new Error(`404 node ${id}`))
      : Promise.resolve(fx.nodes[id]),
  );
  const getRawJourney = vi.fn((_r: string, id: string) =>
    fx.journeys[id] === undefined
      ? Promise.reject(new Error(`404 journey ${id}`))
      : Promise.resolve(fx.journeys[id]),
  );
  const listTrees = vi.fn(async () => fx.trees.map((id) => ({ _id: id })));
  const client = {
    listTrees,
    getRawJourney,
    getRawNode,
    getRawScript,
    getRawScriptByName: vi.fn(async (_r: string, n: string) => fx.scriptsByName?.[n] ?? null),
    getRawTheme: vi.fn(async () => null),
    getRawEmailTemplate: vi.fn(async () => null),
    getRawSocialIdp: vi.fn(async () => null),
  } as unknown as PaicClient;
  return { client, getRawScript, getRawJourney, listTrees };
}

/** Two journeys that BOTH reference the same script — the realm-export shape. */
function sharedScriptFixture(): Fixture {
  const decision = (nodeId: string) => ({
    _id: nodeId,
    _type: { _id: "ScriptedDecisionNode" },
    script: "shared-1",
  });
  return {
    trees: ["Alpha", "Beta"],
    journeys: {
      Alpha: {
        _id: "Alpha",
        entryNodeId: "a1",
        nodes: { a1: { nodeType: "ScriptedDecisionNode" } },
      },
      Beta: { _id: "Beta", entryNodeId: "b1", nodes: { b1: { nodeType: "ScriptedDecisionNode" } } },
    },
    nodes: { a1: decision("a1"), b1: decision("b1") },
    scripts: {
      "shared-1": { _id: "shared-1", name: "shared-helpers", script: b64("var x = 1;") },
    },
  };
}

describe("buildRealmBundle", () => {
  it("bundles every tree in the realm", async () => {
    const fx = sharedScriptFixture();
    fx.trees = ["Alpha", "Beta"];
    const { client } = makeClient(fx);
    const bundle = await buildRealmBundle(client, CONN, "alpha", "1.0.0", "NOW", log);
    expect(Object.keys(bundle?.trees ?? {}).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("stamps realm scope + allLevels depth in meta", async () => {
    const { client } = makeClient(sharedScriptFixture());
    const bundle = await buildRealmBundle(client, CONN, "alpha", "1.0.0", "NOW", log);
    expect(bundle?.meta.scope).toBe("realm");
    expect(bundle?.meta.depthMode).toBe("allLevels");
    expect(bundle?.meta.realm).toBe("alpha");
    expect(bundle?.meta.exportDate).toBe("NOW");
  });

  it("fetches a shared script ONCE but keeps a copy in EVERY tree's map", async () => {
    // The core D46 invariant. The fetch is memoized across trees (a realm export
    // otherwise re-fetches a shared library once per referencing tree), but the
    // OUTPUT keeps the per-tree duplication — a shared top-level `scripts` map
    // would be our own dialect and would break frodo / PAIC-UI import.
    const { client, getRawScript } = makeClient(sharedScriptFixture());
    const bundle = await buildRealmBundle(client, CONN, "alpha", "1.0.0", "NOW", log);
    expect(getRawScript).toHaveBeenCalledTimes(1); // fetched once…
    expect(bundle?.trees.Alpha.scripts["shared-1"]).toBeDefined(); // …but present
    expect(bundle?.trees.Beta.scripts["shared-1"]).toBeDefined(); // …in both trees
  });

  it("skips a tree that 404s and still bundles the rest", async () => {
    const fx = sharedScriptFixture();
    fx.trees = ["Alpha", "Ghost", "Beta"]; // Ghost is listed but not fetchable
    const { client } = makeClient(fx);
    const bundle = await buildRealmBundle(client, CONN, "alpha", "1.0.0", "NOW", log);
    expect(Object.keys(bundle?.trees ?? {}).sort()).toEqual(["Alpha", "Beta"]);
  });

  it("returns null for a realm with no journeys", async () => {
    const fx = sharedScriptFixture();
    fx.trees = [];
    const { client } = makeClient(fx);
    expect(await buildRealmBundle(client, CONN, "alpha", "1.0.0", "NOW", log)).toBeNull();
  });

  it("returns null when every listed tree fails to fetch", async () => {
    const fx = sharedScriptFixture();
    fx.trees = ["Ghost1", "Ghost2"];
    const { client } = makeClient(fx);
    expect(await buildRealmBundle(client, CONN, "alpha", "1.0.0", "NOW", log)).toBeNull();
  });

  it("reports progress once per tree, in listing order", async () => {
    const fx = sharedScriptFixture();
    fx.trees = ["Alpha", "Beta"];
    const { client } = makeClient(fx);
    const seen: Array<[number, number, string]> = [];
    await buildRealmBundle(client, CONN, "alpha", "1.0.0", "NOW", log, (d, t, id) =>
      seen.push([d, t, id]),
    );
    expect(seen).toEqual([
      [1, 2, "Alpha"],
      [2, 2, "Beta"],
    ]);
  });

  it("passes the realm through to the client verbatim (root realm = empty string)", async () => {
    const { client, listTrees } = makeClient(sharedScriptFixture());
    await buildRealmBundle(client, CONN, "", "1.0.0", "NOW", log);
    expect(listTrees).toHaveBeenCalledWith("");
  });
});
