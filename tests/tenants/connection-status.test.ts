import { describe, expect, it } from "vitest";
import { makeConnectionStatusStore } from "@/tenants/connection-status";

const HOST = "openam-tenant.example.forgeblocks.com";
const OTHER = "openam-other.example.forgeblocks.com";

describe("connection-status store (D40)", () => {
  it("returns undefined for an untested host", () => {
    const store = makeConnectionStatusStore();
    expect(store.get(HOST)).toBeUndefined();
  });

  it("markOk / markFail record the last outcome per host", () => {
    const store = makeConnectionStatusStore();
    store.markOk(HOST);
    expect(store.get(HOST)).toBe("ok");
    store.markFail(HOST);
    expect(store.get(HOST)).toBe("fail");
  });

  it("status is independent per host", () => {
    const store = makeConnectionStatusStore();
    store.markOk(HOST);
    store.markFail(OTHER);
    expect(store.get(HOST)).toBe("ok");
    expect(store.get(OTHER)).toBe("fail");
  });

  it("clear() forgets a host's status (e.g. on edit / delete)", () => {
    const store = makeConnectionStatusStore();
    store.markOk(HOST);
    store.clear(HOST);
    expect(store.get(HOST)).toBeUndefined();
  });
});
