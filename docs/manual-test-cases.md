# Manual test case management

Angles 3.0 adds manual test case management: QAs author versioned test cases per team,
execute them in runs, and see the results in the same dashboards as automated runs.

This guide covers authoring, custom field configuration, permissions, and what a
deployment needs before the feature is usable.

## Concepts

**Test case** — an authored manual test: title, description, preconditions, tags, steps
with expected results, and any custom fields configured for the team. A case has a
`status` (`DRAFT`, `ACTIVE`, `DEPRECATED`) and a `priority` (`LOW`, `MEDIUM`, `HIGH`,
`CRITICAL`).

**Version** — every test case exists twice: as a *mutable head* holding the current
content, and as one *frozen version document* per version that has ever existed. Version
documents are only ever inserted, never updated or deleted.

**Shared step** — a named, re-usable sequence of steps that many cases can include.

**Test run** — a set of cases executed together against an environment. A run creates a
real `Build` tagged `executionType: 'manual'`, so every existing dashboard and metric
picks it up.

**Attachment** — an image uploaded against a case, shared step, or execution.

### Why versions matter

An execution must render exactly what the tester saw. When a run is created, each selected
case is resolved to its **current version document** and the run stores that `ObjectId`.
Because no code path updates or deletes version documents, an execution recorded against
version 3 can never start showing version 4's content — including when the change came
from a shared step edited months later.

Two consequences worth knowing up front:

- Editing a case that is part of an **in-flight run** does not shift the steps under the
  tester. The run keeps executing the version it started against. To pick up the edit,
  re-add the case to the run — that creates a second entry bound to the newer version, or
  use `rebind` (below) on an entry that has not been executed yet.
- Editing a **shared step** re-versions every case that includes it, immediately. Check
  `GET /shared-step/:id/usage` first to see how many cases that is.

An edit that changes nothing does not burn a version, and neither does a status change —
workflow state is not content.

## Authoring

### Creating a case

`POST /rest/api/v1.0/manual-test-case` with at least `team` and `title`. New cases start
at `DRAFT` and version 1.

Required custom fields are **only enforced when the case leaves `DRAFT`**, so authoring
stays frictionless — save early, fill in the mandatory fields when the case is ready to
become `ACTIVE`.

### Steps

Each step has an `action` (required), an `expected` result, optional test `data`, and
optional `attachments`. Steps carry their own `_id`, which is preserved into every frozen
version, so a step result binds to a specific step of a specific version and survives a
later reorder or deletion.

To include a shared step, set `sharedStep` on the step instead of writing `action` /
`expected`. The included step's own text is ignored — the shared step's steps are expanded
in its place.

Expansion happens **when a version is written**, not when a case is read. The frozen
version stores the fully expanded, flattened step list, with `sharedStepRef` and
`sharedStepVersion` on each expanded step for display attribution only.

### Referencing images in a step

