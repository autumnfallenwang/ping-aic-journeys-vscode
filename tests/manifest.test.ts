import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Manifest ↔ source consistency. These mismatches don't fail the build, the type
 * checker, or any behavioural test — they surface only as a menu item that does
 * nothing when clicked in the Extension Development Host. Cheap to assert here.
 */
const ROOT = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const extensionSrc = readFileSync(join(ROOT, "src/extension.ts"), "utf8");

const contributed: string[] = (pkg.contributes?.commands ?? []).map(
  (c: { command: string }) => c.command,
);
const registered = new Set(
  [...extensionSrc.matchAll(/registerCommand\(\s*"([^"]+)"/g)].map((m) => m[1]),
);
const menus: Record<string, Array<{ command: string }>> = pkg.contributes?.menus ?? {};

describe("package.json manifest", () => {
  it("registers every contributed command in extension.ts", () => {
    const missing = contributed.filter((c) => !registered.has(c));
    expect(missing).toEqual([]);
  });

  it("contributes every command that extension.ts registers", () => {
    const undeclared = [...registered].filter((c) => !contributed.includes(c));
    expect(undeclared).toEqual([]);
  });

  it("only references contributed commands from menus", () => {
    // A menu entry naming a command that isn't contributed renders as a dead item.
    const bad: string[] = [];
    for (const [menu, items] of Object.entries(menus)) {
      for (const item of items) {
        if (item.command && !contributed.includes(item.command))
          bad.push(`${menu}: ${item.command}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("exposes the realm export from both the palette-hidden list and the realm context menu", () => {
    // D46's two entry points. The context-menu item hands the command a RealmNode
    // (whose `.realm` is the Realm OBJECT) — see the export-realm-journeys tests.
    expect(contributed).toContain("paicJourneys.exportRealmJourneys");
    const ctx = menus["view/item/context"] ?? [];
    const realmItem = ctx.find(
      (m: { command: string; when?: string }) =>
        m.command === "paicJourneys.exportRealmJourneys" && /viewItem == realm/.test(m.when ?? ""),
    );
    expect(realmItem).toBeTruthy();
  });
});
