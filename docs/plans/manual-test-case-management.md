# Manual Test Case Management — Implementation Plan

## Goal

Add manual test case management to Angles so QAs can author, version, organise and
execute manual test cases per team, with the results appearing alongside automated runs
in the existing dashboards.

## Design decisions

These were settled before planning and constrain everything below:

| Decision | Choice |
| --- | --- |
| Manual run ↔ Build relationship | Manual runs create a real `Build` document tagged `executionType: 'manual'`, plus dedicated `manualtestcases` / `manualtestruns` collections |
| Step attachments | A new dedicated `Attachment` model and collection, independent of `Screenshot` |
| Permissions | Admin configures custom fields; team leads manage shared steps; any team member authors and executes |
| Scope | Angles API + angles-ui, delivered in phases |
| Execution ↔ case versioning | Every version is written to an append-only `manualtestcaseversions` collection; executions bind to a version document, never to the mutable case |

### Why executions bind to an immutable version document

An execution must render exactly what the tester saw. Storing a version *number* on the
execution is not enough — resolving `case + version` back to content requires the content
to still exist somewhere, and pointing at the live case means any later edit rewrites
history retroactively.

So the case is split into a mutable head (current content) and an append-only version
collection (every version that ever existed, fully frozen — including expanded shared steps
and the custom field definitions in force at the time). An execution holds an `ObjectId` to
a version document. Because nothing in the system ever updates or deletes those documents,
there is no code path by which a historical execution can start showing newer content.

### Why manual runs reuse `Build`

Every dashboard and metrics aggregation in the API is anchored on `Build` and
`TestExecution` — `metrics.controller.js` matches on `{ build: { $in: buildIds } }`, and
`build.controller.js:findAll` drives the dashboard table. Writing manual results as
`Build` + `TestExecution` documents carrying `executionType: 'manual'` means:

- the dashboard, phase metrics, and platform metrics work with a single added `$match`
  field rather than a parallel aggregation pipeline;
- `buildMetricsUtils.calculateBuildMetrics` computes manual result maps for free;
- filtering manual vs automated is one query parameter everywhere.

`ManualTestRun` sits *beside* the build and holds the things a build has no concept of:
assignee, in-progress state, per-case execution status, and the link back to the test case
at the version it was executed against.

### Why attachments are a separate model

`Screenshot` is tightly bound to a build (`build` is `required`), and carries phash,
platformId, view and baseline-comparison semantics that manual attachments do not need.
Rather than loosening `Screenshot.build` to optional — which weakens an invariant every
screenshot query and the whole image-engine relies on — manual attachments get their own
small model with their own upload path and lifecycle.

---

## Phase 1 — Core models and test case CRUD

**New models**

`app/models/manual-test-case.js`
```
ManualTestCase {
  team:            ObjectId ref Team      (required, indexed)
  component:       ObjectId               (optional — matches Build.component)
  title:           String  (required, max 200)
  description:     String
  preconditions:   String
  status:          enum ['DRAFT','ACTIVE','DEPRECATED']  default 'DRAFT'
  priority:        enum ['LOW','MEDIUM','HIGH','CRITICAL'] default 'MEDIUM'
  tags:            [String] (lowercase, trimmed)
  steps:           [ManualStep]
  customFields:    Map<String, Mixed>     (validated against the project's field defs)
  version:         Number  default 1      (bumped on every content change)
  createdBy:       ObjectId ref User
  updatedBy:       ObjectId ref User
  timestamps: true
}

ManualStep (subdocument, _id: true — needed so executions can reference a step)
{
  order:           Number (required)
  action:          String (required)
  expected:        String
  sharedStep:      ObjectId ref SharedStep  (optional — see Phase 3)
  attachments:     [ObjectId ref Attachment]
  data:            String                   (test data for the step)
}
```

Indexes: `{ team: 1, status: 1 }`, `{ team: 1, createdAt: -1 }`, `{ tags: 1 }`,
and a text index on `title`/`description` for search.

### Immutable versions

`ManualTestCase` above is the *mutable head* — it always reflects the latest content. Every
version that has ever existed is also written to its own immutable collection, and this is
what executions bind to.

