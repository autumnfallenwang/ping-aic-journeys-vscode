import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeOnpremAuthStrategy } from "@/auth/onprem-strategy";
import { amContextPath, amOrigin } from "@/paic/am-url";
import { makePaicClient, type PaicClient } from "@/paic/client";
import { makeHttpClient } from "@/paic/http";

/**
 * Permanent live integration test for the on-prem PingAM path (M8 Slice 5).
 * Runs ONLY with `PAIC_LIVE=1` (per `.claude/rules/testing.md`) against the
 * `poc/onprem-am/` bed, which must be up AND seeded
 * (`vagrant up` → `configure-am.sh` → `seed-sample-journeys.sh`). Without
 * `PAIC_LIVE` the suite self-skips, so default `npm test` / CI never need the bed.
 *
 * Coordinates default to the throwaway VM's synthetic lab values (a made-up
 * local FQDN + AM's stock `amadmin`/`password` — not real credentials) and are
 * env-overridable.
 */
const HOST = process.env.ONPREM_AM_HOST ?? "http://openam.bipoc.net:8080";
const USER = process.env.ONPREM_AM_USER ?? "amadmin";
const PASSWORD = process.env.ONPREM_AM_PASSWORD ?? "password";

function noopLogger() {
  const noop = () => undefined;
  const self = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => self,
    // biome-ignore lint/suspicious/noExplicitAny: pino Logger has many fields we don't exercise
  } as any;
  return self;
}

/** Assemble an on-prem client exactly as `client-cache.build()` does. */
function buildOnpremClient(): PaicClient {
  const log = noopLogger();
  const amPath = amContextPath(HOST);
  const authStrategy = makeOnpremAuthStrategy({
    host: HOST,
    username: USER,
    password: PASSWORD,
    amPath,
    log,
  });
  const http = makeHttpClient({ host: amOrigin(HOST), log, authStrategy });
  return makePaicClient({
    http,
    log,
    amPath,
    // On-prem has no IDM (themes/email) or IDC ESV API.
    capabilities: { themes: false, emailTemplates: false, esvs: false },
  });
}

describe.skipIf(!process.env.PAIC_LIVE)("on-prem AM live (poc/onprem-am bed)", () => {
  let client: PaicClient;

  beforeAll(() => {
    client = buildOnpremClient();
  });

  it("lists realms including the root realm", async () => {
    const realms = await client.listRealms();
    expect(realms.some((r) => r.isRoot)).toBe(true);
  });

  it("lists the seeded root-realm journeys", async () => {
    const ids = (await client.listJourneys("")).map((j) => j.id);
    expect(ids).toContain("OnPremLogin");
    expect(ids).toContain("OnPremMfaInner");
  });

  it("resolves the OnPremLogin node types", async () => {
    const journey = await client.getJourney("", "OnPremLogin");
    const nodeTypes = Object.values(journey.nodes).map((n) => n.nodeType);
    expect(nodeTypes).toContain("PageNode");
    expect(nodeTypes).toContain("SelectIdPNode");
    expect(nodeTypes).toContain("InnerTreeEvaluatorNode");
    expect(nodeTypes).toContain("ScriptedDecisionNode");
  });

  it("walks node → script: OnPremLogin's ScriptedDecisionNode → onprem-demo-decision", async () => {
    const journey = await client.getJourney("", "OnPremLogin");
    const entry = Object.entries(journey.nodes).find(
      ([, ref]) => ref.nodeType === "ScriptedDecisionNode",
    );
    expect(entry).toBeTruthy();
    const [nodeId, ref] = entry as [string, { nodeType: string }];

    const payload = await client.getNode("", ref.nodeType, nodeId);
    expect(payload.nodeType).toBe("ScriptedDecisionNode");
    const scriptId = payload.nodeType === "ScriptedDecisionNode" ? payload.scriptId : undefined;
    expect(scriptId).toBeTruthy();

    const script = await client.getScript("", scriptId as string);
    expect(script.name).toBe("onprem-demo-decision");
  });

  it("finds the LIBRARY helper script by name", async () => {
    const lib = await client.getScriptByName("", "onprem-helpers");
    expect(lib).not.toBeNull();
    expect(lib?.context).toBe("LIBRARY");
  });

  it("lists the seeded social IdP", async () => {
    const idps = await client.listSocialIdps("");
    expect(idps.map((i) => i.name)).toContain("onprem-google");
  });

  it("short-circuits Tier-B/C resources (no IDM/IDC on-prem — no HTTP)", async () => {
    expect(await client.listThemes("")).toEqual([]);
    expect(await client.getEsv("esv.demo.flag")).toBeNull();
    expect(await client.getEmailTemplate("welcome")).toBeNull();
  });
});

