import { vi } from "vitest";

vi.mock("vscode", async () => (await import("../../util/vscode-mock")).makeVscodeMock());

import { beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import type { PaicClient } from "@/paic/client";
import type { ClientCache } from "@/tenants/client-cache";
import type { E2W } from "@/webview/transfer/messages";
import { TransferFactory } from "@/webview/transfer/panel";
import { makeFakeLogger } from "../../views/fakes";

interface MockPanel {
  webview: {
    postMessage: ReturnType<typeof vi.fn>;
    __fireReceive: (msg: unknown) => void;
  };
}

async function vscodeMock() {
  return (await import("vscode")) as unknown as {
    __mockState: { createdPanels: MockPanel[] };
    window: {
      showOpenDialog: ReturnType<typeof vi.fn>;
      showWarningMessage: ReturnType<typeof vi.fn>;
    };
    commands: { executeCommand: ReturnType<typeof vi.fn> };
    workspace: { fs: { readFile: ReturnType<typeof vi.fn> } };
  };
}

/** A two-script bundle: one script always resolves, the other is the flaky one. */
const BUNDLE = JSON.stringify({
  meta: {
    bundleSchemaVersion: "1.0",
    origin: "openam-tenant.example.forgeblocks.com",
    connectionType: "paic",
    realm: "alpha",
    exportDate: "2026-08-21T00:00:00.000Z",
    exportTool: "paic-journeys-vscode",
    exportToolVersion: "0.2.0",
  },
  script: {
    "00000000-0000-0000-0000-000000000001": {
      _id: "00000000-0000-0000-0000-000000000001",
      name: "steady",
      context: "LIBRARY",
    },
    "00000000-0000-0000-0000-000000000002": {
      _id: "00000000-0000-0000-0000-000000000002",
      name: "flaky",
      context: "LIBRARY",
    },
  },
});

const STEADY = "script:00000000-0000-0000-0000-000000000001";
const FLAKY = "script:00000000-0000-0000-0000-000000000002";

/** Minimal PaicClient: `flaky`'s name lookup fails until `healed` flips. */
function makeClient(state: { healed: boolean }): PaicClient {
  return {
    findRawScriptsByName: (_realm: string, name: string) =>
      name === "flaky" && !state.healed
        ? Promise.reject(new Error("read ECONNRESET"))
        : // A name match on the target → the row reads `differs`/`identical`, not
          // `new`, which keeps `scriptIdCollision` out of the picture.
          Promise.resolve([{ _id: `target-${name}`, name, context: "LIBRARY", script: "" }]),
    getRawScript: () => Promise.reject(new Error("404")),
    getNodeTypes: async () => [],
    listTrees: async () => [],
    listVariables: async () => [],
    listSecrets: async () => [],
    getRawTheme: async () => null,
    getRawEmailTemplate: async () => null,
    getRawSocialIdp: async () => null,
    getRawScriptByName: async () => null,
    getRawEsv: async () => null,
    getRawJourney: async () => null,
    getRawNode: async () => null,
  } as unknown as PaicClient;
}

async function setup(state: { healed: boolean }) {
  const v = await vscodeMock();
  const client = makeClient(state);
  const cache = { get: async () => client, drop: () => undefined } as unknown as ClientCache;
  const factory = new TransferFactory({
    context: {
      extensionUri: { path: "/ext" },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext,
    listConnections: () => [{ host: "paic.example", kind: "paic" as const }],
    cache,
    connectionKindOf: () => "paic" as const,
    searchFactory: { spawn: () => undefined },
    bundleContent: {} as never,
    log: makeFakeLogger() as never,
  });
  factory.spawn();
  const panel = v.__mockState.createdPanels.at(-1);
  if (!panel) throw new Error("no panel created");

  v.window.showOpenDialog.mockResolvedValue([{ path: "/tmp/b.script.json" }]);
  v.workspace.fs.readFile.mockResolvedValue(new TextEncoder().encode(BUNDLE));

  const send = async (msg: unknown) => {
    panel.webview.__fireReceive(msg);
    // Let the handler's promise chain settle.
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  const posted = () => panel.webview.postMessage.mock.calls.map((c) => c[0] as E2W);
  const lastOf = <T extends E2W["type"]>(type: T) =>
    [...posted()].reverse().find((m) => m.type === type) as Extract<E2W, { type: T }> | undefined;

  await send({ type: "pickBundle" });
  return { send, posted, lastOf, state };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("TransferTab — pre-flight resilience (D46)", () => {
  it("surfaces a failed target read as an `error` verdict, not a dead plan", async () => {
    const t = await setup({ healed: false });
    await t.send({ type: "runPreflight", host: "paic.example", realm: "alpha" });

    const result = t.lastOf("preflightResult");
    expect(result).toBeTruthy();
    const byKey = new Map(result?.verdicts.map((x) => [`${x.kind}:${x.id}`, x]));
    expect(byKey.get(FLAKY)?.status).toBe("error");
    expect(byKey.get(FLAKY)?.message).toBe("read ECONNRESET");
    // The healthy row still resolved — one failure never blanks the plan.
    expect(byKey.get(STEADY)?.status).not.toBe("error");
  });

  it("emits determinate progress for each phase (PD-19)", async () => {
    const t = await setup({ healed: false });
    await t.send({ type: "runPreflight", host: "paic.example", realm: "alpha" });

    const ticks = t.posted().filter((m) => m.type === "preflightProgress");
    expect(ticks.length).toBeGreaterThan(0);
    const compare = ticks.filter((m) => m.type === "preflightProgress" && m.phase === "compare");
    // One tick per component, counting up to the component total.
    expect(compare.map((m) => (m.type === "preflightProgress" ? m.done : 0))).toEqual([1, 2]);
    expect(compare.every((m) => m.type === "preflightProgress" && m.total === 2)).toBe(true);
    expect(ticks.some((m) => m.type === "preflightProgress" && m.phase === "deps")).toBe(true);
  });

  describe("recheckFailed (PD-20)", () => {
    it("re-reads ONLY the requested rows and patches them back", async () => {
      const t = await setup({ healed: false });
      await t.send({ type: "runPreflight", host: "paic.example", realm: "alpha" });

      t.state.healed = true;
      await t.send({
        type: "recheckFailed",
        host: "paic.example",
        realm: "alpha",
        keys: [FLAKY],
      });

      const patch = t.lastOf("verdictsPatched");
      expect(patch?.verdicts).toHaveLength(1);
      expect(`${patch?.verdicts[0].kind}:${patch?.verdicts[0].id}`).toBe(FLAKY);
      expect(patch?.verdicts[0].status).not.toBe("error");
    });

    it("is a no-op for keys that aren't in the bundle", async () => {
      const t = await setup({ healed: false });
      await t.send({ type: "runPreflight", host: "paic.example", realm: "alpha" });
      await t.send({
        type: "recheckFailed",
        host: "paic.example",
        realm: "alpha",
        keys: ["script:nope"],
      });
      expect(t.lastOf("verdictsPatched")).toBeUndefined();
    });

    /**
     * The regression this whole handler is built around. The PD-11 freeze
     * snapshot is captured at pre-flight time with the flaky row still at
     * `error`. If a recheck doesn't REBUILD it, the commit-time re-read sees
     * `error → differs`, calls it drift, and refuses an import that is fine —
     * a failure that looks like a bug in the drift check, three steps from its
     * real cause.
     */
    it("rebuilds the freeze snapshot so a recovered row is not read as drift", async () => {
      const t = await setup({ healed: false });
      await t.send({ type: "runPreflight", host: "paic.example", realm: "alpha" });

      t.state.healed = true;
      await t.send({
        type: "recheckFailed",
        host: "paic.example",
        realm: "alpha",
        keys: [FLAKY],
      });

      await t.send({
        type: "execute",
        host: "paic.example",
        realm: "alpha",
        selected: [STEADY, FLAKY],
      });

      expect(t.lastOf("driftDetected")).toBeUndefined();
    });

    it("WOULD have reported drift without the recheck (the snapshot really is load-bearing)", async () => {
      const t = await setup({ healed: false });
      await t.send({ type: "runPreflight", host: "paic.example", realm: "alpha" });

      // Same recovery, but the user never asked for a recheck — the commit-time
      // re-read finds the row healed on its own. That IS drift, correctly.
      t.state.healed = true;
      await t.send({
        type: "execute",
        host: "paic.example",
        realm: "alpha",
        selected: [STEADY, FLAKY],
      });

      expect(t.lastOf("driftDetected")).toBeTruthy();
    });
  });
});

// ─── D48 — the confirm's export verb ─────────────────────────────────────────

/** A DECISION script (value-compared) whose target copy differs → one Overwrite. */
const DIFFERS_BUNDLE = JSON.stringify({
  meta: {
    bundleSchemaVersion: "1.0",
    origin: "openam-tenant.example.forgeblocks.com",
    connectionType: "paic",
    realm: "alpha",
    exportDate: "2026-08-22T00:00:00.000Z",
    exportTool: "paic-journeys-vscode",
    exportToolVersion: "0.2.0",
  },
  script: {
    "00000000-0000-0000-0000-000000000003": {
      _id: "00000000-0000-0000-0000-000000000003",
      name: "decider",
      context: "AUTHENTICATION_TREE_DECISION_NODE",
      language: "JAVASCRIPT",
      script: JSON.stringify("// bundle body"),
    },
  },
});

/** A theme absent from the target → one Create, zero Overwrite. */
const NEW_THEME_BUNDLE = JSON.stringify({
  meta: {
    bundleSchemaVersion: "1.0",
    origin: "openam-tenant.example.forgeblocks.com",
    connectionType: "paic",
    realm: "alpha",
    exportDate: "2026-08-22T00:00:00.000Z",
    exportTool: "paic-journeys-vscode",
    exportToolVersion: "0.2.0",
  },
  theme: { "theme-1": { _id: "theme-1", name: "Corporate" } },
});

async function setupConfirm(bundleJson: string) {
  const v = await vscodeMock();
  const writeSpy = vi.fn();
  const client = {
    // The target's copy of `decider` differs from the bundle's body.
    findRawScriptsByName: async (_realm: string, name: string) => [
      {
        _id: `target-${name}`,
        name,
        context: "AUTHENTICATION_TREE_DECISION_NODE",
        language: "JAVASCRIPT",
        script: Buffer.from("// target body", "utf8").toString("base64"),
      },
    ],
    getRawScript: async () => null,
    getNodeTypes: async () => [],
    listTrees: async () => [],
    listVariables: async () => [],
    listSecrets: async () => [],
    getRawTheme: async () => null,
    getRawEmailTemplate: async () => null,
    getRawSocialIdp: async () => null,
    getRawScriptByName: async () => null,
    getRawEsv: async () => null,
    getRawJourney: async () => null,
    getRawNode: async () => null,
    writeScript: writeSpy,
    writeTheme: writeSpy,
  } as unknown as PaicClient;
  const cache = { get: async () => client, drop: () => undefined } as unknown as ClientCache;
  const factory = new TransferFactory({
    context: { extensionUri: { path: "/ext" }, subscriptions: [] } as unknown as vscode.ExtensionContext,
    listConnections: () => [{ host: "paic.example", kind: "paic" as const }],
    cache,
    connectionKindOf: () => "paic" as const,
    searchFactory: { spawn: () => undefined },
    bundleContent: {} as never,
    log: makeFakeLogger() as never,
  });
  factory.spawn();
  const panel = v.__mockState.createdPanels.at(-1);
  if (!panel) throw new Error("no panel created");
  v.window.showOpenDialog.mockResolvedValue([{ path: "/tmp/b.json" }]);
  v.workspace.fs.readFile.mockResolvedValue(new TextEncoder().encode(bundleJson));
  const send = async (msg: unknown) => {
    panel.webview.__fireReceive(msg);
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  const lastOf = <T extends E2W["type"]>(type: T) =>
    [...panel.webview.postMessage.mock.calls.map((c) => c[0] as E2W)]
      .reverse()
      .find((m) => m.type === type) as Extract<E2W, { type: T }> | undefined;
  await send({ type: "pickBundle" });
  return { send, lastOf, v, writeSpy };
}

describe("TransferTab — confirm modal export verb (D48)", () => {
  it("offers the export verb on an overwrite plan; choosing it exports and writes NOTHING", async () => {
    const t = await setupConfirm(DIFFERS_BUNDLE);
    await t.send({ type: "runPreflight", host: "paic.example", realm: "alpha" });
    t.v.window.showWarningMessage.mockResolvedValue("Export target realm…");

    await t.send({
      type: "execute",
      host: "paic.example",
      realm: "alpha",
      selected: ["script:00000000-0000-0000-0000-000000000003"],
    });

    // The modal carried BOTH verbs (title, options, ...verbs).
    const args = t.v.window.showWarningMessage.mock.calls.at(-1) as unknown[];
    expect(args.slice(2)).toEqual(["Export target realm…", "Import"]);
    // …and routed to the same command the inspector's realm card uses.
    expect(t.v.commands.executeCommand).toHaveBeenCalledWith("paicJourneys.exportRealmJourneys", {
      host: "paic.example",
      realm: "alpha",
      realmLabel: "alpha",
    });
    // Export is a dead end: no write, and the plan stays editable (no results).
    expect(t.writeSpy).not.toHaveBeenCalled();
    const result = t.lastOf("executeResult");
    expect(result?.results).toEqual([]);
    expect(result?.summary).toContain("Exported the target realm");
  });

  it("keeps the single-verb confirm when the plan only creates", async () => {
    const t = await setupConfirm(NEW_THEME_BUNDLE);
    await t.send({ type: "runPreflight", host: "paic.example", realm: "alpha" });
    t.v.window.showWarningMessage.mockResolvedValue(undefined); // dismissed

    await t.send({
      type: "execute",
      host: "paic.example",
      realm: "alpha",
      selected: ["theme:theme-1"],
    });

    const args = t.v.window.showWarningMessage.mock.calls.at(-1) as unknown[];
    expect(args.slice(2)).toEqual(["Import"]); // no export offer — nothing to lose
    expect(t.v.commands.executeCommand).not.toHaveBeenCalled();
    expect(t.writeSpy).not.toHaveBeenCalled();
    expect(t.lastOf("executeResult")?.summary).toBe("Cancelled.");
  });
});
