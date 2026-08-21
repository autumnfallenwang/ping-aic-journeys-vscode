// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ParsedBundle } from "@/webview/transfer/messages";
import { App } from "@/webview/transfer/ui/App";

const PAIC_CONN = { host: "paic.example", name: "PAIC", kind: "paic" as const };
const ONPREM_CONN = { host: "onprem.example", name: "AM", kind: "onprem" as const };

function themeBundle(): ParsedBundle {
  return {
    meta: {
      bundleSchemaVersion: "1.0",
      origin: "openam-tenant.example.forgeblocks.com",
      connectionType: "paic",
      realm: "alpha",
      exportDate: "2026-06-11T00:00:00.000Z",
      exportTool: "paic-journeys-vscode",
      exportToolVersion: "0.1.1",
    },
    kind: "theme",
    label: "Theme",
    components: [{ kind: "theme", id: "zzzexporttesttheme", displayName: "zzz export test theme" }],
    inventory: [],
  };
}

function journeyBundle(): ParsedBundle {
  return {
    meta: null,
    kind: "journey",
    label: "Journey bundle (1 tree)",
    components: [{ kind: "journey", id: "j", displayName: "j" }],
    inventory: ["Nodes: 0"],
  };
}

function scriptBundle(): ParsedBundle {
  return {
    meta: null,
    kind: "script",
    label: "Script",
    components: [{ kind: "script", id: "s", displayName: "lib" }],
    inventory: [],
  };
}

function variableBundle(): ParsedBundle {
  return {
    meta: null,
    kind: "variable",
    label: "ESV variable",
    components: [{ kind: "variable", id: "esv-x", displayName: "esv.x", detail: "value: hello" }],
    inventory: [],
  };
}

/** A journey verdict (existence-only: new/exists). */
const jv = (id: string, status: "new" | "exists") => ({
  kind: "journey",
  id,
  displayName: id,
  status,
});

/** A JourneyUnitPlan (S5 decision model). */
const jp = (
  id: string,
  role: "subject" | "inner",
  verdict: "new" | "exists" | "identical",
  defaultAction: "create" | "overwrite" | "keep",
  allowedActions: Array<"create" | "overwrite" | "keep">,
) => ({ id, displayName: id, role, verdict, defaultAction, allowedActions });

/** Load a journey bundle, pick a target, and post a journey preflight. */
function journeyPreflight(
  verdicts: unknown[],
  journeyPlans: unknown[],
  requires: unknown[] = [],
): void {
  postToWebview({ type: "bundleLoaded", fileName: "j.journey.json", bundle: journeyBundle() });
  selectTargetAndPreflight(verdicts, requires, journeyPlans);
}

/** Drive the App to a target-selected + preflight-loaded state with the given verdicts. */
function selectTargetAndPreflight(
  verdicts: unknown[],
  requires: unknown[] = [],
  journeyPlans: unknown[] = [],
): void {
  pickCombo("target-connection", "paic", "paic.example");
  postToWebview({ type: "realmsResult", host: "paic.example", realms: ["alpha"] });
  pickCombo("target-realm", "alpha", "alpha");
  postToWebview({
    type: "preflightResult",
    host: "paic.example",
    realm: "alpha",
    verdicts,
    requires,
    journeyPlans,
  });
}

/** Dispatch an extension→webview message the way the panel's postMessage does. */
function postToWebview(data: unknown): void {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data }));
  });
}

/** Drive a `Combobox`: focus + type to open/filter, then click the option. */
function pickCombo(id: string, typeText: string, value: string): void {
  const input = document.getElementById(id) as HTMLInputElement;
  act(() => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: typeText } });
  });
  const opt = document.getElementById(`${id}-opt-${value}`);
  if (!opt) throw new Error(`combobox option ${value} not rendered`);
  act(() => {
    fireEvent.mouseDown(opt);
  });
}

