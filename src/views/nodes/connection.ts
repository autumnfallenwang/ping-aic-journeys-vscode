import * as vscode from "vscode";
import type { Connection } from "../../domain/types";
import type { ClientCache } from "../../tenants/client-cache";
import type { Logger } from "../../util/logger";
import { MessageNode, PaicNode } from "./base";
import { RealmNode } from "./realm";

/** A persisted PAIC connection. First-class L1 tree item. */
export class ConnectionNode extends PaicNode {
  readonly uid: string;
  constructor(
    public readonly connection: Connection,
    private readonly cache: ClientCache,
    private readonly log: Logger,
    parent?: PaicNode,
  ) {
    super(connection.name || connection.host, vscode.TreeItemCollapsibleState.Collapsed);
    this.parent = parent;
    this.uid = `connection:${connection.host}`;
    // `id` powers VS Code's per-row collapse-state persistence + selection
    // identity across tree refreshes. `uid` is already stable (derived from
    // user-owned config, not random), so reusing it is safe.
    this.id = this.uid;
    this.description = connection.name ? connection.host : undefined;
    this.tooltip = buildConnectionTooltip(connection);
    this.contextValue = "connection";
    // A PAIC connection is a tenant environment addressed by hostname —
    // `server-environment`, not `plug` (D39).
    this.iconPath = new vscode.ThemeIcon("server-environment");
  }

  protected async loadChildren(): Promise<PaicNode[]> {
    const client = await this.cache.get(this.connection.host);
    const all = await client.listRealms();
    // PAIC reserves the root realm for the platform; service accounts always
    // 403 on its journey/script endpoints. Identify it by `isRoot` (wire-level
    // `parentPath === null`) rather than name, since some deployments report
    // the root name as "/" and others as something else. Hide it so the tree
    // stays clean. If on-prem AM support is added later, gate on connection
    // type instead.
    const realms = all
      .filter((r) => !r.isRoot && r.name !== "/")
      // Sort alphabetically (D33 — applies even to single-kind levels).
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    if (realms.length === 0) {
      return [new MessageNode("No realms found", "info")];
    }
    return realms.map((r) => new RealmNode(this.connection.host, r, this.cache, this.log, this));
  }
}

function buildConnectionTooltip(c: Connection): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`### ${c.name ?? c.host}\n\n`);
  md.appendMarkdown(`**Host:** \`${c.host}\`\n\n`);
  md.appendMarkdown(`**Service Account ID:** \`${c.saId}\`\n`);
  return md;
}
