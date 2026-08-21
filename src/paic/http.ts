import { randomUUID } from "node:crypto";
import axios, {
  AxiosHeaders,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import axiosRetry from "axios-retry";
import type { AuthStrategy } from "../auth/strategy";
import type { Logger } from "../util/logger";
import { PaicError } from "./errors";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 4;
/**
 * Backoff base for `exponentialDelay` (ms). axios-retry defaults to 100, which
 * puts all attempts inside ~1.5 s — fine for a momentary blip, useless when the
 * link is genuinely degraded (every attempt lands in the same congestion
 * window). At 500 the ladder is ~1s / 2s / 4s / 8s, which straddles one. See
 * D46 / PD-19 (gap PG3).
 */
const RETRY_DELAY_FACTOR_MS = 500;
const USER_AGENT = "paic-journeys-vscode";

export interface PaicRequestConfig extends AxiosRequestConfig {
  /** Value for the `Accept-API-Version` header (e.g. `"protocol=2.1,resource=1.0"`). */
  apiVersion?: string;
}

export interface HttpClient {
  get<T>(url: string, config?: PaicRequestConfig): Promise<AxiosResponse<T>>;
  /** Hatch for AIC's `_action=` POSTs. */
  post<T>(url: string, data?: unknown, config?: PaicRequestConfig): Promise<AxiosResponse<T>>;
  /** Import writes (D43). Idempotent (same-id PUT); callers may pass an
   * `If-Match` header via `config.headers` (preserved by the interceptor). */
  put<T>(url: string, data?: unknown, config?: PaicRequestConfig): Promise<AxiosResponse<T>>;
}

export interface HttpClientOptions {
  host: string;
  log: Logger;
  /** Produces the auth header(s) for each request (Bearer for PAIC, Cookie for
   * on-prem AM). The transport merges them verbatim and never interprets the
   * scheme. `forceRefresh` is the 401 self-heal signal. */
  authStrategy: AuthStrategy;
  /** Per-request timeout (ms). Default 30_000. */
  timeoutMs?: number;
  /** Retry count for network errors / 5xx / 429. Default 4. */
  retries?: number;
  /** Exponential-backoff base in ms. Default `RETRY_DELAY_FACTOR_MS` (500).
   * Injectable so tests can exercise the retry ladder without real waits. */
  retryDelayFactorMs?: number;
  /** Injected axios instance — for tests only. */
  axiosInstance?: AxiosInstance;
}

// Per-request annotations stashed on the InternalAxiosRequestConfig for the
// response interceptor to read.
interface RequestState {
  paicReqId?: string;
  paicStart?: number;
  paicRetried401?: boolean;
  /** Set by the 401 handler so the retried pass calls the auth strategy with
   * `forceRefresh`. The transport never holds the credential itself. */
  paicForceAuthRefresh?: boolean;
}

type AnnotatedConfig = InternalAxiosRequestConfig & RequestState;

/**
 * Build an HTTP client bound to one PAIC tenant. Every outgoing request gets:
 *   - `Authorization: Bearer <token>` minted via the injected `getToken` callback
 *   - `X-ForgeRock-TransactionId: <uuid>` — per-request, for tenant-side log correlation
 *   - `Accept-API-Version` when the caller specified one
 *
 * Retries network errors, 5xx, and 429 (honoring `Retry-After`). On 401, the
 * client re-mints the token once and retries the same request.
 *
 * Every request emits structured logs (`http.request`, `http.error`,
 * `http.retry`, `http.unauthorized`) via the injected logger.
 */
export function makeHttpClient(opts: HttpClientOptions): HttpClient {
  const log = opts.log.child({ component: "paic.http" });
  const instance =
    opts.axiosInstance ??
    axios.create({
      baseURL: opts.host.startsWith("http") ? opts.host : `https://${opts.host}`,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: { "User-Agent": USER_AGENT },
    });

  axiosRetry(instance, {
    retries: opts.retries ?? DEFAULT_RETRIES,
    retryCondition: (err) =>
      axiosRetry.isNetworkOrIdempotentRequestError(err) || err.response?.status === 429,
    retryDelay: (count, err) => {
      const retryAfter = err.response?.headers?.["retry-after"];
      if (retryAfter !== undefined) {
        const sec = Number.parseInt(String(retryAfter), 10);
        // Add a 100 ms safety margin so we comfortably clear the server's window.
        if (Number.isFinite(sec)) return sec * 1000 + 100;
      }
      return axiosRetry.exponentialDelay(
        count,
        err,
        opts.retryDelayFactorMs ?? RETRY_DELAY_FACTOR_MS,
      );
    },
    onRetry: (count, err, req) => {
      log.warn(
        {
          event: "http.retry",
          attempt: count,
          status: err.response?.status,
          url: req.url,
        },
        "Retrying PAIC request",
      );
    },
  });

  instance.interceptors.request.use(async (cfg: InternalAxiosRequestConfig) => {
    const config = cfg as AnnotatedConfig;
    // On the 401-retry pass the response interceptor set paicForceAuthRefresh so
    // the strategy discards its cached credential and produces a fresh one.
    const authHeaders = await opts.authStrategy.getAuthHeaders(
      config.paicForceAuthRefresh ? { forceRefresh: true } : undefined,
    );
    const reqId = randomUUID();

    const headers =
      config.headers instanceof AxiosHeaders ? config.headers : new AxiosHeaders(config.headers);
    for (const [name, value] of Object.entries(authHeaders)) headers.set(name, value);
    headers.set("X-ForgeRock-TransactionId", reqId);
    headers.set("Accept", "application/json");

    const apiVersion = (config as PaicRequestConfig).apiVersion;
    if (apiVersion) headers.set("Accept-API-Version", apiVersion);
    config.headers = headers;

    config.paicReqId = reqId;
    config.paicStart = Date.now();
    return config;
  });

  instance.interceptors.response.use(
    (resp) => {
      const cfg = resp.config as AnnotatedConfig;
      log.info(
        {
          event: "http.request",
          method: cfg.method?.toUpperCase(),
          url: cfg.url,
          status: resp.status,
          duration_ms: cfg.paicStart === undefined ? undefined : Date.now() - cfg.paicStart,
          req_id: cfg.paicReqId,
        },
        "PAIC request completed",
      );
      return resp;
    },
    async (error: unknown) => {
      // axios attaches the config to AxiosError; fall back to undefined if absent.
      const errCfg = (error as { config?: AnnotatedConfig })?.config;
      const status = (error as { response?: { status?: number } })?.response?.status;

      // 401 → refresh the credential once and retry the same request. Flag the
      // config and re-dispatch; the request interceptor performs the forced
      // refresh, keeping a single "produce auth headers" code path.
      if (status === 401 && errCfg && !errCfg.paicRetried401) {
        errCfg.paicRetried401 = true;
        errCfg.paicForceAuthRefresh = true;
        log.warn(
          { event: "http.unauthorized", url: errCfg.url, req_id: errCfg.paicReqId },
          "Auth rejected — refreshing credential and retrying once",
        );
        // Await here (not bare return) so a failure on the retried request flows
        // back through this handler's error path rather than escaping unwrapped.
        return await instance.request(errCfg);
      }

      log.error(
        {
          event: "http.error",
          method: errCfg?.method?.toUpperCase(),
          url: errCfg?.url,
          status,
          req_id: errCfg?.paicReqId,
          duration_ms: errCfg?.paicStart === undefined ? undefined : Date.now() - errCfg.paicStart,
        },
        "PAIC request failed",
      );
      throw PaicError.from(error);
    },
  );

  return {
    get: <T>(url: string, config?: PaicRequestConfig) => instance.get<T>(url, config),
    post: <T>(url: string, data?: unknown, config?: PaicRequestConfig) =>
      instance.post<T>(url, data, config),
    put: <T>(url: string, data?: unknown, config?: PaicRequestConfig) =>
      instance.put<T>(url, data, config),
  };
}
