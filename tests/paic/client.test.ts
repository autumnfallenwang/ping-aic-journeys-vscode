import type { AxiosResponse } from "axios";
import { beforeEach, describe, expect, it } from "vitest";
import { makePaicClient, type PaicClient, type PaicClientOptions } from "@/paic/client";
import { PaicError } from "@/paic/errors";
import type { HttpClient, PaicRequestConfig } from "@/paic/http";

// In-memory fake HttpClient that records every call and serves canned responses.
interface FakeCall {
  method: "GET" | "POST" | "PUT";
  url: string;
  apiVersion?: string;
  /** Request body (PUT) + headers — for write-path assertions (If-Match, etc.). */
  body?: unknown;
  headers?: Record<string, unknown>;
}

function makeFakeHttp(): {
  http: HttpClient;
  calls: FakeCall[];
  /** Push a canned response to be returned by the NEXT call to `http.get` (FIFO). */
  enqueueGet: <T>(data: T) => void;
  /** Same, but for POST. Not used at M1 but kept for completeness. */
  enqueuePost: <T>(data: T) => void;
  /** Push a canned PUT response (FIFO) with an optional HTTP status (201 create / 200 update). */
  enqueuePut: <T>(data: T, status?: number) => void;
  /** Push a rejection for the NEXT PUT (e.g. a 412 PaicError). */
  enqueuePutReject: (err: unknown) => void;
} {
  const calls: FakeCall[] = [];
  const getQueue: unknown[] = [];
  const postQueue: unknown[] = [];
  const putQueue: ({ data: unknown; status: number } | { reject: unknown })[] = [];

  function build<T>(data: T, status = 200): AxiosResponse<T> {
    return {
      data,
      status,
      statusText: "OK",
      headers: {},
      // biome-ignore lint/suspicious/noExplicitAny: test stub; the real config shape is opaque
      config: {} as any,
    };
  }

  const http: HttpClient = {
    get: <T>(url: string, config?: PaicRequestConfig) => {
      calls.push({ method: "GET", url, apiVersion: config?.apiVersion });
      const next = getQueue.shift();
      if (next === undefined) {
        return Promise.reject(new Error(`unexpected GET ${url} — no canned response`));
      }
      return Promise.resolve(build<T>(next as T));
    },
    post: <T>(url: string, _data?: unknown, config?: PaicRequestConfig) => {
      calls.push({ method: "POST", url, apiVersion: config?.apiVersion });
      const next = postQueue.shift();
      if (next === undefined) {
        return Promise.reject(new Error(`unexpected POST ${url} — no canned response`));
      }
      return Promise.resolve(build<T>(next as T));
    },
    put: <T>(url: string, data?: unknown, config?: PaicRequestConfig) => {
      calls.push({
        method: "PUT",
        url,
        apiVersion: config?.apiVersion,
        body: data,
        headers: config?.headers as Record<string, unknown> | undefined,
      });
      const next = putQueue.shift();
      if (next === undefined) {
        return Promise.reject(new Error(`unexpected PUT ${url} — no canned response`));
      }
      if ("reject" in next) return Promise.reject(next.reject);
      return Promise.resolve(build<T>(next.data as T, next.status));
    },
  };

  return {
    http,
    calls,
    enqueueGet: (data) => getQueue.push(data),
    enqueuePost: (data) => postQueue.push(data),
    enqueuePut: (data, status = 200) => putQueue.push({ data, status }),
    enqueuePutReject: (err) => putQueue.push({ reject: err }),
  };
}

function makeFakeLogger(): PaicClientOptions["log"] {
  const noop = () => undefined;
  const self: PaicClientOptions["log"] = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => self,
    // biome-ignore lint/suspicious/noExplicitAny: pino Logger has many fields we don't use
  } as any;
  return self;
}

let client: PaicClient;
let fake: ReturnType<typeof makeFakeHttp>;

beforeEach(() => {
  fake = makeFakeHttp();
  client = makePaicClient({ http: fake.http, log: makeFakeLogger() });
});