`app/models/manual-test-case-version.js`
```
ManualTestCaseVersion {
  testCase:      ObjectId ref ManualTestCase (required, indexed)
  version:       Number  (required)
  team:          ObjectId ref Team

  // Full frozen content — every authored field, not just the steps
  title:         String
  description:   String
  preconditions: String
  priority:      String
  tags:          [String]
  steps:         [ManualStep]        (shared steps already expanded — see Phase 3)
  customFields:  Map<String, Mixed>

  // Field definitions as they stood at this version, so an archived or relabelled
  // custom field still renders with its original label and type
  fieldDefinitions: [CustomFieldDefinitionSnapshot]

  createdBy:     ObjectId ref User
  createdAt:     Date
}
```
Unique compound index `{ testCase: 1, version: 1 }`.

Documents in this collection are **never updated or deleted** — the controllers only ever
`insert` here. That is the property the whole feature rests on: an execution that points at
version 3 can never be made to render version 4's content, because version 3's document is
not reachable by any write path.

**Write flow**: `manual-test-case.controller.create` writes head + version 1 together.
`update` compares the incoming body against the head, and when any *content* field differs
(title, description, preconditions, priority, tags, steps, customFields — not `status`,
which is workflow state) it increments `head.version` and inserts a new version document.
An edit that changes nothing is a no-op and does not burn a version.

Both writes go through a `session`-less two-step with the version inserted **first**, so a
crash between the two leaves an orphan version rather than a head pointing at a version
that does not exist. `manual-test-case-utils.getVersion(caseId, version)` falls back to the
head only when no version document exists at all (pre-migration data), and logs when it
does.

**Read routes**
```
GET /manual-test-case/:caseId/version            -> list of versions (metadata only)
GET /manual-test-case/:caseId/version/:version   -> full frozen content
```

**Files to add**
- `app/models/manual-test-case.js`
- `app/controllers/manual-test-case.controller.js` — `create`, `findAll`, `findOne`,
  `update`, `delete`, `clone`
- `app/routes/manual-test-case.routes.js`
- register in `server.js` next to the other route requires

**Route surface** (all under `/rest/api/v1.0`)
```
POST   /manual-test-case                    hasTeamAccess
GET    /manual-test-case?teamId=&status=&tags=&search=&limit=&skip=
GET    /manual-test-case/:caseId
PUT    /manual-test-case/:caseId            hasTeamAccess
POST   /manual-test-case/:caseId/clone      hasTeamAccess
DELETE /manual-test-case/:caseId            hasTeamLeadAccess
```

Follow the existing controller idiom exactly: `validationResult` guard returning 422,
promise chains, `NotFoundError` / `ForbiddenError` from `app/exceptions/errors.js`,
`handleError(err, res)` in the `.catch`, and a `debug` logger named
`manual-test-case:controller`.

**Tests**: `test/manual-test-case.tests.js` following `test/team.tests.js` — positive CRUD,
422 on empty body, 403 for a user without team access, 404 for unknown team.

---

## Phase 2 — Configurable custom fields

Admins define extra fields; each field definition is scoped to a team (the "project").

**New model** `app/models/custom-field-definition.js`
```
CustomFieldDefinition {
  team:        ObjectId ref Team  (required, indexed)
  key:         String  (required, /^[a-z][a-z0-9_]{0,39}$/ — stable storage key)
  label:       String  (required)
  type:        enum ['text','textarea','number','date','boolean','select','multiselect','user']
  options:     [String]           (required when type is select/multiselect)
  required:    Boolean default false
  defaultValue: Mixed
  order:       Number
  appliesTo:   enum ['testcase','execution','both'] default 'testcase'
  archived:    Boolean default false
}
```
Unique compound index `{ team: 1, key: 1 }`.

**Validation util** `app/utils/custom-field-utils.js`
- `validateCustomFields(definitions, values)` — coerces and type-checks a `customFields`
  map against the team's definitions; throws `InvalidRequestError` listing every offending
  key at once (matching how `settings.routes.js` rejects unknown config keys rather than
  ignoring them).
- Unknown keys are rejected, not silently dropped.
- `required` is enforced only when the case leaves `DRAFT`, so authoring stays frictionless.

**Routes** — admin-only for writes, readable by anyone with team access:
```
POST   /custom-field                   authorizeAdmin
GET    /custom-field?teamId=
PUT    /custom-field/:fieldId          authorizeAdmin
DELETE /custom-field/:fieldId          authorizeAdmin   (soft-archive if in use)
```

Deleting a field that has values on existing cases archives it instead of removing it, so
history stays readable. This is checked in the controller before deletion.

**Wire into Phase 1**: `manual-test-case.controller.create/update` loads the team's
definitions and runs `validateCustomFields` before saving.

---

## Phase 3 — Re-usable shared steps

