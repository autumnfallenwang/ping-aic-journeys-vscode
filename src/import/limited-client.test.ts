import { describe, expect, it } from "vitest";
import { limitClient, PREFLIGHT_CONCURRENCY } from "@/import/limited-client";
import type { PreflightClient } from "@/import/preflight";
import { makeLimiter } from "@/paic/concurrency";

/**
 * Records peak concurrency. Calls block until `releaseAll()`; once released,
 * calls that the limiter dequeues LATER resolve immediately — otherwise the
 * queued tail would create fresh gates nobody ever opens and the test would
 * hang instead of measuring anything.
 */
function trackingClient() {
  let active = 0;
  let peak = 0;
  let released = false;
  const gates: Array<(v: unknown) => void> = [];
  const call = async () => {
    active += 1;
    peak = Math.max(peak, active);
    if (!released) {
      await new Promise((resolve) => gates.push(resolve));
    }
    active -= 1;
    return null;
  };
  const client = new Proxy({} as PreflightClient, { get: () => call });
  return {
    client,
    peak: () => peak,
    inFlight: () => active,
    releaseAll: () => {
      released = true;
      for (const open of gates.splice(0)) open(null);
    },
  };
}

describe("limitClient", () => {
  it("caps total in-flight calls at the limiter's size", async () => {
    const t = trackingClient();
    const limited = limitClient(t.client, makeLimiter(3));

    const calls = Array.from({ length: 10 }, () => limited.getRawScript("alpha", "id"));
    // Let the limiter drain its queue up to the cap.
    await Promise.resolve();
    await Promise.resolve();

    expect(t.inFlight()).toBe(3);
    t.releaseAll();
    await Promise.all(calls);
    expect(t.peak()).toBe(3);
  });

  it("caps ACROSS different methods — one shared budget, not one per method", async () => {
    const t = trackingClient();
    const limited = limitClient(t.client, makeLimiter(2));

    const calls = [
      limited.getRawScript("alpha", "a"),
      limited.getRawJourney("alpha", "b"),
      limited.getRawNode("alpha", "T", "c"),
      limited.listTrees("alpha"),
    ];
    await Promise.resolve();
    await Promise.resolve();

    expect(t.inFlight()).toBe(2);
    t.releaseAll();
    await Promise.all(calls);
    expect(t.peak()).toBe(2);
  });

  /**
   * The regression that motivated wrapping the CLIENT rather than the phase
   * functions (D46). If a slot were held by the outer task while it awaits its
   * own inner fan-out, this deadlocks the moment every slot is an outer task.
   * Because only leaf calls take a slot, the inner calls can always proceed.
   */
  it("does not deadlock when a caller fans out again inside an outer call", async () => {
    const limited = limitClient(
      {
        getRawJourney: async () => ({ _id: "j" }),
        getRawNode: async () => ({ _id: "n" }),
      } as unknown as PreflightClient,
      makeLimiter(2),
    );

    // 4 outer tasks (> the cap of 2), each fanning out 3 inner reads.
    const outer = Array.from({ length: 4 }, async (_, i) => {
      await limited.getRawJourney("alpha", `j${i}`);
      return Promise.all(
        Array.from({ length: 3 }, (__, n) => limited.getRawNode("alpha", "T", `n${n}`)),
      );
    });

    const settled = await Promise.race([
      Promise.all(outer).then(() => "done"),
      new Promise((r) => setTimeout(() => r("deadlock"), 1000)),
    ]);
    expect(settled).toBe("done");
  });

  it("propagates rejections and frees the slot", async () => {
    const boom = new Error("read ECONNRESET");
    const limited = limitClient(
      {
        getRawScript: () => Promise.reject(boom),
        listTrees: async () => [],
      } as unknown as PreflightClient,
      makeLimiter(1),
    );

    await expect(limited.getRawScript("alpha", "x")).rejects.toThrow("read ECONNRESET");
    // The slot must be free — a leaked slot would hang this forever.
    await expect(limited.listTrees("alpha")).resolves.toEqual([]);
  });

  it("defaults to PREFLIGHT_CONCURRENCY when no limiter is passed", async () => {
    const t = trackingClient();
    const limited = limitClient(t.client);
    const calls = Array.from({ length: PREFLIGHT_CONCURRENCY + 5 }, () =>
      limited.getRawScript("alpha", "id"),
    );
    await Promise.resolve();
    await Promise.resolve();

    expect(t.inFlight()).toBe(PREFLIGHT_CONCURRENCY);
    t.releaseAll();
    await Promise.all(calls);
  });

  it("forwards arguments verbatim", async () => {
    const seen: unknown[][] = [];
    const limited = limitClient({
      getRawNode: (...args: unknown[]) => {
        seen.push(args);
        return Promise.resolve(null);
      },
    } as unknown as PreflightClient);

    await limited.getRawNode("alpha", "PageNode", "node-1");
    expect(seen).toEqual([["alpha", "PageNode", "node-1"]]);
  });
});
