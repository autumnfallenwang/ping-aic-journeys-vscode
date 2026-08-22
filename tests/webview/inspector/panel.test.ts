import { vi } from "vitest";

vi.mock("vscode", async () => (await import("../../util/vscode-mock")).makeVscodeMock());

import { beforeEach, describe, expect, it } from "vitest";
import type * as vscode from "vscode";
import type { Connection, Journey } from "@/domain/types";
import { ConnectionNode } from "@/views/nodes/connection";
import { JourneyNode } from "@/views/nodes/journey";
import { ScriptNode } from "@/views/nodes/script";
import { InspectorFactory } from "@/webview/inspector/panel";
import {
  makeFakeCache,
  makeFakeLogger,
  makeFakePaicClient,
  makeFakeResolverCache,
} from "../../views/fakes";

const CONN: Connection = { kind: "paic", host: "h.example.com", saId: "sa-1" };

interface VscodeMockState {
  createWebviewPanel: ReturnType<typeof vi.fn>;
  createTreeView: ReturnType<typeof vi.fn>;
  createdPanels: Array<{
    webview: {
      postMessage: ReturnType<typeof vi.fn>;
      __fireReceive: (msg: unknown) => void;
    };
  }>;
}

async function getVscodeMockState(): Promise<VscodeMockState> {
  const mod = (await import("vscode")) as unknown as { __mockState: VscodeMockState };
  return mod.__mockState;
}