**New model** `app/models/shared-step.js`
```
SharedStep {
  team:        ObjectId ref Team (required, indexed)
  name:        String (required, max 150)
  description: String
  steps:       [ManualStep]        (same subdocument shape as a test case's steps)
  version:     Number default 1
  createdBy / updatedBy: ObjectId ref User
  timestamps: true
}
```
Unique compound index `{ team: 1, name: 1 }`.

**Referencing model**: a test case step with `sharedStep` set is an *inclusion* — its own
`action`/`expected` are ignored and the shared step's steps are expanded in their place at
read time. Expansion happens in a util (`app/utils/manual-step-utils.js:expandSteps`) used
by the case read endpoint (when `?expand=true`) and, critically, when a
`ManualTestCaseVersion` document is written — the version stores steps **already expanded
and flattened**, carrying `sharedStepRef` / `sharedStepVersion` for display attribution only.

That placement matters. A shared step included by twelve cases is edited constantly; if
versions stored the reference unexpanded, every historical execution of all twelve cases
would silently re-render with the new shared content. Expanding at version-write time means
editing a shared step affects only cases versioned *after* the edit.

**Consequence**: editing a shared step must version every test case that includes it.
`shared-step.controller.update` bumps the shared step, then inserts a new
`ManualTestCaseVersion` for each referencing case (re-expanded, `head.version` incremented),
with a `SHARED_STEP_UPDATE` history entry naming the shared step as the cause. This is
batched and logged; the `usage` endpoint below tells the author how many cases that will be
before they commit.

**Routes**
```
POST   /shared-step                    hasTeamLeadAccess
GET    /shared-step?teamId=&search=
GET    /shared-step/:sharedStepId
GET    /shared-step/:sharedStepId/usage   -> test cases referencing it
PUT    /shared-step/:sharedStepId      hasTeamLeadAccess
DELETE /shared-step/:sharedStepId      hasTeamLeadAccess  (409 if referenced)
```

Editing a shared step bumps its `version` and writes a history entry (Phase 5), and the
`usage` endpoint lets the UI warn the author how many cases they are about to affect.

---

## Phase 4 — Attachments

**New model** `app/models/attachment.js`
```
Attachment {
  team:        ObjectId ref Team (required)
  scope:       enum ['testcase','sharedstep','execution']  (required)
  testCase / sharedStep / manualExecution: ObjectId (whichever matches scope)
  filename:    String  (server-generated)
  originalName: String (sanitised, display only)
  mimeType:    String
  size:        Number
  path:        String  (on-disk path)
  thumbnail:   String
  uploadedBy:  ObjectId ref User
  timestamps: true
}
```

**Storage** `app/utils/multer-config-attachments.js`, modelled directly on
`multer-config-screenshots.js`:
- root `ATTACHMENT_ROOT = path.resolve(__dirname, '../../attachments')`
- destination keyed on a validated Mongo id, with the same
  `startsWith(ROOT + path.sep)` defence-in-depth check
- `EXTENSION_BY_MIME` allowlist; client filename discarded, `crypto.randomBytes` filename
- 10 MB limit, same as screenshots

**Thumbnailing** reuses `jimp` the way `image-utils` does; a small
`attachment-utils.generateThumbnail` writes a `.thumb.png` beside the original.

**Routes**
```
POST   /attachment            (multipart, field `attachment`)  hasTeamAccess
GET    /attachment/:id                                          hasTeamAccess
GET    /attachment/:id/file                                     hasTeamAccess
GET    /attachment/:id/thumbnail                                hasTeamAccess
DELETE /attachment/:id                                          hasTeamAccess
```

Deleting a test case or execution cascades to its attachments (files + documents),
mirroring `imageUtils.removeScreenshotDirectories`. Add `attachments/` to `.gitignore` and
`.dockerignore`, and mount it as a volume in the Dockerfile/k8s manifests the way
`screenshots/` is.

**Attachments are immutable once referenced by a version.** Removing an image from a step
in the editor drops it from the *head* only — the file and its `Attachment` document stay,
because frozen versions still reference them and a historical execution must render the
image the tester actually saw. `attachment.controller.delete` therefore checks
`ManualTestCaseVersion` for references and returns 409 when any exist; only attachments
referenced solely by the head are hard-deleted. Cascade-on-case-delete removes the versions
first, so the reference check passes and the files are collected.

Attachments referenced from a step's *expected result* are addressed in markdown as
`![alt](attachment:<id>)`; the UI resolves those to `/attachment/:id/file`.

