# Angles Backend — Agent Rules

## 1. Swagger / OpenAPI Spec Must Stay in Sync

Every time an API endpoint is **added, modified, or removed**, you MUST update `swagger/swagger.json` to reflect the change.

The spec uses **OpenAPI 3.0.0**. Follow the existing structure exactly:

- **New endpoint**: add a new path entry under `"paths"` with all HTTP methods, request bodies, and response codes documented.
- **Modified endpoint**: update the corresponding path/method — request body schema, parameters, and/or response schemas.
- **Deleted endpoint**: remove the path/method entry entirely.
- **New model/schema**: add it under `"components"` → `"schemas"`. Follow the naming convention of existing schemas (e.g. `StoredEnvironment`, `Team`).
- Every response must document **at minimum**: `200`/`201` (success), `404` (not found, where applicable), `409` (conflict, where applicable), and `422` (validation error).
- All `422` responses must reference `#/components/schemas/DefaultResponse`.

## 2. Input Validation Is Mandatory on Every Route

Every route handler must validate its inputs using **`express-validator`** (`check`, `param`, `query` from the `express-validator` package), matching the pattern used across existing routes (e.g. `app/routes/environment.routes.js`).

### Rules by input type

| Input | Required checks |
|-------|----------------|
| **MongoDB ID path params** (e.g. `:environmentId`) | `param('id').isMongoId()` |
| **String name fields** | `.exists({ checkFalsy: true })` + `.matches(/^[A-Za-z0-9-]{2,50}$/)` + `.withMessage(...)` |
| **Free-text / description fields** | `.exists({ checkFalsy: true })` + `.isLength({ min: 1, max: 500 })` |
| **Enum fields** | `.isIn([...allowedValues])` + `.withMessage(...)` |
| **Numeric fields** | `.isInt({ min: 0 })` or `.isFloat({ min: 0 })` as appropriate |
| **Boolean fields** | `.isBoolean()` |
| **Date fields** | `.isISO8601()` |
| **Optional fields** | Chain `.optional()` before all other checks |

### Validation error handling in controllers

Every controller action must begin with:

```js
const errors = validationResult(req);
if (!errors.isEmpty()) {
  return res.status(422).json({ errors: errors.array() });
}
```

Do **not** skip this block on any handler, including `findAll`, `delete`, or any read-only operation that accepts params.

## 3. Error Handling

- Use the shared `handleError` utility from `app/exceptions/errors.js` in all `.catch()` blocks.
- Throw `NotFoundError` when a resource cannot be found by ID.
- Throw `ConflictError` when a uniqueness constraint would be violated (check for duplicates **before** saving).
- Never return raw Mongoose/MongoDB error objects to the client.

## 4. Mongoose Models

- All new models must include `{ timestamps: true }` in the schema options.
- Fields that must be unique must have both `unique: true` on the schema field **and** an explicit `Schema.index({ field: 1 }, { unique: true })`.
- Use `lowercase: true` on name/identifier string fields to enforce case-insensitive uniqueness.

## 5. Controller Conventions

- All controller exports are named functions (e.g. `exports.create`, `exports.findAll`, `exports.findOne`, `exports.update`, `exports.delete`).
- Use `.lean()` on Mongoose queries that are read-only (no need to instantiate full Mongoose documents).
- Log significant actions using `debug` (e.g. `const log = debug('myresource:controller')`).
- HTTP response codes: `201` for creation, `200` for reads/updates/deletes, `422` for validation failures, `404` for not found, `409` for conflicts.

## 6. Route File Conventions

- Route files live in `app/routes/` and are named `<resource>.routes.js`.
- They export a single function `(app, path) => { ... }` and are registered in `server.js`.
- All routes are mounted under `/rest/api/v1.0` and protected by `authMiddleware.isAuthenticated` (already applied globally in `server.js`) — do **not** re-apply it per-route unless explicitly required.

## 7. Unit Tests Are Mandatory for New Functionality

Every time new functionality is **added** (a new endpoint, controller action, model, or non-trivial behavior change), you MUST add unit tests covering it. Tests must follow the same standards as the existing suite:

- Test files live in `test/` and are named `<resource>.tests.js`, using `mocha` + `supertest` + `pino`, matching the pattern in `test/team.tests.js`.
- Use `describe`/`it` blocks grouped by endpoint (e.g. `describe('POST /team', ...)`), with a separate `describe('... - negative tests', ...)` block for validation/error-path cases.
- Cover both the happy path (expected success status, e.g. `200`/`201`) and negative cases (`422` validation errors, `404` not found, `409` conflicts, as applicable).
- Use `before`/`after` hooks to set up and tear down any test data directly via the Mongoose models (e.g. `Team.deleteMany`, `team.save`, `team.remove`), not via the API.
- Do not leave new routes, controller logic, or models untested — if you add it, you test it.
