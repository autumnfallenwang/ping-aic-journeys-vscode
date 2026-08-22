import { describe, expect, it } from "vitest";
import { makeOnpremAuthStrategy } from "@/auth/onprem-strategy";
import type { Connection } from "@/domain/types";
import { buildRealmBundle } from "@/export/realm-bundle";
import { discoverScriptDeps, innerTreeRefs } from "@/import/discover";
import { planJourneyUnits } from "@/import/journey-plan";
import { limitClient } from "@/import/limited-client";
import { parseBundle } from "@/import/parse";
import {
  checkJourneyGates,
  computeIdenticalJourneys,
  discoverDeps,
  readJourneyCompareInputs,
  runPreflight,
} from "@/import/preflight";
import { amContextPath, amOrigin } from "@/paic/am-url";
import { makePaicClient, type PaicClient } from "@/paic/client";
import { makeHttpClient } from "@/paic/http";

/**
 * Realm-level export → import round trip against the `poc/onprem-am/` bed (D46).
 * Runs ONLY with `PAIC_LIVE=1` (per `.claude/rules/testing.md`); the bed must be up
 * AND seeded, with the `alpha` sub-realm present.
 *
 * This is the end-to-end proof the unit tests can't give: that a realm bundle built
 * from a live AM parses, pre-flights, and produces a sane plan against a DIFFERENT
 * realm — including the subject/inner split derived purely from tree content, and
 * the gate that must NOT fire when every inner journey is bundled.
 *
 * Read-only: it exports and plans, and never writes to the tenant.
 */
const HOST = process.env.ONPREM_AM_HOST ?? "http://openam.bipoc.net:8080";
const USER = process.env.ONPREM_AM_USER ?? "amadmin";
const PASSWORD = process.env.ONPREM_AM_PASSWORD ?? "password";
/** The realm to export (has its own journeys + inner-journey references). */
const SOURCE_REALM = "alpha";
/** The realm to plan against — deliberately a different one. */
const TARGET_REALM = "";

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
    capabilities: { themes: false, emailTemplates: false, esvs: false },
  });
}

const CONN: Connection = { kind: "onprem", host: HOST, username: USER };

describe.skipIf(!process.env.PAIC_LIVE)("realm export → import (poc/onprem-am bed)", () => {
  it("exports every journey in a realm and plans it against another realm", async () => {
    const log = noopLogger();
    const client = buildOnpremClient();

    // ─── Export ──────────────────────────────────────────────────────────────
    const progress: Array<[number, number, string]> = [];
    const bundle = await buildRealmBundle(
      client,
      CONN,
      SOURCE_REALM,
      "0.0.0-test",
      "2026-01-01T00:00:00.000Z",
      log,
      (done, total, id) => progress.push([done, total, id]),
    );
    expect(bundle).not.toBeNull();
    if (!bundle) return;

    const treeIds = Object.keys(bundle.trees);
    expect(treeIds.length).toBeGreaterThan(1);
    expect(bundle.meta.scope).toBe("realm");
    expect(bundle.meta.depthMode).toBe("allLevels");
    expect(bundle.meta.connectionType).toBe("am-onprem");
    // One progress tick per listed tree, in listing order.
    expect(progress).toHaveLength(progress[0]?.[1] ?? 0);
    expect(progress.at(-1)?.[0]).toBe(progress.at(-1)?.[1]);

    // Leaves stay DUPLICATED per tree (frodo/PAIC-UI interop) even though the
    // fetch is deduped — the invariant `realm-bundle.test.ts` pins with a fake.
    const entries = treeIds.flatMap((id) => Object.keys(bundle.trees[id].scripts));
    expect(entries.length).toBeGreaterThanOrEqual(new Set(entries).size);

    // ─── Import plan against a different realm ───────────────────────────────
    const parsed = parseBundle(JSON.stringify(bundle));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const raws = parsed.rawComponents;
    expect(parsed.bundle.kind).toBe("journey");

    // ONE wrapped client across every phase, so the cap is total in-flight rather
    // than per-call — the same wiring `panel.ts` uses.
    const readClient = limitClient(client);
    const verdicts = await runPreflight(readClient, TARGET_REALM, "onprem", raws);
    const [advisory, gates] = await Promise.all([
      discoverDeps(readClient, TARGET_REALM, discoverScriptDeps(raws)),
      checkJourneyGates(readClient, TARGET_REALM, raws),
    ]);
    const cache = await readJourneyCompareInputs(readClient, TARGET_REALM, raws, verdicts);
    const identical = computeIdenticalJourneys(cache);
    const verdictOf = (id: string, status: string): "new" | "exists" | "identical" => {
      if (status === "new") return "new";
      return identical.has(id) ? "identical" : "exists";
    };
    const verdictById = new Map(
      verdicts.filter((v) => v.kind === "journey").map((v) => [v.id, verdictOf(v.id, v.status)]),
    );
    const plans = planJourneyUnits(raws, verdictById);

    // Every bundled tree gets a plan row, split into subjects + inners purely from
    // `InnerTreeEvaluatorNode.tree` refs (PD-18 — never from `meta`).
    expect(plans).toHaveLength(treeIds.length);
    expect(plans.some((p) => p.role === "subject")).toBe(true);
    expect(plans.some((p) => p.role === "inner")).toBe(true);

    // THE key D46 property: a realm bundle contains every inner it references, so
    // the "inner journey missing on target" gate must NOT fire — a single-journey
    // file with the same refs WOULD be hard-blocked here.
    const blocking = [...advisory, ...gates].filter(
      (d) => d.severity === "blocking" && d.status === "missing",
    );
    expect(blocking.filter((d) => d.kind === "innerJourney")).toEqual([]);

    // Inner-before-outer write order is derivable for every bundled unit.
    for (const p of plans) {
      const unit = raws.find((c) => c.kind === "journey" && c.id === p.id);
      if (!unit) continue;
      for (const ref of innerTreeRefs(unit.raw)) {
        // Every referenced inner is itself bundled (that's what makes the gate pass).
        expect(treeIds).toContain(ref);
      }
    }
  }, 180_000);

  it("exports the root realm through the empty-string realm argument", async () => {
    // `getRealmPath()` resolves `/realms/root` from "" whatever the wire name is —
    // the path both the RealmCard button and the context menu funnel into.
    const bundle = await buildRealmBundle(
      buildOnpremClient(),
      CONN,
      "",
      "0.0.0-test",
      "2026-01-01T00:00:00.000Z",
      noopLogger(),
    );
    expect(bundle).not.toBeNull();
    expect(Object.keys(bundle?.trees ?? {}).length).toBeGreaterThan(0);
  }, 120_000);
});