---

## Phase 5 — Change history

Every mutation to a test case or shared step records who changed what.

**New model** `app/models/manual-change-history.js`
```
ManualChangeHistory {
  entityType:  enum ['testcase','sharedstep','customfield']
  entityId:    ObjectId (indexed)
  team:        ObjectId ref Team
  action:      enum ['CREATE','UPDATE','DELETE','CLONE','STATUS_CHANGE','SHARED_STEP_UPDATE']
  version:     Number          (the resulting version)
  changes:     [{ field, from, to }]
  changedBy:   ObjectId ref User   (required)
  changedAt:   Date  default now
  comment:     String              (optional, author-supplied)
}
```
Indexes: `{ entityId: 1, changedAt: -1 }`, `{ team: 1, changedAt: -1 }`.

**Util** `app/utils/history-utils.js`
- `diffDocuments(before, after, trackedPaths)` returns the `changes` array, deep-comparing
  the `steps` array and the `customFields` map rather than reporting them as one opaque
  change.
- `recordChange({ entityType, entityId, action, before, after, user, comment })` — called
  from the controllers after a successful save, never inside the same await as the save,
  so a history write failure logs but does not fail the user's request.

**Routes**
```
GET /manual-test-case/:caseId/history?limit=&skip=
GET /shared-step/:sharedStepId/history
```
Responses populate `changedBy` to `{ _id, username }` only — never the whole user
document, which carries `apiTokens`.

Retention: history is never auto-pruned in this phase; the `cleanup/` scripts get a
follow-up task if volume becomes a problem.

---

## Phase 6 — Manual test runs and executions

This is where manual results join the automated model.

**Change to `app/models/build.js`**
```
executionType: { type: String, enum: ['automated','manual'], default: 'automated', required: true }
```
plus index `{ team: 1, executionType: 1, start: -1 }`.

Defaulting to `'automated'` means every existing build document reads back correctly with
no migration; a backfill script is still provided in `scripts/` so the new index is dense.

**Change to `app/models/execution.js`**: the same `executionType` field, plus
```
manualTestCase:        ObjectId ref ManualTestCase        (optional)
manualTestCaseVersion: ObjectId ref ManualTestCaseVersion (optional)
versionNumber:         Number                             (optional, denormalised)
executedBy:            ObjectId ref User                  (optional)
```
The version ref is carried on the execution as well as on the run entry deliberately: an
execution is reachable from the dashboard and from
`test-execution-history` without ever loading the run, and it must be able to render the
content it was executed against on its own.
`TestExecution.actions[].steps[]` already carries `name`/`expected`/`actual`/`status`/
`screenshot`, which is very close to what a manual step result needs. Add an optional
`attachments: [ObjectId ref Attachment]` to the existing `Step` subdocument so a manual
step result can reference uploaded images without a parallel structure.

**New model** `app/models/manual-test-run.js`
```
ManualTestRun {
  name:        String (required)
  team:        ObjectId ref Team (required, indexed)
  component:   ObjectId
  environment: ObjectId ref Environment (required)
  phase:       ObjectId ref Phase
  build:       ObjectId ref Build     (the tagged manual build this run writes into)
  status:      enum ['PLANNED','IN_PROGRESS','COMPLETED','CANCELLED']
  assignedTo:  ObjectId ref User
  platforms:   [Platform]             (reuses app/models/platform.js verbatim)
  testCases:   [{
      testCase:        ObjectId ref ManualTestCase          (the head — for "show me all
                                                             runs of this case" queries)
      testCaseVersion: ObjectId ref ManualTestCaseVersion   (the frozen content actually
                                                             executed — required)
      versionNumber:   Number   (denormalised for display without a join)
      status:          enum ['NOT_RUN','PASS','FAIL','ERROR','SKIPPED','BLOCKED','IN_PROGRESS']
      execution:       ObjectId ref TestExecution
      executedBy:      ObjectId ref User
      start / end:     Date
  }]
  createdBy:   ObjectId ref User
  timestamps: true
}
```

Reusing `Platform` unchanged is what satisfies requirement 5 — manual runs capture exactly
the same platform/device metrics as automated ones (`platformName`, `platformVersion`,
`browserName`, `browserVersion`, `deviceName`, `screenWidth/Height`, `pixelRatio`), so the
platform metrics aggregations need no new fields.

