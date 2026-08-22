// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RealmCard } from "@/webview/inspector/ui/cards/RealmCard";
import type { SelectPayload } from "@/webview/messages";

function payload(active: boolean): Extract<SelectPayload, { kind: "realm" }> {
  return {
    kind: "realm",
    uid: "realm:h:alpha",
    host: "openam-tenant.example.forgeblocks.com",
    realm: { name: "alpha", active, parentPath: "/", isRoot: false },
  };
}

/** An on-prem root realm — its wire name is not the REST argument (D41/D46). */
function rootPayload(): Extract<SelectPayload, { kind: "realm" }> {
  return {
    kind: "realm",
    uid: "realm:h:/",
    host: "openam.example.net:8080",
    realm: { name: "/", active: true, parentPath: "", isRoot: true },
  };
}

describe("RealmCard", () => {
  it("renders realm name as heading", () => {
    render(<RealmCard payload={payload(true)} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("alpha");
  });

  it("shows Active for an active realm", () => {
    render(<RealmCard payload={payload(true)} />);
    expect(screen.getByText("Active")).toBeTruthy();
  });

  it("shows Inactive for a disabled realm", () => {
    render(<RealmCard payload={payload(false)} />);
    expect(screen.getByText("Inactive")).toBeTruthy();
  });
  it("has no Export button when no handler is passed", () => {
    render(<RealmCard payload={payload(true)} />);
    expect(screen.queryByRole("button", { name: /Export/ })).toBeNull();
  });

  it("posts exportRealmJourneys with the realm name for a normal realm", () => {
    const onExport = vi.fn();
    render(<RealmCard payload={payload(true)} onExportRealmJourneys={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    expect(onExport).toHaveBeenCalledWith({
      type: "exportRealmJourneys",
      host: "openam-tenant.example.forgeblocks.com",
      realm: "alpha",
      realmLabel: "alpha",
    });
  });

  it("sends an EMPTY realm argument for the root realm (D46)", () => {
    // The root realm's REST argument must be "" so `getRealmPath()` resolves
    // `/realms/root` whatever the wire name is ("/" here) — the same rule
    // `RealmNode.loadChildren` applies. Sending "/" would export the wrong realm.
    const onExport = vi.fn();
    render(<RealmCard payload={rootPayload()} onExportRealmJourneys={onExport} />);
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    expect(onExport).toHaveBeenCalledWith({
      type: "exportRealmJourneys",
      host: "openam.example.net:8080",
      realm: "",
      realmLabel: "root",
    });
  });
});