function makeMockContext() {
  return {
    extensionUri: { path: "/ext" },
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

beforeEach(async () => {
  const state = await getVscodeMockState();
  state.createWebviewPanel.mockClear();
  state.createdPanels.length = 0;
});

/** Helper — wait for the next microtask drain so async webview post-messages
 * land before we assert on them. */
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Simulate the webview signaling React-mounted by firing `{ type: "ready" }`
 * on every panel created so far. Production webviews fire this from
 * `webview/inspector/ui/main.tsx`; tests have to do it manually because the
 * mock webview never runs the React bundle. The extension gates outbound
 * `post()` calls on this handshake (see lesson 2026-05-26), so without it
 * `await tab.ready` would hang for `READY_TIMEOUT_MS`. */
function fireReadyOnAll(state: VscodeMockState): void {
  for (const p of state.createdPanels) {
    p.webview.__fireReceive({ type: "ready" });
  }
}

describe("InspectorFactory.spawn — per-click new tab (D24)", () => {
  it("spawn() creates a fresh WebviewPanel on each call — no reuse", async () => {
    const state = await getVscodeMockState();
    const cache = makeFakeCache(makeFakePaicClient({}));
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });

    const node = new ConnectionNode(CONN, cache, log);
    factory.spawn(node);
    factory.spawn(node);
    factory.spawn(node);
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(3);
  });

  it("spawn(connectionNode) posts a select message with the connection payload to its own webview", async () => {
    const state = await getVscodeMockState();
    const cache = makeFakeCache(makeFakePaicClient({}));
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });
    const node = new ConnectionNode(CONN, cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;

    const post = state.createdPanels[0].webview.postMessage;
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "select",
        payload: expect.objectContaining({ kind: "connection", connection: CONN }),
      }),
    );
  });

  it("spawn(journeyNode) fetches + posts journeyDeps with nodeIndex", async () => {
    const state = await getVscodeMockState();
    const journey: Journey = {
      id: "Login",
      enabled: true,
      entryNodeId: "n1",
      nodes: { n1: { nodeType: "ScriptedDecisionNode", connections: {} } },
    };
    const client = makeFakePaicClient({
      nodesByKey: {
        "alpha:ScriptedDecisionNode:n1": {
          id: "n1",
          nodeType: "ScriptedDecisionNode",
          scriptId: "s-1",
          outcomes: [],
          inputs: [],
          outputs: [],
        },
      },
    });
    const cache = makeFakeCache(client);
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });
    const node = new JourneyNode("h.example.com", "alpha", journey, cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;

    const post = state.createdPanels[0].webview.postMessage;
    const calls = post.mock.calls.map((c: unknown[]) => c[0]);
    const depsMsg = calls.find(
      (
        m,
      ): m is {
        type: "journeyDeps";
        scripts: unknown[];
        nodeIndex: Record<string, { kind: string; scriptId?: string; uid?: string }>;
      } => Boolean(m) && (m as { type?: unknown }).type === "journeyDeps",
    );
    expect(depsMsg).toBeDefined();
    expect(depsMsg?.scripts).toHaveLength(1);
    expect(depsMsg?.nodeIndex.n1?.kind).toBe("script");
    expect(depsMsg?.nodeIndex.n1?.scriptId).toBe("s-1");
    expect(depsMsg?.nodeIndex.n1?.uid).toBe("script:h.example.com:alpha:s-1");
  });

  it("journeyDeps uses the resolved script NAME (not the UUID) for the scripts deps list label", async () => {
    const state = await getVscodeMockState();
    const journey: Journey = {
      id: "Login",
      enabled: true,
      entryNodeId: "n1",
      nodes: { n1: { nodeType: "ScriptedDecisionNode", connections: {} } },
    };
    const client = makeFakePaicClient({
      nodesByKey: {
        "alpha:ScriptedDecisionNode:n1": {
          id: "n1",
          nodeType: "ScriptedDecisionNode",
          scriptId: "s-1",
          outcomes: [],
          inputs: [],
          outputs: [],
        },
      },
      scriptsByKey: {
        "alpha:s-1": { id: "s-1", name: "AuthHelper", language: "JAVASCRIPT", body: "" },
      },
    });
    const cache = makeFakeCache(client);
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });
    const node = new JourneyNode("h.example.com", "alpha", journey, cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;

    const post = state.createdPanels[0].webview.postMessage;
    const calls = post.mock.calls.map((c: unknown[]) => c[0]);
    const depsMsg = calls.find(
      (
        m,
      ): m is {
        type: "journeyDeps";
        scripts: Array<{ label: string; uid: string }>;
        nodeIndex: Record<string, { scriptName?: string; scriptId?: string }>;
      } => Boolean(m) && (m as { type?: unknown }).type === "journeyDeps",
    );
    expect(depsMsg?.scripts[0].label).toBe("AuthHelper");
    expect(depsMsg?.nodeIndex.n1?.scriptName).toBe("AuthHelper");
    expect(depsMsg?.nodeIndex.n1?.scriptId).toBe("s-1");
  });

  it("on `previewNode` message the factory spawns a NEW tab for the target uid", async () => {
    const state = await getVscodeMockState();
    const journey: Journey = {
      id: "Login",
      enabled: true,
      entryNodeId: "n1",
      nodes: { n1: { nodeType: "ScriptedDecisionNode", connections: {} } },
    };
    const client = makeFakePaicClient({
      nodesByKey: {
        "alpha:ScriptedDecisionNode:n1": {
          id: "n1",
          nodeType: "ScriptedDecisionNode",
          scriptId: "s-1",
          outcomes: [],
          inputs: [],
          outputs: [],
        },
      },
    });
    const cache = makeFakeCache(client);
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });
    const node = new JourneyNode("h.example.com", "alpha", journey, cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;
    // After the journey tab renders, its ScriptNode child is registered.
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(1);

    const journeyPanel = state.createdPanels[0];
    journeyPanel.webview.__fireReceive({
      type: "previewNode",
      uid: "script:h.example.com:alpha:s-1",
    });
    await flush();
    // The script preview tab is a fresh panel — fire its ready handshake
    // so its initial `select` post can drain.
    fireReadyOnAll(state);
    await flush();

    // A second panel was created for the script preview.
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(2);
    const scriptPanel = state.createdPanels[1];
    const calls = scriptPanel.webview.postMessage.mock.calls.map((c: unknown[]) => c[0]);
    const selectMsg = calls.find((m) => (m as { type?: unknown }).type === "select");
    expect(selectMsg).toMatchObject({
      payload: expect.objectContaining({
        kind: "script",
        scriptId: "s-1",
      }),
    });
  });

  it("ignores `previewNode` for an unknown uid (no panel spawned, no throw)", async () => {
    const state = await getVscodeMockState();
    const cache = makeFakeCache(makeFakePaicClient({}));
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });
    const node = new ConnectionNode(CONN, cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(1);

    state.createdPanels[0].webview.__fireReceive({
      type: "previewNode",
      uid: "script:never-registered:s-?",
    });
    await flush();
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  it("spawn(scriptNode) posts a scriptDeps message derived from its expanded children", async () => {
    const state = await getVscodeMockState();
    const client = makeFakePaicClient({
      scriptsByKey: {
        "alpha:s-1": {
          id: "s-1",
          name: "Auth",
          language: "JAVASCRIPT",
          body: `require('helpers'); var url = systemEnv.getProperty("esv.kyid.portal.name");`,
        },
      },
      scriptsByName: {
        "alpha:byName:helpers": {
          id: "s-lib-h",
          name: "helpers",
          language: "JAVASCRIPT",
          body: "",
        },
      },
    });
    const cache = makeFakeCache(client);
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });
    const node = new ScriptNode("h.example.com", "alpha", "s-1", cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;

    const post = state.createdPanels[0].webview.postMessage;
    const calls = post.mock.calls.map((c: unknown[]) => c[0]);
    const depsMsg = calls.find(
      (
        m,
      ): m is {
        type: "scriptDeps";
        libraryScripts: Array<{ uid: string; label: string; kind: string }>;
        esvs: Array<{ uid: string; label: string; kind: string }>;
      } => Boolean(m) && (m as { type?: unknown }).type === "scriptDeps",
    );
    expect(depsMsg?.libraryScripts.map((l) => l.label)).toEqual(["helpers"]);
    expect(depsMsg?.esvs.map((e) => e.label)).toEqual(["esv.kyid.portal.name"]);
  });

  it("journeyDeps carries themes / emailTemplates / socialIdps arrays from new payload kinds", async () => {
    const state = await getVscodeMockState();
    const journey: Journey = {
      id: "Login",
      enabled: true,
      entryNodeId: "n1",
      nodes: {
        n1: { nodeType: "PageNode", connections: {} },
        n2: { nodeType: "EmailSuspendNode", connections: {} },
        n3: { nodeType: "SocialProviderHandlerNode", connections: {} },
      },
    };
    const client = makeFakePaicClient({
      nodesByKey: {
        "alpha:PageNode:n1": {
          id: "n1",
          nodeType: "PageNode",
          themeId: "theme-1",
          childRefs: [],
        },
        "alpha:EmailSuspendNode:n2": {
          id: "n2",
          nodeType: "EmailSuspendNode",
          emailTemplateName: "Welcome",
        },
        "alpha:SocialProviderHandlerNode:n3": {
          id: "n3",
          nodeType: "SocialProviderHandlerNode",
          scriptId: "s-social",
          filteredProviders: ["google-oidc"],
        },
      },
    });
    const cache = makeFakeCache(client);
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });
    const node = new JourneyNode("h.example.com", "alpha", journey, cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;

    const post = state.createdPanels[0].webview.postMessage;
    const calls = post.mock.calls.map((c: unknown[]) => c[0]);
    const depsMsg = calls.find(
      (
        m,
      ): m is {
        type: "journeyDeps";
        themes: Array<{ label: string }>;
        emailTemplates: Array<{ label: string }>;
        socialIdps: Array<{ label: string }>;
      } => Boolean(m) && (m as { type?: unknown }).type === "journeyDeps",
    );
    expect(depsMsg?.themes.map((t) => t.label)).toEqual(["theme-1"]);
    expect(depsMsg?.emailTemplates.map((e) => e.label)).toEqual(["Welcome"]);
    expect(depsMsg?.socialIdps.map((s) => s.label)).toEqual(["google-oidc"]);
  });

  it("nodeIndex carries the new typed fields per Slice 4 NodeInfo widening", async () => {
    const state = await getVscodeMockState();
    const journey: Journey = {
      id: "Login",
      enabled: true,
      entryNodeId: "p1",
      nodes: {
        p1: { nodeType: "PageNode", connections: {} },
        e1: { nodeType: "EmailSuspendNode", connections: {} },
        s1: { nodeType: "SocialProviderHandlerNode", connections: {} },
        i1: { nodeType: "SelectIdPNode", connections: {} },
        d1: { nodeType: "DeviceMatchNode", connections: {} },
      },
    };
    const client = makeFakePaicClient({
      nodesByKey: {
        "alpha:PageNode:p1": {
          id: "p1",
          nodeType: "PageNode",
          themeId: "theme-1",
          childRefs: [],
        },
        "alpha:EmailSuspendNode:e1": {
          id: "e1",
          nodeType: "EmailSuspendNode",
          emailTemplateName: "Welcome",
        },
        "alpha:SocialProviderHandlerNode:s1": {
          id: "s1",
          nodeType: "SocialProviderHandlerNode",
          scriptId: "s-social",
          filteredProviders: ["google-oidc"],
        },
        "alpha:SelectIdPNode:i1": {
          id: "i1",
          nodeType: "SelectIdPNode",
          filteredProviders: ["apple-oidc"],
        },
        "alpha:DeviceMatchNode:d1": {
          id: "d1",
          nodeType: "DeviceMatchNode",
          useScript: false,
        },
      },
    });
    const cache = makeFakeCache(client);
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });
    const node = new JourneyNode("h.example.com", "alpha", journey, cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;

    const post = state.createdPanels[0].webview.postMessage;
    const calls = post.mock.calls.map((c: unknown[]) => c[0]);
    const depsMsg = calls.find(
      (
        m,
      ): m is {
        type: "journeyDeps";
        nodeIndex: Record<
          string,
          {
            kind: string;
            uid?: string;
            scriptId?: string;
            themeId?: string;
            emailTemplateName?: string;
            socialIdpNames?: string[];
            useScript?: boolean;
            rawNodeType?: string;
          }
        >;
      } => Boolean(m) && (m as { type?: unknown }).type === "journeyDeps",
    );
    const idx = depsMsg!.nodeIndex;
    expect(idx.p1.kind).toBe("theme");
    expect(idx.p1.themeId).toBe("theme-1");
    expect(idx.p1.uid).toBe("theme:h.example.com:alpha:theme-1");
    expect(idx.e1.kind).toBe("emailTemplate");
    expect(idx.e1.emailTemplateName).toBe("Welcome");
    expect(idx.e1.uid).toBe("email-template:h.example.com:alpha:Welcome");
    expect(idx.s1.kind).toBe("script");
    expect(idx.s1.scriptId).toBe("s-social");
    expect(idx.s1.socialIdpNames).toEqual(["google-oidc"]);
    expect(idx.i1.kind).toBe("socialIdp");
    expect(idx.i1.socialIdpNames).toEqual(["apple-oidc"]);
    expect(idx.i1.uid).toBe("social-idp:h.example.com:alpha:apple-oidc");
    expect(idx.d1.kind).toBe("other");
    expect(idx.d1.useScript).toBe(false);
  });
});