/**
 * Live regression for AM's `<field>-encrypted` companions (see `paic/encrypted.ts`).
 *
 * A journey exported from PAIC carries `password-encrypted` on any OTP-email /
 * social-IdP node. Writing that payload back makes AM answer
 * `500 "Request contained encrypted data"` — it matches on the KEY, so the
 * failure reproduces on this on-prem bed even though on-prem never EMITS one.
 * Verified by hand before the fix; this asserts `writeNode` strips it so the
 * import succeeds. Mocks cannot cover this — the 500 comes from AM itself.
 */
describe.skipIf(!process.env.PAIC_LIVE)("on-prem `-encrypted` write regression", () => {
  const REALM = "alpha";
  const NODE_TYPE = "OneTimePasswordSmtpSenderNode";
  const SCRATCH_ID = "ffffffff-0000-4000-8000-00000000dead";

  async function adminToken(): Promise<string> {
    const res = await fetch(`${HOST}/am/json/realms/root/authenticate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept-API-Version": "resource=2.0, protocol=1.0",
        "X-OpenAM-Username": USER,
        "X-OpenAM-Password": PASSWORD,
      },
    });
    return ((await res.json()) as { tokenId: string }).tokenId;
  }

  /** The client has no delete; clean up the scratch node over raw REST. */
  async function deleteScratchNode(): Promise<void> {
    const token = await adminToken();
    await fetch(
      `${HOST}/am/json/realms/root/realms/${REALM}/realm-config/authentication` +
        `/authenticationtrees/nodes/${NODE_TYPE}/${SCRATCH_ID}`,
      {
        method: "DELETE",
        headers: {
          "Accept-API-Version": "protocol=2.1,resource=1.0",
          iPlanetDirectoryPro: token,
        },
      },
    );
  }

  afterAll(deleteScratchNode);

  it("imports a node whose payload carries `password-encrypted` (was a 500)", async () => {
    const client = buildOnpremClient();
    const outcome = await client.writeNode(REALM, NODE_TYPE, SCRATCH_ID, {
      _id: SCRATCH_ID,
      hostName: "localhost",
      hostPort: 1025,
      sslOption: "NON_SSL",
      fromEmailAddress: "a@b.test",
      emailAttribute: "mail",
      password: null,
      "password-encrypted": "AQICAHjcm9mCT1V0kQnZmR8xW0pQ3mF9pJq2sYtLxNvKbGdHtw==",
    });
    expect(outcome).toBe("created");
  });

  it("the stored node carries no companion, and the rest of the config persisted", async () => {
    const client = buildOnpremClient();
    const raw = (await client.getRawNode(REALM, NODE_TYPE, SCRATCH_ID)) as Record<string, unknown>;
    expect(raw).not.toHaveProperty("password-encrypted");
    // NB: we deliberately do NOT assert on `password` here. AM echoes it as
    // `null` when the field was never written, but OMITS it entirely when
    // written as an explicit null — an AM quirk, not our behavior. That
    // `stripEncrypted` preserves a `password: null` it is handed is asserted in
    // `src/paic/encrypted.test.ts`, where we actually control the input.
    expect(raw.hostName).toBe("localhost");
    expect(raw.sslOption).toBe("NON_SSL");
    expect(raw.fromEmailAddress).toBe("a@b.test");
  });
});