**Flow**
1. `POST /manual-test-run` — resolves each selected case to its **current version
   document** and stores that `ObjectId` on the run entry, then creates the backing `Build`
   with `executionType: 'manual'`, `result: defaultResultMap`. The run never copies content;
   it points at the immutable version.
2. `PUT /manual-test-run/:runId/test-case/:caseId/result` — records the per-step
   actual/status/attachments, creates or updates the `TestExecution`
   (`executionType: 'manual'`, `manualTestCase`, `manualTestCaseVersion`, `executedBy`),
   then calls the existing `buildMetricsUtils.addExecutionToBuild` so the build's result map
   and status recompute through the same code path as automated runs — including its
   optimistic-concurrency retry loop.
3. `PUT /manual-test-run/:runId/status` — transitions the run; completing it stamps `end`.

**Version binding is fixed at run creation, not at execution time.** If a QA edits a case
while a run is in progress, the in-flight run keeps executing the version it started
against — the steps do not shift under the tester mid-run. Picking up the edit requires
explicitly re-adding the case to the run, which creates a second entry bound to the newer
version.

`PUT /manual-test-run/:runId/test-case/:caseId/rebind` moves a `NOT_RUN` entry onto the
latest version. It is rejected with a 409 for any entry that already has a result, since
that would silently re-point a recorded execution at content it was never run against.

**Step results reference the frozen step `_id`.** `ManualStep` carries `_id: true` and those
ids are preserved into the version document, so a step result binds to a specific step of a
specific version. A reordered or deleted step in a later version cannot pull a historical
result onto the wrong step.

Note `BLOCKED` is a manual-only per-case state. It maps to `SKIPPED` when written to the
`TestExecution`, because `executionStates` in `build.js`/`execution.js` is a closed enum
that the whole metrics layer depends on — the richer state is kept on the run document.

`SKIPPED` rather than `ERROR` (which this plan originally proposed): a blocked test was
never executed, so nothing was verified and no defect was found. Recording it as `ERROR`
would inflate the failure count on every dashboard and alert that counts errors, and
conflate "could not run" with "ran and errored".

**Routes**
```
POST   /manual-test-run                                        hasTeamAccess
GET    /manual-test-run?teamId=&status=&assignedTo=&limit=&skip=
GET    /manual-test-run/:runId
PUT    /manual-test-run/:runId                                 hasTeamAccess
PUT    /manual-test-run/:runId/test-case/:caseId/result        hasTeamAccess
PUT    /manual-test-run/:runId/status                          hasTeamAccess
DELETE /manual-test-run/:runId                                 hasTeamLeadAccess
```

**Tests**: `test/manual-test-run.tests.js` — creating a run creates a tagged build;
recording a result updates the build's result map; a completed run reports the right
status; `BLOCKED` maps to `ERROR` on the execution.

---

## Phase 7 — Dashboard and metrics filtering

**API changes** — all additive and backwards compatible:

- `build.controller.js:findAll` — accept `executionType` query param, add
  `query.executionType = executionType` when present. Absent means both, preserving
  today's behaviour for existing clients.
- `build.routes.js` — `query('executionType').optional().isIn(['automated','manual'])`.
- `metrics.controller.js:retrieveMetricsPerPhase` — same param, applied to `buildQuery`
  before the `Build.find`, so the executions aggregation narrows automatically.
- `metrics.routes.js` — same validator.
- Phase metrics response gains a per-period `executionTypeBreakdown: { automated, manual }`
  so the UI can stack the two without a second request.

**Prometheus** (`app/controllers/prometheus.controller.js`, `app/utils/domain-metrics.js`):
add `execution_type` as a label on the existing build/execution gauges rather than new
metric names, so existing dashboards keep working and the Grafana boards in `docs/grafana`
gain a filter. Validate the output with the dockerised promtool flow before committing.

---

## Phase 8 — angles-ui

New pages under `src/app/`, each with a matching component folder under
`src/components/pages/` per the existing convention:

| Route | Purpose |
| --- | --- |
| `manual-test-cases` | Team-scoped list with search, tag/status/priority filters |
| `manual-test-cases/[caseId]` | Case detail — steps, expected results, attachments, custom fields, history tab, version selector |
| `manual-test-cases/[caseId]/version/[version]` | Read-only view of a frozen version, with a diff against any other version |
| `shared-steps` | Shared step library + usage view |
| `manual-test-runs` | Run list and run creation wizard |
| `manual-test-runs/[runId]` | Execution view — step-by-step, pass/fail per step, attachment upload, platform capture. Always renders the **bound version**, with a "v3 · 2 versions behind latest" badge linking to the diff |
| `admin/custom-fields` | Admin field configuration (alongside `admin/settings`) |