describe("InspectorTab.onMessage — resolveFull (D35)", () => {
  it("posts an ok-shaped resolveResult after resolving a JourneyNode root", async () => {
    const state = await getVscodeMockState();
    const journey: Journey = {
      id: "Login",
      enabled: true,
      entryNodeId: "n1",
      nodes: { n1: { nodeType: "ScriptedDecisionNode", connections: {} } },
    };
    const client = makeFakePaicClient({
      nodesByKey: {
        "alpha:ScriptedDecisionNode:n1": {
          id: "n1",
          nodeType: "ScriptedDecisionNode",
          scriptId: "s-1",
          outcomes: [],
          inputs: [],
          outputs: [],
        },
      },
    });
    const graph = {
      rootKey: "journey:Login",
      nodes: {
        "journey:Login": {
          key: "journey:Login",
          kind: "journey" as const,
          id: "Login",
          displayName: "Login",
          depth: 0,
        },
        "script:s-1": {
          key: "script:s-1",
          kind: "script" as const,
          id: "s-1",
          displayName: "auth-decision",
          depth: 1,
        },
      },
      edges: [{ fromKey: "journey:Login", toKey: "script:s-1", via: "ScriptedDecisionNode" }],
      durationMs: 7,
    };
    const cache = makeFakeCache(client);
    const log = makeFakeLogger();
    const resolverCache = makeFakeResolverCache({
      graphsByKey: { "h.example.com|alpha|journey|Login": graph },
    });
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache,
      log,
    });
    const node = new JourneyNode("h.example.com", "alpha", journey, cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;
    state.createdPanels[0].webview.__fireReceive({ type: "resolveFull" });
    await flush();

    const calls = state.createdPanels[0].webview.postMessage.mock.calls.map((c: unknown[]) => c[0]);
    const result = calls.find(
      (m: unknown) => Boolean(m) && (m as { type?: unknown }).type === "resolveResult",
    ) as { ok: boolean; graph?: typeof graph; message?: string } | undefined;
    expect(result?.ok).toBe(true);
    expect(result?.graph?.rootKey).toBe("journey:Login");
  });

  it("posts an err-shaped resolveResult when the resolver rejects", async () => {
    const state = await getVscodeMockState();
    const journey: Journey = {
      id: "Login",
      enabled: true,
      entryNodeId: "n1",
      nodes: { n1: { nodeType: "ScriptedDecisionNode", connections: {} } },
    };
    const client = makeFakePaicClient({
      nodesByKey: {
        "alpha:ScriptedDecisionNode:n1": {
          id: "n1",
          nodeType: "ScriptedDecisionNode",
          scriptId: "s-1",
          outcomes: [],
          inputs: [],
          outputs: [],
        },
      },
    });
    const cache = makeFakeCache(client);
    const log = makeFakeLogger();
    const resolverCache = makeFakeResolverCache({ rejectWith: new Error("tenant 503") });
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache,
      log,
    });
    const node = new JourneyNode("h.example.com", "alpha", journey, cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;
    state.createdPanels[0].webview.__fireReceive({ type: "resolveFull" });
    await flush();

    const calls = state.createdPanels[0].webview.postMessage.mock.calls.map((c: unknown[]) => c[0]);
    const result = calls.find(
      (m: unknown) => Boolean(m) && (m as { type?: unknown }).type === "resolveResult",
    ) as { ok: boolean; message?: string } | undefined;
    expect(result?.ok).toBe(false);
    expect(result?.message).toMatch(/tenant 503/);
  });

  it("ignores resolveFull on a card kind with no root support (no resolveResult posted)", async () => {
    const state = await getVscodeMockState();
    const cache = makeFakeCache(makeFakePaicClient({}));
    const log = makeFakeLogger();
    const resolverCache = makeFakeResolverCache();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache,
      log,
    });
    const node = new ConnectionNode(CONN, cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;
    state.createdPanels[0].webview.__fireReceive({ type: "resolveFull" });
    await flush();

    const calls = state.createdPanels[0].webview.postMessage.mock.calls.map((c: unknown[]) => c[0]);
    const result = calls.find(
      (m: unknown) => Boolean(m) && (m as { type?: unknown }).type === "resolveResult",
    );
    expect(result).toBeUndefined();
    // The fake resolver's `resolve` must not have been invoked.
    expect(resolverCache.resolve).not.toHaveBeenCalled();
  });

  it("refreshResolved drops the cache entry then posts a fresh resolveResult", async () => {
    const state = await getVscodeMockState();
    const journey: Journey = {
      id: "Login",
      enabled: true,
      entryNodeId: "n1",
      nodes: { n1: { nodeType: "ScriptedDecisionNode", connections: {} } },
    };
    const client = makeFakePaicClient({
      nodesByKey: {
        "alpha:ScriptedDecisionNode:n1": {
          id: "n1",
          nodeType: "ScriptedDecisionNode",
          scriptId: "s-1",
          outcomes: [],
          inputs: [],
          outputs: [],
        },
      },
    });
    const graph = {
      rootKey: "journey:Login",
      nodes: {
        "journey:Login": {
          key: "journey:Login",
          kind: "journey" as const,
          id: "Login",
          displayName: "Login",
          depth: 0,
        },
      },
      edges: [],
      durationMs: 3,
    };
    const cache = makeFakeCache(client);
    const log = makeFakeLogger();
    const resolverCache = makeFakeResolverCache({
      graphsByKey: { "h.example.com|alpha|journey|Login": graph },
    });
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache,
      log,
    });
    const node = new JourneyNode("h.example.com", "alpha", journey, cache, log);

    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;
    state.createdPanels[0].webview.__fireReceive({ type: "refreshResolved" });
    await flush();

    // `dropOne` was called with the expected ResolverKey shape before `resolve`.
    expect(resolverCache.dropOne).toHaveBeenCalledWith({
      host: "h.example.com",
      realm: "alpha",
      kind: "journey",
      id: "Login",
    });
    expect(resolverCache.resolve).toHaveBeenCalledTimes(1);

    const calls = state.createdPanels[0].webview.postMessage.mock.calls.map((c: unknown[]) => c[0]);
    const result = calls.find(
      (m: unknown) => Boolean(m) && (m as { type?: unknown }).type === "resolveResult",
    ) as { ok: boolean } | undefined;
    expect(result?.ok).toBe(true);
  });
});