describe("PaicClient", () => {
  it("listRealms calls /am/json/global-config/realms with the realm API version", async () => {
    fake.enqueueGet({
      result: [
        { _id: "1", name: "alpha", active: true, parentPath: "/" },
        { _id: "2", name: "beta", active: false, parentPath: "/" },
      ],
      pagedResultsCookie: null,
    });

    const realms = await client.listRealms();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toBe("/am/json/global-config/realms?_queryFilter=true");
    expect(fake.calls[0].apiVersion).toBe("protocol=2.0,resource=1.0");
    expect(realms).toEqual([
      { name: "alpha", active: true, parentPath: "/", isRoot: false },
      { name: "beta", active: false, parentPath: "/", isRoot: false },
    ]);
  });

  it("listJourneys builds the realm-pathed URL and follows pagedResultsCookie", async () => {
    fake.enqueueGet({
      result: [
        {
          _id: "Login",
          enabled: true,
          entryNodeId: "e",
          nodes: {},
        },
      ],
      pagedResultsCookie: "abc",
    });
    fake.enqueueGet({
      result: [
        {
          _id: "Registration",
          enabled: false,
          entryNodeId: "e2",
          nodes: {},
        },
      ],
      pagedResultsCookie: null,
    });

    const journeys = await client.listJourneys("alpha");

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].url).toBe(
      "/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/trees?_queryFilter=true",
    );
    expect(fake.calls[0].apiVersion).toBe("protocol=2.1,resource=1.0");
    // Second call carries the cookie.
    expect(fake.calls[1].url).toContain("_pagedResultsCookie=abc");
    expect(journeys.map((j) => j.id)).toEqual(["Login", "Registration"]);
  });

  it("getJourney URL-encodes the journey ID", async () => {
    fake.enqueueGet({
      _id: "kyid/2B1",
      enabled: true,
      entryNodeId: "e",
      nodes: {},
    });

    await client.getJourney("alpha", "kyid/2B1");

    expect(fake.calls[0].url).toBe(
      "/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/trees/kyid%2F2B1",
    );
    expect(fake.calls[0].apiVersion).toBe("protocol=2.1,resource=1.0");
  });

  it("getNode embeds nodeType and nodeId in the URL and returns a mapped payload", async () => {
    fake.enqueueGet({
      _id: "node-uuid",
      _type: { _id: "ScriptedDecisionNode" },
      script: "script-uuid-7",
      outcomes: ["true", "false"],
      inputs: ["*"],
      outputs: ["*"],
    });

    const node = await client.getNode("alpha", "ScriptedDecisionNode", "node-uuid");

    expect(fake.calls[0].url).toBe(
      "/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/nodes/ScriptedDecisionNode/node-uuid",
    );
    expect(node.nodeType).toBe("ScriptedDecisionNode");
    if (node.nodeType === "ScriptedDecisionNode") {
      expect(node.scriptId).toBe("script-uuid-7");
      expect(node.outcomes).toEqual(["true", "false"]);
    }
  });

  it("getScript uses the script API version and decodes the body", async () => {
    const source = "function go(){ return 'ok'; }";
    fake.enqueueGet({
      _id: "s-1",
      name: "GoScript",
      language: "JAVASCRIPT",
      script: Buffer.from(source, "utf8").toString("base64"),
    });

    const script = await client.getScript("alpha", "s-1");

    expect(fake.calls[0].url).toBe("/am/json/realms/root/realms/alpha/scripts/s-1");
    expect(fake.calls[0].apiVersion).toBe("protocol=2.0,resource=1.0");
    expect(script).toEqual({
      id: "s-1",
      name: "GoScript",
      language: "JAVASCRIPT",
      body: source,
    });
  });

  it("getRawScript returns the unmapped raw object (base64 body + _rev intact)", async () => {
    const b64 = Buffer.from("var x = 1;", "utf8").toString("base64");
    fake.enqueueGet({
      _id: "s-2",
      _rev: "7",
      name: "RawScript",
      language: "JAVASCRIPT",
      script: b64,
      context: "AUTHENTICATION_TREE_DECISION_NODE",
    });

    const raw = await client.getRawScript("alpha", "s-2");

    expect(fake.calls[0].url).toBe("/am/json/realms/root/realms/alpha/scripts/s-2");
    expect(fake.calls[0].apiVersion).toBe("protocol=2.0,resource=1.0");
    expect(raw._id).toBe("s-2");
    expect(raw._rev).toBe("7");
    expect(raw.script).toBe(b64); // raw passthrough — NOT decoded
  });

  it("getRawTheme returns the raw theme element filtered from the themerealm doc", async () => {
    fake.enqueueGet({
      _id: "ui/themerealm",
      realm: {
        alpha: [
          { _id: "theme-1", name: "Corp", _rev: "5" },
          { _id: "theme-2", name: "Other" },
        ],
      },
    });
    const raw = await client.getRawTheme("alpha", "theme-1");
    expect(fake.calls[0].url).toBe("/openidm/config/ui/themerealm");
    expect(raw).toEqual({ _id: "theme-1", name: "Corp", _rev: "5" });
  });

  it("getRawTheme returns null when the theme isn't in the realm", async () => {
    fake.enqueueGet({ realm: { alpha: [] } });
    expect(await client.getRawTheme("alpha", "nope")).toBeNull();
  });

  it("getRawEmailTemplate returns the raw IDM config object", async () => {
    fake.enqueueGet({ _id: "emailTemplate/welcome", enabled: true, subject: { en: "Hi" } });
    const raw = await client.getRawEmailTemplate("welcome");
    expect(fake.calls[0].url).toBe("/openidm/config/emailTemplate/welcome");
    expect(raw).toEqual({ _id: "emailTemplate/welcome", enabled: true, subject: { en: "Hi" } });
  });

  it("getRawSocialIdp posts nextdescendents and returns the matching raw element", async () => {
    fake.enqueuePost({
      result: [
        { _id: "google", _type: { _id: "oidcConfig" }, clientId: "abc" },
        { _id: "apple", _type: { _id: "appleConfig" } },
      ],
    });
    const raw = await client.getRawSocialIdp("alpha", "google");
    expect(fake.calls[0].method).toBe("POST");
    expect(fake.calls[0].apiVersion).toBe("protocol=2.1,resource=1.0");
    expect(raw).toEqual({ _id: "google", _type: { _id: "oidcConfig" }, clientId: "abc" });
  });

  it("getRawEsv returns the variable raw object + kind, using the hyphenated id", async () => {
    fake.enqueueGet({ _id: "esv-foo-bar", valueBase64: "eA==", expressionType: "string" });
    const r = await client.getRawEsv("esv.foo.bar");
    expect(fake.calls[0].url).toBe("/environment/variables/esv-foo-bar");
    expect(fake.calls[0].apiVersion).toBe("protocol=1.0,resource=1.0");
    expect(r).toEqual({
      kind: "variable",
      raw: { _id: "esv-foo-bar", valueBase64: "eA==", expressionType: "string" },
    });
  });

  it("getRawJourney returns the unmapped journey skeleton", async () => {
    fake.enqueueGet({
      _id: "Login",
      _rev: "3",
      entryNodeId: "n1",
      nodes: { n1: { nodeType: "PageNode" } },
    });
    const raw = await client.getRawJourney("alpha", "Login");
    expect(fake.calls[0].url).toBe(
      "/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/trees/Login",
    );
    expect(fake.calls[0].apiVersion).toBe("protocol=2.1,resource=1.0");
    expect(raw).toEqual({
      _id: "Login",
      _rev: "3",
      entryNodeId: "n1",
      nodes: { n1: { nodeType: "PageNode" } },
    });
  });

  it("getRawNode returns the unmapped node payload", async () => {
    fake.enqueueGet({ _id: "n1", _rev: "2", _type: { _id: "ScriptedDecisionNode" }, script: "s1" });
    const raw = await client.getRawNode("alpha", "ScriptedDecisionNode", "n1");
    expect(fake.calls[0].url).toBe(
      "/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/nodes/ScriptedDecisionNode/n1",
    );
    expect(fake.calls[0].apiVersion).toBe("protocol=2.1,resource=1.0");
    expect(raw._type).toEqual({ _id: "ScriptedDecisionNode" });
    expect(raw.script).toBe("s1");
  });

  it("getRawScriptByName returns the first raw result, or null on miss", async () => {
    fake.enqueueGet({ result: [{ _id: "s1", name: "helpers", script: "eA==" }] });
    const hit = await client.getRawScriptByName("alpha", "helpers");
    expect(fake.calls[0].apiVersion).toBe("protocol=2.0,resource=1.0");
    expect(hit).toEqual({ _id: "s1", name: "helpers", script: "eA==" });

    fake.enqueueGet({ result: [] });
    expect(await client.getRawScriptByName("alpha", "nope")).toBeNull();
  });

  it("listScripts lists ALL scripts (_queryFilter=true) + maps body/context (D36)", async () => {
    fake.enqueueGet({
      result: [
        {
          _id: "s1",
          name: "Decision",
          script: "eA==",
          context: "AUTHENTICATION_TREE_DECISION_NODE",
        },
        { _id: "s2", name: "lib", script: "eQ==", context: "LIBRARY" },
      ],
      pagedResultsCookie: null,
    });
    const scripts = await client.listScripts("alpha");
    expect(fake.calls[0].url).toBe("/am/json/realms/root/realms/alpha/scripts?_queryFilter=true");
    expect(fake.calls[0].apiVersion).toBe("protocol=2.0,resource=1.0");
    expect(scripts.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(scripts[0].body).toBe("x"); // base64 "eA==" → "x"
    expect(scripts[1].context).toBe("LIBRARY");
  });

  it("listEmailTemplates enumerates IDM config + keeps only emailTemplate/* (prefix stripped)", async () => {
    fake.enqueueGet({
      result: [
        { _id: "access" },
        { _id: "emailTemplate/welcome", enabled: true, subject: { en: "Hi" } },
        { _id: "ui/themerealm" },
        { _id: "emailTemplate/reset", enabled: false },
      ],
      pagedResultsCookie: null,
    });
    const templates = await client.listEmailTemplates();
    expect(fake.calls[0].url).toBe("/openidm/config?_queryFilter=true");
    expect(templates.map((t) => t.name)).toEqual(["welcome", "reset"]); // prefix stripped, non-email filtered
  });

  it("findRawScriptsByName returns ALL same-named hits (dup-name count, TD-9)", async () => {
    fake.enqueueGet({
      result: [
        { _id: "a", name: "dup" },
        { _id: "b", name: "dup" },
      ],
    });
    const hits = await client.findRawScriptsByName("alpha", "dup");
    expect(hits.map((h) => h._id)).toEqual(["a", "b"]);

    fake.enqueueGet({ result: [] });
    expect(await client.findRawScriptsByName("alpha", "nope")).toEqual([]);
  });

  it("getTheme fetches the whole themerealm config and filters by realm + id", async () => {
    // The wire shape uses `realm` (singular) and the value is the theme
    // array directly — no `.themes` wrapper. Verified against sb3 via the
    // theme-probe POC.
    fake.enqueueGet({
      realm: {
        alpha: [
          { _id: "theme-1", name: "Default", isDefault: true },
          {
            _id: "theme-2",
            name: "Custom",
            primaryColor: "#3057A4",
            linkedTrees: ["JourneyA", "JourneyB"],
            logo: { en: "https://example.com/logo.svg" },
            logoAltText: { en: "Logo" },
          },
        ],
        beta: [{ _id: "theme-3", name: "Other" }],
      },
    });
    const found = await client.getTheme("alpha", "theme-2");
    expect(fake.calls[0].url).toBe("/openidm/config/ui/themerealm");
    expect(found).toMatchObject({
      id: "theme-2",
      name: "Custom",
      realm: "alpha",
      primaryColor: "#3057A4",
      linkedTrees: ["JourneyA", "JourneyB"],
      logo: { en: "https://example.com/logo.svg" },
    });

    fake.enqueueGet({
      realm: { alpha: [{ _id: "theme-1", name: "Default" }] },
    });
    const miss = await client.getTheme("alpha", "no-such-theme");
    expect(miss).toBeNull();
  });

  it("listThemes fetches /openidm/config/ui/themerealm once and returns all mapped themes for the realm", async () => {
    fake.enqueueGet({
      realm: {
        alpha: [
          { _id: "t1", name: "First", isDefault: true },
          { _id: "t2", name: "Second", primaryColor: "#3057A4" },
        ],
        beta: [{ _id: "t3", name: "BetaTheme" }],
      },
    });
    const themes = await client.listThemes("alpha");
    expect(fake.calls[0].url).toBe("/openidm/config/ui/themerealm");
    expect(themes.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(themes[0].isDefault).toBe(true);
    expect(themes[1].primaryColor).toBe("#3057A4");
  });

  it("getEmailTemplate fetches /openidm/config/emailTemplate/<name> and maps the result", async () => {
    fake.enqueueGet({
      _id: "emailTemplate/welcome",
      enabled: true,
      from: "noreply@example.com",
      subject: { en: "Hi" },
    });
    const t = await client.getEmailTemplate("welcome");
    expect(fake.calls[0].url).toBe("/openidm/config/emailTemplate/welcome");
    expect(t).toEqual({
      name: "welcome",
      enabled: true,
      from: "noreply@example.com",
      subject: { en: "Hi" },
      message: undefined,
    });
  });

  it("listSocialIdps POSTs _action=nextdescendents and maps the result array", async () => {
    fake.enqueuePost({
      result: [
        { _id: "google-oidc", _type: { _id: "googleSocialAuthentication" }, enabled: true },
        { _id: "apple-oidc", _type: { _id: "appleSocialAuthentication" }, enabled: false },
      ],
    });
    const idps = await client.listSocialIdps("alpha");
    expect(fake.calls[0].method).toBe("POST");
    expect(fake.calls[0].url).toBe(
      "/am/json/realms/root/realms/alpha/realm-config/services/SocialIdentityProviders?_action=nextdescendents",
    );
    expect(fake.calls[0].apiVersion).toBe("protocol=2.1,resource=1.0");
    expect(idps).toEqual([
      { name: "google-oidc", type: "googleSocialAuthentication", enabled: true, realm: "alpha" },
      { name: "apple-oidc", type: "appleSocialAuthentication", enabled: false, realm: "alpha" },
    ]);
  });

  it("getSocialIdp delegates to listSocialIdps and returns the matching entry", async () => {
    fake.enqueuePost({
      result: [
        { _id: "google-oidc", _type: { _id: "googleSocialAuthentication" }, enabled: true },
        { _id: "apple-oidc", _type: { _id: "appleSocialAuthentication" }, enabled: false },
      ],
    });
    const idp = await client.getSocialIdp("alpha", "apple-oidc");
    expect(idp).toEqual({
      name: "apple-oidc",
      type: "appleSocialAuthentication",
      enabled: false,
      realm: "alpha",
    });
  });

  it("getSocialIdp returns null when no IdP with that name exists in the realm", async () => {
    fake.enqueuePost({
      result: [{ _id: "google-oidc", _type: { _id: "googleSocialAuthentication" }, enabled: true }],
    });
    const idp = await client.getSocialIdp("alpha", "nonexistent");
    expect(idp).toBeNull();
  });

  it("getEsv tries /environment/variables/<name> first; returns mapped variable on hit", async () => {
    fake.enqueueGet({
      _id: "esv/variables/PUBLIC_URL",
      description: "Public URL",
      expressionType: "string",
    });
    const got = await client.getEsv("PUBLIC_URL");
    expect(fake.calls[0].url).toBe("/environment/variables/PUBLIC_URL");
    expect(fake.calls[0].apiVersion).toBe("protocol=1.0,resource=1.0");
    expect(got).toEqual({
      kind: "variable",
      name: "PUBLIC_URL",
      description: "Public URL",
      expressionType: "string",
      lastChangeDate: undefined,
    });
  });

  it("getEsv translates the dotted script-form name to the hyphenated REST id", async () => {
    // POC-validated against sb3: `/variables/esv.kyid.portal.name` → 400 from
    // the API; `/variables/esv-kyid-portal-name` → 200. Translate before URL,
    // keep the dotted name for display in the mapped result.
    fake.enqueueGet({
      _id: "esv-kyid-portal-name",
      description: "Portal name",
      expressionType: "string",
    });
    const got = await client.getEsv("esv.kyid.portal.name");
    expect(fake.calls[0].url).toBe("/environment/variables/esv-kyid-portal-name");
    expect(got).toEqual({
      kind: "variable",
      name: "esv.kyid.portal.name", // canonical display name stays dotted
      description: "Portal name",
      expressionType: "string",
      lastChangeDate: undefined,
    });
  });

  it("listVariables pages /environment/variables and translates hyphenated _ids to dotted names", async () => {
    fake.enqueueGet({
      result: [
        { _id: "esv-kyid-portal-name", expressionType: "string", loaded: true },
        { _id: "esv-tenant-fqdn", expressionType: "string", loaded: true },
      ],
      pagedResultsCookie: null,
    });
    const vars = await client.listVariables("alpha");
    expect(fake.calls[0].url).toBe("/environment/variables?_queryFilter=true");
    expect(fake.calls[0].apiVersion).toBe("protocol=1.0,resource=1.0");
    expect(vars.map((v) => v.name)).toEqual(["esv.kyid.portal.name", "esv.tenant.fqdn"]);
    expect(vars[0].kind).toBe("variable");
    expect(vars[0].loaded).toBe(true);
  });

  it("listSecrets pages /environment/secrets and returns dotted-name secrets with version fields", async () => {
    fake.enqueueGet({
      result: [
        {
          _id: "esv-ad-creds",
          encoding: "generic",
          loaded: true,
          activeVersion: "1",
          loadedVersion: "1",
          useInPlaceholders: true,
        },
      ],
      pagedResultsCookie: null,
    });
    const secs = await client.listSecrets("alpha");
    expect(fake.calls[0].url).toBe("/environment/secrets?_queryFilter=true");
    expect(secs[0]).toEqual({
      kind: "secret",
      name: "esv.ad.creds",
      description: undefined,
      encoding: "generic",
      lastChangeDate: undefined,
      lastChangedBy: undefined,
      loaded: true,
      activeVersion: "1",
      loadedVersion: "1",
      useInPlaceholders: true,
    });
  });

  it("getScriptByName queries by name and returns the first mapped result (or null)", async () => {
    const source = "exports.help = function(){};";
    // First call — hit.
    fake.enqueueGet({
      result: [
        {
          _id: "s-lib",
          name: "helpers",
          language: "JAVASCRIPT",
          script: Buffer.from(source, "utf8").toString("base64"),
        },
      ],
      pagedResultsCookie: null,
    });
    const hit = await client.getScriptByName("alpha", "helpers");
    expect(fake.calls[0].url).toContain("/am/json/realms/root/realms/alpha/scripts?");
    // URLSearchParams encodes the quotes; either `%22` or `+` between tokens is OK.
    expect(fake.calls[0].url).toContain("name+eq+%22helpers%22");
    expect(fake.calls[0].apiVersion).toBe("protocol=2.0,resource=1.0");
    expect(hit).toEqual({ id: "s-lib", name: "helpers", language: "JAVASCRIPT", body: source });

    // Second call — miss (empty result array).
    fake.enqueueGet({ result: [], pagedResultsCookie: null });
    const miss = await client.getScriptByName("alpha", "nope");
    expect(miss).toBeNull();
  });

  it("short-circuits Tier-B/C methods when capabilities are disabled — no HTTP (D41 Slice 3)", async () => {
    const offline = makePaicClient({
      http: fake.http,
      log: makeFakeLogger(),
      capabilities: { themes: false, emailTemplates: false, esvs: false },
    });

    expect(await offline.getTheme("alpha", "t-1")).toBeNull();
    expect(await offline.listThemes("alpha")).toEqual([]);
    expect(await offline.getEmailTemplate("welcome")).toBeNull();
    expect(await offline.getEsv("esv.x.y")).toBeNull();
    expect(await offline.listVariables("alpha")).toEqual([]);
    expect(await offline.listSecrets("alpha")).toEqual([]);

    // None of the short-circuited methods touched the HTTP layer.
    expect(fake.calls).toHaveLength(0);
  });

  it("prefixes AM URLs with an injected amPath (D41 Slice 3)", async () => {
    const onprem = makePaicClient({ http: fake.http, log: makeFakeLogger(), amPath: "/openam" });
    fake.enqueueGet({ result: [], pagedResultsCookie: null });

    await onprem.listJourneys(""); // realm "" → root

    expect(fake.calls[0].url).toBe(
      "/openam/json/realms/root/realm-config/authentication/authenticationtrees/trees?_queryFilter=true",
    );
  });
});

