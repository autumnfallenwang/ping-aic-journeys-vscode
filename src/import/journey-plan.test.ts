import { describe, expect, it } from "vitest";
import { type JourneyUnitPlan, planJourneyUnits } from "./journey-plan";
import type { ImportComponent } from "./parse";

const innerEval = (tree: string) => ({ _type: { _id: "InnerTreeEvaluatorNode" }, tree });

/** A journey unit as `parse.ts` decomposes it (nodes folded into `raw`). */
const journey = (id: string, nodes: Record<string, unknown> = {}): ImportComponent => ({
  kind: "journey",
  id,
  displayName: id,
  raw: { tree: { _id: id }, nodes, innerNodes: {} },
});

const verdicts = (m: Record<string, "new" | "exists" | "identical">) => new Map(Object.entries(m));

describe("planJourneyUnits — decision matrix", () => {
  it("subject + new → Create only", () => {
    expect(planJourneyUnits([journey("Login")], verdicts({ Login: "new" }))).toEqual<
      JourneyUnitPlan[]
    >([
      {
        id: "Login",
        displayName: "Login",
        role: "subject",
        verdict: "new",
        defaultAction: "create",
        allowedActions: ["create"],
      },
    ]);
  });

  it("subject + exists → defaults to Overwrite but Keep is allowed", () => {
    // The subject is a normal journey row: same Keep⇄Overwrite choice as an
    // inner, only the DEFAULT differs (it's the journey the user asked to
    // import). Deselecting it is legitimate — "push the script fix, leave the
    // wiring alone".
    const [u] = planJourneyUnits([journey("Login")], verdicts({ Login: "exists" }));
    expect(u).toMatchObject({
      role: "subject",
      verdict: "exists",
      defaultAction: "overwrite",
      allowedActions: ["overwrite", "keep"],
    });
  });

  it("subject and inner differ only in default action, not in what's allowed", () => {
    const [subject] = planJourneyUnits([journey("Login")], verdicts({ Login: "exists" }));
    const units = planJourneyUnits(
      [journey("Outer", { n1: innerEval("Inner") }), journey("Inner")],
      verdicts({ Outer: "exists", Inner: "exists" }),
    );
    const inner = units.find((u) => u.role === "inner");
    expect(subject.defaultAction).toBe("overwrite");
    expect(inner?.defaultAction).toBe("keep");
    expect(subject.allowedActions).toEqual(inner?.allowedActions);
  });

  it("inner + new → Create only (caller needs it; can't Keep an absent tree)", () => {
    const comps = [journey("Login", { e: innerEval("MFA") }), journey("MFA")];
    const units = planJourneyUnits(comps, verdicts({ Login: "exists", MFA: "new" }));
    expect(units.find((u) => u.id === "MFA")).toMatchObject({
      role: "inner",
      verdict: "new",
      defaultAction: "create",
      allowedActions: ["create"],
    });
  });

  it("inner + exists → Keep default, Overwrite allowed", () => {
    const comps = [journey("Login", { e: innerEval("DeviceCheck") }), journey("DeviceCheck")];
    const units = planJourneyUnits(comps, verdicts({ Login: "exists", DeviceCheck: "exists" }));
    expect(units.find((u) => u.id === "DeviceCheck")).toMatchObject({
      role: "inner",
      verdict: "exists",
      defaultAction: "keep",
      allowedActions: ["overwrite", "keep"],
    });
  });

  it("inner + identical → Keep, locked no-op (no allowed actions, PD-5 amendment)", () => {
    const comps = [journey("Login", { e: innerEval("DeviceCheck") }), journey("DeviceCheck")];
    const units = planJourneyUnits(comps, verdicts({ Login: "exists", DeviceCheck: "identical" }));
    expect(units.find((u) => u.id === "DeviceCheck")).toMatchObject({
      role: "inner",
      verdict: "identical",
      defaultAction: "keep",
      allowedActions: [], // can't opt into a pointless re-write of identical bytes
    });
  });

  it("subject + identical → Keep, locked no-op (nothing to overwrite)", () => {
    const [u] = planJourneyUnits([journey("Login")], verdicts({ Login: "identical" }));
    expect(u).toMatchObject({
      role: "subject",
      verdict: "identical",
      defaultAction: "keep",
      allowedActions: [],
    });
  });
});

describe("planJourneyUnits — role classification", () => {
  it("subject = a root not referenced; inner = referenced by an InnerTreeEvaluatorNode", () => {
    const comps = [
      journey("Login", { a: innerEval("MFA"), b: innerEval("DeviceCheck") }),
      journey("MFA"),
      journey("DeviceCheck"),
    ];
    // empty verdict map → every unit defaults to "new".
    const units = planJourneyUnits(comps, new Map());
    expect(units.map((u) => [u.id, u.role, u.verdict])).toEqual([
      ["Login", "subject", "new"],
      ["MFA", "inner", "new"],
      ["DeviceCheck", "inner", "new"],
    ]);
  });

  it("returns [] for a leaf bundle (no journey units)", () => {
    const comps: ImportComponent[] = [{ kind: "script", id: "s", displayName: "s", raw: {} }];
    expect(planJourneyUnits(comps, new Map())).toEqual([]);
  });
});
