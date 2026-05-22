import * as vscode from "vscode";
import type { Journey, NodePayload } from "../../domain/types";
import type { ClientCache } from "../../tenants/client-cache";
import type { Logger } from "../../util/logger";
import { PaicNode } from "./base";
import { expandJourney } from "./journey-expand";

/**
 * A journey (tree). Carries the full skeleton (returned inline by
 * `listJourneys`), so expansion just needs per-node payload fetches.
 */
export class JourneyNode extends PaicNode {
  readonly uid: string;
  /** Populated by `expandJourney` after fetching per-node payloads. The
   * inspector reads this to build the journey-diagram's node-id index for
   * click-to-drill. Undefined until the journey has been expanded once. */
  payloadsByNodeId?: ReadonlyMap<string, NodePayload>;
  constructor(
    public readonly host: string,
    public readonly realm: string,
    public readonly journey: Journey,
    private readonly cache: ClientCache,
    private readonly log: Logger,
    public readonly visited: readonly string[] = [],
    parent?: PaicNode,
  ) {
    super(journey.id, vscode.TreeItemCollapsibleState.Collapsed);
    this.parent = parent;
    this.uid = `journey:${host}:${realm}:${journey.id}`;
    this.id = this.uid;
    this.description = journey.enabled ? undefined : "(disabled)";
    this.tooltip = buildJourneyTooltip(host, realm, journey);
    this.contextValue = "journey";
    // A journey is the root of a dependency tree — `type-hierarchy`,
    // pairing with inner-journey's `type-hierarchy-sub` (D39).
    this.iconPath = new vscode.ThemeIcon("type-hierarchy");
  }

  protected loadChildren(): Promise<PaicNode[]> {
    return expandJourney({
      host: this.host,
      realm: this.realm,
      journey: this.journey,
      visited: this.visited,
      cache: this.cache,
      log: this.log,
      parent: this,
    });
  }
}

function buildJourneyTooltip(host: string, realm: string, journey: Journey): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`### Journey: \`${journey.id}\`\n\n`);
  md.appendMarkdown(`**Host:** \`${host}\` · **Realm:** \`${realm}\`\n\n`);
  md.appendMarkdown(`**Status:** ${journey.enabled ? "Enabled" : "Disabled"}\n\n`);
  if (journey.description) md.appendMarkdown(`**Description:** ${journey.description}\n\n`);
  if (journey.identityResource)
    md.appendMarkdown(`**Identity Resource:** \`${journey.identityResource}\`\n\n`);
  md.appendMarkdown(`**Entry node:** \`${journey.entryNodeId}\`\n\n`);
  md.appendMarkdown(`**Node count:** ${Object.keys(journey.nodes).length}\n`);
  return md;
}
