import { describe, expect, it } from "vitest";
import { entityKeyOf } from "@/domain/realm-index";
import type {
  EmailSuspendNodePayload,
  EsvSecret,
  EsvVariable,
  InnerTreeEvaluatorNodePayload,
  Journey,
  NodeRef,
  PageNodePayload,
  Script,
  ScriptedDecisionNodePayload,
  SelectIdPNodePayload,
  SocialIdp,
  Theme,
} from "@/domain/types";
import { type BuildProgress, buildRealmIndex } from "@/realm-index/build";
import { makeFakeLogger, makeFakePaicClient } from "../views/fakes";

// ─── Helpers ────────────────────────────────────────────────────────────────

const HOST = "openam-tenant.example.forgeblocks.com";
const REALM = "alpha";

function nodeRef(nodeType: string, connections: Record<string, string> = {}): NodeRef {
  return { nodeType, connections };
}

function journey(id: string, nodes: Record<string, NodeRef>, entryNodeId = ""): Journey {
  return { id, enabled: true, entryNodeId, nodes };
}

function sdNode(id: string, scriptId: string): ScriptedDecisionNodePayload {
  return { id, nodeType: "ScriptedDecisionNode", scriptId, outcomes: [], inputs: [], outputs: [] };
}

function innerNode(id: string, tree: string): InnerTreeEvaluatorNodePayload {
  return { id, nodeType: "InnerTreeEvaluatorNode", tree };
}

function pageNode(
  id: string,
  themeId: string | undefined,
  childRefs: Array<{ id: string; nodeType: string }>,
): PageNodePayload {
  const out: PageNodePayload = { id, nodeType: "PageNode", childRefs };
  if (themeId) out.themeId = themeId;
  return out;
}

function emailNode(id: string, emailTemplateName: string): EmailSuspendNodePayload {
  return { id, nodeType: "EmailSuspendNode", emailTemplateName };
}

function selectIdPNode(id: string, providers: string[]): SelectIdPNodePayload {
  return { id, nodeType: "SelectIdPNode", filteredProviders: providers };
}

function script(id: string, name: string, body = "", context?: string): Script {
  return { id, name, language: "JAVASCRIPT", body, ...(context ? { context } : {}) };
}

function variable(name: string): EsvVariable {
  return { kind: "variable", name };
}

function secret(name: string): EsvSecret {
  return { kind: "secret", name };
}

function theme(id: string, name: string, linkedTrees?: string[]): Theme {
  return { id, name, realm: REALM, ...(linkedTrees ? { linkedTrees } : {}) };
}

