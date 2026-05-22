import { useState } from "react";
import type { Esv, EsvSecret, EsvVariable } from "../../../../domain/types";
import type { SelectPayload, W2E } from "../../../messages";

interface Props {
  payload: Extract<SelectPayload, { kind: "esv" }>;
  onFindUsages?: (d: Extract<W2E, { type: "findUsages" }>) => void;
}

export function EsvCard({ payload, onFindUsages }: Props) {
  const { name, host, realmName, esv } = payload;
  const esvKind: "variable" | "secret" | undefined =
    esv?.kind === "variable" || esv?.kind === "secret" ? esv.kind : undefined;
  return (
    <article className="card">
      <header>
        <span className="kind-badge">{kindBadge(esv)}</span>
        <h1>{name}</h1>
      </header>
      <dl>
        <dt>Host</dt>
        <dd>
          <code>{host}</code>
        </dd>
        <dt>Realm</dt>
        <dd>{realmName}</dd>
        <dt>Name</dt>
        <dd>
          <code>{name}</code>
        </dd>
        {esv?.kind === "variable" ? <VariableFields esv={esv} /> : null}
        {esv?.kind === "secret" ? <SecretFields esv={esv} /> : null}
        {esv ? <SharedAuditFields esv={esv} /> : null}
      </dl>
      {esv ? null : <p className="hint">ESV not found in this tenant.</p>}
      {onFindUsages ? (
        <div className="card-actions">
          <button
            type="button"
            className="primary"
            onClick={() =>
              onFindUsages({
                type: "findUsages",
                host,
                realm: realmName,
                kind: "esv",
                id: name,
                displayName: name,
                ...(esvKind === undefined ? {} : { esvKind }),
              })
            }
          >
            <i className="codicon codicon-search" aria-hidden />
            Find usages
          </button>
        </div>
      ) : null}
    </article>
  );
}

function kindBadge(esv: Esv | undefined): string {
  if (!esv) return "ESV";
  return esv.kind === "variable" ? "ESV · Variable" : "ESV · Secret";
}

function VariableFields({ esv }: { esv: EsvVariable }) {
  return (
    <>
      <dt>Kind</dt>
      <dd>Variable</dd>
      {esv.expressionType ? (
        <>
          <dt>Expression type</dt>
          <dd>
            <code>{esv.expressionType}</code>
          </dd>
        </>
      ) : null}
      {esv.description ? (
        <>
          <dt>Description</dt>
          <dd>{esv.description}</dd>
        </>
      ) : null}
      <dt>Value</dt>
      <dd>
        <ValueField b64={esv.valueBase64} />
      </dd>
    </>
  );
}

function SecretFields({ esv }: { esv: EsvSecret }) {
  return (
    <>
      <dt>Kind</dt>
      <dd>Secret</dd>
      {esv.encoding ? (
        <>
          <dt>Encoding</dt>
          <dd>
            <code>{esv.encoding}</code>
          </dd>
        </>
      ) : null}
      {esv.description ? (
        <>
          <dt>Description</dt>
          <dd>{esv.description}</dd>
        </>
      ) : null}
      {esv.activeVersion ? (
        <>
          <dt>Active version</dt>
          <dd>
            <code>{esv.activeVersion}</code>
          </dd>
        </>
      ) : null}
      {esv.loadedVersion ? (
        <>
          <dt>Loaded version</dt>
          <dd>
            <code>{esv.loadedVersion}</code>
          </dd>
        </>
      ) : null}
      {esv.useInPlaceholders === undefined ? null : (
        <>
          <dt>Use in placeholders</dt>
          <dd>{esv.useInPlaceholders ? "Yes" : "No"}</dd>
        </>
      )}
    </>
  );
}

function SharedAuditFields({ esv }: { esv: Esv }) {
  return (
    <>
      {esv.loaded === undefined ? null : (
        <>
          <dt>Loaded</dt>
          <dd>{esv.loaded ? "Yes (live)" : "No (staged)"}</dd>
        </>
      )}
      {esv.lastChangeDate ? (
        <>
          <dt>Last changed</dt>
          <dd>
            <code>{esv.lastChangeDate}</code>
          </dd>
        </>
      ) : null}
      {esv.lastChangedBy ? (
        <>
          <dt>Last changed by</dt>
          <dd>{esv.lastChangedBy}</dd>
        </>
      ) : null}
    </>
  );
}

/** Decode `valueBase64` UTF-8 in the webview. `Buffer` isn't available;
 * `atob` returns a binary string, so round-trip through Uint8Array + TextDecoder
 * to safely recover UTF-8 content (e.g. multi-byte characters). */
function decodeEsvValue(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function ValueField({ b64 }: { b64: string | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!b64) return <em>(empty)</em>;
  let decoded: string;
  try {
    decoded = decodeEsvValue(b64);
  } catch {
    return (
      <span className="hint">
        <em>(value present but not decodable as UTF-8)</em>
      </span>
    );
  }
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(decoded);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard failed — silent. Users can still select + copy the <code>.
    }
  };
  return (
    <>
      <code className="esv-value">{decoded}</code>{" "}
      <button type="button" className="link" onClick={onCopy}>
        {copied ? "Copied!" : "Copy"}
      </button>
    </>
  );
}
