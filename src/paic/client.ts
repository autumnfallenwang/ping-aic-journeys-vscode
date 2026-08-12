import type {
  EmailTemplate,
  Esv,
  EsvSecret,
  EsvVariable,
  Journey,
  NodePayload,
  Realm,
  Script,
  SocialIdp,
  Theme,
} from "../domain/types";
import type { Logger } from "../util/logger";
import { stripEncrypted } from "./encrypted";
import { PaicError } from "./errors";
import type { HttpClient } from "./http";
import {
  mapEmailTemplate,
  mapEsvSecret,
  mapEsvVariable,
  mapJourney,
  mapNodePayload,
  mapRealm,
  mapScript,
  mapSocialIdp,
  mapTheme,
  type RawEmailTemplate,
  type RawEsvSecret,
  type RawEsvVariable,
  type RawJourney,
  type RawNodePayload,
  type RawRealm,
  type RawScript,
  type RawSocialIdp,
  type RawTheme,
  type RawThemeRealmConfig,
} from "./mappers";
import { listAllPaged, type PagedResponse } from "./pagination";
import { getRealmPath } from "./realm-path";

const TREE_API_VERSION = "protocol=2.1,resource=1.0";
const SCRIPT_API_VERSION = "protocol=2.0,resource=1.0";
const REALM_API_VERSION = "protocol=2.0,resource=1.0";
const SOCIAL_IDP_API_VERSION = "protocol=2.1,resource=1.0";
const ESV_API_VERSION = "protocol=1.0,resource=1.0";

const DEFAULT_AM_PATH = "/am";

/** Which platform-resource families this connection's backend exposes. PAIC
 * cloud has all three; a standalone on-prem AM has none (no IDM, no IDC ESV
 * API), so those methods short-circuit instead of paying a 404 (D41 Slice 3). */
export interface ClientCapabilities {
  /** IDM themes (`/openidm/config/ui/themerealm`). */
  themes: boolean;
  /** IDM email templates (`/openidm/config/emailTemplate`). */
  emailTemplates: boolean;
  /** IDC ESVs (`/environment/variables|secrets`). */
  esvs: boolean;
}

const ALL_CAPABILITIES: ClientCapabilities = { themes: true, emailTemplates: true, esvs: true };

/** Result of a raw ESV fetch — the discovered kind plus the unmapped object.
 * Used by the export feature to pick the frodo per-type key (variable/secret). */
export type RawEsvResult =
  | { kind: "variable"; raw: RawEsvVariable }
  | { kind: "secret"; raw: RawEsvSecret };

/** Whether a write created a new resource or overwrote an existing one
 * (201 vs 200, or array insert vs replace for the theme splice). */
export type WriteOutcome = "created" | "overwritten";

/** Environment restart ("apply") status — `GET /environment/startup`. */
export type EsvRestartStatus = "ready" | "restarting";

export interface PaicClient {
  listRealms(): Promise<Realm[]>;
  listJourneys(realm: string): Promise<Journey[]>;
  getJourney(realm: string, id: string): Promise<Journey>;
  getNode(realm: string, nodeType: string, nodeId: string): Promise<NodePayload>;
  getScript(realm: string, id: string): Promise<Script>;
  /** Fetch the RAW, unmapped REST script object (base64 body, `_rev`, audit
   * fields intact). The export feature needs the faithful wire shape rather
   * than the cleaned domain `Script`. */
  getRawScript(realm: string, id: string): Promise<RawScript>;
  /** Lookup a script by name in a realm. Used to resolve library-script
   * references (`require('<name>')`) discovered during script-body parsing.
   * Returns `null` if no script in the realm has that name. */
  getScriptByName(realm: string, name: string): Promise<Script | null>;
  /** List EVERY script in a realm (`_queryFilter=true`) — including ones not
   * referenced by any journey. The response carries each script's body, so the
   * realm-index closure walk needs no per-script fetch. */
  listScripts(realm: string): Promise<Script[]>;

  // M3 Slice 3 — journey-level resource lookups.

