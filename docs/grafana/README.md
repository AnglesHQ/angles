# Grafana dashboard

`angles-dashboard.json` is a ready-to-import Grafana dashboard for an Angles instance,
built on the Prometheus metrics documented in [`../prometheus-metrics.md`](../prometheus-metrics.md).

It has five rows — Overview, Usage, API performance, Resources, and a collapsed
Metrics pipeline health row — described under [Layout](#layout) below.

## Prerequisites

1. The Angles scrape endpoint must be enabled — set `ANGLES_METRICS_TOKEN` (or
   `ANGLES_METRICS_PUBLIC=true`). See the metrics doc for the full list of settings.
2. Prometheus must be scraping it:

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

The **Angles storage used** and **Stored files** panels stay empty unless
`ANGLES_METRICS_DISK_USAGE=true` is also set — that collector walks the image
directories, so it is opt-in.

## Importing

**UI:** Dashboards → New → Import → *Upload dashboard JSON file* → pick
`angles-dashboard.json` → select your Prometheus data source.

**Provisioning** (file-based, for a managed deployment):

```yaml
# /etc/grafana/provisioning/dashboards/angles.yml
apiVersion: 1
providers:
  - name: angles
    type: file
    options:
      path: /var/lib/grafana/dashboards
```

Copy `angles-dashboard.json` into that directory.

**API:**

```bash
curl -X POST http://grafana:3000/api/dashboards/db \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <grafana-api-token>" \
  -d "{\"dashboard\": $(cat angles-dashboard.json), \"overwrite\": true}"
```

## Variables

| Variable | Purpose |
| --- | --- |
| `datasource` | Which Prometheus data source to query — set once after import. |
| `job` | Filters to one Prometheus job, so a single dashboard can serve several Angles instances. |

## Layout

**Overview** — the "is it up, is it healthy" band: version, target and database
liveness, uptime, throughput, error rate and p95 latency.

**Usage** — what the instance actually holds: builds, executions, screenshots,
baselines, teams and users, then builds/executions by status and by team. These are
*gauges over current database contents*, not cumulative counters — they step down
when the cleanup cron deletes old builds.

*Last build per team* is the panel worth alerting on: it shows how long ago each team
last submitted a build, red past 24h. A pipeline that silently stops produces no
errors, so nothing else on this dashboard would catch it.

**API performance** — RED metrics: request rate by route and status class, latency
percentiles, per-route p95, in-flight concurrency, and 4xx/5xx breakdowns. Routes are
labelled by matched *pattern*, so build ids never appear as separate series.

**Resources** — process and host CPU, memory, load average, disk per volume, and
event loop lag. Lag is the saturation signal that matters most here: CPU-heavy image
comparison blocks the loop and shows up on that panel well before requests start
failing.

**Metrics pipeline health** (collapsed) — scrape duration, domain cache age and
collection errors. Expand this when the usage numbers look stale or wrong; a cache age
climbing past `ANGLES_METRICS_CACHE_TTL_MS` means collection is failing and the numbers
above are being served from a stale cache.

## Notes on the queries

- **`or vector(0)` on the error-rate tile.** An instance that has served no 5xx at all
  produces an empty result, which renders as "No data" — indistinguishable from a
  broken panel on a headline health tile. `or vector(0)` makes it read 0.
- **`ignoring(state)` on host memory and disk usage.** Both divide/subtract series that
  carry different `state` labels; without `ignoring(state)` Prometheus finds no matching
  pairs and the panels are permanently blank. `volume` is deliberately *not* ignored on
  the disk query, so each volume keeps its own gauge.
- **p95 shows "No requests" when idle.** `histogram_quantile` is 0/0 → NaN with no
  traffic in the window. That is honest for a percentile, so the NaN is mapped to a
  label rather than papered over with a zero.
- **Colours use Grafana's semantic names** (`green`, `red`, `text`, `dark-blue`…) rather
  than fixed hex, so the dashboard stays legible in both light and dark themes. Build
  and execution statuses use the reserved status palette (PASS green, FAIL red, ERROR
  orange, SKIPPED neutral); latency percentiles use shades of one hue, since p50/p90/p99
  are magnitude on a single scale rather than distinct identities.

## Verified against

Grafana 13.1.3 and Prometheus, scraping a live Angles instance: all 46 panel queries
return data (the two 5xx panels legitimately return none when no server errors have
occurred), and the dashboard was render-tested in both light and dark themes.