describe("Transfer App", () => {
  it("posts pickBundle when Choose bundle is clicked", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [] }} />);
    fireEvent.click(screen.getByText("Choose bundle…"));
    expect(post).toHaveBeenCalledWith({ type: "pickBundle" });
  });

  it("renders the Source preview (chip + meta + component) on bundleLoaded", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x.theme.json", bundle: themeBundle() });
    expect(screen.getByText("Theme")).toBeTruthy(); // type chip
    expect(screen.getByText("zzz export test theme")).toBeTruthy(); // component row
    expect(screen.getByText("alpha")).toBeTruthy(); // meta realm
    expect(screen.getByText("x.theme.json")).toBeTruthy(); // file name
  });

  it("shows an error banner on bundleError", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [] }} />);
    postToWebview({ type: "bundleError", message: "This file isn't valid JSON." });
    expect(screen.getByText("This file isn't valid JSON.")).toBeTruthy();
  });

  it("shows the Target section for a leaf bundle", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x.theme.json", bundle: themeBundle() });
    expect(screen.getByText("Target")).toBeTruthy();
    expect(screen.getByText("Connection")).toBeTruthy();
  });

  it("shows the Target section for a journey bundle (no longer deferred)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "j.journey.json", bundle: journeyBundle() });
    expect(screen.getByText("Target")).toBeTruthy();
    expect(screen.queryByText(/arrives in a later batch/)).toBeNull();
  });

  it("posts listRealms when a connection is chosen", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    pickCombo("target-connection", "paic", "paic.example");
    expect(post).toHaveBeenCalledWith({ type: "listRealms", host: "paic.example" });
  });

  it("posts runPreflight and shows a pending state once a target is fully selected", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    pickCombo("target-connection", "paic", "paic.example");
    postToWebview({ type: "realmsResult", host: "paic.example", realms: ["alpha"] });
    pickCombo("target-realm", "alpha", "alpha");
    expect(post).toHaveBeenCalledWith({
      type: "runPreflight",
      host: "paic.example",
      realm: "alpha",
    });
    expect(screen.getByText("Checking target…")).toBeTruthy();
  });

  it("renders Plan verdicts from a matching preflightResult", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    pickCombo("target-connection", "paic", "paic.example");
    postToWebview({ type: "realmsResult", host: "paic.example", realms: ["alpha"] });
    pickCombo("target-realm", "alpha", "alpha");
    postToWebview({
      type: "preflightResult",
      host: "paic.example",
      realm: "alpha",
      verdicts: [
        {
          kind: "theme",
          id: "zzzexporttesttheme",
          displayName: "zzz export test theme",
          status: "differs",
        },
      ],
      requires: [],
      journeyPlans: [],
    });
    // Smart-default (S9a): the Differs row arrives pre-checked → Overwrite.
    expect(screen.getByText("Overwrite")).toBeTruthy();
  });

  it("renders an unsupported verdict for a theme on on-prem", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [ONPREM_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    pickCombo("target-connection", "onprem", "onprem.example");
    postToWebview({ type: "realmsResult", host: "onprem.example", realms: ["root"] });
    pickCombo("target-realm", "root", "root");
    postToWebview({
      type: "preflightResult",
      host: "onprem.example",
      realm: "root",
      verdicts: [
        { kind: "theme", id: "t", displayName: "zzz export test theme", status: "unsupported" },
      ],
      requires: [],
      journeyPlans: [],
    });
    expect(screen.getByText("Unsupported")).toBeTruthy();
  });

  it("shows the Import button for an ESV variable bundle (variables are writable)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "v.variable.json", bundle: variableBundle() });
    selectTargetAndPreflight([
      { kind: "variable", id: "esv-x", displayName: "esv.x", status: "new" },
    ]);
    // Smart-default (S9a): the writable row is pre-checked.
    expect(screen.getByText(/Import 1 selected/)).toBeTruthy();
  });

  it("renders ESV writes as 'pending apply' with the apply-coming hint", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "v.variable.json", bundle: variableBundle() });
    selectTargetAndPreflight([
      { kind: "variable", id: "esv-x", displayName: "esv.x", status: "new" },
    ]);
    postToWebview({
      type: "executeResult",
      host: "paic.example",
      realm: "alpha",
      results: [{ kind: "variable", id: "esv-x", displayName: "esv.x", status: "created" }],
      summary: "1 created · 0 overwritten · 0 skipped · 0 failed",
    });
    expect(screen.getByText(/aren't live until applied/)).toBeTruthy();
    // TD-10: the ESV row's Status now reads the outcome.
    expect(screen.getByText("Created")).toBeTruthy();
  });

  /** Drive the App through an ESV import so the Apply button is available. */
  function importEsv(post = vi.fn()) {
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "v.variable.json", bundle: variableBundle() });
    selectTargetAndPreflight([
      { kind: "variable", id: "esv-x", displayName: "esv.x", status: "new" },
    ]);
    postToWebview({
      type: "executeResult",
      host: "paic.example",
      realm: "alpha",
      results: [{ kind: "variable", id: "esv-x", displayName: "esv.x", status: "created" }],
      summary: "1 created",
    });
    return post;
  }

  it("shows the Apply ESV changes button after an ESV import and posts applyEsv", () => {
    const post = importEsv();
    fireEvent.click(screen.getByText("Apply ESV changes"));
    expect(post).toHaveBeenCalledWith({ type: "applyEsv", host: "paic.example" });
  });

  it("renders apply progress then the applied result", () => {
    importEsv();
    postToWebview({
      type: "applyProgress",
      host: "paic.example",
      status: "restarting",
      elapsedS: 30,
    });
    expect(screen.getByText(/Applying ESV changes/)).toBeTruthy();
    postToWebview({ type: "applyResult", host: "paic.example", ok: true, elapsedS: 185 });
    expect(screen.getByText(/ESV changes applied/)).toBeTruthy();
  });

  it("keeps apply progress through a realm-dropdown change (host-keyed)", () => {
    importEsv();
    postToWebview({
      type: "applyProgress",
      host: "paic.example",
      status: "restarting",
      elapsedS: 30,
    });
    // Change the realm — the apply is host-scoped, so it must survive.
    postToWebview({ type: "realmsResult", host: "paic.example", realms: ["alpha", "beta"] });
    pickCombo("target-realm", "beta", "beta");
    expect(screen.getByText(/Applying ESV changes/)).toBeTruthy();
  });

  it("shows an Import button for a writable atom bundle and posts execute", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([
      {
        kind: "theme",
        id: "zzzexporttesttheme",
        displayName: "zzz export test theme",
        status: "new",
      },
    ]);
    fireEvent.click(screen.getByText(/Import 1 selected/)); // pre-checked (smart-default)
    expect(post).toHaveBeenCalledWith({
      type: "execute",
      host: "paic.example",
      realm: "alpha",
      selected: ["theme:zzzexporttesttheme"],
    });
  });

  it("after a run, the row Status shows the outcome and the table locks (TD-10)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([{ kind: "theme", id: "t", displayName: "zzz theme", status: "new" }]);
    postToWebview({
      type: "executeResult",
      host: "paic.example",
      realm: "alpha",
      results: [{ kind: "theme", id: "t", displayName: "zzz theme", status: "created" }],
      summary: "1 created · 0 overwritten · 0 skipped · 0 failed",
    });
    expect(screen.getByText("Created")).toBeTruthy(); // phase-3 status in the table
    // Locked: the checkbox is disabled and the read-only note appears.
    expect((screen.getByLabelText("Import zzz theme") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/this plan is now read-only/)).toBeTruthy();
  });

  it("a cancelled import (no results) returns to the editable plan — not locked, no Re-plan", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([{ kind: "theme", id: "t", displayName: "zzz theme", status: "new" }]);
    postToWebview({
      type: "executeResult",
      host: "paic.example",
      realm: "alpha",
      results: [], // Cancel writes nothing — target unchanged, plan still valid.
      summary: "Cancelled.",
    });
    // NOT locked: no read-only state, no Re-plan / Download report.
    expect(screen.queryByText(/this plan is now read-only/)).toBeNull();
    expect(screen.queryByText("Re-plan")).toBeNull();
    expect(screen.queryByText("Download report")).toBeNull();
    // The plan is editable again (checkbox live) and the Import button is back.
    expect((screen.getByLabelText("Import zzz theme") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(/Import 1 selected/)).toBeTruthy();
    // The reason is surfaced as a transient note.
    expect(screen.getByText("Cancelled.")).toBeTruthy();
  });

  it("shows the Import button for a new script bundle (scripts are writable)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "s.script.json", bundle: scriptBundle() });
    selectTargetAndPreflight([
      { kind: "script", id: "s", displayName: "RiskDecision", status: "new" },
    ]);
    // Smart-default (S9a): the writable row is pre-checked.
    expect(screen.getByText(/Import 1 selected/)).toBeTruthy();
    expect(screen.queryByText(/arrives in a later batch/)).toBeNull();
  });

  it("renders discovered deps as info-only rows IN the table (TD-9, folded into TD-8)", () => {
    const { container } = render(
      <App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />,
    );
    postToWebview({ type: "bundleLoaded", fileName: "s.script.json", bundle: scriptBundle() });
    selectTargetAndPreflight(
      [{ kind: "script", id: "s", displayName: "RiskDecision", status: "new" }],
      [
        { kind: "script", name: "fraud-helpers", status: "missing" },
        { kind: "esv", name: "esv.threshold", status: "present", detail: "variable" },
      ],
    );
    // No separate "Requires" section anymore — deps are table rows.
    expect(screen.queryByText(/Requires/)).toBeNull();
    const names = [...container.querySelectorAll(".plan-name")].map((n) => n.textContent);
    expect(names).toContain("RiskDecision");
    expect(names.some((n) => n?.startsWith("fraud-helpers"))).toBe(true); // + reason note (S9a)
    expect(names.some((n) => n?.startsWith("esv.threshold"))).toBe(true);
    expect(screen.getByText("Missing ⚠")).toBeTruthy(); // fraud-helpers (advisory)
    // A dep row is info-only: disabled checkbox, Status carries the existence fact.
    expect((screen.getByLabelText("Import fraud-helpers") as HTMLInputElement).disabled).toBe(true);
  });

  // ─── TD-8 Plan table ───────────────────────────────────────────────────────

  it("renders the grid table headers (no Action column; Review added per TD-11)", () => {
    const { container } = render(
      <App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />,
    );
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([{ kind: "theme", id: "t", displayName: "zzz theme", status: "new" }]);
    const headers = [...container.querySelectorAll(".plan-col-head")].map((h) => h.textContent);
    expect(headers).toEqual(["Type", "Status", "Name", "Review", "Notes"]);
  });

  it("TD-10/S9a: three-phase Status — Create (pre-checked) ⇄ New (unchecked)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([{ kind: "theme", id: "t", displayName: "zzz theme", status: "new" }]);
    const cb = screen.getByLabelText("Import zzz theme") as HTMLInputElement;
    expect(cb.checked).toBe(true); // smart-default: pre-checked
    expect(screen.getByText("Create")).toBeTruthy(); // phase 2 by default
    expect(screen.getByText(/Import 1 selected · 1 create · 0 overwrite/)).toBeTruthy();
    fireEvent.click(cb); // uncheck → reverts to phase 1
    expect(screen.getByText("New")).toBeTruthy();
    expect(screen.queryByText("Create")).toBeNull();
    fireEvent.click(cb); // re-check → phase 2
    expect(screen.getByText("Create")).toBeTruthy();
    expect(screen.queryByText("New")).toBeNull();
  });

  it("TD-10: a differs row shows Differs → Overwrite when checked", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([
      { kind: "theme", id: "t", displayName: "zzz theme", status: "differs" },
    ]);
    expect(screen.getByText("Overwrite")).toBeTruthy(); // pre-checked (smart-default)
    fireEvent.click(screen.getByLabelText("Import zzz theme")); // uncheck → comparison fact
    expect(screen.getByText("Differs")).toBeTruthy();
  });

  it("an identical row shows a checked-but-locked 'present' checkbox + Status=Identical", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([
      { kind: "theme", id: "t", displayName: "zzz theme", status: "identical" },
    ]);
    const cb = screen.getByLabelText("Import zzz theme") as HTMLInputElement;
    expect(cb.disabled).toBe(true);
    expect(cb.checked).toBe(true); // present = checked-grey "already on target" (not empty)
    expect(screen.getByText("Identical")).toBeTruthy();
  });

  it("an all-identical LEAF plan shows a DISABLED 'Nothing to import' button (not hidden)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([
      { kind: "theme", id: "t", displayName: "zzz theme", status: "identical" },
    ]);
    const btn = screen.getByText("Nothing to import") as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // shown + greyed, never gone
  });

  it("an all-identical JOURNEY plan shows a DISABLED 'Nothing to import' button", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight([jv("Login", "exists")], [jp("Login", "subject", "identical", "keep", [])]);
    const btn = screen.getByText("Nothing to import") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("an unsupported row has a disabled checkbox and Status=Unsupported", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [ONPREM_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    pickCombo("target-connection", "onprem", "onprem.example");
    postToWebview({ type: "realmsResult", host: "onprem.example", realms: ["root"] });
    pickCombo("target-realm", "root", "root");
    postToWebview({
      type: "preflightResult",
      host: "onprem.example",
      realm: "root",
      verdicts: [{ kind: "theme", id: "t", displayName: "zzz theme", status: "unsupported" }],
      requires: [],
      journeyPlans: [],
    });
    // Uniform column: disabled (not absent) checkbox.
    expect((screen.getByLabelText("Import zzz theme") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Unsupported")).toBeTruthy();
  });

  it("an id-collision row is blocked (disabled checkbox) + names the occupant (TD-9)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "s.script.json", bundle: scriptBundle() });
    selectTargetAndPreflight([
      {
        kind: "script",
        id: "U1",
        displayName: "Foo",
        status: "id-collision",
        message: 'UUID U1 is already used by a different script "Bar" on the target',
      },
    ]);
    expect(screen.getByText("ID collision")).toBeTruthy();
    expect((screen.getByLabelText("Import Foo") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/already used by a different script "Bar"/)).toBeTruthy();
  });

  it("select-all checks every actionable row; button counts follow", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([
      { kind: "theme", id: "a", displayName: "aaa", status: "new" },
      { kind: "theme", id: "b", displayName: "bbb", status: "differs" },
      { kind: "theme", id: "c", displayName: "ccc", status: "identical" }, // no-op, not selected
    ]);
    // Smart-default: both writable rows pre-checked; ccc (identical) excluded.
    expect(screen.getByText(/Import 2 selected · 1 create · 1 overwrite/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Select all")); // all-checked → toggle OFF
    expect(screen.getByText("Nothing selected")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Select all")); // toggle back ON
    expect(screen.getByText(/Import 2 selected · 1 create · 1 overwrite/)).toBeTruthy();
  });

  it("button counts follow per-row selection; execute carries only checked keys", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([
      { kind: "theme", id: "a", displayName: "aaa", status: "new" },
      { kind: "theme", id: "b", displayName: "bbb", status: "differs" },
    ]);
    // Smart-default checks both; deselect the New, leaving only the Differs.
    fireEvent.click(screen.getByLabelText("Import aaa"));
    expect(screen.getByText(/Import 1 selected · 0 create · 1 overwrite/)).toBeTruthy();
    fireEvent.click(screen.getByText(/Import 1 selected/));
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "execute", selected: ["theme:b"] }),
    );
  });

  // ─── TD-11 Review column ─────────────────────────────────────────────────

  it("a script differs row shows BOTH Diff + Find usages; clicks post the right messages", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "s.script.json", bundle: scriptBundle() });
    selectTargetAndPreflight([
      {
        kind: "script",
        id: "bundle-uuid",
        displayName: "RiskDecision",
        status: "differs",
        resolvedTargetId: "target-uuid",
      },
    ]);
    fireEvent.click(screen.getByText("Compare"));
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "openDiff",
        bundleKey: "script:bundle-uuid",
        targetScriptId: "target-uuid", // TD-9: the entity we'd overwrite, not the bundle id
      }),
    );
    fireEvent.click(screen.getByText("Usages"));
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "openFindUsages",
        // Keyed by the TARGET's id (resolvedTargetId), not the bundle id — so it
        // matches the RealmIndex the Search page seeds its dropdown from.
        targetKey: "script:target-uuid",
        targetKind: "script",
      }),
    );
  });

  it("a theme differs row shows ONLY Find usages (Diff is scripts-only, v1)", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([
      { kind: "theme", id: "t", displayName: "my-theme", status: "differs" },
    ]);
    expect(screen.getByText("Usages")).toBeTruthy();
    expect(screen.queryByText("Compare")).toBeNull();
    // No resolvedTargetId → key falls back to v.id (themes are id-identified).
    fireEvent.click(screen.getByText("Usages"));
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "openFindUsages",
        targetKey: "theme:t",
        targetKind: "theme",
      }),
    );
  });

  it("non-differs rows (new / identical) have no Review buttons", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "s.script.json", bundle: scriptBundle() });
    selectTargetAndPreflight([
      { kind: "script", id: "a", displayName: "NewOne", status: "new" },
      { kind: "script", id: "b", displayName: "SameOne", status: "identical" },
    ]);
    expect(screen.queryByText("Compare")).toBeNull();
    expect(screen.queryByText("Usages")).toBeNull();
  });

  it("Review buttons stay live after import locks the table", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "s.script.json", bundle: scriptBundle() });
    selectTargetAndPreflight([
      { kind: "script", id: "s", displayName: "RiskDecision", status: "differs" },
    ]);
    postToWebview({
      type: "executeResult",
      host: "paic.example",
      realm: "alpha",
      results: [{ kind: "script", id: "s", displayName: "RiskDecision", status: "overwritten" }],
      summary: "0 created · 1 overwritten · 0 skipped · 0 failed",
    });
    // Table is locked (checkbox disabled) but inspection buttons remain.
    expect((screen.getByLabelText("Import RiskDecision") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText("Compare")).toBeTruthy();
    expect(screen.getByText("Usages")).toBeTruthy();
  });

  it("sorts rows by kind then name (script → theme → variable)", () => {
    const { container } = render(
      <App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />,
    );
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([
      { kind: "variable", id: "v", displayName: "vee", status: "new" },
      { kind: "theme", id: "t2", displayName: "bbb", status: "new" },
      { kind: "theme", id: "t1", displayName: "aaa", status: "new" },
      { kind: "script", id: "s", displayName: "ess", status: "new" },
    ]);
    const names = [...container.querySelectorAll(".plan-name")].map((n) => n.textContent);
    expect(names).toEqual(["ess", "aaa", "bbb", "vee"]); // script, theme(a,b), variable
  });
});

