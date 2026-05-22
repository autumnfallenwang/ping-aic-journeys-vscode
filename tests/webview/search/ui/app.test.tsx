// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CacheStatus, SearchPayload, W2E } from "@/webview/search/messages";
import { App } from "@/webview/search/ui/App";

const HOST = "h.example.com";
const REALM = "alpha";

function payload(over: Partial<SearchPayload> = {}): SearchPayload {
  return {
    connections: [{ host: HOST, name: "Sandbox" }],
    selectedHost: null,
    selectedRealm: null,
    prefill: null,
    ...over,
  };
}

function makeVscode() {
  const posts: W2E[] = [];
  return {
    posts,
    vscode: { postMessage: (m: W2E) => posts.push(m) },
  };
}

function emptyCache(): CacheStatus {
  return { builtAt: null, scanDurationMs: null, counts: null };
}

function populatedCache(): CacheStatus {
  return {
    builtAt: 1_700_000_000_000,
    scanDurationMs: 1234,
    counts: { journey: 2, script: 5, esv: 3, theme: 1, emailTemplate: 0, socialIdp: 0 },
  };
}

function dispatch(data: unknown) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data }));
  });
}

describe("Search App — scope selection", () => {
  it("posts `ready` on mount", () => {
    const { vscode, posts } = makeVscode();
    render(<App vscode={vscode} payload={payload()} />);
    expect(posts.some((p) => p.type === "ready")).toBe(true);
  });

  it("with no selection shows a hint and no Build button", () => {
    const { vscode } = makeVscode();
    render(<App vscode={vscode} payload={payload()} />);
    expect(screen.getByText(/Pick a connection and realm/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Build index/i })).toBeNull();
  });

  it("with no connections configured shows the no-connections hint", () => {
    const { vscode } = makeVscode();
    render(<App vscode={vscode} payload={payload({ connections: [] })} />);
    expect(screen.getByText(/No connections configured/i)).toBeTruthy();
  });

  it("selecting a connection in the combobox posts listRealms", () => {
    const { vscode, posts } = makeVscode();
    render(<App vscode={vscode} payload={payload()} />);
    // Connection is a custom Combobox (D38): open it, pick the option.
    fireEvent.focus(screen.getByLabelText(/Connection/i));
    fireEvent.mouseDown(screen.getByRole("option", { name: /Sandbox/i }));
    const listRealms = posts.find((p) => p.type === "listRealms");
    expect(listRealms).toMatchObject({ type: "listRealms", host: HOST });
  });

  it("a pre-selected host+realm payload posts listRealms + peek on mount", () => {
    const { vscode, posts } = makeVscode();
    render(<App vscode={vscode} payload={payload({ selectedHost: HOST, selectedRealm: REALM })} />);
    expect(posts.find((p) => p.type === "listRealms")).toMatchObject({ host: HOST });
    expect(posts.find((p) => p.type === "peek")).toMatchObject({
      type: "peek",
      host: HOST,
      realm: REALM,
    });
  });

  it("realmsResult populates the realm combobox options", () => {
    const { vscode } = makeVscode();
    render(<App vscode={vscode} payload={payload({ selectedHost: HOST })} />);
    dispatch({ type: "realmsResult", host: HOST, realms: ["alpha", "beta"] });
    // Realm is a custom Combobox (D38): open it and read the option rows.
    fireEvent.focus(screen.getByLabelText(/Realm/i));
    expect(screen.getByRole("option", { name: "alpha" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "beta" })).toBeTruthy();
  });

  it("the Realm combobox is disabled until a connection is picked (D38)", () => {
    const { vscode } = makeVscode();
    render(<App vscode={vscode} payload={payload()} />);
    const realm = screen.getByLabelText(/Realm/i);
    expect(realm.hasAttribute("disabled")).toBe(true);
    // Focusing a disabled combobox opens no popup.
    fireEvent.focus(realm);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("Search App — query flow once scope is set", () => {
  function renderScoped() {
    const made = makeVscode();
    render(
      <App vscode={made.vscode} payload={payload({ selectedHost: HOST, selectedRealm: REALM })} />,
    );
    return made;
  }

  it("peekResult 'Not built' shows the Build button; clicking posts build with host+realm", () => {
    const { posts } = renderScoped();
    dispatch({ type: "peekResult", host: HOST, realm: REALM, status: emptyCache() });
    fireEvent.click(screen.getByRole("button", { name: /Build index/i }));
    expect(posts.find((p) => p.type === "build")).toMatchObject({
      type: "build",
      host: HOST,
      realm: REALM,
    });
  });

  it("buildDone updates the header counts", () => {
    renderScoped();
    dispatch({ type: "buildDone", host: HOST, realm: REALM, status: populatedCache() });
    expect(screen.getByText(/5 scripts/i)).toBeTruthy();
  });

  it("shows a progress bar with phase label + percentage during build", () => {
    renderScoped();
    dispatch({ type: "buildStart", host: HOST, realm: REALM });
    dispatch({
      type: "buildProgress",
      host: HOST,
      realm: REALM,
      phase: "journeys",
      done: 50,
      total: 100,
    });
    // Label is the determinate journey count; pct = round(5 + 73·0.5) = 42.
    expect(screen.getByText("Scanning journeys — 50 / 100")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("the scripts phase advances the bar too (determinate done/total)", () => {
    renderScoped();
    dispatch({ type: "buildStart", host: HOST, realm: REALM });
    // Scripts phase, half-scanned → pct = round(78 + 20·0.5) = 88.
    dispatch({
      type: "buildProgress",
      host: HOST,
      realm: REALM,
      phase: "scripts",
      done: 100,
      total: 200,
    });
    // Unified `X / Y` label, same shape as the journey phase.
    expect(screen.getByText("Resolving scripts — 100 / 200")).toBeTruthy();
    expect(screen.getByText("88%")).toBeTruthy();
  });

  it("clamps the bar monotonically when the script total grows", () => {
    renderScoped();
    dispatch({ type: "buildStart", host: HOST, realm: REALM });
    // Layer 1 finishes: 200 / 200 → 98%.
    dispatch({
      type: "buildProgress",
      host: HOST,
      realm: REALM,
      phase: "scripts",
      done: 200,
      total: 200,
    });
    expect(screen.getByText("98%")).toBeTruthy();
    // Layer 2 surfaces 20 more library scripts → total grows to 220, done
    // still 200. Raw pct would dip to ~96%; the clamp holds it at 98%.
    dispatch({
      type: "buildProgress",
      host: HOST,
      realm: REALM,
      phase: "scripts",
      done: 200,
      total: 220,
    });
    expect(screen.getByText("98%")).toBeTruthy();
    expect(screen.getByText("Resolving scripts — 200 / 220")).toBeTruthy();
  });

  it("By name query posts query with host+realm; result-row click posts previewByKey", () => {
    const { posts } = renderScoped();
    dispatch({ type: "peekResult", host: HOST, realm: REALM, status: populatedCache() });
    fireEvent.click(screen.getByRole("radio", { name: /By name/i }));
    fireEvent.change(screen.getByLabelText(/Pattern/i), { target: { value: "Login" } });
    fireEvent.click(screen.getByRole("button", { name: /^Search$/i }));
    const query = posts.find(
      (p): p is Extract<W2E, { type: "query"; mode: "byName" }> =>
        p.type === "query" && (p as { mode?: string }).mode === "byName",
    );
    expect(query).toMatchObject({ host: HOST, realm: REALM, pattern: "Login" });

    dispatch({
      type: "queryResult",
      host: HOST,
      realm: REALM,
      mode: "byName",
      results: [{ key: "script:s1", kind: "script", id: "s1", displayName: "validator" }],
    });
    fireEvent.click(screen.getByRole("button", { name: /validator/i }));
    expect(posts.find((p) => p.type === "previewByKey")).toMatchObject({
      type: "previewByKey",
      host: HOST,
      realm: REALM,
      id: "s1",
    });
  });

  it("drops a stale result whose (host, realm) differs from the current scope", () => {
    renderScoped();
    // A buildDone for a DIFFERENT realm must not update the header.
    dispatch({ type: "buildDone", host: HOST, realm: "beta", status: populatedCache() });
    expect(screen.queryByText(/5 scripts/i)).toBeNull();
    expect(screen.getByText(/Not built/i)).toBeTruthy();
  });

  it("By-name results render kind-grouped `── Kind (N) ──` dividers", () => {
    renderScoped();
    dispatch({ type: "peekResult", host: HOST, realm: REALM, status: populatedCache() });
    dispatch({
      type: "queryResult",
      host: HOST,
      realm: REALM,
      mode: "byName",
      results: [
        { key: "script:s1", kind: "script", id: "s1", displayName: "validator" },
        { key: "theme:t1", kind: "theme", id: "t1", displayName: "corporate" },
      ],
    });
    expect(screen.getByText(/Scripts \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Themes \(1\)/)).toBeTruthy();
  });

  it("Find-usages results show a List | Tree toggle, defaulting to List", () => {
    renderScoped();
    dispatch({ type: "peekResult", host: HOST, realm: REALM, status: populatedCache() });
    dispatch(findUsagesResult());
    const list = screen.getByRole("radio", { name: "List" });
    const tree = screen.getByRole("radio", { name: "Tree" });
    expect(list.getAttribute("aria-checked")).toBe("true");
    expect(tree.getAttribute("aria-checked")).toBe("false");
  });

  it("switching to Tree renders the journey → target path tree", () => {
    renderScoped();
    dispatch({ type: "peekResult", host: HOST, realm: REALM, status: populatedCache() });
    dispatch(findUsagesResult());
    fireEvent.click(screen.getByRole("radio", { name: "Tree" }));
    // The root journey and the leaf target are both rendered as nodes.
    expect(screen.getByRole("button", { name: "Login" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "esv.x" })).toBeTruthy();
  });

  it("header count reflects the active view — direct refs in List, paths in Tree (D37)", () => {
    renderScoped();
    dispatch({ type: "peekResult", host: HOST, realm: REALM, status: populatedCache() });
    dispatch(findUsagesResult());
    // Both headers lead with the shared "N references" anchor (D37 amend.);
    // each header's second number is countable in that view.
    expect(screen.getByText(/1 reference in 1 journey/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "Tree" }));
    expect(screen.getByText(/1 reference reached on 1 path/)).toBeTruthy();
  });

  it("List view collapses N same-via refs from one journey into one badged row (D37)", () => {
    renderScoped();
    dispatch({ type: "peekResult", host: HOST, realm: REALM, status: populatedCache() });
    dispatch(findUsagesResultMulti());
    // Three ScriptedDecisionNode refs from `Login` → one row with (3 refs).
    expect(screen.getAllByRole("button", { name: "Login" })).toHaveLength(1);
    expect(screen.getByText("(3 refs)")).toBeTruthy();
    // Header: 3 references (the shared anchor), in 1 journey.
    expect(screen.getByText(/3 references in 1 journey/)).toBeTruthy();
  });

  it("Target combobox filters candidates as the user types a substring", () => {
    renderScoped();
    dispatch({ type: "peekResult", host: HOST, realm: REALM, status: populatedCache() });
    dispatch(listEntitiesResult());
    // `name: "Target"` disambiguates from the scope `<select>`s, which also
    // carry the implicit `combobox` role.
    const input = screen.getByRole("combobox", { name: "Target" });
    // Empty input + focus → popup shows every candidate.
    fireEvent.focus(input);
    expect(screen.getByRole("option", { name: "alpha-login-validator" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "helpers" })).toBeTruthy();
    // Typing a substring narrows to matching displayNames.
    fireEvent.change(input, { target: { value: "valid" } });
    expect(screen.getByRole("option", { name: "alpha-login-validator" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "helpers" })).toBeNull();
  });

  it("Target combobox shows a 'No entity matches' row when nothing matches", () => {
    renderScoped();
    dispatch({ type: "peekResult", host: HOST, realm: REALM, status: populatedCache() });
    dispatch(listEntitiesResult());
    fireEvent.change(screen.getByRole("combobox", { name: "Target" }), {
      target: { value: "zzz-no-such-thing" },
    });
    expect(screen.getByText("No entity matches")).toBeTruthy();
  });

  it("picking a Target combobox option selects it and enables Search", () => {
    const { posts } = renderScoped();
    dispatch({ type: "peekResult", host: HOST, realm: REALM, status: populatedCache() });
    dispatch(listEntitiesResult());
    fireEvent.focus(screen.getByRole("combobox", { name: "Target" }));
    fireEvent.mouseDown(screen.getByRole("option", { name: "helpers" }));
    const search = screen.getByRole("button", { name: "Search" });
    expect(search.hasAttribute("disabled")).toBe(false);
    fireEvent.click(search);
    expect(posts.find((p) => p.type === "query")).toMatchObject({
      type: "query",
      mode: "findUsages",
      targetKey: "script:s-helpers",
    });
  });
});

/** A `listEntitiesResult` populating the Target combobox with two scripts. */
function listEntitiesResult() {
  const mk = (id: string, name: string) => ({
    key: `script:${id}`,
    kind: "script" as const,
    id,
    displayName: name,
  });
  const empty: never[] = [];
  return {
    type: "listEntitiesResult" as const,
    host: HOST,
    realm: REALM,
    entitiesByKind: {
      journey: empty,
      script: [mk("s-validator", "alpha-login-validator"), mk("s-helpers", "helpers")],
      esv: empty,
      theme: empty,
      emailTemplate: empty,
      socialIdp: empty,
    },
  };
}

/** A findUsages `queryResult` where one journey references the target via
 * three same-type nodes — exercises the List-view collapse (D37). */
function findUsagesResultMulti() {
  const journey = { key: "journey:Login", kind: "journey", id: "Login", displayName: "Login" };
  const esv = { key: "esv:esv.x", kind: "esv", id: "esv.x", displayName: "esv.x" };
  const ref = { ref: { fromKey: journey.key, via: "ScriptedDecisionNode" }, entity: journey };
  return {
    type: "queryResult" as const,
    host: HOST,
    realm: REALM,
    mode: "findUsages" as const,
    targetKey: esv.key,
    refs: [ref, ref, ref],
    paths: {
      targetKey: esv.key,
      usageCount: 3,
      roots: [
        {
          key: journey.key,
          entity: journey,
          children: [
            { key: esv.key, entity: esv, via: "ScriptedDecisionNode", refCount: 3, children: [] },
          ],
        },
      ],
    },
  };
}

/** A findUsages `queryResult` — journey `Login` → esv `esv.x`. */
function findUsagesResult() {
  const journey = { key: "journey:Login", kind: "journey", id: "Login", displayName: "Login" };
  const esv = { key: "esv:esv.x", kind: "esv", id: "esv.x", displayName: "esv.x" };
  return {
    type: "queryResult" as const,
    host: HOST,
    realm: REALM,
    mode: "findUsages" as const,
    targetKey: esv.key,
    refs: [{ ref: { fromKey: journey.key, via: "ScriptedDecisionNode" }, entity: journey }],
    paths: {
      targetKey: esv.key,
      usageCount: 1,
      roots: [
        {
          key: journey.key,
          entity: journey,
          children: [{ key: esv.key, entity: esv, via: "string literal", children: [] }],
        },
      ],
    },
  };
}
