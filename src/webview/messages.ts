/**
 * Typed message protocol between the extension host (Node.js) and the
 * inspector webview (browser, React). Both sides import these types so a
 * mismatch is a compile-time error.
 *
 * Direction is encoded in the union name:
 *   - `E2W` — extension → webview (host pushes selection / dep data to UI)
 *   - `W2E` — webview → extension (UI requests navigation, signals ready)
 */
import type { ResolvedGraph } from "../domain/resolved-graph";
import type {
  Connection,
  EmailTemplate,
  Esv,
  Journey,
  Realm,
  Script,
  SocialIdp,
  Theme,
} from "../domain/types";

/** A lightweight reference to a tree node that the panel may navigate to. */
export interface NodeRef {
  uid: string;
  /** Display label for the link. */
  label: string;
  /** Discriminates which card kind shows when the user navigates. */
  kind:
    | "connection"
    | "realm"
    | "journey"
    | "script"
    | "innerJourney"
    | "libraryScript"
    | "esv"
    | "theme"
    | "emailTemplate"
    | "socialIdp";
  /** Only meaningful for `kind === "esv"`. Sub-classification from D22's
   * per-script-expansion ESV index fetch. Lets the Direct view in
   * `ScriptCard` split the level-1 ESV list into "ESV Variables" /
   * "ESV Secrets" / "ESVs (missing)" sections. Absent on older nodes or
   * when the index fetch failed → renders as a single `── ESVs ──` group. */
  esvKind?: "variable" | "secret" | "missing";
}

/** Per-node info attached to journey-diagram nodes for click handling + hover. */
export interface NodeInfo {
  kind: "script" | "inner" | "theme" | "emailTemplate" | "socialIdp" | "other";
  /** Tree-node uid the inspector can navigate to. Populated for inner/theme/
   * emailTemplate/socialIdp/script kinds when a matching tree leaf exists. */
  uid?: string;
  /** For script-bearing kinds → clicking opens this script's body. Set on
   * `ScriptedDecisionNode`, `ClientScriptNode`, and on the conditional-script
   * kinds (Config/Device/PingOneVerify) when their `useScript` flag is on,
   * plus on `SocialProviderHandler*` (script wins over its IdPs for clicks). */
  scriptId?: string;
  /** Resolved script name (when journey-expand's eager fetch succeeded).
   * Diagram views prefer this over `scriptId` for clarity. */
  scriptName?: string;
  /** For InnerTreeEvaluatorNode → the inner journey's id (informational). */
  innerTreeId?: string;
  /** Schema slices for hover tooltips. Populated for ScriptedDecisionNode. */
  outcomes?: string[];
  inputs?: string[];
  outputs?: string[];
  /** For `kind: "other"` — the raw AIC node-type string (`PageNode`, etc.). */
  rawNodeType?: string;
  /** For PageNode payloads whose `stage` carries a themeId. */
  themeId?: string;
  /** For EmailSuspendNode / EmailTemplateNode payloads. */
  emailTemplateName?: string;
  /** For SelectIdPNode / SocialProviderHandlerNode*. The full filteredProviders
   * list; the diagram view renders a count + truncated names, the tooltip
   * shows the whole list. `uid` (when set) points to the first IdP's tree leaf. */
  socialIdpNames?: string[];
  /** For ConfigProviderNode / DeviceMatchNode / PingOneVerifyCompletionDecisionNode.
   * Decorates the view + tooltip to indicate whether the (structurally-present)
   * scriptId is actually active. */
  useScript?: boolean;
}

/** Extension → webview. */
export type E2W =
  | { type: "select"; payload: SelectPayload }
  | {
      type: "journeyDeps";
      uid: string;
      scripts: NodeRef[];
      inners: NodeRef[];
      themes: NodeRef[];
      emailTemplates: NodeRef[];
      socialIdps: NodeRef[];
      nodeIndex: Record<string, NodeInfo>;
    }
  | {
      type: "scriptDeps";
      uid: string;
      libraryScripts: NodeRef[];
      esvs: NodeRef[];
    }
  /** D35 — result of a `resolveFull` W2E. The card switches its Full / Flat
   * view from "Resolving…" to rendering the graph. `ok: false` carries an
   * error message (e.g. tenant fetch failed mid-walk). */
  | { type: "resolveResult"; ok: true; graph: ResolvedGraph }
  | { type: "resolveResult"; ok: false; message: string }
  | { type: "error"; uid?: string; message: string };

export type SelectPayload =
  | { kind: "connection"; uid: string; connection: Connection }
  | { kind: "realm"; uid: string; host: string; realm: Realm }
  | { kind: "journey"; uid: string; host: string; realmName: string; journey: Journey }
  | {
      kind: "innerJourney";
      uid: string;
      host: string;
      realmName: string;
      journey: Journey;
      visited: readonly string[];
    }
  | {
      kind: "script";
      uid: string;
      host: string;
      realmName: string;
      scriptId: string;
      script?: Script;
    }
  | {
      kind: "libraryScript";
      uid: string;
      host: string;
      realmName: string;
      scriptId: string;
      name: string;
      script?: Script;
    }
  | {
      kind: "esv";
      uid: string;
      host: string;
      realmName: string;
      name: string;
      esv?: Esv;
    }
  | {
      kind: "theme";
      uid: string;
      host: string;
      realmName: string;
      themeId: string;
      theme?: Theme;
    }
  | {
      kind: "emailTemplate";
      uid: string;
      host: string;
      realmName: string;
      name: string;
      template?: EmailTemplate;
    }
  | {
      kind: "socialIdp";
      uid: string;
      host: string;
      realmName: string;
      name: string;
      idp?: SocialIdp;
    }
  | { kind: "message"; uid: string; label: string };

