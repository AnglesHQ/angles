# Test attachments

Automated tests can attach files to their results: console and browser logs, network HAR
files, video recordings, Playwright traces, page HTML snapshots and images. They are shown
on the execution in the Angles UI, each with a viewer that suits the file.

## How it works

A test uploads files while it runs, but the execution is only saved when the test
finishes (or, in batch mode, when the whole run finishes). So, like screenshots, files are
uploaded against the **build**, and the execution claims them when it is saved:

1. `POST /rest/api/v1.0/build/{buildId}/attachment` with the file in the multipart field
   `attachment`. The response contains the attachment's `_id` and `kind`.
2. List the id when saving the execution, either for the whole test or for one step:

   ```json
   {
     "title": "Guest user can pay with a saved card",
     "suite": "Checkout",
     "build": "<buildId>",
     "attachments": ["<video id>", "<trace id>", "<har id>"],
     "actions": [{
       "name": "Pay with card",
       "steps": [{
         "name": "Verify order confirmation",
         "status": "FAIL",
         "timestamp": "2026-10-03T09:14:08Z",
         "attachments": ["<html snapshot id>"]
       }]
     }]
   }
   ```

   This works for `POST /execution` and for batches sent with
   `PUT /build/{buildId}/executions`. An id that was not uploaded against the execution's
   own build is dropped, so an execution can never claim another build's (or team's)
   file. Executions sent together with a new build (`POST /build`) cannot carry any,
   because nothing can have been uploaded against a build that does not exist yet.

The Angles clients wrap both steps: upload with `attachFile` (`attach_file` in Python)
and the id is added to the current test or step for you.

## Supported files

The kind, and the type the file is served with, come from the file extension. The
client's mime type is ignored, because test frameworks report most of these as
`application/octet-stream`.

| Extension | Kind | Shown in the UI as |
|---|---|---|
| `.log`, `.txt` | `log` | Text, with search |
| `.json` | `json` | Formatted JSON |
| `.har` | `har` | A table of requests, with failed requests highlighted |
| `.webm`, `.mp4` | `video` | A video player |
| `.zip` with "trace" in the name | `trace` | Download, with a link to the Playwright trace viewer |
| other `.zip` | `archive` | Download |
| `.html`, `.htm` | `html` | The page in a sandboxed frame, scripts disabled |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | `image` | The image |

Anything else is rejected with a `400`. The size limit is `ANGLES_ATTACHMENT_MAX_SIZE_MB`
(default `100`).

## Reading files

- `GET /attachment?executionId=<id>` lists the files an execution claimed (execution- and
  step-level). `GET /attachment?buildId=<id>` lists everything uploaded against a build.
  Server paths are never returned.
- `GET /attachment/{id}/file` serves the file. Range requests work, so videos can be
  seeked. Add `?download=true` to always download.

Every file is served with `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: sandbox`, and HTML snapshots, traces and archives are always
served as downloads. An HTML snapshot is the page under test, so it may contain scripts;
opened directly from the API it would otherwise run them on the Angles origin with the
viewer's session.

## Storage and clean-up

Files are written to `attachments/<buildId>/` with server-generated names, on the same
volume as manual-testing attachments (`/app/attachments` in Docker and Kubernetes).

- Deleting an execution deletes the files it claimed.
- Deleting a build, by hand or through the nightly clean-up, deletes all of its files,
  including any that no execution claimed.
- `DELETE /attachment/{id}` deletes one file and removes it from the execution or step
  that listed it.
