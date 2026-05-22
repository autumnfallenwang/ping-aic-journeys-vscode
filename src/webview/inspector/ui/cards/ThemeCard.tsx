import type { Theme } from "../../../../domain/types";
import type { SelectPayload, W2E } from "../../../messages";

interface Props {
  payload: Extract<SelectPayload, { kind: "theme" }>;
  onFindUsages?: (d: Extract<W2E, { type: "findUsages" }>) => void;
}

export function ThemeCard({ payload, onFindUsages }: Props) {
  const { themeId, host, realmName, theme } = payload;
  const heading = theme?.name || themeId;
  return (
    <article className="card">
      <header>
        <span className="kind-badge">Theme{theme?.isDefault ? " · Default" : ""}</span>
        <h1>{heading}</h1>
      </header>
      <dl>
        <dt>Host</dt>
        <dd>
          <code>{host}</code>
        </dd>
        <dt>Realm</dt>
        <dd>{realmName}</dd>
        <dt>Theme ID</dt>
        <dd>
          <code>{themeId}</code>
        </dd>
        {theme ? <ThemeFields theme={theme} /> : null}
      </dl>
      {theme?.logo ? <LogoPreview theme={theme} /> : null}
      {theme?.linkedTrees && theme.linkedTrees.length > 0 ? (
        <LinkedTrees ids={theme.linkedTrees} />
      ) : null}
      {theme ? null : <p className="hint">Theme resolution failed; showing id only.</p>}
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
                kind: "theme",
                id: themeId,
                displayName: theme?.name ?? themeId,
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

function ThemeFields({ theme }: { theme: Theme }) {
  return (
    <>
      {theme.name ? (
        <>
          <dt>Name</dt>
          <dd>{theme.name}</dd>
        </>
      ) : null}
      {theme.journeyLayout ? (
        <>
          <dt>Layout</dt>
          <dd>
            <code>{theme.journeyLayout}</code>
          </dd>
        </>
      ) : null}
      {theme.fontFamily ? (
        <>
          <dt>Font</dt>
          <dd>{theme.fontFamily}</dd>
        </>
      ) : null}
      {theme.primaryColor ? (
        <>
          <dt>Primary color</dt>
          <dd>
            <Swatch color={theme.primaryColor} />
          </dd>
        </>
      ) : null}
      {theme.backgroundColor ? (
        <>
          <dt>Background color</dt>
          <dd>
            <Swatch color={theme.backgroundColor} />
          </dd>
        </>
      ) : null}
      {theme.backgroundImage ? (
        <>
          <dt>Background image</dt>
          <dd>
            <a href={theme.backgroundImage} rel="noreferrer noopener" target="_blank">
              {theme.backgroundImage}
            </a>
          </dd>
        </>
      ) : null}
    </>
  );
}

function Swatch({ color }: { color: string }) {
  return (
    <span className="theme-swatch">
      <span className="theme-swatch-dot" style={{ background: color }} />
      <code>{color}</code>
    </span>
  );
}

function LogoPreview({ theme }: { theme: Theme }) {
  // AIC stores logo URLs per-locale; default to `en` if present, else first key.
  const logoMap = theme.logo ?? {};
  const altMap = theme.logoAltText ?? {};
  const locale = logoMap.en ? "en" : Object.keys(logoMap)[0];
  if (!locale) return null;
  const src = logoMap[locale];
  const alt = altMap[locale] ?? "Theme logo";
  if (!src) return null;
  return (
    <section className="theme-logo">
      <h2>Logo</h2>
      <img alt={alt} className="theme-logo-img" src={src} />
    </section>
  );
}

function LinkedTrees({ ids }: { ids: readonly string[] }) {
  return (
    <section className="deps">
      <h2>Linked journeys ({ids.length})</h2>
      <ul>
        {ids.map((id) => (
          <li key={id}>
            <code>{id}</code>
          </li>
        ))}
      </ul>
    </section>
  );
}
