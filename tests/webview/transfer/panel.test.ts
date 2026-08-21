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
    window: { showOpenDialog: ReturnType<typeof vi.fn> };
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