function socialIdp(name: string): SocialIdp {
  return { name, type: "google-oidc", enabled: true, realm: REALM };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("buildRealmIndex", () => {
  it("produces an entry with the right host/realm and a finite duration", async () => {
    const client = makeFakePaicClient({ journeysByRealm: { [REALM]: [] } });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);
    expect(entry.host).toBe(HOST);
    expect(entry.realm).toBe(REALM);
    expect(entry.scanDurationMs).toBeGreaterThanOrEqual(0);
    expect(entry.builtAt).toBeGreaterThan(0);
    expect(entry.entities).toEqual({});
    expect(entry.inboundRefs).toEqual({});
  });

  it("collects every journey as an entity with displayName === journey.id", async () => {
    const j1 = journey("Login", {});
    const j2 = journey("Registration", {});
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j1, j2] },
      journeyById: { Login: j1, Registration: j2 },
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    expect(entry.entities[entityKeyOf("journey", "Login")]).toMatchObject({
      kind: "journey",
      id: "Login",
      displayName: "Login",
    });
    expect(entry.entities[entityKeyOf("journey", "Registration")]).toMatchObject({
      kind: "journey",
      id: "Registration",
    });
    expect(entry.counts.journey).toBe(2);
  });

  it("collects every referenced script as a script entity, deduplicating across journeys", async () => {
    const j1 = journey("Login", { n1: nodeRef("ScriptedDecisionNode") });
    const j2 = journey("MFA", { n2: nodeRef("ScriptedDecisionNode") });
    const sd1 = sdNode("n1", "shared-script-uuid");
    const sd2 = sdNode("n2", "shared-script-uuid");
    const s = script("shared-script-uuid", "shared-validator");
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j1, j2] },
      journeyById: { Login: j1, MFA: j2 },
      nodesByKey: {
        [`${REALM}:ScriptedDecisionNode:n1`]: sd1,
        [`${REALM}:ScriptedDecisionNode:n2`]: sd2,
      },
      scriptsByKey: { [`${REALM}:shared-script-uuid`]: s },
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    const scriptEntity = entry.entities[entityKeyOf("script", "shared-script-uuid")];
    expect(scriptEntity).toMatchObject({
      kind: "script",
      id: "shared-script-uuid",
      displayName: "shared-validator",
    });
    expect(entry.counts.script).toBe(1);

    const refs = entry.inboundRefs[entityKeyOf("script", "shared-script-uuid")];
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.fromKey).sort()).toEqual([
      entityKeyOf("journey", "Login"),
      entityKeyOf("journey", "MFA"),
    ]);
  });

  it("keeps two same-type nodes in one journey as distinct edges (D37 amendment)", async () => {
    // One journey, three ScriptedDecisionNodes all pointing at the same
    // script — mirrors the sb3 `ChooseGoBack` shape. Before D37 the
    // (from|to|nodeType) dedup collapsed these to one edge; now each node
    // is its own edge, distinguished by `fromNodeId`.
    const j = journey("Login", {
      n1: nodeRef("ScriptedDecisionNode"),
      n2: nodeRef("ScriptedDecisionNode"),
      n3: nodeRef("ScriptedDecisionNode"),
    });
    const s = script("shared-uuid", "ChooseGoBack");
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j] },
      journeyById: { Login: j },
      nodesByKey: {
        [`${REALM}:ScriptedDecisionNode:n1`]: sdNode("n1", "shared-uuid"),
        [`${REALM}:ScriptedDecisionNode:n2`]: sdNode("n2", "shared-uuid"),
        [`${REALM}:ScriptedDecisionNode:n3`]: sdNode("n3", "shared-uuid"),
      },
      scriptsByKey: { [`${REALM}:shared-uuid`]: s },
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    const refs = entry.inboundRefs[entityKeyOf("script", "shared-uuid")];
    expect(refs).toHaveLength(3);
    // Same from + via, three distinct node ids.
    expect(refs.every((r) => r.fromKey === entityKeyOf("journey", "Login"))).toBe(true);
    expect(refs.every((r) => r.via === "ScriptedDecisionNode")).toBe(true);
    expect(refs.map((r) => r.fromNodeId).sort()).toEqual(["n1", "n2", "n3"]);
  });

  it("marks scripts with context === 'LIBRARY' as isLibrary === true", async () => {
    const j = journey("Login", { n1: nodeRef("ScriptedDecisionNode") });
    const sd = sdNode("n1", "lib-uuid");
    const s = script("lib-uuid", "helpers", "", "LIBRARY");
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j] },
      journeyById: { Login: j },
      nodesByKey: { [`${REALM}:ScriptedDecisionNode:n1`]: sd },
      scriptsByKey: { [`${REALM}:lib-uuid`]: s },
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    expect(entry.entities[entityKeyOf("script", "lib-uuid")]?.isLibrary).toBe(true);
  });

  it("discovers library-script chains via require() (A → B → C)", async () => {
    const j = journey("Login", { n1: nodeRef("ScriptedDecisionNode") });
    const sd = sdNode("n1", "uuid-A");
    const scriptA = script("uuid-A", "A", "require('B');");
    const scriptB = script("uuid-B", "B", "require('C');", "LIBRARY");
    const scriptC = script("uuid-C", "C", "// leaf", "LIBRARY");
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j] },
      journeyById: { Login: j },
      nodesByKey: { [`${REALM}:ScriptedDecisionNode:n1`]: sd },
      scriptsByKey: {
        [`${REALM}:uuid-A`]: scriptA,
        [`${REALM}:uuid-B`]: scriptB,
        [`${REALM}:uuid-C`]: scriptC,
      },
      scriptsByName: {
        [`${REALM}:byName:B`]: scriptB,
        [`${REALM}:byName:C`]: scriptC,
      },
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    // All three scripts materialized.
    expect(entry.entities[entityKeyOf("script", "uuid-A")]).toBeDefined();
    expect(entry.entities[entityKeyOf("script", "uuid-B")]).toBeDefined();
    expect(entry.entities[entityKeyOf("script", "uuid-C")]).toBeDefined();

    // B has an inbound require() ref from A; C has one from B.
    expect(entry.inboundRefs[entityKeyOf("script", "uuid-B")]).toEqual([
      { fromKey: entityKeyOf("script", "uuid-A"), via: "require()" },
    ]);
    expect(entry.inboundRefs[entityKeyOf("script", "uuid-C")]).toEqual([
      { fromKey: entityKeyOf("script", "uuid-B"), via: "require()" },
    ]);
  });

  it("discovers ESVs referenced in script bodies and classifies as variable / secret", async () => {
    const j = journey("Login", { n1: nodeRef("ScriptedDecisionNode") });
    const sd = sdNode("n1", "uuid-A");
    const body = `var v = "esv.my.var"; var s = "esv.my.secret";`;
    const scriptA = script("uuid-A", "A", body);
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j] },
      journeyById: { Login: j },
      nodesByKey: { [`${REALM}:ScriptedDecisionNode:n1`]: sd },
      scriptsByKey: { [`${REALM}:uuid-A`]: scriptA },
      variables: [variable("esv.my.var")],
      secrets: [secret("esv.my.secret")],
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    expect(entry.entities[entityKeyOf("esv", "esv.my.var")]).toMatchObject({
      kind: "esv",
      id: "esv.my.var",
      esvKind: "variable",
    });
    expect(entry.entities[entityKeyOf("esv", "esv.my.secret")]).toMatchObject({
      esvKind: "secret",
    });
    expect(entry.inboundRefs[entityKeyOf("esv", "esv.my.var")]).toEqual([
      { fromKey: entityKeyOf("script", "uuid-A"), via: "string literal" },
    ]);
  });

  it("omits ESV refs whose name isn't in the tenant's variables+secrets lists", async () => {
    const j = journey("Login", { n1: nodeRef("ScriptedDecisionNode") });
    const sd = sdNode("n1", "uuid-A");
    const body = `var x = "esv.does.not.exist";`;
    const scriptA = script("uuid-A", "A", body);
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j] },
      journeyById: { Login: j },
      nodesByKey: { [`${REALM}:ScriptedDecisionNode:n1`]: sd },
      scriptsByKey: { [`${REALM}:uuid-A`]: scriptA },
      variables: [],
      secrets: [],
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    expect(entry.entities[entityKeyOf("esv", "esv.does.not.exist")]).toBeUndefined();
    expect(entry.counts.esv).toBe(0);
  });

  it("collects themes from listThemes(realm) and merges PageNode.themeId references", async () => {
    const j = journey("Login", { n1: nodeRef("PageNode") });
    const pn = pageNode("n1", "theme-corp", []);
    const t = theme("theme-corp", "Corporate");
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j] },
      journeyById: { Login: j },
      nodesByKey: { [`${REALM}:PageNode:n1`]: pn },
      themesByKey: { [`${REALM}:theme-corp`]: t },
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    // Theme entity carries the resolved displayName, not the id.
    expect(entry.entities[entityKeyOf("theme", "theme-corp")]).toMatchObject({
      kind: "theme",
      id: "theme-corp",
      displayName: "Corporate",
    });
    // Inbound ref from journey via PageNode. Journey-node edges also carry
    // a `fromNodeId` (D37 amendment) — match on the stable fields.
    const refs = entry.inboundRefs[entityKeyOf("theme", "theme-corp")];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ fromKey: entityKeyOf("journey", "Login"), via: "PageNode" });
    expect(refs[0].fromNodeId).toBe("n1");
  });

  it("merges Theme.linkedTrees into the same inboundRefs entry", async () => {
    const j1 = journey("Login", { n1: nodeRef("PageNode") });
    const j2 = journey("Other", {});
    const pn = pageNode("n1", "theme-corp", []);
    // Theme exposes linkedTrees=[Login, Other]. Login is also linked via
    // PageNode → two different `via` values, both pointing at theme-corp.
    const t = theme("theme-corp", "Corporate", ["Login", "Other"]);
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j1, j2] },
      journeyById: { Login: j1, Other: j2 },
      nodesByKey: { [`${REALM}:PageNode:n1`]: pn },
      themesByKey: { [`${REALM}:theme-corp`]: t },
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    const refs = entry.inboundRefs[entityKeyOf("theme", "theme-corp")];
    // Login appears twice — once via PageNode, once via Theme.linkedTrees.
    // Other appears only via Theme.linkedTrees.
    expect(refs).toHaveLength(3);
    const fromKeys = refs.map((r) => `${r.fromKey}|${r.via}`).sort();
    expect(fromKeys).toEqual([
      `${entityKeyOf("journey", "Login")}|PageNode`,
      `${entityKeyOf("journey", "Login")}|Theme.linkedTrees`,
      `${entityKeyOf("journey", "Other")}|Theme.linkedTrees`,
    ]);
  });

  it("collects social IdPs and creates inbound refs from SelectIdPNode.filteredProviders", async () => {
    const j = journey("Login", { n1: nodeRef("SelectIdPNode") });
    const sn = selectIdPNode("n1", ["google", "apple"]);
    const idp1 = socialIdp("google");
    const idp2 = socialIdp("apple");
    const idp3 = socialIdp("facebook"); // not referenced — should still appear as orphan entity
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j] },
      journeyById: { Login: j },
      nodesByKey: { [`${REALM}:SelectIdPNode:n1`]: sn },
      socialIdpsByRealm: { [REALM]: [idp1, idp2, idp3] },
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    expect(entry.entities[entityKeyOf("socialIdp", "google")]).toBeDefined();
    expect(entry.entities[entityKeyOf("socialIdp", "apple")]).toBeDefined();
    expect(entry.entities[entityKeyOf("socialIdp", "facebook")]).toBeDefined();
    expect(entry.counts.socialIdp).toBe(3);

    const googleRefs = entry.inboundRefs[entityKeyOf("socialIdp", "google")];
    expect(googleRefs).toHaveLength(1);
    expect(googleRefs[0]).toMatchObject({
      fromKey: entityKeyOf("journey", "Login"),
      via: "SelectIdPNode",
    });
    expect(googleRefs[0].fromNodeId).toBe("n1");
    expect(entry.inboundRefs[entityKeyOf("socialIdp", "facebook")]).toBeUndefined();
  });

  it("creates inner-journey inbound refs targeting the inner journey's entity key", async () => {
    const outer = journey("Outer", { n1: nodeRef("InnerTreeEvaluatorNode") });
    const inner = journey("Inner", {});
    const inNode = innerNode("n1", "Inner");
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [outer, inner] },
      journeyById: { Outer: outer, Inner: inner },
      nodesByKey: { [`${REALM}:InnerTreeEvaluatorNode:n1`]: inNode },
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    const refs = entry.inboundRefs[entityKeyOf("journey", "Inner")];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      fromKey: entityKeyOf("journey", "Outer"),
      via: "InnerTreeEvaluatorNode",
    });
    expect(refs[0].fromNodeId).toBe("n1");
  });

  it("creates email-template entities only when a journey references one", async () => {
    const j = journey("Verify", { n1: nodeRef("EmailSuspendNode") });
    const en = emailNode("n1", "welcome-email");
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j] },
      journeyById: { Verify: j },
      nodesByKey: { [`${REALM}:EmailSuspendNode:n1`]: en },
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    expect(entry.entities[entityKeyOf("emailTemplate", "welcome-email")]).toMatchObject({
      kind: "emailTemplate",
      id: "welcome-email",
      displayName: "welcome-email",
    });
    const refs = entry.inboundRefs[entityKeyOf("emailTemplate", "welcome-email")];
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      fromKey: entityKeyOf("journey", "Verify"),
      via: "EmailSuspendNode",
    });
    expect(refs[0].fromNodeId).toBe("n1");
  });

  it("counts entities per kind", async () => {
    const j = journey("Login", { n1: nodeRef("ScriptedDecisionNode") });
    const sd = sdNode("n1", "s-uuid");
    const s = script("s-uuid", "validator");
    const t = theme("t1", "Default");
    const idp = socialIdp("google");
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j] },
      journeyById: { Login: j },
      nodesByKey: { [`${REALM}:ScriptedDecisionNode:n1`]: sd },
      scriptsByKey: { [`${REALM}:s-uuid`]: s },
      themesByKey: { [`${REALM}:t1`]: t },
      socialIdpsByRealm: { [REALM]: [idp] },
      variables: [variable("esv.x")],
      secrets: [],
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    expect(entry.counts).toMatchObject({
      journey: 1,
      script: 1,
      theme: 1,
      socialIdp: 1,
      esv: 0, // not referenced by any script body
      emailTemplate: 0,
    });
  });

  it("survives a failed node payload fetch — logs warn + skips that node", async () => {
    const j = journey("Login", {
      n1: nodeRef("ScriptedDecisionNode"),
      n2: nodeRef("ScriptedDecisionNode"),
    });
    const sd1 = sdNode("n1", "s-1");
    // n2 has no nodesByKey entry → getNode rejects.
    const s1 = script("s-1", "s-1");
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j] },
      journeyById: { Login: j },
      nodesByKey: { [`${REALM}:ScriptedDecisionNode:n1`]: sd1 },
      scriptsByKey: { [`${REALM}:s-1`]: s1 },
    });
    // Should not throw — n2 is logged + skipped.
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);
    expect(entry.entities[entityKeyOf("script", "s-1")]).toBeDefined();
    expect(Object.keys(entry.entities).length).toBeGreaterThan(0);
  });

  it("survives a failed script body fetch — script entity still exists with id-only displayName", async () => {
    const j = journey("Login", { n1: nodeRef("ScriptedDecisionNode") });
    const sd = sdNode("n1", "missing-script");
    // No `scriptsByKey` entry — getScript will reject for "missing-script".
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j] },
      journeyById: { Login: j },
      nodesByKey: { [`${REALM}:ScriptedDecisionNode:n1`]: sd },
    });
    const entry = await buildRealmIndex({ client, log: makeFakeLogger() }, HOST, REALM);

    // Script entity still materialized from the journey scan, with id as
    // displayName (no enrichment because getScript failed).
    const e = entry.entities[entityKeyOf("script", "missing-script")];
    expect(e).toBeDefined();
    expect(e?.displayName).toBe("missing-script");
  });

  it("invokes onProgress across phases with determinate journey done/total", async () => {
    const j1 = journey("Login", {});
    const j2 = journey("Registration", {});
    const client = makeFakePaicClient({
      journeysByRealm: { [REALM]: [j1, j2] },
      journeyById: { Login: j1, Registration: j2 },
    });
    const events: BuildProgress[] = [];
    await buildRealmIndex(
      { client, log: makeFakeLogger(), onProgress: (p) => events.push(p) },
      HOST,
      REALM,
    );
    const phases = events.map((e) => e.phase);
    expect(phases).toContain("preparing");
    expect(phases).toContain("journeys");
    expect(phases).toContain("scripts");
    expect(phases).toContain("finishing");
    // The journey phase is determinate — the last journeys event is all-done.
    const journeyEvents = events.filter((e) => e.phase === "journeys");
    expect(journeyEvents[0]).toMatchObject({ done: 0, total: 2 });
    expect(journeyEvents[journeyEvents.length - 1]).toMatchObject({ done: 2, total: 2 });
  });
});