  /** Fetch a single theme by id from a realm. Internally fetches the whole
   * `ui/themerealm` IDM config and filters; returns null if not found. */
  getTheme(realm: string, themeId: string): Promise<Theme | null>;
  /** Return every theme in a realm. Single fetch of `ui/themerealm`; lets
   * the tree pre-resolve multiple PageNode.themeIds in one round-trip. */
  listThemes(realm: string): Promise<Theme[]>;
  /** Fetch a single IDM email template by name. Returns null on 404. */
  getEmailTemplate(name: string): Promise<EmailTemplate | null>;
  /** List EVERY IDM email template (tenant-wide). Enumerates `/openidm/config`
   * and filters to `emailTemplate/<name>` config ids. Empty on a no-IDM backend. */
  listEmailTemplates(): Promise<EmailTemplate[]>;
  /** List all social IdPs in a realm (one POST via `_action=nextdescendents`). */
  listSocialIdps(realm: string): Promise<SocialIdp[]>;
  /** Fetch a single social IdP in a realm by its name. AIC's REST API requires
   * (type, id) for direct lookup, but our callers only carry the name → this
   * method fetches the full realm list and filters. Returns null if no IdP
   * with that name exists in the realm. */
  getSocialIdp(realm: string, name: string): Promise<SocialIdp | null>;
  /** Fetch an ESV by name — tries `/environment/variables/<name>` first,
   * falls through to `/environment/secrets/<name>` on 404. Returns null on
   * double-miss. */
  getEsv(name: string): Promise<Esv | null>;
  /** List all ESV variables in the tenant (paged). `realm` arg accepted for
   * API symmetry but the endpoint is tenant-scoped. Returned `name`s are in
   * canonical dotted form (REST `_id`s are hyphenated; translated here). */
  listVariables(realm: string): Promise<EsvVariable[]>;
  /** List all ESV secrets in the tenant (paged). Same scope + naming notes
   * as `listVariables`. */
  listSecrets(realm: string): Promise<EsvSecret[]>;

  // ── Raw accessors (export feature) — return the unmapped wire object ──
  /** Raw journey skeleton (entry node + nodes map + staticNodes). */
  getRawJourney(realm: string, id: string): Promise<RawJourney>;
  /** Raw node payload (wire `_type` / `script` / `stage` / etc.). */
  getRawNode(realm: string, nodeType: string, nodeId: string): Promise<RawNodePayload>;
  /** Raw script looked up by name (the `require()` resolution path); null on miss. */
  getRawScriptByName(realm: string, name: string): Promise<RawScript | null>;
  /** All raw scripts with the given name. AM allows duplicate names, so this
   * returns every hit (the count drives cross-env match-ambiguity detection,
   * TD-9). Empty array on no match. */
  findRawScriptsByName(realm: string, name: string): Promise<RawScript[]>;
  /** Raw theme element from the realm's `ui/themerealm` array; null if absent
   * or no IDM on this backend. */
  getRawTheme(realm: string, themeId: string): Promise<RawTheme | null>;
  /** Raw IDM email-template config; null on 404 or no IDM. */
  getRawEmailTemplate(name: string): Promise<RawEmailTemplate | null>;
  /** Raw social-IdP provider config (full object incl. `_type`); null if absent. */
  getRawSocialIdp(realm: string, name: string): Promise<RawSocialIdp | null>;
  /** Raw ESV with the discovered kind (variable vs secret); null on miss or no
   * IDC ESV API. Secret raw is metadata-only (the API never returns the value). */
  getRawEsv(name: string): Promise<RawEsvResult | null>;

