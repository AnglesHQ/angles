# Prometheus metrics

Angles exposes a Prometheus scrape endpoint at **`GET /metrics`**, covering both host/process
resource usage and Angles' own application data.

Note the path: it is served from the server root, **not** under `/rest/api/v1.0`. It is mounted
outside the API base path because Prometheus cannot hold a session cookie, and the existing
`/rest/api/v1.0/metrics/*` reporting endpoints explicitly reject API tokens. The scrape endpoint
therefore performs its own authentication.

## Enabling it

The endpoint returns **404 until it is explicitly enabled**. The scrape body contains team and
environment names, so exposing it is a deliberate act rather than a default.

| Variable | Effect |
| --- | --- |
| `ANGLES_METRICS_TOKEN` | Require this token, as `Authorization: Bearer <token>` or in the `x-metrics-token` header. **Recommended.** |
| `ANGLES_METRICS_PUBLIC` | `true` serves the endpoint with no authentication. Only appropriate when the port is not reachable from outside the deployment network (a Kubernetes `ClusterIP`, an unpublished Docker port). |

Tuning:

| Variable | Default | Effect |
| --- | --- | --- |
| `ANGLES_METRICS_CACHE_TTL_MS` | `60000` | How long the database aggregations are cached between scrapes. |
| `ANGLES_METRICS_MAX_SERIES` | `200` | Caps per-team/per-environment label cardinality. `0` disables the labelled breakdowns and keeps the global totals. |
| `ANGLES_METRICS_DISK_USAGE` | unset | `true` additionally walks the screenshot and compare directories to report their size. Costs O(files) per refresh; the filesystem-level `angles_disk_bytes` gauges are always on and are usually enough. |

## Prometheus configuration

```yaml
scrape_configs:
  - job_name: angles
    scrape_interval: 30s
    static_configs:
      - targets: ['angles:3000']
    authorization:
      type: Bearer
      credentials: '<ANGLES_METRICS_TOKEN>'
```

Keep `scrape_interval` at or above `ANGLES_METRICS_CACHE_TTL_MS`; scraping faster only re-renders
the same cached database numbers.

## Grafana

A ready-to-import dashboard covering everything below lives in
[`grafana/angles-dashboard.json`](grafana/README.md).

## Metrics

### Resource usage

| Metric | Type | Labels | Notes |
| --- | --- | --- | --- |
| `angles_process_cpu_user_seconds_total` | counter | | Use `rate()` for CPU usage over time. |
| `angles_process_cpu_system_seconds_total` | counter | | |
| `angles_process_cpu_usage_percent` | gauge | | Percentage of a *single* core since the last scrape, so >100 is valid on multi-core hosts. |
| `angles_process_resident_memory_bytes` | gauge | | RSS - the number to alert on for container OOM. |
| `angles_process_heap_bytes` | gauge | `state` (`used`/`total`) | |
| `angles_process_external_memory_bytes` | gauge | `type` (`external`/`array_buffers`) | Image buffers land here, not in the V8 heap. |
| `angles_process_uptime_seconds` | gauge | | A reset indicates a restart/crash loop. |
| `angles_event_loop_lag_seconds` | gauge | | Saturation signal. Rises when image work blocks the loop, usually before requests start failing. |
| `angles_host_cpus` | gauge | | |
| `angles_host_load_average` | gauge | `period` (`1m`/`5m`/`15m`) | |
| `angles_host_memory_bytes` | gauge | `state` (`total`/`free`) | |
| `angles_disk_bytes` | gauge | `volume`, `state` (`total`/`used`/`available`) | Filesystem-level, for the `screenshots` and `compares` volumes. |
| `angles_storage_bytes` | gauge | `volume` | Only with `ANGLES_METRICS_DISK_USAGE=true`. |
| `angles_storage_files` | gauge | `volume` | Only with `ANGLES_METRICS_DISK_USAGE=true`. |