**Shared components** under `src/components/features/`:
- `manual-step-editor` — drag-ordered step list with expected results and inline images
- `custom-field-form` — renders inputs from field definitions
- `change-history` — timeline of `ManualChangeHistory` entries with the author
- `attachment-upload` — drop zone, thumbnail preview, markdown reference insertion
- `version-badge` — "v3 · 2 behind latest", shown anywhere an execution is displayed
- `version-diff` — side-by-side comparison of two frozen versions, reusing the
  `diffDocuments` output shape from Phase 5 so the API does the field-level diffing

**Dashboard filtering**: add an execution-type toggle (All / Automated / Manual) to
`DashboardPage.js` and `MetricsPage.js`, threaded through the existing query-string state
into `ApiUtilities.js` calls. The charts in `dashboard/charts` and `metrics/charts` gain a
stacked series when "All" is selected.

All UI work follows the design-system rules in the angles-ui `CLAUDE.md`/`.agents/AGENTS.md`,
and the Next.js version notes there — read `node_modules/next/dist/docs/` before writing
page code rather than assuming conventions.

---

## Phase 9 — Client library and docs

- `angles-javascript-client`: new `ManualTestCaseRequests.ts`, `SharedStepRequests.ts`,
  `ManualTestRunRequests.ts`, `AttachmentRequests.ts` plus models under
  `src/lib/models/` mirroring the schemas above, and enums under `models/enum/`.
  Register them in `AnglesReporter.ts`.
- `swagger/swagger.json`: document every new endpoint. It is a single 5.3k-line file —
  add the new paths and component schemas in place rather than restructuring it.
- `docs/manual-test-cases.md`: authoring guide, custom field configuration, permissions
  matrix, and the attachment storage/volume requirements for deployment.

The Java and Python clients are deliberately out of scope — they exist to *report*
automated results from test frameworks, and manual test management has no equivalent
programmatic caller.

---

## Delivery order and risk

Phases 1–5 are independently shippable and touch no existing code paths, so they carry
almost no regression risk. The risk concentrates in:

- **Phase 6**, which modifies `Build` and `TestExecution` — both defaulted and additive,
  but they are the two hottest collections in the system. The backfill script should run
  before the new index is built on a large deployment.
- **Phase 7**, which edits live dashboard and metrics queries. Every change is an optional
  narrowing filter; the existing test suites (`test/build.tests.js`,
  `test/execution.tests.js`, `test/prometheus.tests.js`) must pass unchanged, which is the
  main guard that omitting the param preserves today's behaviour.

Run the API test suite with `PORT=3999` and a `MONGO_URL` set — port 3000 is taken by
docker locally.

**The version-immutability tests are the ones that matter most**, since a regression there
is silent — nothing errors, history just quietly starts lying. `test/manual-versioning.tests.js`
must cover:

1. Execute a case at v1, edit the case to v2, re-read the execution → still renders v1
   content (title, steps, expected results, custom field values, and labels).
2. Edit a shared step included by a case → historical executions of that case are unchanged;
   only cases versioned after the edit see the new content.
3. Delete an attachment referenced by a frozen version → 409, and the historical execution
   still renders the image.
4. Reorder and delete steps in v2 → v1's step results stay bound to the right steps.
5. An update that changes nothing does not create a new version.
6. `rebind` on an entry with a recorded result → 409.

Storage cost is worth stating plainly: a case edited 50 times stores 50 full copies. Test
case documents are small (text and a handful of refs — attachments are stored by reference,
not copied), so this is measured in kilobytes per case and is the right trade for
auditability. If it ever matters, versions are prunable by age *for cases with no executions
bound to them* — but that is deliberately not built now.

## Open items to confirm during implementation

1. ~~Whether a manual run should span multiple components~~ — settled: single component,
   matching `Build.component`; a case from another component is rejected (phase 6).
2. ~~Whether `DEPRECATED` test cases should be selectable in a new run~~ — settled: no,
   rejected with a 400 naming the case (phase 6).
3. Attachment retention — currently tied to the parent entity's lifetime, with no
   independent expiry.
4. ~~Whether editing a shared step should version every referencing case immediately~~ —
   settled: immediate cascade (phase 3).
5. Whether `status` transitions (`DRAFT` → `ACTIVE`) should burn a version. The plan says no
   — workflow state is not content — so an execution's bound version has no `status` field.