Upload the image (see [Attachments](#attachments)), then reference it from the step's
expected or actual result in markdown:

```
![login page](attachment:64f0c2a1e4b0a1b2c3d4e5f6)
```

The UI resolves `attachment:<id>` to `GET /attachment/:id/file`.

### Cloning

`POST /manual-test-case/:caseId/clone` creates a new `DRAFT` starting at version 1 with
its own independent version history. It does not share versions with the original.

## Custom fields

Admins define extra fields per team. Each definition has:

| Property | Notes |
| --- | --- |
| `key` | Stable storage key, `/^[a-z][a-z0-9_]{0,39}$/`. Unique per team. |
| `label` | Display name; safe to change without touching stored values. |
| `type` | `text`, `textarea`, `number`, `date`, `boolean`, `select`, `multiselect`, `user` |
| `options` | Required for `select` and `multiselect`. |
| `required` | Enforced only when a case leaves `DRAFT`. |
| `defaultValue` | Applied when the field is absent. |
| `order` | Display order. |
| `appliesTo` | `testcase`, `execution`, or `both`. |
| `archived` | Set instead of deleting when values exist. |

Values are validated against the team's definitions on every write. **Unknown keys are
rejected rather than silently dropped**, and every offending key is reported at once.

### Changing a definition later

- Renaming a `label` is safe — stored values key off `key`, not the label.
- Changing `key` is not a rename; it is a different field.
- Deleting a field that has values on existing cases **archives it instead**, so history
  stays readable. Archived fields keep rendering wherever a value already exists, but are
  not offered for new input.

Each frozen version stores the field definitions as they stood at that version, so an
archived or relabelled field still renders with its original label and type when you look
back at an old execution.

## Test runs

1. **Create** — `POST /manual-test-run` with the team, environment, and the case ids to
   include. Each case is resolved to its current version and the run creates its backing
   manual build. `DEPRECATED` cases are rejected, naming the case — reactivate them first.
   A case that belongs to a *different* component than the run is also rejected, because
   the backing build carries a single component and a mismatch would make the component
   metrics wrong; a case with no component set is accepted into any run. If the request
   omits `component`, the run falls back to the team's first component rather than
   refusing.
2. **Execute** — `PUT /manual-test-run/:runId/test-case/:caseId/result` records per-step
   actual results, statuses and attachments. This writes a `TestExecution` and then calls
   the same `buildMetricsUtils.addExecutionToBuild` that automated runs use, so build
   metrics recompute through one code path.
3. **Complete** — `PUT /manual-test-run/:runId/status` transitions the run
   (`PLANNED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`); completing stamps `end`.

### Per-case result states

`NOT_RUN`, `IN_PROGRESS`, `PASS`, `FAIL`, `ERROR`, `SKIPPED`, `BLOCKED`.

`BLOCKED` is manual-only and **maps to `SKIPPED`** on the underlying `TestExecution`,
because the execution status enum is closed and the whole metrics layer depends on it. The
richer state is kept on the run document.

`SKIPPED` rather than `ERROR` is deliberate: a blocked test was never executed, so nothing
was verified and no defect was found. Recording it as `ERROR` would inflate the failure
count on every dashboard and alert that counts errors.

### Rebinding

`PUT /manual-test-run/:runId/test-case/:caseId/rebind` moves a `NOT_RUN` entry onto the
case's latest version. It returns **409 for any entry that already has a result**, since
that would silently re-point a recorded execution at content it was never run against.

### Platform and device metrics

Runs carry the same `Platform` array as automated executions — `platformName`,
`platformVersion`, `browserName`, `browserVersion`, `deviceName`, `screenWidth`,
`screenHeight`, `pixelRatio` — so the platform metrics aggregations work unchanged.

## Attachments

Upload with `POST /attachment` as multipart form data, field name `attachment`, plus one
of `testCaseId`, `sharedStepId` or `executionId` to say what it belongs to.

- **Allowed types**: PNG, JPEG, GIF, WebP, BMP, TIFF. The client-supplied filename is
  discarded and a random one generated.
- **Size limit**: 10 MB, matching screenshots.
- A thumbnail is generated alongside the original, served from
  `GET /attachment/:id/thumbnail`.

### Attachments are immutable once a version references them

Removing an image from a step in the editor drops it from the **head only**. The file and
its document stay, because frozen versions still reference them and a historical execution
must render the image the tester actually saw.

`DELETE /attachment/:id` therefore returns **409** when any frozen version references it.
Only attachments referenced solely by the head are hard-deleted. Deleting the parent case
removes its versions first, so the reference check passes and the files are collected.

There is currently no independent expiry — attachment retention is tied to the parent
entity's lifetime.

## Change history

Every mutation to a test case, shared step or custom field records who changed what.
Actions: `CREATE`, `UPDATE`, `DELETE`, `CLONE`, `STATUS_CHANGE`, `SHARED_STEP_UPDATE`,
`ARCHIVE`.

```
GET /manual-test-case/:caseId/history?limit=&skip=
GET /shared-step/:sharedStepId/history
```

A cascade from a shared step edit is recorded as `SHARED_STEP_UPDATE` naming the shared
step as the cause, so a case that changed without anyone editing it directly is
explainable.

History writes never fail the user's request — a failure is logged instead. History is not
auto-pruned.

## Permissions

| Action | Required |
| --- | --- |
| Author, read, clone test cases | Team access |
| Delete a test case | Team lead |
| Create, edit, delete shared steps | Team lead |
| Read shared steps and usage | Team access |
| Create runs, record results, transition status | Team access |
| Delete a run | Team lead |
| Upload, read, delete attachments | Team access to the owning entity |
| Configure custom fields | Admin |
| Read custom field definitions | Team access |

## Filtering manual vs automated

Both list endpoints accept an optional `executionType` of `automated` or `manual`:

```
GET /build?teamId=<id>&executionType=manual
GET /metrics/phase?teamId=<id>&executionType=manual
```

**Omitting it returns both**, which is exactly what every pre-3.0 client saw. The filter
narrows; it never reshapes.

The phase metrics response also gains a per-period
`executionTypeBreakdown: { automated, manual }` that accounts for every execution in the
period, so a stacked chart built from it matches `result.TOTAL`.

Prometheus gauges gained an `execution_type` label rather than new metric names. **This
changes the label set of `angles_builds_by_team`** — a recording rule or dashboard query
that matched on an exact label set needs updating; one that matches by name does not.

## Deployment

### Turning the feature on and off

Manual test case management is optional and **enabled by default**. An admin controls it
from **Admin → Settings → Feature Management**; the toggle covers test cases, test runs,
shared steps and folders as a single unit, because a run is a run *of* cases.

Turning it off:

- removes the Manual Testing menu from the navigation for every user,
- replaces the pages themselves with an explanation, so a bookmarked link says why it no
  longer works, and
- makes `/manual-test-case`, `/manual-test-run`, `/manual-folder` and `/shared-step`
  respond `404` for every method — the data is genuinely unreachable, not merely hidden.

Nothing is deleted. Re-enabling restores every case, run and shared step exactly as it
was. Changes apply immediately; no restart is needed.

To deploy an instance with the feature already off, set:

```
ANGLES_MANUAL_TESTING_ENABLED=false
```

Any value other than the string `false` leaves the feature enabled, so an unset or
misspelled value behaves as it always did.

This variable is a **seed, not an override**. It supplies the value written when the
feature settings are first created — the same create-if-missing pattern as
`ANGLES_ADMIN_PASSWORD`. Once those settings exist the database is authoritative and the
variable is ignored, so a restart can never silently revert a change an admin made in the
UI. To change the toggle on a running instance, use the admin UI.

### Attachment storage

Attachments are written to `/app/attachments`, grouped into one directory per owning
entity. This needs to be a persistent volume, or attachments vanish on restart.

Already wired up:

- `Dockerfile` — `VOLUME /app/attachments`
- `setup/docker-compose.yml` — `angles_attachments` volume
- `setup/kubernetes/04-angles-pod.yaml` — mounted from the existing PVC

`attachments/` is in both `.gitignore` and `.dockerignore`.

If you are upgrading an existing deployment with its own manifests, add the mount before
enabling the feature.

### Backfilling executionType

`executionType` defaults to `automated` in the schema, so documents written before 3.0
**already read back correctly** with no migration. What they lack is the field on disk,
which means the `{ team, executionType, start }` index cannot cover them and a filtered
query falls back to a broader index.

On a large deployment, run the backfill before building the new index:

```
MONGO_URL=... node scripts/backfill-execution-type.js
```

It only touches documents where the field is genuinely absent, so it is safe to run
repeatedly.

### Storage cost

A case edited 50 times stores 50 full copies. Test case documents are small — text and a
handful of refs, with attachments stored by reference rather than copied — so this is
measured in kilobytes per case, and is the right trade for auditability.

Versions are prunable by age *for cases with no executions bound to them*, but that is
deliberately not built.

## Client libraries

**angles-javascript-client** exposes the full surface: `manualTestCases`, `sharedSteps`,
`customFields`, `attachments` and `manualTestRuns` on the reporter, plus the optional
`executionType` filter on the build and metrics calls. This is what angles-ui uses.

**angles-java-client** and **angles-python-client** are reporting clients for automated
frameworks and carry no manual test management surface. They can *read* `executionType`,
the manual execution refs and step `attachments`, and pass an `executionType` filter to
list calls.

Neither can **write** `executionType`. It is what distinguishes a manual run from an
automated one, and a reporting client setting it to `manual` would put a build on the
dashboard that no manual run exists to explain. It stays server-assigned — `POST /build`
from those clients gets the schema default.

## API reference

Full request and response schemas are in `swagger/swagger.json`, browsable at
**`/api-docs`** — note that is served from the server root, not under `/rest/api/v1.0`.

```
POST   /manual-test-case                                 GET    /manual-test-case
GET    /manual-test-case/:caseId                         PUT    /manual-test-case/:caseId
DELETE /manual-test-case/:caseId                         POST   /manual-test-case/:caseId/clone
GET    /manual-test-case/:caseId/version                 GET    /manual-test-case/:caseId/version/:version
GET    /manual-test-case/:caseId/history

POST   /shared-step                                      GET    /shared-step
GET    /shared-step/:sharedStepId                        PUT    /shared-step/:sharedStepId
DELETE /shared-step/:sharedStepId                        GET    /shared-step/:sharedStepId/usage
GET    /shared-step/:sharedStepId/history

POST   /custom-field                                     GET    /custom-field
GET    /custom-field/:fieldId                            PUT    /custom-field/:fieldId
DELETE /custom-field/:fieldId

POST   /attachment                                       GET    /attachment?testCaseId=|sharedStepId=
GET    /attachment/:attachmentId                         DELETE /attachment/:attachmentId
GET    /attachment/:attachmentId/file                    GET    /attachment/:attachmentId/thumbnail

POST   /manual-test-run                                  GET    /manual-test-run
GET    /manual-test-run/:runId                           PUT    /manual-test-run/:runId
DELETE /manual-test-run/:runId                           PUT    /manual-test-run/:runId/status
PUT    /manual-test-run/:runId/test-case/:caseId/result
PUT    /manual-test-run/:runId/test-case/:caseId/rebind
```