/** Leaf kinds the Export… button can request (one per leaf card). */
export type ExportComponentKind =
  | "script"
  | "libraryScript"
  | "theme"
  | "emailTemplate"
  | "socialIdp"
  | "esv";

/** Webview → extension. */
export type W2E =
  | { type: "ready" }
  | {
      type: "openScriptBody";
      host: string;
      realm: string;
      scriptId: string;
      language?: string;
    }
  | {
      type: "openEmailTemplateBody";
      host: string;
      /** Template slug (the `name` field on EmailTemplate). */
      name: string;
      locale: string;
    }
  | {
      /** Open the card for `uid` in a separate preview panel beside the
       * main inspector — does NOT change tree selection or main-inspector
       * state. Triggered by clicks on the journey diagram. */
      type: "previewNode";
      uid: string;
    }
  /** D35 — kick off a forward-dep walk for THIS tab's root. The extension
   * derives the root identity from the tab's node (one tab = one card =
   * one root), runs the walker (or hits the resolver cache), and replies
   * with `resolveResult`. Cards with no resolve support (e.g. Connection,
   * Realm) ignore this. */
  | { type: "resolveFull" }
  /** D35 — re-resolve THIS tab's root. The extension drops the resolver
   * cache entry for this root, then runs `resolveFull`'s flow. Triggered
   * by the per-card `↻` refresh button. */
  | { type: "refreshResolved" }
  /** D35 — open the card for a node clicked inside the Full / Flat tree.
   * The resolver's composite key (`${kind}:${id}`) doesn't match the
   * sidebar's `uidIndex` format, so we can't reuse `previewNode`. The
   * panel constructs a `PaicNode` for the descriptor (host/realm come
   * from the tab's own node) and spawns a fresh tab via the factory. */
  | {
      type: "previewResolved";
      /** Resolved graph kind ("journey" → inner-journey card, "script"
       * → script or library-script depending on `isLibrary`). */
      kind: "journey" | "script" | "esv" | "theme" | "emailTemplate" | "socialIdp";
      /** Domain id (journey name / script UUID / dotted ESV name / etc.). */
      id: string;
      /** Display name carried so the new card can show something while
       * the tab's render fetches richer metadata. */
      displayName: string;
      /** When `kind === "script"`, distinguishes regular scripts from
       * library scripts (`context === "LIBRARY"`). */
      isLibrary?: boolean;
    }
  /** D36 — open the Search webview with a findUsages prefill for the
   * entity described by this message. Posted by the `[🔍 Find usages]`
   * button on inspector cards (Script / LibraryScript / ESV / Theme /
   * InnerJourney). The panel routes this to the `paicJourneys.findUsages`
   * command which spawns the Search webview via SearchFactory. */
  | {
      type: "findUsages";
      host: string;
      realm: string;
      kind: "journey" | "script" | "esv" | "theme" | "emailTemplate" | "socialIdp";
      id: string;
      displayName: string;
      isLibrary?: boolean;
      esvKind?: "variable" | "secret" | "missing";
    }
  /** D42 / M9 — export a single leaf component to a JSON file. Posted by the
   * `[Export…]` button on inspector cards; the panel routes it to the
   * `paicJourneys.exportComponent` command. */
  | {
      type: "exportComponent";
      host: string;
      realm: string;
      kind: ExportComponentKind;
      id: string;
      name?: string;
    }
  /** D42 / M9 Phase 2 — export a whole journey (or inner journey). The depth
   * choice (Level 1 / All levels) is a QuickPick shown extension-side. */
  | {
      type: "exportJourney";
      host: string;
      realm: string;
      journeyId: string;
      name?: string;
      isInner?: boolean;
    }
  /** D46 / M9 Phase 5 — export EVERY journey in a realm. No depth choice: at
   * realm scope the inner-journey closure is inherent. */
  | {
      type: "exportRealmJourneys";
      host: string;
      /** REST realm argument — `""` for the root realm (see `RealmNode`). */
      realm: string;
      /** Display label for the filename (`"root"` for the root realm). */
      realmLabel: string;
    };

// ─── Type-guard helpers ───────────────────────────────────────────────────
// Useful in tests + on the webview side where `event.data` is `unknown`.

export function isE2W(msg: unknown): msg is E2W {
  if (!msg || typeof msg !== "object") return false;
  const t = (msg as { type?: unknown }).type;
  return (
    t === "select" ||
    t === "journeyDeps" ||
    t === "scriptDeps" ||
    t === "resolveResult" ||
    t === "error"
  );
}

export function isW2E(msg: unknown): msg is W2E {
  if (!msg || typeof msg !== "object") return false;
  const t = (msg as { type?: unknown }).type;
  return (
    t === "ready" ||
    t === "openScriptBody" ||
    t === "openEmailTemplateBody" ||
    t === "previewNode" ||
    t === "resolveFull" ||
    t === "refreshResolved" ||
    t === "previewResolved" ||
    t === "findUsages" ||
    t === "exportComponent" ||
    t === "exportJourney" ||
    t === "exportRealmJourneys"
  );
}
