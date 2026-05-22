/**
 * D40 — session-scoped connection verification status.
 *
 * Records whether a connection's last Test Connection (token mint) in THIS
 * Extension Host session passed or failed. Held in memory only — never
 * persisted to settings, never synced — so it can never go stale: a fresh
 * window starts every connection untested. The connection config holds
 * identity (`host`, `saId`, `name`); "did the last test pass" is runtime
 * state and lives here instead.
 *
 * `ConnectionNode` reads this to tint its icon (green / red / none).
 */

export type ConnectionVerifyStatus = "ok" | "fail";

export interface ConnectionStatusStore {
  /** Record a passing Test Connection for `host`. */
  markOk(host: string): void;
  /** Record a failing Test Connection for `host`. */
  markFail(host: string): void;
  /** The session status for `host`, or `undefined` if untested this session. */
  get(host: string): ConnectionVerifyStatus | undefined;
  /** Forget `host` — e.g. on connection delete or host rename. */
  clear(host: string): void;
}

/** Create an empty in-memory connection-status store. */
export function makeConnectionStatusStore(): ConnectionStatusStore {
  const status = new Map<string, ConnectionVerifyStatus>();
  return {
    markOk: (host) => {
      status.set(host, "ok");
    },
    markFail: (host) => {
      status.set(host, "fail");
    },
    get: (host) => status.get(host),
    clear: (host) => {
      status.delete(host);
    },
  };
}
