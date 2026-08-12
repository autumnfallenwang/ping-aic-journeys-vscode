# Transfer Endpoints Reference

> The empirically-confirmed REST contract for **writing** each transferable component into a
> PAIC or on-prem AM tenant — the foundation the cross-environment **import** feature
> (**D42** / **D43**) is built on. Every endpoint here was double-confirmed against a live tenant
> with a full Create → Read → Update → Delete cycle (the trailing DELETE also leaves the tenant
> clean), not merely taken from frodo's API layer, which can be version-stale. Originated as a
> gitignored POC (`poc/transfer-endpoints/`); this is the committed, scrubbed record.

## Scope & deployments

CRUD was confirmed on two deployments: a **PAIC cloud sandbox tenant** (service-account
JWT-bearer auth) and a **throwaway on-prem AM VM** (admin user → AM SSO cookie, cookie name
discovered via `GET /am/json/serverinfo/*`). Only **leaves** are covered here; structural wiring
(nodes → tree → reference-remapping → inner-journey toggle) is a later round (see the end).

| | PAIC (cloud) | on-prem AM (classic) |
|---|---|---|
| Auth | service-account **JWT-bearer** | admin user → AM SSO cookie |
| AM base path | `https://<host>/am` | `http://<host>:<port>/<context>` |
| Default realm path | `alpha` → `/realms/root/realms/alpha` | root → `/realms/root` |
| IDM / platform (`/openidm`, `/environment`) | present | **absent** (bare AM has no IDM) |

**Key finding — no per-leaf deployment branch.** The 3 AM-native leaves (script, library script,
social IdP) behave **identically** on PAIC and bare AM: same status codes, same diff masks, same
UUID-preservation, same secret redaction. Only **auth + base path** differ. The 4 IDM/platform
leaves (email template, ESV variable, ESV secret, theme) are **N/A** on bare AM (no IDM).

## Applicability matrix

| Leaf | PAIC | on-prem AM | on-prem note |
|---|---|---|---|
| Script / library script | ✅ | ✅ | AM-native (`/am/.../scripts`) |
| Social IdP | ✅ | ✅ | AM-native service |
| Email template | ✅ | **N/A** | bare AM has no IDM `emailTemplate`; AM uses its own Email Service |
| Theme | ✅ | **N/A** | `ui/themerealm` is platform/IDM; classic AM theming differs |
| ESV variable | ✅ | **N/A** | no `/environment` service; on-prem uses AM config / secret stores |
| ESV secret | ✅ | **N/A** | same — on-prem uses AM Secret Stores (file/keystore) |

Where a leaf is N/A on-prem, the on-prem equivalent is treated as an **environment prerequisite**,
not a transferable artifact. The compatibility gate (D43 / TD-6) enforces this per-component.

## Summary

| # | Leaf | Match key | C | R | U | D | Notes |
|---|---|---|---|---|---|---|---|
| 1 | Email template | name | ✅ | ✅ | ✅ | ✅ | 201/200/200/200; mask = `_id`; no `_rev` |
| 2 | ESV variable | name | ✅ | ✅ | ✅ | ✅ | all 200; value readable; create == update (no 201) |
| 3 | Social IdP | (type, name) | ✅ | ✅ | ✅ | ✅ | PUT/DELETE confirmed; **clientSecret redacted** |
| 4 | Script | UUID | ✅ | ✅ | ✅ | ✅ | **client UUID preserved** on create (201); plain PUT |
| 5 | Library script | name→UUID | ✅ | ✅ | ✅ | ✅ | name query resolves to UUID |
| 6 | Theme | id/name | ✅ | ✅ | ✅ | ✅ | whole-doc splice on `themerealm`; siblings intact |
| 7 | ESV secret | name | ✅ | ⚠️ | ✅ | ✅ | value write-only; DELETE works (frodo lacks it) |

