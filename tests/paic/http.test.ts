import axios, { type InternalAxiosRequestConfig } from "axios";
import MockAdapter from "axios-mock-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthStrategy } from "@/auth/strategy";
import { PaicError } from "@/paic/errors";
import { type HttpClientOptions, makeHttpClient } from "@/paic/http";

interface LogCall {
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  fields: Record<string, unknown>;
  msg: string;
}

interface FakeLogger {
  calls: LogCall[];
  trace(fields: Record<string, unknown>, msg: string): void;
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
  fatal(fields: Record<string, unknown>, msg: string): void;
  child(_b: Record<string, unknown>): FakeLogger;
}

function makeFakeLogger(): FakeLogger {
  const calls: LogCall[] = [];
  const make = (level: LogCall["level"]) => (fields: Record<string, unknown>, msg: string) => {
    calls.push({ level, fields, msg });
  };
  const self: FakeLogger = {
    calls,
    trace: make("trace"),
    debug: make("debug"),
    info: make("info"),
    warn: make("warn"),
    error: make("error"),
    fatal: make("fatal"),
    child: () => self,
  };
  return self;
}

/** A fake AuthStrategy that yields successive Bearer tokens and records each
 * call's `forceRefresh` flag — the transport-side analogue of the old
 * getToken stub. */
function makeFakeAuthStrategy(tokens: string[] = ["tok-1", "tok-2"]): {
  strategy: AuthStrategy;
  calls: Array<{ forceRefresh: boolean }>;
} {
  const calls: Array<{ forceRefresh: boolean }> = [];
  let idx = 0;
  const strategy: AuthStrategy = {
    getAuthHeaders: (opts) => {
      calls.push({ forceRefresh: !!opts?.forceRefresh });
      return Promise.resolve({
        Authorization: `Bearer ${tokens[Math.min(idx++, tokens.length - 1)]}`,
      });
    },
  };
  return { strategy, calls };
}

let logger: FakeLogger;
let mock: MockAdapter;
let instance: ReturnType<typeof axios.create>;

beforeEach(() => {
  logger = makeFakeLogger();
  instance = axios.create();
  mock = new MockAdapter(instance);
});

afterEach(() => {
  mock.reset();
  vi.useRealTimers();
});

