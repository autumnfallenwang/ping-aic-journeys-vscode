// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EsvCard } from "@/webview/inspector/ui/cards/EsvCard";
import type { SelectPayload } from "@/webview/messages";

const baseline: Extract<SelectPayload, { kind: "esv" }> = {
  kind: "esv",
  uid: "esv:h:alpha:esv.kyid.portal.name",
  host: "openam-tenant.example.forgeblocks.com",
  realmName: "alpha",
  name: "esv.kyid.portal.name",
};

describe("EsvCard", () => {
  it("renders the unresolved-fallback hint when no esv payload is attached", () => {
    render(<EsvCard payload={baseline} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("esv.kyid.portal.name");
    expect(screen.getByText(/not found in this tenant/i)).toBeTruthy();
  });

  it("renders variable kind + expressionType + decoded value with a Copy button", async () => {
    const value = "https://portal.example.com";
    const valueBase64 = Buffer.from(value, "utf-8").toString("base64");
    // jsdom/happy-dom may not provide navigator.clipboard by default — stub it.
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    render(
      <EsvCard
        payload={{
          ...baseline,
          esv: {
            kind: "variable",
            name: "esv.kyid.portal.name",
            description: "Portal URL",
            expressionType: "string",
            lastChangeDate: "2025-09-01T12:24:49Z",
            lastChangedBy: "alice@example.com",
            loaded: true,
            valueBase64,
          },
        }}
      />,
    );
    expect(screen.getByText("ESV · Variable")).toBeTruthy();
    expect(screen.getByText("Variable")).toBeTruthy();
    expect(screen.getByText("string")).toBeTruthy();
    expect(screen.getByText("Portal URL")).toBeTruthy();
    expect(screen.getByText(value)).toBeTruthy();
    expect(screen.getByText("Yes (live)")).toBeTruthy();
    expect(screen.getByText("alice@example.com")).toBeTruthy();

    const copyBtn = screen.getByRole("button", { name: /copy/i });
    fireEvent.click(copyBtn);
    // Wait for the async clipboard write + setCopied state update to flush;
    // findByText resolves inside act(), so no "not wrapped in act" warning.
    await screen.findByRole("button", { name: /copied!/i });
    expect(writeText).toHaveBeenCalledWith(value);
  });

  it("renders (empty) placeholder for variable with no valueBase64", () => {
    render(
      <EsvCard
        payload={{
          ...baseline,
          esv: {
            kind: "variable",
            name: "esv.kyid.portal.name",
            expressionType: "string",
          },
        }}
      />,
    );
    expect(screen.getByText(/\(empty\)/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });

  it("renders secret kind with versions + placeholder flag + encoding", () => {
    render(
      <EsvCard
        payload={{
          ...baseline,
          name: "esv.ad.creds",
          esv: {
            kind: "secret",
            name: "esv.ad.creds",
            encoding: "generic",
            activeVersion: "2",
            loadedVersion: "2",
            useInPlaceholders: true,
            loaded: true,
            lastChangedBy: "bob@example.com",
          },
        }}
      />,
    );
    expect(screen.getByText("ESV · Secret")).toBeTruthy();
    expect(screen.getByText("Secret")).toBeTruthy();
    expect(screen.getByText("generic")).toBeTruthy();
    // Both Active version + Loaded version render "2" → expect two matches.
    expect(screen.getAllByText("2", { selector: "code" })).toHaveLength(2);
    expect(screen.getByText("Yes")).toBeTruthy(); // useInPlaceholders
    // No Value field exists on a secret card — the REST API never returns it.
    expect(screen.queryByText(/^Value$/)).toBeNull();
  });

  it("decodes UTF-8 multibyte values correctly", () => {
    const value = "héllo wörld";
    const valueBase64 = Buffer.from(value, "utf-8").toString("base64");
    render(
      <EsvCard
        payload={{
          ...baseline,
          esv: {
            kind: "variable",
            name: "esv.kyid.portal.name",
            valueBase64,
          },
        }}
      />,
    );
    expect(screen.getByText(value)).toBeTruthy();
  });

  it("Find usages button fires onFindUsages carrying esvKind when known (M5 Slice 3)", () => {
    const onFindUsages = vi.fn();
    render(
      <EsvCard
        payload={{
          ...baseline,
          esv: { kind: "variable", name: "esv.kyid.portal.name" },
        }}
        onFindUsages={onFindUsages}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Find usages/i }));
    expect(onFindUsages).toHaveBeenCalledWith({
      type: "findUsages",
      host: baseline.host,
      realm: "alpha",
      kind: "esv",
      id: "esv.kyid.portal.name",
      displayName: "esv.kyid.portal.name",
      esvKind: "variable",
    });
  });
});