describe("InspectorFactory.spawnByDescriptor — M5 Slice 2 refactor", () => {
  it("spawnByDescriptor(script descriptor) opens a new tab and posts a select payload", async () => {
    const state = await getVscodeMockState();
    const client = makeFakePaicClient({
      scriptsByKey: {
        "alpha:s-1": { id: "s-1", name: "validator", language: "JAVASCRIPT", body: "" },
      },
    });
    const cache = makeFakeCache(client);
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log: makeFakeLogger(),
    });

    const tab = await factory.spawnByDescriptor("h.example.com", "alpha", {
      kind: "script",
      id: "s-1",
      displayName: "validator",
    });
    fireReadyOnAll(state);
    await tab?.ready;
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(1);

    const calls = state.createdPanels[0].webview.postMessage.mock.calls.map((c: unknown[]) => c[0]);
    const select = calls.find(
      (m: unknown) => Boolean(m) && (m as { type?: unknown }).type === "select",
    ) as { payload?: { kind?: string; scriptId?: string } } | undefined;
    expect(select?.payload?.kind).toBe("script");
    expect(select?.payload?.scriptId).toBe("s-1");
  });

  it("spawnByDescriptor opens a new tab for every supported entity kind", async () => {
    const state = await getVscodeMockState();
    const client = makeFakePaicClient({});
    const cache = makeFakeCache(client);
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log: makeFakeLogger(),
    });

    const kinds: Array<"esv" | "theme" | "emailTemplate" | "socialIdp" | "journey"> = [
      "esv",
      "theme",
      "emailTemplate",
      "socialIdp",
      "journey",
    ];
    const tabs = await Promise.all(
      kinds.map((kind) =>
        factory.spawnByDescriptor("h.example.com", "alpha", {
          kind,
          id: `${kind}-x`,
          displayName: `${kind}-x`,
        }),
      ),
    );
    fireReadyOnAll(state);
    await Promise.all(tabs.map((t) => t?.ready));
    expect(state.createWebviewPanel).toHaveBeenCalledTimes(kinds.length);
  });
});

