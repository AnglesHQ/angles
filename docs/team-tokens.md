# Team tokens

A team token is an API token that belongs to a team rather than to a person. Use one for
the automation pipelines that report a team's test results.

|                         | Personal token                                     | Team token                                      |
| ----------------------- | -------------------------------------------------- | ----------------------------------------------- |
| Belongs to              | The user who created it                            | The team                                        |
| Acts as                 | That user: every team they can reach, their role   | A member of its one team                        |
| Keeps working when…     | …that user keeps the same access                   | …people join or leave the team                  |
| Can change              | Anything that user can                             | Only the team's test results (see below)        |
| Managed by              | The user (or an admin) under User Settings         | The team's leads (or an admin) under Team Settings |

## Creating one

In the UI, open **Team Settings**, pick the team, and add a token under **Team tokens**: give
it a name (say, the pipeline that will use it) and an expiry of 1 to 365 days. The token is
shown once, when it is created; copy it into your pipeline's secrets. Only its hash is
stored, so it cannot be shown again: if it is lost, revoke it and create another.

Team leads can manage the tokens of the teams they lead; admins can manage any team's.
Tokens can only be managed from a signed-in session, never with an API token, so a leaked
token cannot mint or revoke others.

The same is available through the API:

| Endpoint | |
| --- | --- |
| `GET /rest/api/v1.0/team/{teamId}/tokens` | List the team's tokens: name, who created it, when it expires and when it was last used. |
| `POST /rest/api/v1.0/team/{teamId}/tokens` | Create one: `{ "name": "nightly-pipeline", "expiresInDays": 90 }`. The response carries the `token`. |
| `DELETE /rest/api/v1.0/team/{teamId}/tokens/{tokenId}` | Revoke one. It stops working at once. |

Deleting a team deletes its tokens.

## Using one

Team tokens start with `angles_team_` and are sent in the `x-api-key` header, exactly like
a personal token, so the Java, JavaScript and Python clients use them unchanged:

```javascript
import anglesReporter from 'angles-javascript-client';

anglesReporter.setBaseUrl('https://angles-api.example.com/rest/api/v1.0/');
anglesReporter.setApiKey(process.env.ANGLES_TEAM_TOKEN);
```

A team token can:

- **report results** for its team: `POST /build`, `PUT /build/{buildId}/executions`,
  `PUT /build/{buildId}/artifacts`, `PUT /build/{buildId}/keep`,
  `POST /build/{buildId}/attachment`, `POST /execution` and `POST /screenshot`. That is
  everything the clients' reporters do;
- **read its team's data**, such as a build it reported, its HTML report, or a baseline
  comparison, just as a member of the team can.

Everything else is refused with a `403`: changes beyond reporting (deleting builds,
editing teams, environments, baselines, settings or manual tests), other teams' data, and
the user routes.

Builds a team token reports show the token's name as **Triggered by**, marked as a team
token. The token list shows when each token was last used (to the hour), which tells you
whether a pipeline still depends on it before you revoke it.
