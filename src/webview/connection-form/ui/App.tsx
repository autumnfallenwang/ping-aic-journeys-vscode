import { useEffect, useRef, useState } from "react";
import type { ConnectionFormData, ConnectionFormPayload, E2W, W2E } from "../messages";

interface VsCodeApi {
  postMessage(msg: W2E): void;
}

interface Props {
  vscode: VsCodeApi;
  payload: ConnectionFormPayload;
}

type ValidateResultState =
  | { state: "idle" }
  | { state: "pending" }
  | { state: "ok"; expiresIn: number; droppedScopes: string[] }
  | { state: "err"; message: string };

interface FieldErrors {
  host?: string;
  saId?: string;
  jwk?: string;
}

export function App({ vscode, payload }: Props) {
  const isEdit = payload.mode === "edit";

  const [name, setName] = useState(payload.initial?.name ?? "");
  const [host, setHost] = useState(payload.initial?.host ?? "");
  const [saId, setSaId] = useState(payload.initial?.saId ?? "");
  const [jwk, setJwk] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});

  // Mutable ref tracks the most recently issued Test Connection request id.
  // Used for stale-result filtering inside the (effect-scoped) message
  // listener — a state value would be captured by closure and out-of-date
  // by the time the message arrives.
  const requestIdRef = useRef(0);
  const [result, setResult] = useState<ValidateResultState>({ state: "idle" });

  useEffect(() => {
    const onMsg = (ev: MessageEvent<E2W>) => {
      const m = ev.data;
      if (!m || m.type !== "validateResult") return;
      if (m.requestId !== requestIdRef.current) return;
      if (m.ok) {
        setResult({ state: "ok", expiresIn: m.expiresIn, droppedScopes: m.droppedScopes });
      } else {
        setResult({ state: "err", message: m.message });
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, []);

  function validate(): ConnectionFormData | null {
    const errs: FieldErrors = {};
    const h = host.trim();
    const s = saId.trim();
    const n = name.trim();
    const j = jwk.trim();

    if (h) {
      const dup = payload.existingHosts.includes(h) && !(isEdit && payload.initial?.host === h);
      if (dup) errs.host = "A connection with this host already exists.";
    } else {
      errs.host = "Host is required.";
    }

    if (!s) errs.saId = "Service Account ID is required.";

    if (isEdit) {
      if (j) {
        try {
          JSON.parse(j);
        } catch {
          errs.jwk = "JWK must be valid JSON.";
        }
      }
    } else {
      if (j) {
        try {
          JSON.parse(j);
        } catch {
          errs.jwk = "JWK must be valid JSON.";
        }
      } else {
        errs.jwk = "JWK is required.";
      }
    }

    setErrors(errs);
    if (Object.keys(errs).length > 0) return null;
    return { host: h, saId: s, name: n || undefined, jwk: j || undefined };
  }

  const onSave = () => {
    const data = validate();
    if (data) vscode.postMessage({ type: "save", data });
  };

  const onCancel = () => {
    vscode.postMessage({ type: "cancel" });
  };

  const onTest = () => {
    const data = validate();
    if (!data) return;
    const next = requestIdRef.current + 1;
    requestIdRef.current = next;
    setResult({ state: "pending" });
    vscode.postMessage({ type: "validate", data, requestId: next });
  };

  return (
    <>
      <h1>{isEdit ? "Edit Connection" : "Add Connection"}</h1>
      <div className="subtitle">
        {isEdit
          ? "Update this connection's metadata. Leave the JWK blank to keep the existing secret."
          : "Add a new PAIC tenant connection. The JWK is stored in VS Code SecretStorage."}
      </div>

      <div className="field">
        <label htmlFor="name">
          Display name <span className="hint optional">(optional)</span>
        </label>
        <input
          id="name"
          type="text"
          placeholder="e.g. prod-tenant"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="host">
          Host<span className="required">*</span>
        </label>
        <input
          id="host"
          type="text"
          placeholder="openam-tenant.example.forgeblocks.com"
          value={host}
          onChange={(e) => setHost(e.target.value)}
        />
        <div className="hint warn">host is the stable ID; renaming it moves the stored secret</div>
        <div className="error">{errors.host ?? ""}</div>
      </div>

      <div className="field">
        <label htmlFor="saId">
          Service Account ID<span className="required">*</span>
        </label>
        <input
          id="saId"
          type="text"
          placeholder="00000000-0000-0000-0000-000000000000"
          value={saId}
          onChange={(e) => setSaId(e.target.value)}
        />
        <div className="error">{errors.saId ?? ""}</div>
      </div>

      <div className="field">
        <label htmlFor="jwk">
          Service Account JWK (JSON)
          {!isEdit && <span className="required">*</span>}
        </label>
        <textarea
          id="jwk"
          spellCheck={false}
          placeholder="Paste the service-account JWK JSON here"
          value={jwk}
          onChange={(e) => setJwk(e.target.value)}
        />
        <div className="hint lock">stored in VS Code SecretStorage</div>
        {isEdit && <div className="hint">leave blank to keep the existing JWK</div>}
        <div className="error">{errors.jwk ?? ""}</div>
      </div>

      <div className="actions">
        <button
          type="button"
          className="primary"
          onClick={onTest}
          disabled={result.state === "pending"}
        >
          Test Connection
        </button>
        <div className="right">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" onClick={onSave}>
            Save
          </button>
        </div>
      </div>

      {result.state !== "idle" && <ResultBanner result={result} />}
    </>
  );
}

function ResultBanner({ result }: { result: ValidateResultState }) {
  if (result.state === "pending") {
    return <div className="validate-result pending">Testing connection…</div>;
  }
  if (result.state === "ok") {
    const dropSuffix =
      result.droppedScopes.length > 0
        ? ` (some scopes not granted: ${result.droppedScopes.join(", ")})`
        : "";
    return (
      <div className="validate-result ok">
        ✓ Connected. Token valid for {result.expiresIn}s.{dropSuffix}
      </div>
    );
  }
  if (result.state === "err") {
    return <div className="validate-result err">✗ {result.message}</div>;
  }
  return null;
}
