/**
 * `paicJourneys.exportRealmJourneys` — export EVERY journey in a realm to a
 * frodo/PAIC-UI-compatible `{ meta, trees }` file (D46 / M9 Phase 5). Read-only.
 *
 * Deliberately has no depth prompt (unlike `exportJourney`): at realm scope the
 * inner-journey closure is inherent, so there is nothing to choose. The only
 * interaction is the save dialog; the sweep runs under a determinate progress
 * notification (export has no page of its own — D46's progress rule).
 */

import * as vscode from "vscode";
import { buildRealmBundle } from "../export/realm-bundle";
import type { ClientCache } from "../tenants/client-cache";
import type { TenantsRegistry } from "../tenants/registry";
import type { Logger } from "../util/logger";

export interface ExportRealmJourneysDeps {
  clientCache: ClientCache;
  registry: TenantsRegistry;
  log: Logger;
  extensionVersion: string;
}

interface ExportRealmJourneysArgs {
  host: string;
  /** The realm argument for REST calls — `""` for the root realm so
   * `getRealmPath()` resolves `/realms/root` regardless of its wire name. */
  realm: string;
  /** Display label used for the filename (`"root"` for the root realm). */
  realmLabel: string;
}

/**
 * Accepts BOTH entry points:
 *  - the inspector card → `{ host, realm: string, realmLabel }` (already resolved);
 *  - the sidebar context menu → a `RealmNode`, whose `realm` is the `Realm` OBJECT.
 *
 * The root realm is the trap: REST calls must pass `""` so `getRealmPath()` resolves
 * `/realms/root` regardless of the realm's wire name ("/" / "root" / "Top Level
 * Realm") — the same rule `RealmNode.loadChildren` applies. The display label is
 * "root". Getting this wrong silently exports the wrong realm.
 */
function parseArg(arg: unknown): ExportRealmJourneysArgs | null {
  if (!arg || typeof arg !== "object") return null;
  const a = arg as Record<string, unknown>;
  if (typeof a.host !== "string") return null;

  if (typeof a.realm === "string") {
    return {
      host: a.host,
      realm: a.realm,
      realmLabel:
        typeof a.realmLabel === "string" && a.realmLabel ? a.realmLabel : a.realm || "root",
    };
  }
  // Tree-node shape: a `Realm` domain object.
  if (a.realm && typeof a.realm === "object") {
    const r = a.realm as Record<string, unknown>;
    if (typeof r.name !== "string") return null;
    const isRoot = r.isRoot === true;
    return {
      host: a.host,
      realm: isRoot ? "" : r.name,
      realmLabel: isRoot ? "root" : r.name,
    };
  }
  return null;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/** frodo's `titleCase` (`ref/frodo-lib/src/utils/ExportImportUtils.ts:263`):
 * lower-case the whole token, then upper-case the first letter of each
 * space-separated word. */
function titleCase(input: string): string {
  return input
    .toLowerCase()
    .split(" ")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * `all<Realm>Journeys.journey.json` — frodo's whole-realm convention, reproduced
 * exactly (`getRealmString()` + `getTypedFilename(…, "journey")`): split the realm
 * on `/`, title-case each segment, concatenate. Deliberately plain, matching the
 * single-journey export's `<JourneyName>.journey.json` — provenance (origin host,
 * export date) lives in `meta`, not in the name, so there's nothing to duplicate.
 *
 * Takes the REST realm ARGUMENT, not the display label, which reproduces frodo's
 * behaviour for free in every case:
 *   "alpha"           → allAlphaJourneys.journey.json
 *   "alpha/customers" → allAlphaCustomersJourneys.journey.json
 *   ""      (root)    → allJourneys.journey.json   ← the realm string collapses
 */
function defaultFilename(realm: string): string {
  const realmString = realm.split("/").map(titleCase).join("");
  return `${sanitizeFilename(`all${realmString}Journeys`)}.journey.json`;
}

export async function exportRealmJourneys(
  deps: ExportRealmJourneysDeps,
  arg: unknown,
): Promise<void> {
  const { clientCache, registry, log, extensionVersion } = deps;
  const parsed = parseArg(arg);
  if (!parsed) {
    log.warn(
      { event: "exportRealmJourneys.badArg" },
      "exportRealmJourneys invoked with missing/invalid args",
    );
    return;
  }

  const conn = registry.list().find((c) => c.host === parsed.host);
  if (!conn) {
    log.warn(
      { event: "exportRealmJourneys.noConnection", host: parsed.host },
      "No connection registered for host",
    );
    vscode.window.showErrorMessage(`No connection found for ${parsed.host}.`);
    return;
  }

  const filename = defaultFilename(parsed.realm);
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
  const defaultUri = folder ? vscode.Uri.joinPath(folder, filename) : vscode.Uri.file(filename);
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { JSON: ["json"] },
    saveLabel: "Export",
  });
  if (!target) {
    log.debug(
      { event: "exportRealmJourneys.cancelled", host: parsed.host, realm: parsed.realm },
      "Realm export cancelled by user",
    );
    return;
  }

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Exporting all journeys in "${parsed.realmLabel}"…`,
      },
      async (progress) => {
        const client = await clientCache.get(parsed.host);
        let lastPct = 0;
        const bundle = await buildRealmBundle(
          client,
          conn,
          parsed.realm,
          extensionVersion,
          new Date().toISOString(),
          log,
          (done, total, treeId) => {
            // Determinate: `increment` is a delta, so send the change since the
            // last report rather than the running percentage.
            const pct = Math.round((done / total) * 100);
            progress.report({ message: `${done}/${total} — ${treeId}`, increment: pct - lastPct });
            lastPct = pct;
          },
        );
        if (!bundle) {
          log.warn(
            { event: "exportRealmJourneys.empty", host: parsed.host, realm: parsed.realm },
            "No journeys found in realm; nothing exported",
          );
          vscode.window.showErrorMessage(
            `No journeys found in the realm "${parsed.realmLabel}" — nothing to export.`,
          );
          return;
        }
        const json = JSON.stringify(bundle, null, 2);
        await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(json));
        const treeCount = Object.keys(bundle.trees).length;
        log.info(
          {
            event: "exportRealmJourneys",
            host: parsed.host,
            realm: parsed.realm,
            trees: treeCount,
          },
          "Exported all realm journeys to file",
        );
        vscode.window.showInformationMessage(`Exported ${filename} (${treeCount} journey(s)).`);
      },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      {
        event: "exportRealmJourneys.failed",
        host: parsed.host,
        realm: parsed.realm,
        message,
      },
      "Failed to export realm journeys",
    );
    vscode.window.showErrorMessage(`Couldn't export the realm's journeys. ${message}`);
  }
}
