import { vi } from "vitest";

vi.mock("vscode", async () => (await import("../../util/vscode-mock")).makeVscodeMock());

import { beforeEach, describe, expect, it } from "vitest";
import { MessageNode } from "@/views/nodes/base";
import { ConnectionNode } from "@/views/nodes/connection";
import { RealmNode } from "@/views/nodes/realm";
import { makeFakeCache, makeFakeLogger, makeFakePaicClient } from "../fakes";

const CONN = { host: "h.example.com", saId: "sa-1", name: "Demo" };

let listRealmsCalls: number;

function makeNode(
  realmsOnFirstCall = [{ name: "alpha", active: true, parentPath: "/", isRoot: false }],
) {
  listRealmsCalls = 0;
  const client = makeFakePaicClient({ realms: realmsOnFirstCall });
  // Wrap listRealms so the test can assert recall on refresh.
  const orig = client.listRealms;
  client.listRealms = vi.fn(() => {
    listRealmsCalls++;
    return orig();
  });
  const cache = makeFakeCache(client);
  return new ConnectionNode(CONN, cache, makeFakeLogger());
}

describe("ConnectionNode", () => {
  beforeEach(() => {
    listRealmsCalls = 0;
  });

  it("getChildren returns one RealmNode per realm", async () => {
    const node = makeNode([
      { name: "alpha", active: true, parentPath: "/", isRoot: false },
      { name: "beta", active: false, parentPath: "/", isRoot: false },
    ]);
    const kids = await node.getChildren();
    expect(kids).toHaveLength(2);
    expect(kids[0]).toBeInstanceOf(RealmNode);
    expect((kids[0] as RealmNode).realm.name).toBe("alpha");
    expect((kids[1] as RealmNode).realm.name).toBe("beta");
  });

  it("empty realm list emits a MessageNode", async () => {
    const node = makeNode([]);
    const kids = await node.getChildren();
    expect(kids).toHaveLength(1);
    expect(kids[0]).toBeInstanceOf(MessageNode);
    expect(kids[0].label).toBe("No realms found");
  });

  it("filters out the PAIC root realm (isRoot=true)", async () => {
    const node = makeNode([
      { name: "/", active: true, parentPath: "/", isRoot: true },
      { name: "alpha", active: true, parentPath: "/", isRoot: false },
      { name: "bravo", active: true, parentPath: "/", isRoot: false },
    ]);
    const kids = await node.getChildren();
    expect(kids).toHaveLength(2);
    expect((kids[0] as RealmNode).realm.name).toBe("alpha");
    expect((kids[1] as RealmNode).realm.name).toBe("bravo");
  });

  it("filters root realm even when wire name is not `/` (e.g. 'Top Level Realm')", async () => {
    const node = makeNode([
      { name: "Top Level Realm", active: true, parentPath: "/", isRoot: true },
      { name: "alpha", active: true, parentPath: "/", isRoot: false },
    ]);
    const kids = await node.getChildren();
    expect(kids).toHaveLength(1);
    expect((kids[0] as RealmNode).realm.name).toBe("alpha");
  });

  it("sorts realms alphabetically, case-insensitive (D33)", async () => {
    const node = makeNode([
      { name: "ZebraRealm", active: true, parentPath: "/", isRoot: false },
      { name: "aardvark", active: true, parentPath: "/", isRoot: false },
      { name: "Bravo", active: true, parentPath: "/", isRoot: false },
      { name: "alpha", active: true, parentPath: "/", isRoot: false },
    ]);
    const kids = await node.getChildren();
    const names = kids.map((k) => (k as RealmNode).realm.name);
    expect(names).toEqual(["aardvark", "alpha", "Bravo", "ZebraRealm"]);
  });

  it("emits the empty-list MessageNode when only root is returned", async () => {
    const node = makeNode([{ name: "/", active: true, parentPath: "/", isRoot: true }]);
    const kids = await node.getChildren();
    expect(kids).toHaveLength(1);
    expect(kids[0]).toBeInstanceOf(MessageNode);
    expect(kids[0].label).toBe("No realms found");
  });

  it("refresh() clears the cache — next getChildren re-calls listRealms", async () => {
    const node = makeNode();
    await node.getChildren();
    await node.getChildren();
    expect(listRealmsCalls).toBe(1);
    node.refresh();
    await node.getChildren();
    expect(listRealmsCalls).toBe(2);
  });

  it("untested-this-session connection has an un-tinted icon (D40)", () => {
    const node = makeNode();
    const icon = node.iconPath as { id: string; color?: { id: string } };
    expect(icon.id).toBe("server-environment");
    expect(icon.color).toBeUndefined();
  });

  it("a verified connection tints its icon green (D40)", () => {
    const node = new ConnectionNode(
      CONN,
      makeFakeCache(makeFakePaicClient({ realms: [] })),
      makeFakeLogger(),
      undefined,
      "ok",
    );
    const icon = node.iconPath as { id: string; color?: { id: string } };
    expect(icon.id).toBe("server-environment");
    expect(icon.color?.id).toBe("charts.green");
  });

  it("a failed connection tints its icon red (D40)", () => {
    const node = new ConnectionNode(
      CONN,
      makeFakeCache(makeFakePaicClient({ realms: [] })),
      makeFakeLogger(),
      undefined,
      "fail",
    );
    const icon = node.iconPath as { id: string; color?: { id: string } };
    expect(icon.color?.id).toBe("charts.red");
  });
});