describe("InspectorTab.onMessage — findUsages (M5 Slice 3)", () => {
  it("dispatches paicJourneys.findUsages via executeCommand with the descriptor", async () => {
    const state = await getVscodeMockState();
    const vscodeMod = (await import("vscode")) as unknown as {
      commands: { executeCommand: ReturnType<typeof vi.fn> };
    };
    const executeCommand = vscodeMod.commands.executeCommand;
    executeCommand.mockClear();

    const client = makeFakePaicClient({});
    const cache = makeFakeCache(client);
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log: makeFakeLogger(),
    });

    const node = new ConnectionNode(CONN, cache, makeFakeLogger());
    const tab = factory.spawn(node);
    fireReadyOnAll(state);
    await tab.ready;

    const panel = state.createdPanels[0];
    panel.webview.__fireReceive({
      type: "findUsages",
      host: "h.example.com",
      realm: "alpha",
      kind: "script",
      id: "s-1",
      displayName: "validator",
      isLibrary: true,
    });
    await flush();

    expect(executeCommand).toHaveBeenCalledWith(
      "paicJourneys.findUsages",
      expect.objectContaining({
        host: "h.example.com",
        realm: "alpha",
        kind: "script",
        id: "s-1",
        displayName: "validator",
        isLibrary: true,
      }),
    );
  });
});