### Angles application data

| Metric | Type | Labels | Notes |
| --- | --- | --- | --- |
| `angles_builds` | gauge | `status` | |
| `angles_builds_by_team` | gauge | `team`, `environment`, `status` | Subject to `ANGLES_METRICS_MAX_SERIES`. |
| `angles_executions` | gauge | `status` | |
| `angles_screenshots` | gauge | | |
| `angles_screenshots_with_phash` | gauge | | Image-engine coverage of the stored screenshots. |
| `angles_baselines` | gauge | | |
| `angles_last_build_timestamp_seconds` | gauge | `team` | Unix timestamp of the newest build. See the staleness alert below. |
| `angles_entities` | gauge | `type` (`team`/`component`/`environment`/`phase`/`user`) | |

### API traffic (RED)

| Metric | Type | Labels | Notes |
| --- | --- | --- | --- |
| `angles_http_requests_total` | counter | `method`, `route`, `status` | `route` is the matched *pattern* (`/rest/api/v1.0/build/:buildId`), never the raw URL, so build ids cannot explode cardinality. |
| `angles_http_requests_in_flight` | gauge | | Concurrency. |
| `angles_http_request_duration_seconds` | histogram | `method`, `route`, `status` | Buckets run to 120s to cover image-engine work. |

### Self-observability

| Metric | Type | Notes |
| --- | --- | --- |
| `angles_build_info` | gauge | Always `1`; carries `version` and `node` labels. |
| `angles_database_up` | gauge | `1` when the Mongo connection is usable. |
| `angles_metrics_cache_age_seconds` | gauge | Grows beyond the TTL when collection is failing. |
| `angles_metrics_collection_errors_total` | counter | A non-zero rate means the domain numbers are stale. |
| `angles_metrics_scrape_duration_seconds` | gauge | Cost of building the response. |

A scrape never fails as a whole: if Mongo is unreachable, the database-backed families are simply
omitted, `angles_database_up` drops to 0 and the resource metrics still report. That way the
endpoint remains a usable health signal during an outage.

## Suggested alerts

```yaml
groups:
  - name: angles
    rules:
      # The screenshot volume filling up stops uploads entirely.
      - alert: AnglesScreenshotDiskFilling
        expr: angles_disk_bytes{volume="screenshots",state="available"}
              / angles_disk_bytes{volume="screenshots",state="total"} < 0.10
        for: 15m
        annotations:
          summary: "Less than 10% free on the Angles screenshot volume"

      # Detects a CI pipeline that has gone quiet - nothing is failing, nothing is arriving.
      - alert: AnglesNoRecentBuilds
        expr: time() - angles_last_build_timestamp_seconds > 86400
        for: 1h
        annotations:
          summary: "No builds submitted for team {{ $labels.team }} in over 24h"

      - alert: AnglesDatabaseDown
        expr: angles_database_up == 0
        for: 5m

      # Image work starving the event loop.
      - alert: AnglesEventLoopBlocked
        expr: angles_event_loop_lag_seconds > 1
        for: 10m

      - alert: AnglesHighErrorRate
        expr: sum(rate(angles_http_requests_total{status=~"5.."}[5m]))
              / sum(rate(angles_http_requests_total[5m])) > 0.05
        for: 10m

      - alert: AnglesMetricsStale
        expr: rate(angles_metrics_collection_errors_total[15m]) > 0
        for: 15m
```

## Useful queries

```promql
# 95th percentile latency per route
histogram_quantile(0.95,
  sum by (le, route) (rate(angles_http_request_duration_seconds_bucket[5m])))

# Request rate by status class
sum by (status) (rate(angles_http_requests_total[5m]))

# Build pass rate
angles_builds{status="PASS"} / ignoring(status) sum without (status) (angles_builds)

# Process memory as a fraction of host memory
angles_process_resident_memory_bytes / angles_host_memory_bytes{state="total"}
```
