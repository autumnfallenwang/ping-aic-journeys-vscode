import { beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { exportRealmJourneys } from "@/commands/export-realm-journeys";
import { buildRealmBundle } from "@/export/realm-bundle";

vi.mock("vscode", async () => (await import("../util/vscode-mock")).makeVscodeMock());
vi.mock("@/export/realm-bundle", () => ({ buildRealmBundle: vi.fn() }));

// biome-ignore lint/suspicious/noExplicitAny: tiny test logger fake
function fakeLogger(): any {
  const noop = () => undefined;
  const self = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  return { ...self, child: () => self };
}

function makeDeps() {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: minimal cache fake
    clientCache: { get: vi.fn(async () => ({})) } as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry fake
    registry: { list: () => [{ kind: "paic", host: "h1", saId: "sa" }] } as any,
    log: fakeLogger(),
    extensionVersion: "0.3.0",
  };
}

const BUNDLE = {
  meta: { exportTool: "paic-journeys-vscode", scope: "realm" },
  trees: { Login: { nodes: {} }, Inner: { nodes: {} } },
};

/** The realm argument actually handed to `buildRealmBundle` (3rd positional). */
const realmArgOf = () => vi.mocked(buildRealmBundle).mock.calls[0][2];

describe("exportRealmJourneys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(
      vscode.Uri.file("/tmp/allAlphaJourneys.journey.json"),
    );
    // biome-ignore lint/suspicious/noExplicitAny: mock return
    vi.mocked(buildRealmBundle).mockResolvedValue(BUNDLE as any);
  });

  it("builds the realm bundle and writes it — with NO depth prompt", async () => {
    await exportRealmJourneys(makeDeps(), { host: "h1", realm: "alpha", realmLabel: "alpha" });

    expect(buildRealmBundle).toHaveBeenCalledTimes(1);
    expect(realmArgOf()).toBe("alpha");
    expect(vscode.workspace.fs.writeFile).toHaveBeenCalled();
    // D46: realm scope has no level1/allLevels choice — the closure is inherent.
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it("title-cases and concatenates sub-realm path segments like frodo", async () => {
    await exportRealmJourneys(makeDeps(), {
      host: "h1",
      realm: { name: "alpha/customers", active: true, parentPath: "/alpha", isRoot: false },
    });
    const opts = vi.mocked(vscode.window.showSaveDialog).mock.calls[0][0];
    // frodo: realm.split("/").reduce((r, i) => r + titleCase(i), "")
    expect(String(opts?.defaultUri?.path ?? "")).toContain(
      "allAlphaCustomersJourneys.journey.json",
    );
  });

  it("defaults the filename to frodo's all<Realm>Journeys.journey.json", async () => {
    await exportRealmJourneys(makeDeps(), { host: "h1", realm: "alpha", realmLabel: "alpha" });
    const opts = vi.mocked(vscode.window.showSaveDialog).mock.calls[0][0];
    expect(String(opts?.defaultUri?.path ?? "")).toContain("allAlphaJourneys.journey.json");
  });

  // ─── The two entry points (the wiring the EDH exercises) ──────────────────

  it("accepts the inspector-card shape (realm already resolved to a string)", async () => {
    await exportRealmJourneys(makeDeps(), { host: "h1", realm: "alpha", realmLabel: "alpha" });
    expect(realmArgOf()).toBe("alpha");
  });

  it("accepts a RealmNode from the sidebar context menu (realm is an OBJECT)", async () => {
    // The `view/item/context` menu hands the command the tree node itself, whose
    // `.realm` is the `Realm` domain object — not the string the card sends. If
    // `parseArg` only understood the card shape this menu item would silently do
    // nothing, which is exactly the kind of dead wiring unit tests should catch.
    await exportRealmJourneys(makeDeps(), {
      host: "h1",
      realm: { name: "alpha", active: true, parentPath: "/", isRoot: false },
    });
    expect(buildRealmBundle).toHaveBeenCalledTimes(1);
    expect(realmArgOf()).toBe("alpha");
  });

  it("sends an EMPTY realm argument for a root RealmNode, labelled 'root'", async () => {
    // `getRealmPath()` resolves `/realms/root` from "" regardless of the wire name
    // ("/" / "root" / "Top Level Realm"). Passing the name would export the wrong
    // realm — silently, with a 200.
    await exportRealmJourneys(makeDeps(), {
      host: "h1",
      realm: { name: "/", active: true, parentPath: "", isRoot: true },
    });
    expect(realmArgOf()).toBe("");
    const opts = vi.mocked(vscode.window.showSaveDialog).mock.calls[0][0];
    // frodo: the root realm string collapses to empty → "allJourneys", not "allRootJourneys".
    expect(String(opts?.defaultUri?.path ?? "")).toContain("allJourneys.journey.json");
  });

  // ─── Failure / cancel paths ───────────────────────────────────────────────

  it("does nothing for a malformed arg", async () => {
    await exportRealmJourneys(makeDeps(), { host: 42 });
    expect(buildRealmBundle).not.toHaveBeenCalled();
    expect(vscode.window.showSaveDialog).not.toHaveBeenCalled();
  });

  it("surfaces an error when the host has no registered connection", async () => {
    await exportRealmJourneys(makeDeps(), { host: "unknown", realm: "alpha" });
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(buildRealmBundle).not.toHaveBeenCalled();
  });

  it("writes nothing when the user cancels the save dialog", async () => {
    vi.mocked(vscode.window.showSaveDialog).mockResolvedValue(undefined);
    await exportRealmJourneys(makeDeps(), { host: "h1", realm: "alpha" });
    expect(buildRealmBundle).not.toHaveBeenCalled();
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
  });

  it("reports an empty realm instead of writing an empty file", async () => {
    vi.mocked(buildRealmBundle).mockResolvedValue(null);
    await exportRealmJourneys(makeDeps(), { host: "h1", realm: "alpha", realmLabel: "alpha" });
    expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it("surfaces a build failure without throwing", async () => {
    vi.mocked(buildRealmBundle).mockRejectedValue(new Error("boom"));
    await expect(
      exportRealmJourneys(makeDeps(), { host: "h1", realm: "alpha" }),
    ).resolves.toBeUndefined();
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });
});