describe("Transfer App — journey import (S8b)", () => {
  it("renders the subject as a 'Main journey' ROW, plus the inner-journey row", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists"), jv("MFA", "new")],
      [
        jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"]),
        jp("MFA", "inner", "new", "create", ["create"]),
      ],
    );
    expect(screen.getByText(/Import journey:/)).toBeTruthy(); // destination line
    expect(screen.getByText("Main journey")).toBeTruthy(); // subject row type
    expect(screen.getByText("Inner journey")).toBeTruthy(); // inner row type
    expect(screen.getByLabelText("Import Login")).toBeTruthy(); // subject is now a row
    expect(screen.getByLabelText("Import MFA")).toBeTruthy();
  });

  it("the subject defaults to CHECKED (Overwrite); unchecking it flips to Keep", () => {
    // Differs from an inner only in the seeded default — the subject is the
    // journey the user asked to import, so it writes unless deselected.
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists")],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"])],
    );
    const cb = screen.getByLabelText("Import Login") as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(cb.disabled).toBe(false);
    expect(screen.getByText("Overwrite")).toBeTruthy();
    act(() => fireEvent.click(cb));
    expect(screen.getByText("Keep")).toBeTruthy();
  });

  it("the subject row carries no shared-overwrite warning (it isn't shared)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists")],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"])],
    );
    expect(screen.queryByText(/shared — Overwrite affects other journeys/)).toBeNull();
  });

  it("an exists inner defaults to Keep; checking it flips the Status to Overwrite", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists"), jv("DeviceCheck", "exists")],
      [
        jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"]),
        jp("DeviceCheck", "inner", "exists", "keep", ["overwrite", "keep"]),
      ],
    );
    const cb = screen.getByLabelText("Import DeviceCheck") as HTMLInputElement;
    expect(cb.checked).toBe(false); // default Keep
    // The subject row is seeded checked, so it already reads Overwrite — count
    // rather than getByText, which would now match two rows.
    expect(screen.getByText("Keep")).toBeTruthy(); // only the inner
    expect(screen.getAllByText("Overwrite")).toHaveLength(1); // only the subject
    act(() => fireEvent.click(cb));
    expect(screen.getAllByText("Overwrite")).toHaveLength(2); // both now
    expect(screen.queryByText("Keep")).toBeNull();
  });

  it("an identical inner journey is a locked 'Identical' no-op (PD-5 amendment)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists"), jv("DeviceCheck", "exists")],
      [
        jp("Login", "subject", "exists", "overwrite", ["overwrite"]),
        jp("DeviceCheck", "inner", "identical", "keep", []), // own scope unchanged
      ],
    );
    const cb = screen.getByLabelText("Import DeviceCheck") as HTMLInputElement;
    // Present/no-op: checked + locked (no opt-in to re-writing identical bytes).
    expect(cb.checked).toBe(true);
    expect(cb.disabled).toBe(true);
    expect(screen.getByText("Identical")).toBeTruthy();
    // Not the Keep/Overwrite affordance — no shared-overwrite warning.
    expect(screen.queryByText(/shared — Overwrite affects other journeys/)).toBeNull();
  });

  it("a new inner shows a forced Create (checkbox checked + disabled)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists"), jv("MFA", "new")],
      [
        jp("Login", "subject", "exists", "overwrite", ["overwrite"]),
        jp("MFA", "inner", "new", "create", ["create"]),
      ],
    );
    const cb = screen.getByLabelText("Import MFA") as HTMLInputElement;
    expect(cb.checked).toBe(true);
    expect(cb.disabled).toBe(true);
    expect(screen.getByText("Create")).toBeTruthy();
  });

  it("a missing blocking gate shows the ⛔ banner and disables Import", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists")],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite"])],
      [{ kind: "nodeType", name: "PingOneVerifyNode", status: "missing", severity: "blocking" }],
    );
    expect(screen.getByText(/required prerequisite/)).toBeTruthy();
    const btn = screen.getByRole("button", { name: /Import journey/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("Import posts journeyActions (checked exists-inner → overwrite) + seeded leaf keys", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [
        jv("Login", "exists"),
        jv("DeviceCheck", "exists"),
        { kind: "script", id: "s1", displayName: "helper", status: "new" },
      ],
      [
        jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"]),
        jp("DeviceCheck", "inner", "exists", "keep", ["overwrite", "keep"]),
      ],
    );
    act(() => fireEvent.click(screen.getByLabelText("Import DeviceCheck"))); // Keep → Overwrite
    act(() => fireEvent.click(screen.getByRole("button", { name: /Import journey/ })));
    const call = post.mock.calls.map((c) => c[0]).find((m) => m.type === "execute");
    // The subject now carries an explicit action too (seeded checked → overwrite).
    expect(call.journeyActions).toEqual({ Login: "overwrite", DeviceCheck: "overwrite" });
    expect(call.selected).toContain("script:s1"); // bundled leaf seeded
    expect(call.selected).toContain("journey:DeviceCheck"); // overwrite-inner key
    expect(call.selected).toContain("journey:Login"); // subject seeded checked
  });

  it("deselecting the subject posts Keep for it while leaves still import", () => {
    // "Push the script fix, leave the wiring alone" — newly possible now that
    // the subject is a normal row rather than a forced-Overwrite header.
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists"), { kind: "script", id: "s1", displayName: "helper", status: "new" }],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"])],
    );
    act(() => fireEvent.click(screen.getByLabelText("Import Login"))); // Overwrite → Keep
    act(() => fireEvent.click(screen.getByRole("button", { name: /Import journey/ })));
    const call = post.mock.calls.map((c) => c[0]).find((m) => m.type === "execute");
    expect(call.journeyActions).toEqual({ Login: "keep" });
    expect(call.selected).toContain("script:s1"); // the leaf still writes
    expect(call.selected).not.toContain("journey:Login");
  });

  // ── Compare options (poc/proposals/compare-options.md) ─────────────────────

  const EXACT = {
    ignoreNodePositions: false,
    ignoreNodeDisplayNames: false,
    ignoreJourneyTags: false,
  };

  it("shows the three compare-option checkboxes, all unchecked by default", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists")],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"])],
    );
    expect(screen.getByText("Ignore when comparing:")).toBeTruthy();
    for (const label of ["node positions", "node display names", "journey tags"]) {
      const cb = screen.getByLabelText(`Ignore ${label}`) as HTMLInputElement;
      expect(cb.checked).toBe(false); // default is EXACT — nothing relaxed
    }
  });

  it("hides the options for a leaf-only bundle (they'd be inert)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "s.script.json", bundle: scriptBundle() });
    selectTargetAndPreflight([{ kind: "script", id: "s1", displayName: "helper", status: "new" }]);
    expect(screen.queryByText("Ignore when comparing:")).toBeNull();
  });

  it("posts setCompareOptions with the toggled flag", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists")],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"])],
    );
    act(() => fireEvent.click(screen.getByLabelText("Ignore node positions")));
    const call = post.mock.calls.map((c) => c[0]).find((m) => m.type === "setCompareOptions");
    expect(call).toMatchObject({
      host: "paic.example",
      realm: "alpha",
      options: { ...EXACT, ignoreNodePositions: true },
    });
  });

  it("toggles are independent — a second box adds to the first", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists")],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"])],
    );
    act(() => fireEvent.click(screen.getByLabelText("Ignore node positions")));
    act(() => fireEvent.click(screen.getByLabelText("Ignore journey tags")));
    const calls = post.mock.calls.map((c) => c[0]).filter((m) => m.type === "setCompareOptions");
    expect(calls[calls.length - 1].options).toEqual({
      ignoreNodePositions: true,
      ignoreNodeDisplayNames: false,
      ignoreJourneyTags: true,
    });
    // …and the boxes reflect it
    expect((screen.getByLabelText("Ignore node positions") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Ignore journey tags") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Ignore node display names") as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("journeyPlansUpdated flips a row to Identical without a new pre-flight", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists"), jv("DeviceCheck", "exists")],
      [
        jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"]),
        jp("DeviceCheck", "inner", "exists", "keep", ["overwrite", "keep"]),
      ],
    );
    expect(screen.getByText("Keep")).toBeTruthy(); // inner, pre-toggle
    postToWebview({
      type: "journeyPlansUpdated",
      host: "paic.example",
      realm: "alpha",
      journeyPlans: [
        jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"]),
        jp("DeviceCheck", "inner", "identical", "keep", []), // now a locked no-op
      ],
    });
    const cb = screen.getByLabelText("Import DeviceCheck") as HTMLInputElement;
    expect(cb.disabled).toBe(true);
    expect(screen.getByText("Identical")).toBeTruthy();
    // Plain "Identical" — no "(ignoring …)" suffix, by design.
    expect(screen.queryByText(/ignoring/)).toBeNull();
  });

  it("journeyPlansUpdated preserves the user's LEAF selection", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [
        jv("Login", "exists"),
        { kind: "script", id: "s1", displayName: "helper", status: "new" },
        { kind: "script", id: "s2", displayName: "other", status: "differs" },
      ],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"])],
    );
    act(() => fireEvent.click(screen.getByLabelText("Import other"))); // deselect s2
    postToWebview({
      type: "journeyPlansUpdated",
      host: "paic.example",
      realm: "alpha",
      journeyPlans: [jp("Login", "subject", "identical", "keep", [])],
    });
    act(() => fireEvent.click(screen.getByRole("button", { name: /Import journey/ })));
    const call = post.mock.calls.map((c) => c[0]).find((m) => m.type === "execute");
    expect(call.selected).toContain("script:s1"); // still selected
    expect(call.selected).not.toContain("script:s2"); // still deselected
    expect(call.journeyActions).toEqual({ Login: "keep" }); // identical → no write
  });

  it("ignores a journeyPlansUpdated for a different target (stale)", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists")],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite", "keep"])],
    );
    postToWebview({
      type: "journeyPlansUpdated",
      host: "other.example",
      realm: "alpha",
      journeyPlans: [jp("Login", "subject", "identical", "keep", [])],
    });
    expect(screen.getByText("Overwrite")).toBeTruthy(); // unchanged
  });

  it("driftDetected re-runs the pre-flight", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists")],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite"])],
    );
    post.mockClear();
    postToWebview({
      type: "driftDetected",
      host: "paic.example",
      realm: "alpha",
      drifted: [{ key: "journey:Login", was: "exists", now: "new" }],
    });
    expect(post).toHaveBeenCalledWith({
      type: "runPreflight",
      host: "paic.example",
      realm: "alpha",
    });
  });
});