/**
 * AM's `<field>-encrypted` companions (see `src/paic/encrypted.ts`).
 *
 * PAIC returns e.g. `{"password": null, "password-encrypted": "<blob>"}`; AM then
 * rejects ANY write carrying such a key with `500 "Request contained encrypted
 * data"` — so a bundle exported from PAIC could not be imported anywhere, which
 * is the bug these guard. Stripped on BOTH read and write: read keeps exports and
 * compare clean, write rescues bundles authored before the fix (or by frodo).
 */
describe("`<field>-encrypted` companion stripping", () => {
  it("getRawNode drops the companion and preserves every other field", async () => {
    fake.enqueueGet({
      _id: "n1",
      _type: { _id: "OneTimePasswordSmtpSenderNode" },
      hostName: "smtp.example.com",
      password: null,
      "password-encrypted": "AQICAHjcm9mCT1V0kQ==",
    });
    const raw = (await client.getRawNode("alpha", "OneTimePasswordSmtpSenderNode", "n1")) as Record<
      string,
      unknown
    >;
    expect(raw).not.toHaveProperty("password-encrypted");
    // The nulled plaintext companion is a real writable field — it must survive.
    expect(raw).toHaveProperty("password", null);
    expect(raw.hostName).toBe("smtp.example.com");
  });

  it("writeNode never PUTs a companion, even when the bundle carries one", async () => {
    fake.enqueuePut({}, 201);
    await client.writeNode("alpha", "OneTimePasswordSmtpSenderNode", "n1", {
      _id: "n1",
      hostName: "smtp.example.com",
      password: null,
      "password-encrypted": "AQICAHjcm9mCT1V0kQ==",
    });
    const put = fake.calls.find((c) => c.method === "PUT");
    // Exact, not toMatchObject: a subset match cannot see a key that should be absent.
    expect(put?.body).toEqual({
      _id: "n1",
      hostName: "smtp.example.com",
      password: null,
    });
  });

  it("getRawSocialIdp drops the companion (clientSecret-encrypted)", async () => {
    fake.enqueuePost({
      result: [{ _id: "google", clientId: "c", clientSecret: null, "clientSecret-encrypted": "z" }],
    });
    const raw = (await client.getRawSocialIdp("alpha", "google")) as Record<string, unknown> | null;
    expect(raw).not.toBeNull();
    expect(raw).not.toHaveProperty("clientSecret-encrypted");
    expect(raw).toHaveProperty("clientSecret", null);
    expect(raw?.clientId).toBe("c");
  });

  it("getRawSocialIdp still returns null on a miss", async () => {
    fake.enqueuePost({ result: [{ _id: "other" }] });
    expect(await client.getRawSocialIdp("alpha", "google")).toBeNull();
  });

  it("writeSocialIdp never PUTs a companion", async () => {
    fake.enqueuePut({}, 201);
    await client.writeSocialIdp("alpha", "oidcConfig", "g", {
      _id: "g",
      clientSecret: "resupplied",
      "clientSecret-encrypted": "AQICblob==",
    });
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ _id: "g", clientSecret: "resupplied" });
  });

  it("leaves a payload with no companions untouched", async () => {
    const clean = { _id: "n1", _type: { _id: "PageNode" }, pageHeader: { en: "Sign in" } };
    fake.enqueueGet(clean);
    expect(await client.getRawNode("alpha", "PageNode", "n1")).toEqual(clean);
  });
});