  // ── Import writes (D43) — the only methods that mutate a tenant ──
  /** Create/overwrite an IDM email template. Throws on a no-IDM backend. */
  writeEmailTemplate(name: string, body: Record<string, unknown>): Promise<WriteOutcome>;
  /** Create/overwrite a social IdP at `(typeId, id)` in a realm. */
  writeSocialIdp(
    realm: string,
    typeId: string,
    id: string,
    body: Record<string, unknown>,
  ): Promise<WriteOutcome>;
  /** Create/overwrite a theme via a whole-doc splice of `ui/themerealm`
   * (`If-Match` guarded; preserves siblings + the realm's default). Throws on
   * a no-IDM backend. */
  writeTheme(realm: string, theme: Record<string, unknown>): Promise<WriteOutcome>;
  /** Create/update an ESV variable (`PUT /environment/variables/<id>`). Always
   * reports `"created"` (the API returns 200 for both). Throws on no-ESV
   * backend. ESV writes land pending until applied (D43 / TD-7). */
  writeEsvVariable(id: string, body: Record<string, unknown>): Promise<WriteOutcome>;
  /** Create an ESV secret (`PUT /environment/secrets/<id>`) with a re-supplied
   * `valueBase64`. Always reports `"created"`. Throws on no-ESV backend. */
  writeEsvSecret(id: string, body: Record<string, unknown>): Promise<WriteOutcome>;
  /** Create/overwrite a decision or library script (`PUT …/scripts/<uuid>`).
   * The UUID (the bundle `_id`) is preserved; `context: "LIBRARY"` round-trips
   * for library scripts. 201 → created / 200 → overwritten. */
  writeScript(realm: string, id: string, body: Record<string, unknown>): Promise<WriteOutcome>;
  /** Create/overwrite an authentication-tree node instance
   * (`PUT …/authenticationtrees/nodes/<nodeType>/<nodeId>`). The export shape is
   * written as-is (AM tolerates the `_type`/`_outcomes` echoes — TD-15). 201 →
   * created / 200 → overwritten. */
  writeNode(
    realm: string,
    nodeType: string,
    nodeId: string,
    body: Record<string, unknown>,
  ): Promise<WriteOutcome>;
  /** Create/overwrite a journey/tree (`PUT …/authenticationtrees/trees/<treeId>`),
   * written last in the dependency order. 201 → created / 200 → overwritten. */
  writeTree(realm: string, treeId: string, body: Record<string, unknown>): Promise<WriteOutcome>;
  /** All trees in a realm (`GET …/authenticationtrees/trees?_queryFilter=true`) —
   * the import inner-journey existence gate checks membership by `_id`. */
  listTrees(realm: string): Promise<RawJourney[]>;
  /** Installed node-type ids in the deployment
   * (`POST …/authenticationtrees/nodes?_action=getAllTypes`) — the import
   * node-type gate diffs the bundle's used types against this catalog (TD-14). */
  getNodeTypes(realm: string): Promise<string[]>;
  /** Environment restart ("apply") status — `ready` or `restarting`. ESV
   * writes only take effect after a restart. Throws on no-ESV backend. */
  getStartupStatus(): Promise<EsvRestartStatus>;
  /** Trigger the environment restart that applies pending ESV changes
   * (tenant-wide; requires status `ready`). Throws on no-ESV backend. */
  applyEsvUpdates(): Promise<void>;
}

export interface PaicClientOptions {
  http: HttpClient;
  log: Logger;
  /** AM context-path prefix for `/am`-family URLs. Default `/am`; on-prem WARs
   * may deploy under a custom path (e.g. `/openam`). Derived from the
   * connection's base URL by `client-cache` (D41 Slice 3). */
  amPath?: string;
  /** Platform-resource families this backend exposes. Default: all enabled
   * (PAIC). On-prem passes all-disabled so Tier-B/C methods short-circuit. */
  capabilities?: ClientCapabilities;
}

/**
 * Build a PAIC API client bound to one tenant's `HttpClient`. The client owns
 * URL construction (realm-path), API versioning per endpoint family, and
 * raw → domain translation. Authentication, retries, error wrapping, and
 * logging are delegated to the injected `HttpClient`.
 */
