import { useCallback, useEffect, useState } from "react";
import type { ResolvedNode } from "../../../domain/resolved-graph";
import type {
  E2W,
  ExportComponentKind,
  NodeInfo,
  NodeRef,
  SelectPayload,
  W2E,
} from "../../messages";
import { ConnectionCard } from "./cards/ConnectionCard";
import { EmailTemplateCard } from "./cards/EmailTemplateCard";
import { EsvCard } from "./cards/EsvCard";
import { InnerJourneyCard } from "./cards/InnerJourneyCard";
import { JourneyCard } from "./cards/JourneyCard";
import { LibraryScriptCard } from "./cards/LibraryScriptCard";
import { RealmCard } from "./cards/RealmCard";
import type { ResolveState } from "./cards/ResolvedView";
import { ScriptCard } from "./cards/ScriptCard";
import { SocialIdpCard } from "./cards/SocialIdpCard";
import { ThemeCard } from "./cards/ThemeCard";

interface VsCodeApi {
  postMessage(msg: W2E): void;
}

interface Props {
  vscode: VsCodeApi;
}

interface JourneyDepsState {
  uid: string;
  scripts: NodeRef[];
  inners: NodeRef[];
  themes: NodeRef[];
  emailTemplates: NodeRef[];
  socialIdps: NodeRef[];
  nodeIndex: Record<string, NodeInfo>;
}

export interface ScriptDepsState {
  uid: string;
  libraryScripts: NodeRef[];
  esvs: NodeRef[];
}

export function App({ vscode }: Props) {
  const [selection, setSelection] = useState<SelectPayload | null>(null);
  const [journeyDeps, setJourneyDeps] = useState<JourneyDepsState | null>(null);
  const [scriptDeps, setScriptDeps] = useState<ScriptDepsState | null>(null);
  const [resolveState, setResolveState] = useState<ResolveState>({ status: "idle" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onMsg(e: MessageEvent<E2W>) {
      const m = e.data;
      if (m.type === "select") {
        setSelection(m.payload);
        setJourneyDeps(null);
        setScriptDeps(null);
        setResolveState({ status: "idle" });
        setError(null);
      } else if (m.type === "journeyDeps") {
        setJourneyDeps({
          uid: m.uid,
          scripts: m.scripts,
          inners: m.inners,
          themes: m.themes,
          emailTemplates: m.emailTemplates,
          socialIdps: m.socialIdps,
          nodeIndex: m.nodeIndex,
        });
      } else if (m.type === "scriptDeps") {
        setScriptDeps({ uid: m.uid, libraryScripts: m.libraryScripts, esvs: m.esvs });
      } else if (m.type === "resolveResult") {
        if (m.ok) setResolveState({ status: "ok", graph: m.graph });
        else setResolveState({ status: "err", message: m.message });
      } else if (m.type === "error") {
        setError(m.message);
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const openBody = (host: string, realm: string, scriptId: string, language?: string) =>
    vscode.postMessage({ type: "openScriptBody", host, realm, scriptId, language });
  const onExport = (
    host: string,
    realm: string,
    kind: ExportComponentKind,
    id: string,
    name?: string,
  ) =>
    vscode.postMessage({
      type: "exportComponent",
      host,
      realm,
      kind,
      id,
      ...(name === undefined ? {} : { name }),
    });
  const openEmailBody = (host: string, name: string, locale: string) =>
    vscode.postMessage({ type: "openEmailTemplateBody", host, name, locale });
  const previewNode = (uid: string) => vscode.postMessage({ type: "previewNode", uid });
  const onResolve = useCallback(() => {
    setResolveState({ status: "loading" });
    vscode.postMessage({ type: "resolveFull" });
  }, [vscode]);
  const onRefresh = useCallback(() => {
    setResolveState({ status: "loading" });
    vscode.postMessage({ type: "refreshResolved" });
  }, [vscode]);
  const onPreviewResolved = useCallback(
    (node: ResolvedNode) => {
      vscode.postMessage({
        type: "previewResolved",
        kind: node.kind,
        id: node.id,
        displayName: node.displayName,
        ...(node.isLibrary === undefined ? {} : { isLibrary: node.isLibrary }),
      });
    },
    [vscode],
  );
  const onFindUsages = useCallback(
    (descriptor: Extract<W2E, { type: "findUsages" }>) => vscode.postMessage(descriptor),
    [vscode],
  );
  const onExportJourney = useCallback(
    (descriptor: Extract<W2E, { type: "exportJourney" }>) => vscode.postMessage(descriptor),
    [vscode],
  );
  const onExportRealmJourneys = useCallback(
    (descriptor: Extract<W2E, { type: "exportRealmJourneys" }>) => vscode.postMessage(descriptor),
    [vscode],
  );

  if (!selection) {
    return <div className="empty">Select a tree node to inspect.</div>;
  }
  if (error) {
    return <div className="card-error">⚠ {error}</div>;
  }

  // Only attach deps if they belong to the current selection — otherwise the
  // previous fetch's results might briefly flash for a new node.
  const matchingJourneyDeps = journeyDeps && journeyDeps.uid === selection.uid ? journeyDeps : null;
  const matchingScriptDeps = scriptDeps && scriptDeps.uid === selection.uid ? scriptDeps : null;

  switch (selection.kind) {
    case "connection":
      return <ConnectionCard payload={selection} />;
    case "realm":
      return <RealmCard payload={selection} onExportRealmJourneys={onExportRealmJourneys} />;
    case "journey":
      return (
        <JourneyCard
          payload={selection}
          deps={matchingJourneyDeps}
          resolved={resolveState}
          onPreview={previewNode}
          onResolve={onResolve}
          onRefresh={onRefresh}
          onPreviewResolved={onPreviewResolved}
          onExportJourney={onExportJourney}
        />
      );
    case "innerJourney":
      return (
        <InnerJourneyCard
          payload={selection}
          deps={matchingJourneyDeps}
          resolved={resolveState}
          onPreview={previewNode}
          onResolve={onResolve}
          onRefresh={onRefresh}
          onPreviewResolved={onPreviewResolved}
          onFindUsages={onFindUsages}
          onExportJourney={onExportJourney}
        />
      );
    case "script":
      return (
        <ScriptCard
          payload={selection}
          deps={matchingScriptDeps}
          resolved={resolveState}
          onPreview={previewNode}
          onResolve={onResolve}
          onRefresh={onRefresh}
          onPreviewResolved={onPreviewResolved}
          onOpenBody={openBody}
          onExport={onExport}
          onFindUsages={onFindUsages}
        />
      );
    case "libraryScript":
      return (
        <LibraryScriptCard
          payload={selection}
          deps={matchingScriptDeps}
          resolved={resolveState}
          onPreview={previewNode}
          onResolve={onResolve}
          onRefresh={onRefresh}
          onPreviewResolved={onPreviewResolved}
          onOpenBody={openBody}
          onExport={onExport}
          onFindUsages={onFindUsages}
        />
      );
    case "esv":
      return <EsvCard payload={selection} onExport={onExport} onFindUsages={onFindUsages} />;
    case "theme":
      return <ThemeCard payload={selection} onExport={onExport} onFindUsages={onFindUsages} />;
    case "emailTemplate":
      return (
        <EmailTemplateCard payload={selection} onOpenBody={openEmailBody} onExport={onExport} />
      );
    case "socialIdp":
      return <SocialIdpCard payload={selection} onExport={onExport} />;
    case "message":
      return <div className="empty">{selection.label}</div>;
  }
}