describe("import writes (D43)", () => {
  it("writeEmailTemplate PUTs the body to /emailTemplate/<name>; 201 → created", async () => {
    fake.enqueuePut({}, 201);
    const out = await client.writeEmailTemplate("welcome", { subject: { en: "Hi" } });
    expect(out).toBe("created");
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/openidm/config/emailTemplate/welcome");
    expect(put?.body).toEqual({ subject: { en: "Hi" } });
  });

  it("writeEmailTemplate 200 → overwritten", async () => {
    fake.enqueuePut({}, 200);
    expect(await client.writeEmailTemplate("w", {})).toBe("overwritten");
  });

  it("writeSocialIdp PUTs to <typeId>/<id> with the social-idp api version", async () => {
    fake.enqueuePut({}, 201);
    const out = await client.writeSocialIdp("alpha", "oidcConfig", "g", {
      _id: "g",
      clientSecret: "x",
    });
    expect(out).toBe("created");
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe(
      "/am/json/realms/root/realms/alpha/realm-config/services/SocialIdentityProviders/oidcConfig/g",
    );
    expect(put?.apiVersion).toBe("protocol=2.1,resource=1.0");
    expect(put?.body).toMatchObject({ _id: "g", clientSecret: "x" });
  });

  it("writeScript PUTs to /scripts/<uuid> with the script api version; 201 → created", async () => {
    fake.enqueuePut({}, 201);
    const out = await client.writeScript("alpha", "s-1", { _id: "s-1", script: "ZA==" });
    expect(out).toBe("created");
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/am/json/realms/root/realms/alpha/scripts/s-1");
    expect(put?.apiVersion).toBe("protocol=2.0,resource=1.0");
    expect(put?.body).toMatchObject({ _id: "s-1", script: "ZA==" });
  });

  it("writeScript 200 → overwritten", async () => {
    fake.enqueuePut({}, 200);
    expect(await client.writeScript("alpha", "s-1", { _id: "s-1" })).toBe("overwritten");
  });

  it("writeNode PUTs to /nodes/<type>/<id> with the tree api version; 201 → created", async () => {
    fake.enqueuePut({}, 201);
    const out = await client.writeNode("alpha", "ScriptedDecisionNode", "n1", {
      _id: "n1",
      script: "s1",
    });
    expect(out).toBe("created");
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe(
      "/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/nodes/ScriptedDecisionNode/n1",
    );
    expect(put?.apiVersion).toBe("protocol=2.1,resource=1.0");
    expect(put?.body).toMatchObject({ _id: "n1", script: "s1" });
  });

  it("writeNode 200 → overwritten", async () => {
    fake.enqueuePut({}, 200);
    expect(await client.writeNode("alpha", "PageNode", "p1", {})).toBe("overwritten");
  });

  it("writeTree PUTs to /trees/<id> with the tree api version; 201 → created", async () => {
    fake.enqueuePut({}, 201);
    const out = await client.writeTree("alpha", "Login", { _id: "Login", entryNodeId: "n1" });
    expect(out).toBe("created");
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe(
      "/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/trees/Login",
    );
    expect(put?.apiVersion).toBe("protocol=2.1,resource=1.0");
    expect(put?.body).toMatchObject({ _id: "Login", entryNodeId: "n1" });
  });

  it("writeTree 200 → overwritten", async () => {
    fake.enqueuePut({}, 200);
    expect(await client.writeTree("alpha", "Login", {})).toBe("overwritten");
  });

  it("listTrees GETs ?_queryFilter=true (tree api version) and returns the result array", async () => {
    fake.enqueueGet({ result: [{ _id: "Login" }, { _id: "MFA" }] });
    const trees = await client.listTrees("alpha");
    expect(fake.calls[0].url).toBe(
      "/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/trees?_queryFilter=true",
    );
    expect(fake.calls[0].apiVersion).toBe("protocol=2.1,resource=1.0");
    expect(trees.map((t) => t._id)).toEqual(["Login", "MFA"]);
  });

  it("getNodeTypes POSTs ?_action=getAllTypes and maps result._id, dropping ids-less entries", async () => {
    fake.enqueuePost({
      result: [{ _id: "PageNode" }, { _id: "ScriptedDecisionNode" }, { name: "no-id" }],
    });
    const types = await client.getNodeTypes("alpha");
    expect(fake.calls[0].url).toBe(
      "/am/json/realms/root/realms/alpha/realm-config/authentication/authenticationtrees/nodes?_action=getAllTypes",
    );
    expect(fake.calls[0].apiVersion).toBe("protocol=2.1,resource=1.0");
    expect(types).toEqual(["PageNode", "ScriptedDecisionNode"]);
  });

  it("writeTheme splices into themerealm with If-Match, preserving siblings; create → isDefault:false", async () => {
    fake.enqueueGet({
      _id: "ui/themerealm",
      _rev: "7",
      realm: { alpha: [{ _id: "other", isDefault: true }] },
    });
    fake.enqueuePut({}, 200);
    const out = await client.writeTheme("alpha", { _id: "new", backgroundColor: "#1" });
    expect(out).toBe("created");
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/openidm/config/ui/themerealm");
    expect(put?.headers?.["If-Match"]).toBe("7");
    const body = put?.body as { _id: string; realm: { alpha: Array<Record<string, unknown>> } };
    expect(body._id).toBe("ui/themerealm"); // doc id kept
    expect(body.realm.alpha).toHaveLength(2); // sibling preserved + new appended
    expect(body.realm.alpha.find((t) => t._id === "new")?.isDefault).toBe(false);
    expect(body.realm.alpha.find((t) => t._id === "other")?.isDefault).toBe(true); // untouched
  });

  it("writeTheme overwrite preserves the target's existing isDefault, replaces content", async () => {
    fake.enqueueGet({
      _id: "ui/themerealm",
      _rev: "1",
      realm: { alpha: [{ _id: "t", isDefault: true, backgroundColor: "#0" }] },
    });
    fake.enqueuePut({}, 200);
    expect(
      await client.writeTheme("alpha", { _id: "t", isDefault: false, backgroundColor: "#9" }),
    ).toBe("overwritten");
    const put = fake.calls.find((c) => c.method === "PUT");
    const body = put?.body as { realm: { alpha: Array<Record<string, unknown>> } };
    const t = body.realm.alpha.find((x) => x._id === "t");
    expect(t?.isDefault).toBe(true); // default-state preserved
    expect(t?.backgroundColor).toBe("#9"); // content overwritten
  });

  it("writeTheme retries the splice once on a 412", async () => {
    fake.enqueueGet({ _id: "ui/themerealm", _rev: "1", realm: { alpha: [] } });
    fake.enqueuePutReject(new PaicError("precondition failed", { status: 412 }));
    fake.enqueueGet({ _id: "ui/themerealm", _rev: "2", realm: { alpha: [] } });
    fake.enqueuePut({}, 200);
    const out = await client.writeTheme("alpha", { _id: "t", backgroundColor: "#1" });
    expect(out).toBe("created");
    const puts = fake.calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1].headers?.["If-Match"]).toBe("2"); // re-GET picked up the new _rev
  });

  it("writeTheme throws on a no-IDM (on-prem) backend instead of silently skipping", async () => {
    const onprem = makePaicClient({
      http: fake.http,
      log: makeFakeLogger(),
      capabilities: { themes: false, emailTemplates: false, esvs: false },
    });
    await expect(onprem.writeTheme("alpha", { _id: "t" })).rejects.toThrow(/no IDM/);
  });

  it("writeEsvVariable PUTs the body + ESV api version; reports 'created' on a 200", async () => {
    fake.enqueuePut({}, 200);
    const out = await client.writeEsvVariable("esv-x", { valueBase64: "dg==" });
    expect(out).toBe("created"); // 200, not 201, but import is create-only
    const put = fake.calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/environment/variables/esv-x");
    expect(put?.apiVersion).toBe("protocol=1.0,resource=1.0");
    expect(put?.body).toEqual({ valueBase64: "dg==" });
  });

  it("writeEsvSecret PUTs to /environment/secrets/<id>", async () => {
    fake.enqueuePut({}, 200);
    expect(await client.writeEsvSecret("esv-s", { valueBase64: "dg==" })).toBe("created");
    expect(fake.calls.find((c) => c.method === "PUT")?.url).toBe("/environment/secrets/esv-s");
  });

  it("writeEsvVariable normalizes a dotted id to hyphens for the URL", async () => {
    fake.enqueuePut({}, 200);
    await client.writeEsvVariable("esv.zzz.export.var", { valueBase64: "dg==" });
    expect(fake.calls.find((c) => c.method === "PUT")?.url).toBe(
      "/environment/variables/esv-zzz-export-var",
    );
  });

  it("writeEsvVariable throws on a no-ESV (on-prem) backend", async () => {
    const onprem = makePaicClient({
      http: fake.http,
      log: makeFakeLogger(),
      capabilities: { themes: false, emailTemplates: false, esvs: false },
    });
    await expect(onprem.writeEsvVariable("esv-x", {})).rejects.toThrow(/no IDC ESV/);
  });

  it("getStartupStatus reads /environment/startup → restartStatus", async () => {
    fake.enqueueGet({ restartStatus: "restarting" });
    expect(await client.getStartupStatus()).toBe("restarting");
    const get = fake.calls.find((c) => c.url === "/environment/startup");
    expect(get?.apiVersion).toBe("protocol=1.0,resource=1.0");
  });

  it("getStartupStatus defaults to 'ready' when restartStatus is absent", async () => {
    fake.enqueueGet({});
    expect(await client.getStartupStatus()).toBe("ready");
  });

  it("applyEsvUpdates POSTs ?_action=restart with the ESV api version", async () => {
    fake.enqueuePost({ restartStatus: "restarting" });
    await client.applyEsvUpdates();
    const post = fake.calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/environment/startup?_action=restart");
    expect(post?.apiVersion).toBe("protocol=1.0,resource=1.0");
  });

  it("getStartupStatus throws on a no-ESV backend", async () => {
    const onprem = makePaicClient({
      http: fake.http,
      log: makeFakeLogger(),
      capabilities: { themes: false, emailTemplates: false, esvs: false },
    });
    await expect(onprem.getStartupStatus()).rejects.toThrow(/no IDC ESV/);
  });
});
