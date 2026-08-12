import { beforeAll, describe, expect, it } from "vitest";
import { makeOnpremAuthStrategy } from "@/auth/onprem-strategy";
import { amContextPath, amOrigin } from "@/paic/am-url";
import { makePaicClient, type PaicClient } from "@/paic/client";
import { makeHttpClient } from "@/paic/http";

/**
 * Live integration test for the email-OTP journey on the on-prem bed.
 * Runs ONLY with `PAIC_LIVE=1` (per `.claude/rules/testing.md`).
 *
 * Requires the `poc/onprem-am/` bed up, seeded with
 * `provision/03-install-mailpit.sh` + `seed-email-otp.sh`. The OTP is read back
 * out of Mailpit — a fake SMTP sink that stores mail and never delivers it —
 * which is what makes an end-to-end OTP login assertable without a real mailbox.
 *
 * Coordinates default to the throwaway VM's synthetic lab values (a made-up
 * local FQDN, a lab-only identity) and are env-overridable.
 */
const HOST = process.env.ONPREM_AM_HOST ?? "http://openam.bipoc.net:8080";
const ADMIN_USER = process.env.ONPREM_AM_USER ?? "amadmin";
const ADMIN_PASSWORD = process.env.ONPREM_AM_PASSWORD ?? "password";
const MAILPIT = process.env.ONPREM_MAILPIT_URL ?? "http://openam.bipoc.net:8025";
const OTP_USER = process.env.ONPREM_OTP_USER ?? "otpuser";
const OTP_PASSWORD = process.env.ONPREM_OTP_PASSWORD ?? "Xk7qMv2RtZ9L";
const OTP_MAIL = process.env.ONPREM_OTP_MAIL ?? "otpuser@bipoc.test";

const REALM = "alpha";
const TREE = "OnPremEmailOtp";

/** AM's runtime authenticate protocol. Not the config API the PaicClient wraps. */
interface AuthCallbackInput {
  name: string;
  value: string;
}
interface AuthCallback {
  type: string;
  input: AuthCallbackInput[];
}
interface AuthStep {
  authId?: string;
  callbacks?: AuthCallback[];
  tokenId?: string;
  realm?: string;
}

/** Mailpit wire shape — PascalCase fields are theirs, mirrored verbatim. */
interface MailpitSummary {
  ID: string;
}
interface MailpitList {
  total: number;
  messages: MailpitSummary[];
}
interface MailpitAddress {
  Address: string;
}
interface MailpitMessage {
  Subject: string;
  To: MailpitAddress[];
  Text?: string;
  HTML?: string;
}

const AUTH_URL =
  `${HOST}/am/json/realms/root/realms/${REALM}/authenticate` +
  `?authIndexType=service&authIndexValue=${TREE}`;
const AUTH_HEADERS = {
  "Content-Type": "application/json",
  "Accept-API-Version": "resource=2.0, protocol=1.0",
};

async function authStep(body?: AuthStep): Promise<AuthStep> {
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as AuthStep;
}

/** Set the first callback of `type` to `value`; returns false if absent. */
function fillCallback(step: AuthStep, type: string, value: string): boolean {
  const cb = step.callbacks?.find((c) => c.type === type);
  if (!cb?.input?.[0]) return false;
  cb.input[0].value = value;
  return true;
}

async function clearInbox(): Promise<void> {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
}

/** Poll the sink until a message lands, then return it. */
async function waitForMail(timeoutMs = 20_000): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = (await (await fetch(`${MAILPIT}/api/v1/messages`)).json()) as MailpitList;
    const first = list.messages?.[0];
    if (first) {
      return (await (
        await fetch(`${MAILPIT}/api/v1/message/${first.ID}`)
      ).json()) as MailpitMessage;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no mail arrived in the sink within ${timeoutMs}ms`);
}

function extractOtp(mail: MailpitMessage): string {
  const body = mail.Text ?? mail.HTML ?? "";
  const match = body.match(/\b(\d{6})\b/);
  if (!match) throw new Error(`no 6-digit OTP in mail body: ${body.slice(0, 200)}`);
  return match[1];
}

/** Advance the journey to the OTP prompt, returning that step. */
async function reachOtpPrompt(): Promise<AuthStep> {
  const start = await authStep();
  expect(fillCallback(start, "NameCallback", OTP_USER)).toBe(true);
  expect(fillCallback(start, "PasswordCallback", OTP_PASSWORD)).toBe(true);
  const prompt = await authStep(start);
  expect(prompt.tokenId, "journey authenticated without an OTP step").toBeUndefined();
  return prompt;
}

function buildOnpremClient(): PaicClient {
  const noop = () => undefined;
  const log = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => log,
    // biome-ignore lint/suspicious/noExplicitAny: pino Logger has many fields we don't exercise
  } as any;
  const amPath = amContextPath(HOST);
  const authStrategy = makeOnpremAuthStrategy({
    host: HOST,
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
    amPath,
    log,
  });
  const http = makeHttpClient({ host: amOrigin(HOST), log, authStrategy });
  return makePaicClient({
    http,
    log,
    amPath,
    capabilities: { themes: false, emailTemplates: false, esvs: false },
  });
}

describe.skipIf(!process.env.PAIC_LIVE)("on-prem email OTP (poc/onprem-am bed)", () => {
  let client: PaicClient;

  beforeAll(() => {
    client = buildOnpremClient();
  });

  it("lists the seeded OTP journey in the alpha realm", async () => {
    const ids = (await client.listJourneys(REALM)).map((j) => j.id);
    expect(ids).toContain(TREE);
  });

  it("resolves the OTP node types the extension has to render", async () => {
    const journey = await client.getJourney(REALM, TREE);
    const nodeTypes = Object.values(journey.nodes).map((n) => n.nodeType);
    expect(nodeTypes).toContain("PageNode");
    expect(nodeTypes).toContain("DataStoreDecisionNode");
    expect(nodeTypes).toContain("OneTimePasswordGeneratorNode");
    expect(nodeTypes).toContain("OneTimePasswordSmtpSenderNode");
    expect(nodeTypes).toContain("OneTimePasswordCollectorDecisionNode");
    expect(nodeTypes).toContain("RetryLimitDecisionNode");
  });

  it("emails a 6-digit OTP to the user's mail attribute", async () => {
    await clearInbox();
    await reachOtpPrompt();

    const mail = await waitForMail();
    expect(mail.To.map((t) => t.Address)).toContain(OTP_MAIL);
    expect(mail.Subject).toBe("Your verification code");
    expect(extractOtp(mail)).toMatch(/^\d{6}$/);
  });

  it("completes login with the emailed OTP", async () => {
    await clearInbox();
    const prompt = await reachOtpPrompt();

    const otp = extractOtp(await waitForMail());
    expect(fillCallback(prompt, "PasswordCallback", otp)).toBe(true);
    const done = await authStep(prompt);

    expect(
      done.tokenId,
      `expected a session, got ${JSON.stringify(done).slice(0, 200)}`,
    ).toBeTruthy();
    expect(done.realm).toBe(`/${REALM}`);
  });

  it("rejects a wrong OTP instead of issuing a session", async () => {
    await clearInbox();
    const prompt = await reachOtpPrompt();

    const otp = extractOtp(await waitForMail());
    const wrong = otp === "000000" ? "111111" : "000000";
    expect(fillCallback(prompt, "PasswordCallback", wrong)).toBe(true);
    const after = await authStep(prompt);

    // RetryLimitDecisionNode sends us back to the collector rather than failing outright.
    expect(after.tokenId).toBeUndefined();
    expect(after.callbacks?.length ?? 0).toBeGreaterThan(0);
  });
});