/**
 * Handshake gate (lesson 2026-05-26). The webview signals `{ type: "ready" }`
 * once React has mounted and attached its `message` listener; the extension
 * gates every outbound `post()` on that signal so the first `select` cannot
 * race the React mount on slow IPC (RDP). The tests below pin the gate's
 * three contracts: messages buffer before ready, drain in order on ready,
 * and a hung webview eventually drains via the 5s timeout fallback.
 */
describe("InspectorTab — ready-handshake gate", () => {
  it("buffers post() until the webview signals ready (no postMessage before the handshake)", async () => {
    const state = await getVscodeMockState();
    const cache = makeFakeCache(makeFakePaicClient({}));
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });
    const node = new ConnectionNode(CONN, cache, log);

    factory.spawn(node);
    // Drain microtasks — render()'s `buildSelectPayload` resolves
    // synchronously for a ConnectionNode, so without the gate, postMessage
    // would have been called by now. With the gate, it must NOT have been.
    await flush();
    const post = state.createdPanels[0].webview.postMessage;
    expect(post).not.toHaveBeenCalled();
  });

  it("flushes the buffered select message once the webview signals ready", async () => {
    const state = await getVscodeMockState();
    const cache = makeFakeCache(makeFakePaicClient({}));
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });
    const node = new ConnectionNode(CONN, cache, log);

    const tab = factory.spawn(node);
    await flush();
    const post = state.createdPanels[0].webview.postMessage;
    expect(post).not.toHaveBeenCalled();

    fireReadyOnAll(state);
    await tab.ready;

    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "select",
        payload: expect.objectContaining({ kind: "connection" }),
      }),
    );
  });

  it("preserves message order across the gate (select before journeyDeps)", async () => {
    const state = await getVscodeMockState();
    const journey: Journey = {
      id: "Login",
      enabled: true,
      entryNodeId: "n1",
      nodes: { n1: { nodeType: "ScriptedDecisionNode", connections: {} } },
    };
    const client = makeFakePaicClient({
      nodesByKey: {
        "alpha:ScriptedDecisionNode:n1": {
          id: "n1",
          nodeType: "ScriptedDecisionNode",
          scriptId: "s-1",
          outcomes: [],
          inputs: [],
          outputs: [],
        },
      },
    });
    const cache = makeFakeCache(client);
    const log = makeFakeLogger();
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log,
    });
    const node = new JourneyNode("h.example.com", "alpha", journey, cache, log);

    const tab = factory.spawn(node);
    // Give render() time to enqueue both select and journeyDeps behind the gate.
    await flush();
    fireReadyOnAll(state);
    await tab.ready;

    const post = state.createdPanels[0].webview.postMessage;
    const types = post.mock.calls.map((c: unknown[]) => (c[0] as { type: string }).type);
    expect(types).toEqual(["select", "journeyDeps"]);
  });

  it("falls back to flushing after READY_TIMEOUT_MS when the webview never signals ready", async () => {
    vi.useFakeTimers();
    try {
      const state = await getVscodeMockState();
      const cache = makeFakeCache(makeFakePaicClient({}));
      const log = makeFakeLogger();
      const factory = new InspectorFactory({
        context: makeMockContext(),
        cache,
        resolverCache: makeFakeResolverCache(),
        log,
      });
      const node = new ConnectionNode(CONN, cache, log);

      const tab = factory.spawn(node);
      // Drain any synchronous render setup BEFORE we advance the timer.
      await vi.advanceTimersByTimeAsync(0);
      const post = state.createdPanels[0].webview.postMessage;
      expect(post).not.toHaveBeenCalled();

      // Trip the 5s safety net — every queued post() should now resolve.
      await vi.advanceTimersByTimeAsync(5000);
      await tab.ready;

      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "select",
          payload: expect.objectContaining({ kind: "connection" }),
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("InspectorTab.onMessage — exportRealmJourneys (D46)", () => {
  it("dispatches paicJourneys.exportRealmJourneys via executeCommand", async () => {
    // Guards the card → panel → command hop that otherwise only runs in the
    // Extension Development Host.
    const state = await getVscodeMockState();
    const vscodeMod = (await import("vscode")) as unknown as {
      commands: { executeCommand: ReturnType<typeof vi.fn> };
    };
    const executeCommand = vscodeMod.commands.executeCommand;
    executeCommand.mockClear();

    const client = makeFakePaicClient({});
    const cache = makeFakeCache(client);
    const factory = new InspectorFactory({
      context: makeMockContext(),
      cache,
      resolverCache: makeFakeResolverCache(),
      log: makeFakeLogger(),
    });
    const tab = factory.spawn(new ConnectionNode(CONN, cache, makeFakeLogger()));
    fireReadyOnAll(state);
    await tab.ready;

    state.createdPanels[0].webview.__fireReceive({
      type: "exportRealmJourneys",
      host: "h.example.com",
      realm: "",
      realmLabel: "root",
    });
    await flush();

    expect(executeCommand).toHaveBeenCalledWith("paicJourneys.exportRealmJourneys", {
      host: "h.example.com",
      realm: "", // root realm passes through as "" — not the label
      realmLabel: "root",
    });
  });
});
