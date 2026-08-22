import type { Level } from "pino";
import * as vscode from "vscode";
import { exportComponent } from "./commands/export-component";
import { exportJourney } from "./commands/export-journey";
import { exportRealmJourneys } from "./commands/export-realm-journeys";
import { type EntityKind, entityKeyOf } from "./domain/realm-index";
import type { Connection } from "./domain/types";
import { BUNDLE_URI_SCHEME, PaicBundleContentProvider } from "./providers/bundle-content-provider";
import {
  EMAIL_TEMPLATE_URI_SCHEME,
  makeEmailTemplateUri,
  PaicEmailTemplateFileSystemProvider,
} from "./providers/email-template-fs-provider";
import {
  makeScriptUri,
  PaicScriptFileSystemProvider,
  SCRIPT_URI_SCHEME,
} from "./providers/script-fs-provider";
import { makeRealmIndexCache, type RealmIndexCache } from "./realm-index/cache";
import { makeResolverCache, type ResolverCache } from "./resolver/cache";
import { type ClientCache, makeClientCache } from "./tenants/client-cache";
import { makeConnectionStatusStore } from "./tenants/connection-status";
import { makeProductionDeps, makeTenantsRegistry, type TenantsRegistry } from "./tenants/registry";
import { confirm } from "./util/dialogs";
import { type Logger, makeLogger } from "./util/logger";
import { MessageNode, type PaicNode } from "./views/nodes/base";
import { CategoryHeaderNode } from "./views/nodes/category-header";
import { ConnectionNode } from "./views/nodes/connection";
import { LibraryScriptNode } from "./views/nodes/library-script";
import { RealmNode } from "./views/nodes/realm";
import { ScriptNode } from "./views/nodes/script";
import { PaicTreeProvider } from "./views/paic-tree-provider";
import {
  type ConnectionFormData,
  type ConnectionFormInitial,
  openConnectionForm,
} from "./webview/connection-form/panel";
import { InspectorFactory } from "./webview/inspector/panel";
import { SearchFactory } from "./webview/search/panel";
import { TransferFactory } from "./webview/transfer/panel";

const LOG_LEVEL_SETTING = "paicJourneys.logging.level";
const LOG_FILE_ENABLED_SETTING = "paicJourneys.logging.fileEnabled";

