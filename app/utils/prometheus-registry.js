/**
 * A very small Prometheus text-exposition registry.
 *
 * Angles deliberately does not pull in `prom-client` for this: the endpoint only ever
 * *renders* metrics that are sampled on demand (from `os`, `process`, `fs.statfs` and a
 * cached set of Mongo counts), so none of the client library's machinery - histograms
 * with pre-allocated buckets, a global default registry, cluster aggregation - is used.
 * What is left is the text format itself, which is stable and specified.
 *
 * Format reference: one `# HELP` and one `# TYPE` line per metric family, followed by one
 * sample line per label permutation:
 *
 *   # HELP angles_builds_total Total number of builds stored.
 *   # TYPE angles_builds_total gauge
 *   angles_builds_total{team="core"} 42
 */

// Prometheus metric and label names are restricted to this character set; anything the
// registry is asked to emit is checked rather than trusted, because label *values* below
// are derived from user-supplied data (team names, environment names).
const NAME_PATTERN = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

/**
 * Escapes a label value: backslash, double quote and newline are the only characters the
 * exposition format gives meaning to. Team and environment names reach this function
 * straight from the database, so this is what keeps a name containing a quote from
 * producing a corrupt (unparseable) scrape body.
 */
const escapeLabelValue = (value) => String(value)
  .replace(/\\/g, '\\\\')
  .replace(/"/g, '\\"')
  .replace(/\n/g, '\\n');

/**
 * Renders a label set as `{a="1",b="2"}`, or an empty string when there are no labels.
 * Labels with a null/undefined value are dropped: an absent label is meaningful in
 * Prometheus (it does not match `{label="..."}`), whereas an empty one is a silent lie.
 */
const renderLabels = (labels) => {
  const entries = Object.entries(labels || {})
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => {
      if (!NAME_PATTERN.test(key)) {
        throw new Error(`Invalid Prometheus label name: ${key}`);
      }
      return `${key}="${escapeLabelValue(value)}"`;
    });
  return entries.length > 0 ? `{${entries.join(',')}}` : '';
};

/**
 * Renders a single metric family.
 *
 * @param {String} name - metric name, e.g. `angles_builds_total`
 * @param {String} type - `gauge` or `counter`
 * @param {String} help - single-line description
 * @param {Array}  samples - `[{ value, labels }]`
 * @returns {Array<String>} the lines for this family (empty when there are no samples)
 */
const renderMetric = (name, type, help, samples) => {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Prometheus metric name: ${name}`);
  }
  const valid = (samples || []).filter((sample) => Number.isFinite(sample.value));
  // A family with no samples is omitted entirely rather than emitted as a bare HELP/TYPE
  // pair. This matters for the optional collectors (disk, per-team counts): when one is
  // disabled or fails, its metric disappears instead of reporting a misleading zero.
  if (valid.length === 0) {
    return [];
  }
  const lines = [
    `# HELP ${name} ${String(help).replace(/\n/g, ' ')}`,
    `# TYPE ${name} ${type}`,
  ];
  valid.forEach((sample) => {
    lines.push(`${name}${renderLabels(sample.labels)} ${sample.value}`);
  });
  return lines;
};

/**
 * Renders a histogram family.
 *
 * A Prometheus histogram is three families under one name: `_bucket` (cumulative, one per
 * `le` upper bound plus a mandatory `le="+Inf"` equal to the total count), `_sum` and
 * `_count`. `histogram_quantile()` requires the `+Inf` bucket, so it is always emitted.
 *
 * @param {String} name - base name, e.g. `angles_http_request_duration_seconds`
 * @param {String} help - single-line description
 * @param {Array<Number>} bounds - the bucket upper bounds, ascending
 * @param {Array} series - `[{ labels, buckets, sum, count }]`
 */
const renderHistogram = (name, help, bounds, series) => {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Prometheus metric name: ${name}`);
  }
  if (!series || series.length === 0) {
    return [];
  }
  const lines = [
    `# HELP ${name} ${String(help).replace(/\n/g, ' ')}`,
    `# TYPE ${name} histogram`,
  ];
  series.forEach((entry) => {
    bounds.forEach((bound, index) => {
      const labels = renderLabels({ ...entry.labels, le: String(bound) });
      lines.push(`${name}_bucket${labels} ${entry.buckets[index]}`);
    });
    lines.push(`${name}_bucket${renderLabels({ ...entry.labels, le: '+Inf' })} ${entry.count}`);
    lines.push(`${name}_sum${renderLabels(entry.labels)} ${entry.sum}`);
    lines.push(`${name}_count${renderLabels(entry.labels)} ${entry.count}`);
  });
  return lines;
};

/**
 * Renders a list of metric definitions into a scrape body.
 * @param {Array} metrics - `[{ name, type, help, samples }]`, or `{ type: 'histogram',
 *   name, help, bounds, series }`
 * @returns {String} the exposition text, newline-terminated
 */
const render = (metrics) => {
  const lines = [];
  metrics.forEach((metric) => {
    if (metric.type === 'histogram') {
      lines.push(...renderHistogram(metric.name, metric.help, metric.bounds, metric.series));
    } else {
      lines.push(...renderMetric(metric.name, metric.type, metric.help, metric.samples));
    }
  });
  // The exposition format requires a trailing newline after the final sample.
  return `${lines.join('\n')}\n`;
};

module.exports = {
  render,
  renderMetric,
  renderHistogram,
  renderLabels,
  escapeLabelValue,
};
