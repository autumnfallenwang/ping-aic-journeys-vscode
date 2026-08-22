import type { SelectPayload, W2E } from "../../../messages";

interface Props {
  payload: Extract<SelectPayload, { kind: "realm" }>;
  /** D46 — export every journey in this realm. Labelled just "Export…" to match
   * `JourneyCard`'s button. Posts an `exportRealmJourneys` W2E; the panel
   * routes it to the `paicJourneys.exportRealmJourneys` command. */
  onExportRealmJourneys?: (d: Extract<W2E, { type: "exportRealmJourneys" }>) => void;
}

export function RealmCard({ payload, onExportRealmJourneys }: Props) {
  const { realm, host } = payload;
  // The root realm's REST argument is "" so `getRealmPath()` resolves
  // `/realms/root` whatever its wire name is — the same rule `RealmNode` applies.
  const realmArg = realm.isRoot ? "" : realm.name;
  const realmLabel = realm.isRoot ? "root" : realm.name;
  return (
    <article className="card">
      <header>
        <span className="kind-badge">Realm</span>
        <h1>{realm.name}</h1>
      </header>
      <dl>
        <dt>Host</dt>
        <dd>
          <code>{host}</code>
        </dd>
        <dt>Parent path</dt>
        <dd>
          <code>{realm.parentPath}</code>
        </dd>
        <dt>Status</dt>
        <dd>{realm.active ? "Active" : "Inactive"}</dd>
      </dl>
      {onExportRealmJourneys ? (
        <div className="card-actions">
          <button
            type="button"
            className="primary"
            onClick={() =>
              onExportRealmJourneys({
                type: "exportRealmJourneys",
                host,
                realm: realmArg,
                realmLabel,
              })
            }
          >
            <i className="codicon codicon-export" aria-hidden />
            Export…
          </button>
        </div>
      ) : null}
    </article>
  );
}