let log: Logger;
let registry: TenantsRegistry;
let clientCache: ClientCache;
let resolverCache: ResolverCache;
let realmIndexCache: RealmIndexCache;

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("PAIC Journeys", { log: true });
  context.subscriptions.push(channel);

  // All paicJourneys.* settings are user-only (declared "scope": "application"
  // in package.json). Read globalValue explicitly so that any stale or
  // hand-edited workspace entry is deliberately ignored, matching the
  // behavior VS Code itself enforces for application-scoped settings.
  const cfg = vscode.workspace.getConfiguration();
  const level = cfg.inspect<Level>(LOG_LEVEL_SETTING)?.globalValue ?? "info";
  const fileEnabled = cfg.inspect<boolean>(LOG_FILE_ENABLED_SETTING)?.globalValue ?? true;
  const extensionVersion = (context.extension.packageJSON as { version: string }).version;
  log = makeLogger({
    storageUri: context.globalStorageUri,
    version: extensionVersion,
    level,
    fileEnabled,
    channel,
  });
  log.info({ event: "extension.activated" }, "Extension activated");

  registry = makeTenantsRegistry(makeProductionDeps(context), log);
  context.subscriptions.push(registry);

  clientCache = makeClientCache({ registry, log });
  context.subscriptions.push({ dispose: () => clientCache.dispose() });

  // D35 — per-root forward-dep cache. Isolated from clientCache and the
  // lazy tree per D21. Per-host invalidation is wired from this file
  // (the one site that imports both registry and resolver).
  resolverCache = makeResolverCache({ log });
  context.subscriptions.push({ dispose: () => resolverCache.dispose() });

  // D36 — per-realm reverse-dep index cache. Same D21 isolation pattern —
  // does not subscribe to sidebar refresh (rebuilding the index is a
  // 10-second-class operation and should be user-explicit).
  realmIndexCache = makeRealmIndexCache({ log });
  context.subscriptions.push({ dispose: () => realmIndexCache.dispose() });

  // D40 — session-scoped Test Connection results, in memory only. Tints
  // each connection's tree icon green/red; cleared on window reload.
  const connectionStatus = makeConnectionStatusStore();

  const provider = new PaicTreeProvider(() =>
    registry
      .list()
      .map((c) => new ConnectionNode(c, clientCache, log, undefined, connectionStatus.get(c.host))),
  );
  const treeView = vscode.window.createTreeView<PaicNode>("paicJourneys.connections", {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView);

  // D40 — record a Test Connection outcome and refresh the tree so the
  // connection's icon re-tints. Shared by the Add + Edit form callsites.
  const onTestResult = (host: string, ok: boolean): void => {
    if (ok) connectionStatus.markOk(host);
    else connectionStatus.markFail(host);
    provider.reload();
  };

  // Per D24, every "show a card" gesture (tree click, card hyperlink click,
  // diagram node click) spawns a fresh inspector tab via the factory — no
  // reuse, no in-place updates.
  const inspectorFactory = new InspectorFactory({
    context,
    cache: clientCache,
    resolverCache,
    log,
  });
  context.subscriptions.push(inspectorFactory);

  // D36 — singleton Search webview. The page picks its (host, realm) via
  // in-page dropdowns; result-row clicks delegate to
  // `inspectorFactory.spawnByDescriptor` so the descriptor → PaicNode
  // mapping stays a single source of truth (per the 2026-05-19 lesson).
  const searchFactory = new SearchFactory({
    context,
    cache: clientCache,
    realmIndexCache,
    inspectorFactory,
    listConnections: () =>
      registry.list().map((c) => ({ host: c.host, name: c.name, kind: c.kind })),
    log,
  });
  context.subscriptions.push(searchFactory);

  // Serves uploaded-bundle component source as the RIGHT side of the import
  // Diff (TD-11); the transfer panel `.set()`s content keyed by bundle key.
  const bundleContent = new PaicBundleContentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(BUNDLE_URI_SCHEME, bundleContent),
  );

  const transferFactory = new TransferFactory({
    context,
    listConnections: () =>
      registry.list().map((c) => ({ host: c.host, name: c.name, kind: c.kind })),
    cache: clientCache,
    connectionKindOf: (host) => registry.list().find((c) => c.host === host)?.kind,
    searchFactory,
    bundleContent,
    log,
  });
  context.subscriptions.push(transferFactory);

  // Register the FileSystemProvider that surfaces script bodies as
  // `paic-script://<host>/<realm>/<scriptId>.<ext>` editor tabs (D17).
  const scriptFs = new PaicScriptFileSystemProvider(clientCache, log);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(SCRIPT_URI_SCHEME, scriptFs, {
      isReadonly: true,
      isCaseSensitive: true,
    }),
  );

  // Same pattern for email-template bodies — `paic-email-template://<host>/<name>/<locale>.html`.
  const emailTemplateFs = new PaicEmailTemplateFileSystemProvider(clientCache, log);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(EMAIL_TEMPLATE_URI_SCHEME, emailTemplateFs, {
      isReadonly: true,
      isCaseSensitive: true,
    }),
  );

  context.subscriptions.push(
    treeView.onDidChangeSelection((ev) => {
      const node = ev.selection[0];
      if (!node) return;
      // Category headers and message rows aren't data nodes — clicking them
      // shouldn't spawn an inspector tab (D33).
      if (node instanceof CategoryHeaderNode) return;
      if (node instanceof MessageNode) return;
      inspectorFactory.spawn(node);
    }),
  );

  // Cached clients for hosts that disappeared or whose JWK might have changed
  // must be evicted; simplest correct behavior is to drop everything visible
  // at the time of mutation and let the next expand re-mint.
  let priorHosts = registry.list().map((c) => c.host);
  context.subscriptions.push(
    registry.onDidChange(() => {
      for (const h of priorHosts) {
        clientCache.drop(h);
        resolverCache.dropAllForHost(h);
        realmIndexCache.dropAllForHost(h);
        // D40 — a connection edited/removed: its credentials may have
        // changed, so a prior Test Connection result no longer applies.
        connectionStatus.clear(h);
      }
      priorHosts = registry.list().map((c) => c.host);
      inspectorFactory.clearRegistry();
      searchFactory.clearRegistry();
      provider.reload();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("paicJourneys.refresh", () => {
      log.info({ event: "tree.refresh" }, "Refreshing tree");
      for (const h of priorHosts) {
        clientCache.drop(h);
        resolverCache.dropAllForHost(h);
        // Sidebar refresh deliberately does NOT clear realmIndexCache
        // (per D36). The realm index is invalidated only by `Rescan`
        // inside the Search page or registry mutations.
      }
      inspectorFactory.clearRegistry();
      provider.reload();
    }),

    vscode.commands.registerCommand("paicJourneys.openEmailTemplateBody", async (arg: unknown) => {
      const parsed = parseOpenEmailTemplateArg(arg);
      if (!parsed) {
        log.warn(
          { event: "openEmailTemplateBody.badArg" },
          "openEmailTemplateBody invoked without host / name / locale",
        );
        return;
      }
      const uri = makeEmailTemplateUri(parsed.host, parsed.name, parsed.locale);
      log.info(
        {
          event: "openEmailTemplateBody",
          host: parsed.host,
          template_name: parsed.name,
          locale: parsed.locale,
        },
        "Opening email-template body in editor",
      );
      await vscode.commands.executeCommand("vscode.open", uri, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
    }),

    vscode.commands.registerCommand("paicJourneys.openScriptBody", async (arg: unknown) => {
      const parsed = parseOpenScriptArg(arg);
      if (!parsed) {
        log.warn(
          { event: "openScriptBody.badArg" },
          "openScriptBody invoked without host / realm / scriptId",
        );
        return;
      }
      const uri = makeScriptUri(parsed.host, parsed.realm, parsed.scriptId, parsed.language);
      log.info(
        {
          event: "openScriptBody",
          host: parsed.host,
          realm: parsed.realm,
          script_id: parsed.scriptId,
        },
        "Opening script body in editor",
      );
      await vscode.commands.executeCommand("vscode.open", uri, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside,
      });
    }),

    vscode.commands.registerCommand("paicJourneys.exportComponent", (arg: unknown) =>
      exportComponent({ clientCache, registry, log, extensionVersion }, arg),
    ),

    vscode.commands.registerCommand("paicJourneys.exportRealmJourneys", (arg: unknown) =>
      exportRealmJourneys({ clientCache, registry, log, extensionVersion }, arg),
    ),
    vscode.commands.registerCommand("paicJourneys.exportJourney", (arg: unknown) =>
      exportJourney({ clientCache, registry, log, extensionVersion }, arg),
    ),

    vscode.commands.registerCommand("paicJourneys.refreshNode", (node: PaicNode) => {
      if (!node || typeof node.refresh !== "function") return;
      log.debug({ event: "tree.refreshNode", uid: node.uid }, "Refreshing tree node");
      if ("host" in node && typeof (node as { host?: unknown }).host === "string") {
        resolverCache.dropAllForHost((node as { host: string }).host);
      }
      node.refresh();
      provider.reload(node);
    }),

    vscode.commands.registerCommand("paicJourneys.openSearch", (arg?: unknown) => {
      // The Search page opens immediately — connection + realm are picked
      // via in-page dropdowns. Tree-context invocations pre-select what
      // they know: a RealmNode fills both dropdowns, a ConnectionNode
      // fills only the connection dropdown.
      let source = "command";
      const opts: { selectedHost?: string; selectedRealm?: string } = {};
      if (arg instanceof RealmNode) {
        opts.selectedHost = arg.host;
        opts.selectedRealm = arg.realm.name;
        source = "realm-context";
      } else if (arg instanceof ConnectionNode) {
        opts.selectedHost = arg.connection.host;
        source = "connection-context";
      }
      log.info({ event: "search.openSearch", source }, "Opening Search panel");
      searchFactory.spawn(opts);
    }),

    vscode.commands.registerCommand("paicJourneys.openTransfer", () => {
      log.info({ event: "transfer.openTransfer" }, "Opening Transfer panel");
      transferFactory.spawn();
    }),

    vscode.commands.registerCommand("paicJourneys.findUsages", (arg: unknown) => {
      const parsed = parseFindUsagesArg(arg);
      if (!parsed) {
        log.warn(
          { event: "search.findUsages.badArg" },
          "findUsages invoked without a valid descriptor",
        );
        return;
      }
      const targetKey = entityKeyOf(parsed.kind, parsed.id);
      log.info(
        {
          event: "search.findUsages",
          host: parsed.host,
          realm: parsed.realm,
          kind: parsed.kind,
          id: parsed.id,
        },
        "Opening Search panel for findUsages prefill",
      );
      searchFactory.spawn({
        selectedHost: parsed.host,
        selectedRealm: parsed.realm,
        prefill: {
          mode: "findUsages",
          targetKind: parsed.kind,
          targetKey,
        },
      });
    }),

    vscode.commands.registerCommand("paicJourneys.addConnection", async () => {
      log.info({ event: "connection.add.start" }, "Opening Add Connection form");
      const r = await openConnectionForm(context, {
        mode: "add",
        existingHosts: registry.list().map((c) => c.host),
        log,
        getExistingSecret: (h: string) => registry.getJwk(h),
        onTestResult,
      });
      if (!r) {
        log.debug({ event: "connection.add.cancelled" }, "Add Connection cancelled");
        return;
      }
      const { conn, secret } = connectionFromFormData(r);
      if (!secret) {
        log.warn(
          { event: "connection.add.invalid", kind: conn.kind },
          "Secret missing on save — form should have blocked",
        );
        vscode.window.showErrorMessage(
          conn.kind === "onprem"
            ? "An admin password is required when adding an on-prem connection."
            : "A JWK is required when adding a PAIC connection.",
        );
        return;
      }
      await registry.add(conn, secret);
      log.info({ event: "connection.add", host: conn.host, kind: conn.kind }, "Connection added");
    }),

    vscode.commands.registerCommand("paicJourneys.editConnection", async (item: ConnectionNode) => {
      const conn = item.connection;
      log.info(
        { event: "connection.edit.start", host: conn.host, kind: conn.kind },
        "Opening Edit Connection form",
      );
      const initial: ConnectionFormInitial =
        conn.kind === "onprem"
          ? { kind: "onprem", host: conn.host, username: conn.username, name: conn.name }
          : { kind: "paic", host: conn.host, saId: conn.saId, name: conn.name };
      const r = await openConnectionForm(context, {
        mode: "edit",
        initial,
        existingHosts: registry.list().map((c) => c.host),
        log,
        getExistingSecret: (h: string) => registry.getJwk(h),
        onTestResult,
      });
      if (!r) {
        log.debug({ event: "connection.edit.cancelled" }, "Edit Connection cancelled");
        return;
      }
      const { conn: updated, secret } = connectionFromFormData(r);
      await registry.update(conn.host, updated, secret);
      log.info(
        { event: "connection.edit", host: updated.host, kind: updated.kind },
        "Connection updated",
      );
    }),

    vscode.commands.registerCommand(
      "paicJourneys.removeConnection",
      async (item: ConnectionNode) => {
        const conn = item.connection;
        log.info(
          { event: "connection.remove.confirm", host: conn.host },
          "Confirming connection removal",
        );
        const ok = await confirm(
          `Remove connection "${conn.name || conn.host}"?`,
          "This deletes its stored credentials from this machine. You can re-add it later.",
          "Remove",
        );
        if (!ok) {
          log.debug({ event: "connection.remove.cancelled" }, "Remove Connection cancelled");
          return;
        }
        await registry.remove(conn.host);
        log.info({ event: "connection.remove", host: conn.host }, "Connection removed");
      },
    ),
  );
}

export function deactivate(): void {
  // nothing to clean up — disposables are managed via context.subscriptions
}

interface OpenScriptArgs {
  host: string;
  realm: string;
  scriptId: string;
  language?: string;
}

/** Translate kind-tagged form data into a `Connection` + its secret (JWK for
 * PAIC, password for on-prem). The secret is `undefined` when the user left it
 * blank (edit mode keeps the existing one; add mode is caught upstream). */
function connectionFromFormData(r: ConnectionFormData): {
  conn: Connection;
  secret: string | undefined;
} {
  if (r.kind === "onprem") {
    return {
      conn: { kind: "onprem", host: r.host, username: r.username, name: r.name },
      secret: r.password,
    };
  }
  return {
    conn: { kind: "paic", host: r.host, saId: r.saId, name: r.name },
    secret: r.jwk,
  };
}

/** Accepts a `ScriptNode` or `LibraryScriptNode` (tree right-click handed
 * us the tree item) or a plain `{host, realm, scriptId, language?}` payload
 * (from an inspector card's `openScriptBody` message). Both node kinds carry
 * the same `host` / `realm` / `scriptId` fields, so the FS provider serves
 * the body identically. */
function parseOpenScriptArg(arg: unknown): OpenScriptArgs | null {
  if (arg instanceof ScriptNode || arg instanceof LibraryScriptNode) {
    const language = arg.resolved?.language;
    return { host: arg.host, realm: arg.realm, scriptId: arg.scriptId, language };
  }
  if (arg && typeof arg === "object") {
    const a = arg as Record<string, unknown>;
    if (
      typeof a.host === "string" &&
      typeof a.realm === "string" &&
      typeof a.scriptId === "string"
    ) {
      return {
        host: a.host,
        realm: a.realm,
        scriptId: a.scriptId,
        language: typeof a.language === "string" ? a.language : undefined,
      };
    }
  }
  return null;
}

interface OpenEmailTemplateArgs {
  host: string;
  name: string;
  locale: string;
}

/** Accepts `{host, name, locale}` from either a tree-context invocation or
 * an inspector-card button click. (No tree-side EmailTemplateNode binding
 * because email templates are not bound to a specific locale at tree level
 * — locale is picked at the card.) */
function parseOpenEmailTemplateArg(arg: unknown): OpenEmailTemplateArgs | null {
  if (arg && typeof arg === "object") {
    const a = arg as Record<string, unknown>;
    if (typeof a.host === "string" && typeof a.name === "string" && typeof a.locale === "string") {
      return { host: a.host, name: a.name, locale: a.locale };
    }
  }
  return null;
}

interface FindUsagesArgs {
  host: string;
  realm: string;
  kind: EntityKind;
  id: string;
  displayName: string;
  isLibrary?: boolean;
  esvKind?: "variable" | "secret" | "missing";
}

const FIND_USAGES_KINDS: ReadonlySet<EntityKind> = new Set<EntityKind>([
  "journey",
  "script",
  "esv",
  "theme",
  "emailTemplate",
  "socialIdp",
]);

/** Accepts a `{host, realm, kind, id, displayName, isLibrary?, esvKind?}`
 * descriptor (posted by the inspector's `[🔍 Find usages]` button → the
 * `paicJourneys.findUsages` command). */
function parseFindUsagesArg(arg: unknown): FindUsagesArgs | null {
  if (!arg || typeof arg !== "object") return null;
  const a = arg as Record<string, unknown>;
  if (
    typeof a.host !== "string" ||
    typeof a.realm !== "string" ||
    typeof a.kind !== "string" ||
    typeof a.id !== "string" ||
    typeof a.displayName !== "string"
  ) {
    return null;
  }
  if (!FIND_USAGES_KINDS.has(a.kind as EntityKind)) return null;
  const out: FindUsagesArgs = {
    host: a.host,
    realm: a.realm,
    kind: a.kind as EntityKind,
    id: a.id,
    displayName: a.displayName,
  };
  if (typeof a.isLibrary === "boolean") out.isLibrary = a.isLibrary;
  if (a.esvKind === "variable" || a.esvKind === "secret" || a.esvKind === "missing") {
    out.esvKind = a.esvKind;
  }
  return out;
}