**Round 1 complete.** PAIC: 7/7 leaves full CRUD. On-prem AM: 3/3 AM-native leaves (#3/#4/#5)
identical to PAIC. The 4 IDM/platform leaves (#1/#2/#6/#7) confirmed N/A on bare AM.

---

## 1. Email template — name — PAIC ✅ (on-prem N/A)

| Op | Method + endpoint | Status |
|---|---|---|
| C | `PUT /openidm/config/emailTemplate/<name>` | **201** |
| R | `GET /openidm/config/emailTemplate/<name>` | 200 |
| U | `PUT …` (same endpoint, no `If-Match`) | **200** |
| D | `DELETE /openidm/config/emailTemplate/<name>` (GET after → 404) | 200 |

- **Diff mask = `_id` only** — server echoes `emailTemplate/<name>` as `_id`; **no `_rev`, no
  timestamps, no audit fields.** The body you PUT is byte-for-byte what you GET back. The cleanest leaf.
- **No optimistic concurrency** (no `_rev`) → update is a plain PUT; no `If-Match`.
- **Create = 201, Update = 200** → the status code distinguishes "didn't exist" from "overwrote".
- Per-locale `message`/`subject`, `enabled`, `mimeType` all round-trip verbatim.

## 2. ESV variable — name — PAIC ✅ (on-prem N/A)

`Accept-API-Version: protocol=1.0,resource=1.0` · scope `fr:idc:esv:*`

| Op | Method + endpoint | Status |
|---|---|---|
| C | `PUT /environment/variables/<hyphen-id>` | 200 |
| R | `GET /environment/variables/<hyphen-id>` | 200 |
| U | `PUT …` (value changed) | 200 |
| D | `DELETE /environment/variables/<hyphen-id>` (GET after → 404) | 200 |

- **Diff mask = `_id`, `lastChangeDate`, `lastChangedBy`, `loaded`** (all server-managed) — body
  fields (`valueBase64`, `expressionType`, `description`) round-trip verbatim.
- **Value IS readable** — `valueBase64` round-trips. Unlike secrets (#7).
- **Create and Update both return 200** (no 201) → conflict detection must GET-first to know if the
  variable already exists.
- Hyphenated REST id required (`esv-…`); the dotted form is display-only (**D22**).

## 3. Social IdP — (type, name) — both ✅

`Accept-API-Version: protocol=2.1,resource=1.0`

| Op | Method + endpoint | Status |
|---|---|---|
| C | `PUT …/SocialIdentityProviders/<typeId>/<id>` | **201** |
| R | `GET …/<typeId>/<id>` | 200 |
| U | `PUT …` | 200 |
| D | `DELETE …/<typeId>/<id>` (GET after → 404) | 200 |

- **PUT + DELETE confirmed** — frodo only exposed GETs; now empirically verified on both deployments.
- **Type segment `<typeId>`** ∈ {`oidcConfig`, `googleConfig`, `oauth2Config`, `saml2Config`, …}.
  Discovery: `POST …?_action=getAllTypes` + `POST …/<typeId>?_action=template` (19 types on PAIC,
  16 on the on-prem VM — missing the LINE / linkedInV2 variants).
- **`clientSecret` is REDACTED on read** — same class as the ESV secret (#7). The encrypted value
  won't transfer across tenants → **re-supply on import** (prompt). This makes "redacted secret
  fields" a **cross-leaf concern**, not just an ESV-secret one.
- **Diff mask = `_rev`, `_type`** (server-added) + `clientSecret` (redacted).
- A real transfer copies a **complete** source provider, so all required fields are already present
  (the "model from a blank template" validation grind is a POC-only artifact).

## 4. Script (decision-node) — UUID — both ✅

`Accept-API-Version: protocol=2.0,resource=1.0` · scope `fr:am:*` · realm path `/realms/root/realms/<realm>`

| Op | Method + endpoint | Status |
|---|---|---|
| C | `PUT /am/json/<realm>/scripts/<uuid>` (**our UUID preserved**) | **201** |
| R | `GET /am/json/<realm>/scripts/<uuid>` | 200 |
| U | `PUT …` (body changed, plain PUT — no `If-Match`) | 200 |
| D | `DELETE /am/json/<realm>/scripts/<uuid>` (GET after → 404) | 200 |

- **Client-chosen UUID is preserved on create-by-PUT (201)** → cross-env transfer can keep the
  source script UUID, so node `script` references stay valid **without remapping**. frodo's `reUuid`
  becomes *optional* (deliberate-copy only), not required.
- **Diff mask = `_id`, `description`, `default`, `createdBy`, `creationDate`, `lastModifiedBy`,
  `lastModifiedDate`, `evaluatorVersion`** (server-added). No `_rev`; update is a plain PUT.
- Body fields (`name`, `script` base64, `language`, `context`) round-trip verbatim.

## 5. Library script (`require()`) — name→UUID — both ✅

| Op | Mechanism | Status |
|---|---|---|
| C/U/R/D | same endpoints as #4, `context: "LIBRARY"` | create 201, update/read/delete 200 |
| resolve | `GET /am/json/<realm>/scripts?_queryFilter=name eq "<name>"` → 1 hit → UUID | 200 |

- Identical endpoint/behavior to #4; `context: "LIBRARY"` round-trips.
- **Name→UUID resolution works** — the `require('<name>')` import path: query by name returns the
  script + its `_id`. On import: query target by name → hit → reuse its UUID; miss → create.
- Deletion confirmed gone by **both** id and name query. Same diff mask as #4.

## 6. Theme — id/name — PAIC ✅ (on-prem N/A) — whole-doc splice

| Op | Mechanism | Status |
|---|---|---|
| R | `GET /openidm/config/ui/themerealm` → `{ _id:"ui/themerealm", realm: { <realm>: RawTheme[] } }`, client-filter one | 200 |
| C/U | **splice**: GET doc → insert/replace one theme in `realm.<realm>[]` → `PUT /openidm/config/ui/themerealm` | 200 |
| D | **splice**: GET → remove one theme → PUT whole doc (never raw-DELETE the entity — it holds **all** themes) | 200 |

- **No per-theme endpoint** — every op is a read-modify-write on the realm-wide `themerealm` doc.
  PUT returns **200** for all of C/U/D (no 201 — it's always a doc replace).
- **Non-destructive splice** — other themes stay intact through every op; the splice helper must
  always preserve siblings, then PUT the whole doc back.
- **Conflict detection is array membership** (match by theme `_id` or `name`), not HTTP status.
- Honor `isDefault` exclusivity (one default per realm — never flip another theme's); `linkedTrees`
  is a reverse-ref, not pushable config (drop it on write).
- **Import note (D43):** the import write uses **`If-Match: <_rev>`** on the whole-doc PUT (412 →
  re-GET + re-splice once) to guard against a concurrent edit of the shared document.

## 7. ESV secret — name — PAIC ✅ (on-prem N/A) — partial by design

`Accept-API-Version: protocol=1.0,resource=1.0` · scope `fr:idc:esv:*`

| Op | Method + endpoint | Status |
|---|---|---|
| C | `PUT /environment/secrets/<hyphen-id>` (body has `valueBase64`) | 200 |
| R | `GET /environment/secrets/<hyphen-id>` — **metadata only; value NEVER returned** | 200 ⚠️ |
| U | desc: `POST …?_action=setDescription`; value rotate: `POST …/versions?_action=create` (→ version 2) | 200 |
| D | `DELETE /environment/secrets/<hyphen-id>` (GET after → 404) | 200 |

- **Value is write-only** — supplied as `valueBase64` on create/version, **never returned on GET**.
  Round-trip can only assert metadata → **import must prompt for the value** (cross-tenant). The
  canonical "redacted field" case (#3 `clientSecret` is the same class).
- **DELETE is supported (200)** despite frodo exposing no `deleteSecret` — secrets are fully
  manageable and cleanup works.
- New value rotation = a new **version** via `/versions?_action=create`; description via
  `?_action=setDescription`.
- **Diff mask = everything except the value** (`_id`, `activeVersion`, `description`, `encoding`,
  `lastChangeDate`, `lastChangedBy`, `loaded`, `loadedVersion`, `useInPlaceholders`).

## 8. ESV apply (environment restart) — PAIC ✅

ESV writes (variable/secret create or update) land **`loaded: false`** and don't take effect until
an environment **restart** ("apply"). `Accept-API-Version: protocol=1.0,resource=1.0`.

| Purpose | Call | Signal |
|---|---|---|
| Pending? | `GET /environment/variables\|secrets` → filter `loaded === false` | which ESVs await apply |
| Status / progress | `GET /environment/startup` | `{ restartStatus: "ready" \| "restarting" }` |
| Apply | `POST /environment/startup?_action=restart` (requires `ready`; body `null`) | → `restarting` |
| Done | poll `startup` until `restartStatus: "ready"`; ESVs flip `loaded: true` | applied |

- **`loaded` is the per-ESV "applied?" flag** — `false` after create/update, `true` after a restart.
  Already a field on `RawEsvVariable` / `RawEsvSecret`.
- **Two-state model** (`ready` / `restarting`); the `startup` endpoint stays available *through* the
  restart (it's how you monitor it). Apply observed at **~3 min**; frodo's 10-min default is the
  *timeout*, not the expected time.
- **Restart is tenant-wide** — applies *all* pending ESVs (not just imported ones), and **no further
  ESV updates** are possible while `restarting`. Precondition: must be `ready` to initiate.
- frodo reference: `StartupApi.{getStatus,initiateRestart}` + `StartupOps.{checkForUpdates,applyUpdates}`
  (polls every 5 s; we use ~15 s). CLI: `frodo esv apply`.
- **on-prem N/A** — `/environment` is PAIC platform.

---

## Diff masks (importer reuse)

The **diff mask** per leaf — the fields that legitimately differ on read-back (server-managed) — is
itself a deliverable: export strips them and compare normalizes both sides by them, so that
`_rev`/timestamps/audit churn never makes an identical entity read as "differs".

| Leaf | Mask (fields excluded from value-compare) |
|---|---|
| Email template | `_id` |
| ESV variable | `_id`, `lastChangeDate`, `lastChangedBy`, `loaded` |
| Social IdP | `_rev`, `_type`, `clientSecret` (redacted) |
| Script / library | `_id`, `description`, `default`, `createdBy`, `creationDate`, `lastModifiedBy`, `lastModifiedDate`, `evaluatorVersion` |
| Theme | `linkedTrees` (reverse-ref), `isDefault` (realm-exclusive) |
| ESV secret | everything except the value (value is permanently unreadable) |

Note that `_id` is **kept** as transferable identity (UUIDs are preserved on import) — it is excluded
from *value*-compare but never rewritten.

### `<field>-encrypted` companions — stripped everywhere (cross-cutting)

AM returns some secrets as an **encrypted companion key** beside a nulled plaintext one. PAIC reads
of an OTP-email node or a social IdP come back as:

```json
{ "password": null, "password-encrypted": "<blob>" }
{ "clientSecret": null, "clientSecret-encrypted": "<blob>" }
```

**AM rejects any write carrying such a key** — `500 "Request contained encrypted data"`. Empirically
confirmed on AM 7.5.2: a real blob, a masked placeholder, and a fabricated `bogus-encrypted` key all
fail identically, so AM matches on the **key name**, not the value. There is no destination that
accepts one — not even the tenant that produced it. This was a live bug: a journey exported from
PAIC could not be imported anywhere until the field was hand-deleted.

Consequences, all three of which we now handle (`src/paic/encrypted.ts`):

| Where | Why it must be stripped |
|---|---|
| `getRawNode` / `getRawSocialIdp` (read) | Keeps the companion out of exported bundles — it is a real credential at rest, and non-portable anyway (encrypted with the *source* deployment's key) |
| `writeNode` / `writeSocialIdp` (write) | Rescues bundles authored before this fix, or by frodo/amster, which never passed through our read path |
| `canon()` / `normalizeForCompare()` | A pre-fix bundle carries the key; a target read today cannot → the asymmetry would make every affected journey read as "differs" forever |

We match keys **ending** in `-encrypted`. frodo matches the substring anywhere
(`deleteDeepByKey(nodeData, '-encrypted')` in `NodeApi.ts` + five sibling modules), which would also
eat an unrelated field such as `is-encrypted-enabled`.

Nothing is lost by stripping: the plaintext companion **always reads `null`**, so a password
difference was never detectable through this API to begin with. Secrets are re-supplied on import,
same as `clientSecret` (#3) and the ESV secret (#7).

> AM echo quirk, unrelated but easy to trip over: `password` comes back as `null` when the field was
> never written, but is **omitted entirely** when written as an explicit `null`.

## Synthetic test-data naming (for re-testing)

CRUD probes operate on an unmistakably-test, collision-proof, sorts-to-the-bottom resource — never a
real one. The trailing DELETE leaves the tenant clean.

| Kind | Test id/name |
|---|---|
| Script / library script | `zzz_poc_xfer_test` |
| Email template | `zzzpocxfertest` |
| ESV variable | `esv.zzz.poc.xfer.test` → `esv-zzz-poc-xfer-test` |
| ESV secret | `esv.zzz.poc.xfer.secret` → `esv-zzz-poc-xfer-secret` |
| Social IdP | `zzz_poc_xfer_idp` (type `oidc`) |
| Theme | `zzz poc xfer theme` |

---

## Structural / wiring — POC-confirmed (TD-12 · TD-13 · TD-14 · TD-15)

The structural write (journey import, Batch 3) is now confirmed end-to-end — a full export→import round-trip
rebuilt a wired journey on a clean tenant (TD-15). Probes live in the gitignored
`poc/transfer-endpoints/TRACKER.md`; full design in [journey-import-model.md](journey-import-model.md).

- **Node instance** — `PUT/DELETE …/authenticationtrees/nodes/<nodeType>/<nodeId>` (type in path; 404 if the
  type is absent). **The raw export node shape PUTs as-is** — AM tolerates the server-managed echoes
  (`_type`, `_outcomes`, `_id`); only `_rev` need be dropped (TD-15). A missing referenced **script** (UUID
  attr) or **inner tree** (name attr) is rejected `400 "Data validation failed for the attribute, …"` (TD-12).
- **Node type** — must pre-exist in the target deployment; not bundleable by us (the bundle carries node
  references by `_type._id`, not type *definitions*). Preflight derives the required types from the bundle's
  nodes (`_type._id`) and diffs them against the live `nodes?_action=getAllTypes` catalog (a read action;
  never a meta manifest — PD-18). Live catalog:
  **PAIC 234 types · bare on-prem 116 · 108 shared** (TD-14) — so a journey using a cloud-only type (e.g.
  `PingOneVerifyNode`) HARD-fails into bare on-prem. A missing type is a hard preflight blocker.
- **Journey (tree)** — `PUT/DELETE …/authenticationtrees/trees/<treeId>`; written **last**. The full export
  tree object PUTs as-is (no strip beyond `_rev`) (TD-15). Write order: leaves → inner-nodes → nodes →
  **inner trees → outer trees** (an `InnerTreeEvaluatorNode` can't be created before its target tree exists —
  TD-12); the **node PUT is the success gate**, not the final tree PUT.
- **Scripts** — name-unique per realm (`409` on dup name); UUID = identifier, name = cross-env match key →
  reconcile by name + remap node→script UUID refs (TD-13).
- **Inner journey** — shallow ref (level1) vs deep sibling-tree bundle (allLevels) — the depth toggle (TD-1 / TD-5).

### Out of scope (no resolver/client support today)

- SAML2 entities + circles of trust — frodo bundles them; we have no domain type/client method
  (would require extending the resolver first).