describe("Transfer App — whole-plan polish (S9a)", () => {
  it("smart-default pre-checks the writable rows of a leaf bundle", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([{ kind: "theme", id: "t", displayName: "zzz theme", status: "new" }]);
    expect((screen.getByLabelText("Import zzz theme") as HTMLInputElement).checked).toBe(true);
  });

  it("shows the count-summary line pre-import, then the result summary after import", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([
      { kind: "theme", id: "a", displayName: "aaa", status: "new" },
      { kind: "theme", id: "b", displayName: "bbb", status: "identical" },
    ]);
    // Pre-import: plan counts (1 new pre-checked → create; 1 identical → unchanged).
    expect(screen.getByText("Plan: 1 create · 1 unchanged")).toBeTruthy();
    postToWebview({
      type: "executeResult",
      host: "paic.example",
      realm: "alpha",
      results: [{ kind: "theme", id: "a", displayName: "aaa", status: "created" }],
      summary: "1 created · 0 overwritten · 0 skipped · 0 failed",
    });
    // Post-import: the slot becomes the result summary (previously never rendered).
    expect(screen.getByText("1 created · 0 overwritten · 0 skipped · 0 failed")).toBeTruthy();
  });

  it("a missing blocking gate carries a reason note", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists")],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite"])],
      [{ kind: "nodeType", name: "PingOneVerifyNode", status: "missing", severity: "blocking" }],
    );
    expect(screen.getByText("Missing ⛔")).toBeTruthy();
    expect(screen.getByText(/not installed on the target/)).toBeTruthy();
  });

  it("checkbox model: a NEW script in a journey bundle is required (checked+locked); a new theme stays live", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [
        jv("Login", "exists"),
        { kind: "script", id: "s1", displayName: "helper", status: "new" },
        { kind: "theme", id: "t1", displayName: "sign-in", status: "new" },
      ],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite"])],
    );
    const script = screen.getByLabelText("Import helper") as HTMLInputElement;
    expect(script.checked).toBe(true);
    expect(script.disabled).toBe(true); // required — a node needs it, can't deselect
    const theme = screen.getByLabelText("Import sign-in") as HTMLInputElement;
    expect(theme.checked).toBe(true); // smart-default
    expect(theme.disabled).toBe(false); // optional (soft) — live
  });

  it("checkbox model: a present prerequisite shows a checked-locked 'Present' row", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    journeyPreflight(
      [jv("Login", "exists")],
      [jp("Login", "subject", "exists", "overwrite", ["overwrite"])],
      [{ kind: "nodeType", name: "PageNode", status: "present", severity: "blocking" }],
    );
    const cb = screen.getByLabelText("Import PageNode") as HTMLInputElement;
    expect(cb.checked).toBe(true); // "we have it"
    expect(cb.disabled).toBe(true);
    expect(screen.getByText("Present")).toBeTruthy();
  });

  it("PD-17: a Download report button appears after a run and posts downloadReport", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([{ kind: "theme", id: "t", displayName: "zzz theme", status: "new" }]);
    expect(screen.queryByText("Download report")).toBeNull(); // not before a run
    postToWebview({
      type: "executeResult",
      host: "paic.example",
      realm: "alpha",
      results: [{ kind: "theme", id: "t", displayName: "zzz theme", status: "created" }],
      summary: "1 created · 0 overwritten · 0 skipped · 0 failed",
    });
    fireEvent.click(screen.getByText("Download report"));
    expect(post).toHaveBeenCalledWith({ type: "downloadReport" });
  });

  it("G4: a Re-plan button appears after a run and re-runs pre-flight", () => {
    const post = vi.fn();
    render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([{ kind: "theme", id: "t", displayName: "zzz theme", status: "new" }]);
    expect(screen.queryByText("Re-plan")).toBeNull(); // not before a run
    postToWebview({
      type: "executeResult",
      host: "paic.example",
      realm: "alpha",
      results: [{ kind: "theme", id: "t", displayName: "zzz theme", status: "failed" }],
      summary: "0 created · 0 overwritten · 0 skipped · 1 failed",
    });
    post.mockClear();
    fireEvent.click(screen.getByText("Re-plan"));
    expect(post).toHaveBeenCalledWith({
      type: "runPreflight",
      host: "paic.example",
      realm: "alpha",
    });
    expect(screen.getByText("Checking target…")).toBeTruthy(); // back to checking, table unlocked
  });

  // ── PD-19: pre-flight progress ──────────────────────────────────────────
  describe("pre-flight progress (PD-19)", () => {
    /** Drive to the "running" pre-flight state without answering it. */
    function startPreflight() {
      render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
      postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
      pickCombo("target-connection", "paic", "paic.example");
      postToWebview({ type: "realmsResult", host: "paic.example", realms: ["alpha"] });
      pickCombo("target-realm", "alpha", "alpha");
    }

    const progress = (over: Record<string, unknown> = {}) => ({
      type: "preflightProgress",
      host: "paic.example",
      realm: "alpha",
      phase: "compare",
      done: 3,
      total: 12,
      elapsedS: 4,
      ...over,
    });

    it("replaces the static hint with phase, count and elapsed time", () => {
      startPreflight();
      postToWebview(progress());
      expect(screen.getByText("Checking target — comparing components 3/12 · 4s")).toBeTruthy();
    });

    it("names each phase", () => {
      startPreflight();
      postToWebview(progress({ phase: "journeys", done: 40, total: 98, elapsedS: 12 }));
      expect(screen.getByText("Checking target — reading journey nodes 40/98 · 12s")).toBeTruthy();
    });

    it("omits a meaningless count for a single-unit phase", () => {
      startPreflight();
      postToWebview(progress({ phase: "deps", done: 1, total: 1, elapsedS: 7 }));
      expect(screen.getByText("Checking target — checking dependencies · 7s")).toBeTruthy();
    });

    it("keeps ticking elapsed while the count stands still (a transport retry)", () => {
      startPreflight();
      postToWebview(progress({ done: 3, total: 12, elapsedS: 4 }));
      postToWebview(progress({ done: 3, total: 12, elapsedS: 19 }));
      // The whole point: a frozen counter beside a moving clock reads as slow,
      // not hung — a retry has no channel of its own to the UI (D46).
      expect(screen.getByText("Checking target — comparing components 3/12 · 19s")).toBeTruthy();
    });

    it("ignores a stale tick for a target the user has switched away from", () => {
      startPreflight();
      postToWebview(progress({ realm: "beta", done: 9 }));
      expect(screen.getByText("Checking target…")).toBeTruthy();
    });

    it("a late tick cannot knock a delivered plan back into the running state", () => {
      render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
      postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
      selectTargetAndPreflight([
        { kind: "theme", id: "t", displayName: "zzz theme", status: "new" },
      ]);
      postToWebview(progress());
      expect(screen.queryByText(/Checking target/)).toBeNull();
      expect(screen.getByText("zzz theme")).toBeTruthy();
    });
  });

  // ── PD-20: errored rows gate Import; targeted recheck ───────────────────
  describe("errored rows (PD-20)", () => {
    const errored = (id: string, name: string) => ({
      kind: "script",
      id,
      displayName: name,
      status: "error",
      message: "read ECONNRESET",
    });
    const newScript = (id: string, name: string) => ({
      kind: "script",
      id,
      displayName: name,
      status: "new",
    });

    it("disables Import while any row's check failed", () => {
      render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
      postToWebview({ type: "bundleLoaded", fileName: "s", bundle: scriptBundle() });
      selectTargetAndPreflight([newScript("s1", "ok-script"), errored("s2", "flaky-script")]);
      // Regression: this button used to stay ENABLED, and the errored script was
      // silently dropped from the write plan while the journey still referenced it.
      const btn = screen.getByText(/^Import 1 selected/) as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it("explains why, and offers a recheck for exactly the failed rows", () => {
      render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
      postToWebview({ type: "bundleLoaded", fileName: "s", bundle: scriptBundle() });
      selectTargetAndPreflight([newScript("s1", "ok"), errored("s2", "a"), errored("s3", "b")]);
      expect(screen.getByText(/couldn't be checked against the target/)).toBeTruthy();
      expect(screen.getByText(/Recheck failed \(/)).toBeTruthy();
    });

    it("does NOT gate on `unsupported` — a known-safe skip, not an unknown", () => {
      render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
      postToWebview({ type: "bundleLoaded", fileName: "s", bundle: scriptBundle() });
      selectTargetAndPreflight([
        newScript("s1", "ok-script"),
        { kind: "theme", id: "t", displayName: "th", status: "unsupported" },
      ]);
      expect((screen.getByText(/^Import 1 selected/) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByText(/couldn't be checked against the target/)).toBeNull();
    });

    it("posts recheckFailed with only the failed row keys", () => {
      const post = vi.fn();
      render(<App vscode={{ postMessage: post }} payload={{ connections: [PAIC_CONN] }} />);
      postToWebview({ type: "bundleLoaded", fileName: "s", bundle: scriptBundle() });
      selectTargetAndPreflight([newScript("s1", "ok"), errored("s2", "a"), errored("s3", "b")]);
      fireEvent.click(screen.getByText(/Recheck failed/));
      expect(post).toHaveBeenCalledWith({
        type: "recheckFailed",
        host: "paic.example",
        realm: "alpha",
        keys: ["script:s2", "script:s3"],
      });
    });

    it("shows the recheck as in-flight until the patch lands", () => {
      render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
      postToWebview({ type: "bundleLoaded", fileName: "s", bundle: scriptBundle() });
      selectTargetAndPreflight([newScript("s1", "ok"), errored("s2", "flaky")]);

      fireEvent.click(screen.getByText(/Recheck failed/));
      // The plan stays on screen during a recheck, so the button is the ONLY
      // place feedback can appear — without it the click looks like it did
      // nothing for as long as the retry ladder runs.
      const btn = screen.getByText("Rechecking…").closest("button") as HTMLButtonElement;
      expect(btn.disabled).toBe(true);

      postToWebview({
        type: "verdictsPatched",
        host: "paic.example",
        realm: "alpha",
        verdicts: [errored("s2", "flaky")], // still failing — the state must still clear
      });
      expect(screen.queryByText("Rechecking…")).toBeNull();
      expect(screen.getByText(/Recheck failed \(1\)/)).toBeTruthy();
    });

    it("clears the in-flight state when the recheck itself errors", () => {
      render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
      postToWebview({ type: "bundleLoaded", fileName: "s", bundle: scriptBundle() });
      selectTargetAndPreflight([errored("s2", "flaky")]);
      fireEvent.click(screen.getByText(/Recheck failed/));
      postToWebview({
        type: "preflightError",
        host: "paic.example",
        realm: "alpha",
        message: "getaddrinfo ENOTFOUND",
      });
      // A recheck reports its failure on the preflightError channel; if that
      // didn't clear the flag the button would stay disabled forever.
      expect(screen.getByText("getaddrinfo ENOTFOUND")).toBeTruthy();
      expect(screen.queryByText("Rechecking…")).toBeNull();
    });

    it("verdictsPatched MERGES by key — un-rechecked rows survive", () => {
      render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
      postToWebview({ type: "bundleLoaded", fileName: "s", bundle: scriptBundle() });
      selectTargetAndPreflight([newScript("s1", "keeper"), errored("s2", "flaky")]);
      postToWebview({
        type: "verdictsPatched",
        host: "paic.example",
        realm: "alpha",
        verdicts: [newScript("s2", "flaky")],
      });
      // The row that was never rechecked must still be there — a replace (rather
      // than a merge) would silently drop it from the plan.
      expect(screen.getByText("keeper")).toBeTruthy();
      expect(screen.getByText("flaky")).toBeTruthy();
      expect(screen.queryByText("read ECONNRESET")).toBeNull();
    });

    it("re-enables Import once the last failed row recovers, and selects it", () => {
      render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
      postToWebview({ type: "bundleLoaded", fileName: "s", bundle: scriptBundle() });
      selectTargetAndPreflight([newScript("s1", "ok"), errored("s2", "flaky")]);
      postToWebview({
        type: "verdictsPatched",
        host: "paic.example",
        realm: "alpha",
        verdicts: [newScript("s2", "flaky")],
      });
      // A recovered row gets its smart default back — it could not be selected
      // while errored, so without this it would sit unchecked and be skipped.
      expect((screen.getByLabelText("Import flaky") as HTMLInputElement).checked).toBe(true);
      expect((screen.getByText(/^Import 2 selected/) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByText(/couldn't be checked against the target/)).toBeNull();
    });

    it("ignores a patch for a target the user has switched away from", () => {
      render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
      postToWebview({ type: "bundleLoaded", fileName: "s", bundle: scriptBundle() });
      selectTargetAndPreflight([errored("s2", "flaky")]);
      postToWebview({
        type: "verdictsPatched",
        host: "paic.example",
        realm: "beta",
        verdicts: [newScript("s2", "flaky")],
      });
      expect(screen.getByText("read ECONNRESET")).toBeTruthy();
    });
  });

  it("PD-16: executeProgress flips a row's Status live + shows the running count", () => {
    render(<App vscode={{ postMessage: vi.fn() }} payload={{ connections: [PAIC_CONN] }} />);
    postToWebview({ type: "bundleLoaded", fileName: "x", bundle: themeBundle() });
    selectTargetAndPreflight([{ kind: "theme", id: "t", displayName: "zzz theme", status: "new" }]);
    fireEvent.click(screen.getByText(/Import 1 selected/)); // pre-checked → start the run
    postToWebview({
      type: "executeProgress",
      host: "paic.example",
      realm: "alpha",
      result: { kind: "theme", id: "t", displayName: "zzz theme", status: "created" },
      done: 1,
      total: 1,
    });
    expect(screen.getByText("Created")).toBeTruthy(); // row flipped before executeResult
    expect(screen.getByText("Importing… 1/1")).toBeTruthy(); // running count in the summary slot
    expect((screen.getByLabelText("Import zzz theme") as HTMLInputElement).disabled).toBe(true); // frozen
  });
});