export function makePaicClient(opts: PaicClientOptions): PaicClient {
  const log = opts.log.child({ component: "paic.client" });
  const { http } = opts;
  const amPath = opts.amPath ?? DEFAULT_AM_PATH;
  const caps = opts.capabilities ?? ALL_CAPABILITIES;

  const getRawScript = async (realm: string, id: string): Promise<RawScript> => {
    const realmPath = getRealmPath(realm);
    const resp = await http.get<RawScript>(
      `${amPath}/json${realmPath}/scripts/${encodeURIComponent(id)}`,
      { apiVersion: SCRIPT_API_VERSION },
    );
    return resp.data;
  };

  const getRawJourney = async (realm: string, id: string): Promise<RawJourney> => {
    const realmPath = getRealmPath(realm);
    const resp = await http.get<RawJourney>(
      `${amPath}/json${realmPath}/realm-config/authentication/authenticationtrees/trees/${encodeURIComponent(id)}`,
      { apiVersion: TREE_API_VERSION },
    );
    return resp.data;
  };

  const getRawNode = async (
    realm: string,
    nodeType: string,
    nodeId: string,
  ): Promise<RawNodePayload> => {
    const realmPath = getRealmPath(realm);
    const resp = await http.get<RawNodePayload>(
      `${amPath}/json${realmPath}/realm-config/authentication/authenticationtrees/nodes/${encodeURIComponent(nodeType)}/${encodeURIComponent(nodeId)}`,
      { apiVersion: TREE_API_VERSION },
    );
    // Drop AM's `<field>-encrypted` companions at the point payloads enter the
    // domain, so export, compare and the resolver all agree. See `encrypted.ts`.
    return stripEncrypted(resp.data);
  };

  const findRawScriptsByName = async (realm: string, name: string): Promise<RawScript[]> => {
    const realmPath = getRealmPath(realm);
    const params = new URLSearchParams({ _queryFilter: `name eq "${name}"` });
    const resp = await http.get<PagedResponse<RawScript>>(
      `${amPath}/json${realmPath}/scripts?${params.toString()}`,
      { apiVersion: SCRIPT_API_VERSION },
    );
    return resp.data.result;
  };

  const getRawScriptByName = async (realm: string, name: string): Promise<RawScript | null> =>
    (await findRawScriptsByName(realm, name))[0] ?? null;

  return {
    getRawScript,
    getRawJourney,
    getRawNode,
    getRawScriptByName,
    findRawScriptsByName,

    async listRealms(): Promise<Realm[]> {
      const all = await listAllPaged<RawRealm>(async (cookie) => {
        const params = new URLSearchParams({ _queryFilter: "true" });
        if (cookie) params.set("_pagedResultsCookie", cookie);
        const resp = await http.get<PagedResponse<RawRealm>>(
          `${amPath}/json/global-config/realms?${params.toString()}`,
          { apiVersion: REALM_API_VERSION },
        );
        return resp.data;
      });
      log.debug({ event: "client.listRealms.done", count: all.length }, "Listed realms");
      return all.map(mapRealm);
    },

    async listJourneys(realm: string): Promise<Journey[]> {
      const realmPath = getRealmPath(realm);
      const all = await listAllPaged<RawJourney>(async (cookie) => {
        const params = new URLSearchParams({ _queryFilter: "true" });
        if (cookie) params.set("_pagedResultsCookie", cookie);
        const resp = await http.get<PagedResponse<RawJourney>>(
          `${amPath}/json${realmPath}/realm-config/authentication/authenticationtrees/trees?${params.toString()}`,
          { apiVersion: TREE_API_VERSION },
        );
        return resp.data;
      });
      log.debug({ event: "client.listJourneys.done", realm, count: all.length }, "Listed journeys");
      return all.map(mapJourney);
    },

    async getJourney(realm: string, id: string): Promise<Journey> {
      return mapJourney(await getRawJourney(realm, id));
    },

    async getNode(realm: string, nodeType: string, nodeId: string): Promise<NodePayload> {
      return mapNodePayload(await getRawNode(realm, nodeType, nodeId));
    },

    async getScript(realm: string, id: string): Promise<Script> {
      return mapScript(await getRawScript(realm, id));
    },

    async getScriptByName(realm: string, name: string): Promise<Script | null> {
      const raw = await getRawScriptByName(realm, name);
      if (!raw) {
        log.debug(
          { event: "client.getScriptByName.miss", realm, script_name: name },
          "No script with that name in realm",
        );
        return null;
      }
      return mapScript(raw);
    },

    async listScripts(realm: string): Promise<Script[]> {
      const realmPath = getRealmPath(realm);
      const all = await listAllPaged<RawScript>(async (cookie) => {
        const params = new URLSearchParams({ _queryFilter: "true" });
        if (cookie) params.set("_pagedResultsCookie", cookie);
        const resp = await http.get<PagedResponse<RawScript>>(
          `${amPath}/json${realmPath}/scripts?${params.toString()}`,
          { apiVersion: SCRIPT_API_VERSION },
        );
        return resp.data;
      });
      log.debug({ event: "client.listScripts.done", realm, count: all.length }, "Listed scripts");
      return all.map(mapScript);
    },

    async getRawTheme(realm: string, themeId: string): Promise<RawTheme | null> {
      if (!caps.themes) return null; // no IDM on this backend (e.g. on-prem AM)
      // AIC stores all themes for all realms in one IDM config doc. The
      // top-level key is `realm` (singular) and the per-realm value is the
      // theme array directly — no `.themes` wrapper. Verified against sb3.
      const resp = await http.get<RawThemeRealmConfig>("/openidm/config/ui/themerealm");
      const found = (resp.data.realm?.[realm] ?? []).find((t) => t._id === themeId);
      if (!found) {
        log.debug({ event: "client.getTheme.miss", realm, theme_id: themeId }, "Theme not found");
        return null;
      }
      return found;
    },

    async getTheme(realm: string, themeId: string): Promise<Theme | null> {
      const raw = await this.getRawTheme(realm, themeId);
      return raw ? mapTheme(realm, raw) : null;
    },

    async listThemes(realm: string): Promise<Theme[]> {
      if (!caps.themes) return []; // no IDM on this backend (e.g. on-prem AM)
      // One fetch of the whole themerealm doc; the tree uses this to
      // pre-resolve multiple PageNode.themeIds in one round-trip during a
      // journey expansion.
      const resp = await http.get<RawThemeRealmConfig>("/openidm/config/ui/themerealm");
      const raws = resp.data.realm?.[realm] ?? [];
      return raws.map((raw) => mapTheme(realm, raw));
    },

    async getRawEmailTemplate(name: string): Promise<RawEmailTemplate | null> {
      if (!caps.emailTemplates) return null; // no IDM on this backend (e.g. on-prem AM)
      try {
        const resp = await http.get<RawEmailTemplate>(
          `/openidm/config/emailTemplate/${encodeURIComponent(name)}`,
        );
        return resp.data;
      } catch (err) {
        if (err instanceof PaicError && err.status === 404) return null;
        throw err;
      }
    },

    async getEmailTemplate(name: string): Promise<EmailTemplate | null> {
      const raw = await this.getRawEmailTemplate(name);
      return raw ? mapEmailTemplate(name, raw) : null;
    },

    async listEmailTemplates(): Promise<EmailTemplate[]> {
      if (!caps.emailTemplates) return []; // no IDM on this backend (e.g. on-prem AM)
      // No per-type list endpoint — enumerate all IDM config and keep the
      // `emailTemplate/<name>` entries (verified against sb3: 81 of ~338 config objects).
      const resp = await http.get<PagedResponse<RawEmailTemplate>>(
        "/openidm/config?_queryFilter=true",
      );
      const out: EmailTemplate[] = [];
      for (const raw of resp.data.result) {
        const id = typeof raw._id === "string" ? raw._id : "";
        if (!id.startsWith("emailTemplate/")) continue;
        out.push(mapEmailTemplate(id.slice("emailTemplate/".length), raw));
      }
      log.debug(
        { event: "client.listEmailTemplates.done", count: out.length },
        "Listed email templates",
      );
      return out;
    },

    async listSocialIdps(realm: string): Promise<SocialIdp[]> {
      const realmPath = getRealmPath(realm);
      const resp = await http.post<{ result?: RawSocialIdp[] }>(
        `${amPath}/json${realmPath}/realm-config/services/SocialIdentityProviders?_action=nextdescendents`,
        {},
        { apiVersion: SOCIAL_IDP_API_VERSION },
      );
      return (resp.data.result ?? []).map((r) => mapSocialIdp(realm, r));
    },

    async getSocialIdp(realm: string, name: string): Promise<SocialIdp | null> {
      const all = await this.listSocialIdps(realm);
      const found = all.find((i) => i.name === name);
      if (!found) {
        log.debug(
          { event: "client.getSocialIdp.miss", realm, idp_name: name },
          "Social IdP not found in realm",
        );
        return null;
      }
      return found;
    },

    async getRawSocialIdp(realm: string, name: string): Promise<RawSocialIdp | null> {
      const realmPath = getRealmPath(realm);
      const resp = await http.post<{ result?: RawSocialIdp[] }>(
        `${amPath}/json${realmPath}/realm-config/services/SocialIdentityProviders?_action=nextdescendents`,
        {},
        { apiVersion: SOCIAL_IDP_API_VERSION },
      );
      const found = (resp.data.result ?? []).find((r) => r._id === name) ?? null;
      // Same `<field>-encrypted` trap as nodes: PAIC returns `clientSecret-encrypted`
      // alongside the nulled `clientSecret`, and AM 500s on any write carrying it.
      return found === null ? null : stripEncrypted(found);
    },

    async listVariables(_realm: string): Promise<EsvVariable[]> {
      if (!caps.esvs) return []; // no IDC ESV API on this backend (e.g. on-prem AM)
      // ESV endpoints are tenant-scoped, not realm-scoped. _realm accepted for
      // API symmetry. Returned names are dotted (translated from hyphenated _id).
      const all = await listAllPaged<RawEsvVariable>(async (cookie) => {
        const params = new URLSearchParams({ _queryFilter: "true" });
        if (cookie) params.set("_pagedResultsCookie", cookie);
        const resp = await http.get<PagedResponse<RawEsvVariable>>(
          `/environment/variables?${params.toString()}`,
          { apiVersion: ESV_API_VERSION },
        );
        return resp.data;
      });
      return all.map((raw) => mapEsvVariable((raw._id ?? "").replaceAll("-", "."), raw));
    },

    async listSecrets(_realm: string): Promise<EsvSecret[]> {
      if (!caps.esvs) return []; // no IDC ESV API on this backend (e.g. on-prem AM)
      const all = await listAllPaged<RawEsvSecret>(async (cookie) => {
        const params = new URLSearchParams({ _queryFilter: "true" });
        if (cookie) params.set("_pagedResultsCookie", cookie);
        const resp = await http.get<PagedResponse<RawEsvSecret>>(
          `/environment/secrets?${params.toString()}`,
          { apiVersion: ESV_API_VERSION },
        );
        return resp.data;
      });
      return all.map((raw) => mapEsvSecret((raw._id ?? "").replaceAll("-", "."), raw));
    },

    async getEsv(name: string): Promise<Esv | null> {
      if (!caps.esvs) return null; // no IDC ESV API on this backend (e.g. on-prem AM)
      // PAIC ESV REST ids are hyphenated (`esv-foo-bar`) while scripts
      // reference them in dotted form (`esv.foo.bar`). Translate before the
      // URL; keep `name` (dotted) as the canonical display name.
      // POC-validated against sb3: `/variables/esv.kyid.portal.name` → 400;
      // `/variables/esv-kyid-portal-name` → 200.
      const apiId = name.replaceAll(".", "-");
      try {
        const resp = await http.get<RawEsvVariable>(
          `/environment/variables/${encodeURIComponent(apiId)}`,
          { apiVersion: ESV_API_VERSION },
        );
        return mapEsvVariable(name, resp.data);
      } catch (err) {
        if (!(err instanceof PaicError) || err.status !== 404) throw err;
      }
      try {
        const resp = await http.get<RawEsvSecret>(
          `/environment/secrets/${encodeURIComponent(apiId)}`,
          { apiVersion: ESV_API_VERSION },
        );
        return mapEsvSecret(name, resp.data);
      } catch (err) {
        if (err instanceof PaicError && err.status === 404) return null;
        throw err;
      }
    },

    async getRawEsv(name: string): Promise<RawEsvResult | null> {
      if (!caps.esvs) return null; // no IDC ESV API on this backend (e.g. on-prem AM)
      // Dotted display name → hyphenated REST id (see getEsv). Variable vs
      // secret is discovered by which endpoint resolves.
      const apiId = name.replaceAll(".", "-");
      try {
        const resp = await http.get<RawEsvVariable>(
          `/environment/variables/${encodeURIComponent(apiId)}`,
          { apiVersion: ESV_API_VERSION },
        );
        return { kind: "variable", raw: resp.data };
      } catch (err) {
        if (!(err instanceof PaicError) || err.status !== 404) throw err;
      }
      try {
        const resp = await http.get<RawEsvSecret>(
          `/environment/secrets/${encodeURIComponent(apiId)}`,
          { apiVersion: ESV_API_VERSION },
        );
        return { kind: "secret", raw: resp.data };
      } catch (err) {
        if (err instanceof PaicError && err.status === 404) return null;
        throw err;
      }
    },

    // ── Import writes (D43) ──────────────────────────────────────────────────

    async writeEmailTemplate(name: string, body: Record<string, unknown>): Promise<WriteOutcome> {
      if (!caps.emailTemplates) {
        throw new Error("This backend has no IDM; cannot write email templates.");
      }
      const resp = await http.put(
        `/openidm/config/emailTemplate/${encodeURIComponent(name)}`,
        body,
      );
      const outcome: WriteOutcome = resp.status === 201 ? "created" : "overwritten";
      log.info(
        { event: "client.writeEmailTemplate", name, status: resp.status },
        "Wrote email template",
      );
      return outcome;
    },

    async writeSocialIdp(
      realm: string,
      typeId: string,
      id: string,
      body: Record<string, unknown>,
    ): Promise<WriteOutcome> {
      const realmPath = getRealmPath(realm);
      const resp = await http.put(
        `${amPath}/json${realmPath}/realm-config/services/SocialIdentityProviders/${encodeURIComponent(typeId)}/${encodeURIComponent(id)}`,
        stripEncrypted(body), // bundles from disk never passed through getRawSocialIdp
        { apiVersion: SOCIAL_IDP_API_VERSION },
      );
      const outcome: WriteOutcome = resp.status === 201 ? "created" : "overwritten";
      log.info(
        { event: "client.writeSocialIdp", realm, type_id: typeId, idp_id: id, status: resp.status },
        "Wrote social IdP",
      );
      return outcome;
    },

    async writeTheme(realm: string, theme: Record<string, unknown>): Promise<WriteOutcome> {
      if (!caps.themes) throw new Error("This backend has no IDM; cannot write themes.");
      const themeId = typeof theme._id === "string" ? theme._id : undefined;

      // One read-modify-write of the whole `ui/themerealm` doc — there is no
      // per-theme endpoint. `If-Match: <_rev>` guards the shared doc; a 412
      // means the doc advanced under us → re-GET, re-splice, retry once.
      const attempt = async (): Promise<WriteOutcome> => {
        const resp = await http.get<RawThemeRealmConfig & { _id?: string; _rev?: string }>(
          "/openidm/config/ui/themerealm",
        );
        const doc = resp.data;
        const themes = [...(doc.realm?.[realm] ?? [])];
        const idx = themes.findIndex((t) => t._id === themeId);
        const outcome: WriteOutcome = idx >= 0 ? "overwritten" : "created";
        // Overwrite preserves the target's default-state for this theme; a new
        // theme is never made the realm default by an import.
        const element = (
          idx >= 0 ? { ...theme, isDefault: themes[idx].isDefault } : { ...theme, isDefault: false }
        ) as RawTheme;
        if (idx >= 0) themes[idx] = element;
        else themes.push(element);
        const realmMap = { ...(doc.realm ?? {}), [realm]: themes };
        const { _rev, ...rest } = doc as Record<string, unknown>;
        await http.put(
          "/openidm/config/ui/themerealm",
          { ...rest, realm: realmMap },
          _rev ? { headers: { "If-Match": String(_rev) } } : undefined,
        );
        log.info(
          { event: "client.writeTheme", realm, theme_id: themeId, outcome },
          "Wrote theme (themerealm splice)",
        );
        return outcome;
      };

      try {
        return await attempt();
      } catch (err) {
        if (err instanceof PaicError && err.status === 412) {
          log.warn(
            { event: "client.writeTheme.precondition", realm, theme_id: themeId },
            "themerealm changed under us — retrying the splice once",
          );
          return await attempt();
        }
        throw err;
      }
    },

    async writeEsvVariable(id: string, body: Record<string, unknown>): Promise<WriteOutcome> {
      if (!caps.esvs) throw new Error("This backend has no IDC ESV API; cannot write variables.");
      // Hyphenated REST id (dotted display names translate the same way reads do).
      const apiId = id.replaceAll(".", "-");
      const resp = await http.put(`/environment/variables/${encodeURIComponent(apiId)}`, body, {
        apiVersion: ESV_API_VERSION,
      });
      // ESV create + update both return 200 → always "created" (import is create-only).
      log.info(
        { event: "client.writeEsvVariable", id: apiId, status: resp.status },
        "Wrote ESV variable",
      );
      return "created";
    },

    async writeEsvSecret(id: string, body: Record<string, unknown>): Promise<WriteOutcome> {
      if (!caps.esvs) throw new Error("This backend has no IDC ESV API; cannot write secrets.");
      const apiId = id.replaceAll(".", "-");
      const resp = await http.put(`/environment/secrets/${encodeURIComponent(apiId)}`, body, {
        apiVersion: ESV_API_VERSION,
      });
      log.info(
        { event: "client.writeEsvSecret", id: apiId, status: resp.status },
        "Wrote ESV secret",
      );
      return "created";
    },

    async writeScript(
      realm: string,
      id: string,
      body: Record<string, unknown>,
    ): Promise<WriteOutcome> {
      const realmPath = getRealmPath(realm);
      // PUT to the bundle's UUID — preserves cross-env script identity so node
      // `script` refs stay valid. Never log the body (it's the user's source).
      const resp = await http.put(
        `${amPath}/json${realmPath}/scripts/${encodeURIComponent(id)}`,
        body,
        { apiVersion: SCRIPT_API_VERSION },
      );
      const outcome: WriteOutcome = resp.status === 201 ? "created" : "overwritten";
      log.info(
        { event: "client.writeScript", realm, script_id: id, status: resp.status },
        "Wrote script",
      );
      return outcome;
    },

    async writeNode(
      realm: string,
      nodeType: string,
      nodeId: string,
      body: Record<string, unknown>,
    ): Promise<WriteOutcome> {
      const realmPath = getRealmPath(realm);
      // Export shape written as-is (AM tolerates the `_type`/`_outcomes` echoes — TD-15),
      // EXCEPT `<field>-encrypted` companions: AM answers any payload carrying one with
      // `500 "Request contained encrypted data"`. Stripped here as well as on read, because
      // a bundle loaded from disk (pre-fix, or frodo/amster-authored) never passed through
      // `getRawNode`. See `encrypted.ts`.
      const resp = await http.put(
        `${amPath}/json${realmPath}/realm-config/authentication/authenticationtrees/nodes/${encodeURIComponent(nodeType)}/${encodeURIComponent(nodeId)}`,
        stripEncrypted(body),
        { apiVersion: TREE_API_VERSION },
      );
      const outcome: WriteOutcome = resp.status === 201 ? "created" : "overwritten";
      log.info(
        {
          event: "client.writeNode",
          realm,
          node_type: nodeType,
          node_id: nodeId,
          status: resp.status,
        },
        "Wrote node",
      );
      return outcome;
    },

    async writeTree(
      realm: string,
      treeId: string,
      body: Record<string, unknown>,
    ): Promise<WriteOutcome> {
      const realmPath = getRealmPath(realm);
      const resp = await http.put(
        `${amPath}/json${realmPath}/realm-config/authentication/authenticationtrees/trees/${encodeURIComponent(treeId)}`,
        body,
        { apiVersion: TREE_API_VERSION },
      );
      const outcome: WriteOutcome = resp.status === 201 ? "created" : "overwritten";
      log.info(
        { event: "client.writeTree", realm, tree_id: treeId, status: resp.status },
        "Wrote tree",
      );
      return outcome;
    },

    async listTrees(realm: string): Promise<RawJourney[]> {
      const realmPath = getRealmPath(realm);
      const resp = await http.get<PagedResponse<RawJourney>>(
        `${amPath}/json${realmPath}/realm-config/authentication/authenticationtrees/trees?_queryFilter=true`,
        { apiVersion: TREE_API_VERSION },
      );
      return resp.data.result;
    },

    async getNodeTypes(realm: string): Promise<string[]> {
      const realmPath = getRealmPath(realm);
      const resp = await http.post<{ result?: Array<{ _id?: string }> }>(
        `${amPath}/json${realmPath}/realm-config/authentication/authenticationtrees/nodes?_action=getAllTypes`,
        {},
        { apiVersion: TREE_API_VERSION },
      );
      return (resp.data.result ?? []).map((t) => t._id).filter((id): id is string => Boolean(id));
    },

    async getStartupStatus(): Promise<EsvRestartStatus> {
      if (!caps.esvs) throw new Error("This backend has no IDC ESV API; no restart status.");
      const resp = await http.get<{ restartStatus?: EsvRestartStatus }>("/environment/startup", {
        apiVersion: ESV_API_VERSION,
      });
      return resp.data.restartStatus === "restarting" ? "restarting" : "ready";
    },

    async applyEsvUpdates(): Promise<void> {
      if (!caps.esvs) throw new Error("This backend has no IDC ESV API; cannot apply updates.");
      await http.post("/environment/startup?_action=restart", null, {
        apiVersion: ESV_API_VERSION,
      });
      log.info({ event: "client.applyEsvUpdates" }, "Initiated ESV apply (environment restart)");
    },
  };
}
