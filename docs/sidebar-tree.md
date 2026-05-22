# Sidebar Tree Structure

> Visual reference for the left-bar tree (`paicJourneys.connections` view). For the rationale and locked decisions, see [design-plan.md](design-plan.md). For phase status, see [progress.md](progress.md).

## Shape

```
▼ connection: prod-tenant                  [L1]
  ▼ realm: alpha                           [L2]
    ▼ journey: Login                       [L3]
      ▼ 📜 script: MyAuthDecision          [L4]
        📜 library-script: helpers         [L5 — via require() in script body]
          $  esv: TENANT_NAME              [L6 — via &{esv...} in lib body]
        $  esv: PUBLIC_URL                 [L5 — via &{esv...} in script body]
      🌲 inner journey: PasswordReset      [L4 — recursive journey shape]
        ▼ 📜 script: ResetSender           [L5]
          📜 library-script: helpers       [L6 — same library-script ref ok]
        🌲 inner journey: VerifyEmail      [L5]
          📜 script: ...                   [L6 — recurses indefinitely]
      📧 email-template: PasswordResetMail [L4]
      🪪 social-idp: google-oidc           [L4]
      🎨 theme: default                    [L4]
    ▶ journey: Registration
  ▶ realm: beta
▶ connection: stage-tenant
```

**Key change at M3:** `library-script` and `esv` are children of `script` (and recursively of `library-script`), **not** of `journey` — they're discovered by parsing script bodies, not by walking node payloads.

## Levels

| Level | Item | Source | Notes |
|---|---|---|---|
| **L1** | Connection | `paicJourneys.connections` setting | `host` is the stable ID; `name` is an optional display label. JWK lives in SecretStorage. |
| **L2** | Realm | `GET /am/json/global-config/realms` (or fixed list) | Almost always `alpha` + `beta`. Single-realm tenants auto-expand. |
| **L3** | Journey | `GET /am/json/<realm>/realm-config/authentication/authenticationtrees/trees` | One root journey = one resolver entry point. |
| **L4** | Direct dependency | Resolver output for that journey | Children depend on `kind` — see next section. |
| **L5+** | Transitive deps | Resolver recurses | Cycle-guarded via visited-set keyed by `(kind, id)`. |

## Dependency kinds at L4+

| Icon | `NodeKind` | Parent | Source | Recurses into |
|---|---|---|---|---|
| 📜 | `script` | journey | `ScriptedDecisionNode.script` (+ M3's `ClientScriptNode`, `ConfigProviderNode`, `SocialProviderHandlerNode*`, `DeviceMatchNode` (if `useScript`), `PingOneVerifyCompletionDecisionNode` (if `useFilterScript`)) → `/am/json/<realm>/scripts/<id>` | `library-script` + `esv` (both via script-body parsing — D20) |
| 📜 | `library-script` | script / library-script | `require('<name>')` in any script body | Other `library-script`s (recursive) + `esv` |
| `$` | `esv` | script / library-script | `&{esv.X}` / `systemEnv.X` in script body | Leaf |
| 🌲 | `inner journey` | journey | `InnerTreeEvaluatorNode.tree` | Full journey expansion (recursive, cycle-guarded) |
| 🎨 | `theme` | journey | `PageNode.stage` (JSON-encoded or `themeId=` legacy form) | Leaf |
| 📧 | `email-template` | journey | `EmailSuspendNode.emailTemplateName` / `EmailTemplateNode.emailTemplateName` | Leaf |
| 🪪 | `social-idp` | journey | `SocialProviderHandlerNode*.filteredProviders` + `SelectIdPNode.filteredProviders` | Leaf |

M3 ships every row above. Tree view may add a kind-filter toggle in later phases (default-on for scripts + inner journeys, opt-in for the rest).

> The emoji in the diagram + table above are illustrative. The actual rendered icons are VS Code codicons — the canonical entity → codicon map (shared by the sidebar tree, inspector cards, and Search page) is the table in **D39** of [design-plan.md](design-plan.md).

## Edge kinds (for the graph view, not visible in the tree)

- `contains` — journey ⟶ node
- `calls-inner-tree` — journey ⟶ inner journey
- `invokes-script` — node ⟶ script
- `imports-library` — script ⟶ library-script
- `references-esv` — script ⟶ esv (and library-script ⟶ esv)
- `uses-theme` — journey ⟶ theme (via PageNode.stage)
- `references-email-template` — journey ⟶ email-template (via EmailSuspendNode / EmailTemplateNode)
- `uses-social-idp` — journey ⟶ social-idp (via SocialProviderHandlerNode* / SelectIdPNode)

## Lazy expansion

Each level fetches on demand:
- **Click connection** → fetch realm list.
- **Click realm** → fetch journey list (paginated via `pagedResultsCookie`).
- **Click journey** → fetch tree skeleton + node payloads; resolver builds L4+.
- **Click inner journey** → resolver recurses; shows cached result on re-expand within the session.

Per-session memoization keyed by `(connection-host, realm, kind, id)`. No on-disk persistence yet.

## Cycle handling

Visited-set keyed by `(kind, id)`. On second visit to the same node within one walk, emit a `[cycle]` placeholder leaf instead of re-expanding. Logged at `DEBUG`.