describe("makeHttpClient", () => {
  it("injects Authorization, X-ForgeRock-TransactionId, Accept-API-Version on every request", async () => {
    mock.onGet("/x").reply(200, { ok: true });
    const { strategy: authStrategy } = makeFakeAuthStrategy(["my-token"]);
    const client = makeHttpClient({
      host: "openam.example.com",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
    });

    await client.get("/x", { apiVersion: "protocol=2.1,resource=1.0" });

    const headers = mock.history.get[0].headers ?? {};
    expect(headers.Authorization).toBe("Bearer my-token");
    expect(headers["X-ForgeRock-TransactionId"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(headers["Accept-API-Version"]).toBe("protocol=2.1,resource=1.0");
    expect(headers.Accept).toBe("application/json");
  });

  it("generates a fresh transaction ID per request", async () => {
    mock.onGet("/x").reply(200, {});
    const { strategy: authStrategy } = makeFakeAuthStrategy();
    const client = makeHttpClient({
      host: "h",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
    });

    await client.get("/x");
    await client.get("/x");

    const id1 = mock.history.get[0].headers?.["X-ForgeRock-TransactionId"];
    const id2 = mock.history.get[1].headers?.["X-ForgeRock-TransactionId"];
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });

  it("retries on 502 and eventually succeeds", async () => {
    mock
      .onGet("/x")
      .replyOnce(502)
      .onGet("/x")
      .replyOnce(502)
      .onGet("/x")
      .replyOnce(200, { ok: true });
    const { strategy: authStrategy } = makeFakeAuthStrategy();
    const client = makeHttpClient({
      host: "h",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
      retryDelayFactorMs: 1, // ladder timing is asserted separately; keep this fast
    });

    const resp = await client.get<{ ok: boolean }>("/x");

    expect(resp.status).toBe(200);
    expect(resp.data.ok).toBe(true);
    expect(mock.history.get).toHaveLength(3);
    // Two retry warnings were logged.
    const retryLogs = logger.calls.filter((c) => c.fields.event === "http.retry");
    expect(retryLogs).toHaveLength(2);
  });

  /**
   * PD-19 / gap PG3. `read ECONNRESET` — a reset while streaming the response
   * body — is the failure that made import pre-flight rows go red on a degraded
   * link. It has no `response`, so it retries only if axios-retry classifies it
   * as a NETWORK error; `ECONNRESET` must stay off `is-retry-allowed`'s denylist
   * for that to hold. This pins the behaviour we depend on.
   */
  it("retries a network-level ECONNRESET and eventually succeeds", async () => {
    mock
      .onGet("/x")
      // A faithful transport-level reset: no `response`, `code` set, and a
      // `config` — axios-retry rejects outright without config, so a bare
      // Error here would pass the test for the wrong reason.
      .replyOnce((config) =>
        Promise.reject(
          new axios.AxiosError(
            "read ECONNRESET",
            "ECONNRESET",
            config as InternalAxiosRequestConfig,
          ),
        ),
      )
      .onGet("/x")
      .replyOnce(200, { ok: true });
    const { strategy: authStrategy } = makeFakeAuthStrategy();
    const client = makeHttpClient({
      host: "h",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
      retryDelayFactorMs: 1,
    });

    const resp = await client.get<{ ok: boolean }>("/x");

    expect(resp.status).toBe(200);
    expect(mock.history.get).toHaveLength(2);
    expect(logger.calls.filter((c) => c.fields.event === "http.retry")).toHaveLength(1);
  });

  /** PD-19: the default is 4 retries (5 attempts), raised from 3. A bad link
   * needs more than one ladder rung, not fewer. */
  it("makes 5 attempts by default before giving up", async () => {
    mock.onGet("/x").reply(503);
    const { strategy: authStrategy } = makeFakeAuthStrategy();
    const client = makeHttpClient({
      host: "h",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
      retryDelayFactorMs: 1,
    });

    await expect(client.get("/x")).rejects.toBeInstanceOf(PaicError);
    expect(mock.history.get).toHaveLength(5);
  });

  /**
   * PD-19 / gap PG3 — the point of the change. axios-retry's default 100 ms
   * factor puts every attempt inside ~1.5 s, so all of them land in the same
   * congestion window. At 500 the first retry alone waits ~1 s. Asserted with
   * real time (the ladder IS the behaviour under test); one rung only, so the
   * test costs ~1 s.
   */
  it("waits ~1s before the first retry with the shipped default factor", async () => {
    mock.onGet("/x").replyOnce(502).onGet("/x").replyOnce(200, {});
    const { strategy: authStrategy } = makeFakeAuthStrategy();
    const client = makeHttpClient({
      host: "h",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
      // No retryDelayFactorMs — exercise the shipped default.
    });

    const started = Date.now();
    await client.get("/x");
    const elapsed = Date.now() - started;

    // 2^1 * 500 = 1000 ms, plus axios-retry's 0–20% jitter.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(2000);
  }, 10_000);

  it("retries on 429 honoring Retry-After header", async () => {
    mock.onGet("/x").replyOnce(429, "", { "retry-after": "1" }).onGet("/x").replyOnce(200, {});
    const { strategy: authStrategy } = makeFakeAuthStrategy();
    const client = makeHttpClient({
      host: "h",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
    });

    const start = Date.now();
    await client.get("/x");
    const elapsed = Date.now() - start;

    expect(mock.history.get).toHaveLength(2);
    // Retry-After: 1 → wait at least ~1000 ms (we add 100 ms safety, so ≥1000).
    expect(elapsed).toBeGreaterThanOrEqual(1000);
  });

  it("refreshes the credential and retries once on 401", async () => {
    mock.onGet("/x").replyOnce(401).onGet("/x").replyOnce(200, { ok: true });
    const { strategy: authStrategy, calls: authCalls } = makeFakeAuthStrategy(["stale", "fresh"]);
    const client = makeHttpClient({
      host: "h",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
    });

    const resp = await client.get("/x");

    expect(resp.status).toBe(200);
    expect(mock.history.get).toHaveLength(2);
    expect(authCalls).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
    // Second request used the refreshed token.
    expect(mock.history.get[1].headers?.Authorization).toBe("Bearer fresh");
    // We logged the unauthorized event.
    expect(
      logger.calls.some((c) => c.level === "warn" && c.fields.event === "http.unauthorized"),
    ).toBe(true);
  });

  it("throws PaicError on second 401 (no infinite loop)", async () => {
    mock.onGet("/x").reply(401);
    const { strategy: authStrategy, calls: authCalls } = makeFakeAuthStrategy();
    const client = makeHttpClient({
      host: "h",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
    });

    await expect(client.get("/x")).rejects.toBeInstanceOf(PaicError);
    // First request + one retry after force-refresh = 2 attempts total.
    expect(mock.history.get).toHaveLength(2);
    expect(authCalls).toHaveLength(2);
    expect(authCalls[1].forceRefresh).toBe(true);
  });

  it("wraps non-401 4xx errors in PaicError without retry", async () => {
    mock.onGet("/x").reply(404, { error: "not_found", error_description: "Tree X not found" });
    const { strategy: authStrategy } = makeFakeAuthStrategy();
    const client = makeHttpClient({
      host: "h",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
    });

    let caught: unknown;
    try {
      await client.get("/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PaicError);
    const err = caught as PaicError;
    expect(err.status).toBe(404);
    expect(err.errorText).toBe("not_found");
    expect(err.description).toBe("Tree X not found");
    expect(mock.history.get).toHaveLength(1);
  });

  it("logs http.request on success at info level with duration and req_id", async () => {
    mock.onGet("/x").reply(200, {});
    const { strategy: authStrategy } = makeFakeAuthStrategy();
    const client = makeHttpClient({
      host: "h",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
    });

    await client.get("/x");

    const successLogs = logger.calls.filter(
      (c) => c.level === "info" && c.fields.event === "http.request",
    );
    expect(successLogs).toHaveLength(1);
    expect(successLogs[0].fields.status).toBe(200);
    expect(typeof successLogs[0].fields.duration_ms).toBe("number");
    expect(typeof successLogs[0].fields.req_id).toBe("string");
  });

  it("logs http.error on terminal failure with status", async () => {
    // Use retries=0 so a single 500 surfaces immediately.
    mock.onGet("/x").reply(500, { boom: true });
    const { strategy: authStrategy } = makeFakeAuthStrategy();
    const client = makeHttpClient({
      host: "h",
      log: logger as unknown as HttpClientOptions["log"],
      authStrategy,
      axiosInstance: instance,
      retries: 0,
    });

    await expect(client.get("/x")).rejects.toBeInstanceOf(PaicError);
    const errorLogs = logger.calls.filter(
      (c) => c.level === "error" && c.fields.event === "http.error",
    );
    expect(errorLogs).toHaveLength(1);
    expect(errorLogs[0].fields.status).toBe(500);
  });
});
