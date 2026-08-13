const os = require('os');
const fs = require('fs');
const path = require('path');
const debug = require('debug');

const log = debug('metrics:resources');

// The two directories Angles writes image data to. They are resolved from __dirname (not
// the process CWD) to match multer-config-screenshots and image-utils, and are each their
// own Docker VOLUME, so they can sit on different filesystems to the app itself.
const SCREENSHOT_ROOT = path.resolve(__dirname, '../../screenshots');
const COMPARES_ROOT = path.resolve(__dirname, '../../compares');

/**
 * CPU usage has to be measured across an interval - `process.cpuUsage()` alone is a
 * monotonically increasing total, which is exactly what a Prometheus *counter* wants.
 * Both are exposed: the counters (`..._seconds_total`) are the ones to build alerts on,
 * because `rate()` over them is correct regardless of scrape interval, while the
 * point-in-time percentage gauge is convenient for dashboards and for humans reading a
 * single scrape.
 */
let lastCpuSample = { time: process.hrtime.bigint(), usage: process.cpuUsage() };

const sampleProcessCpuPercent = () => {
  const now = process.hrtime.bigint();
  const usage = process.cpuUsage();
  const elapsedMicros = Number(now - lastCpuSample.time) / 1000;
  // Two scrapes landing in the same microsecond would divide by zero; skip the sample
  // rather than emit Infinity (renderMetric would drop it, but this is clearer).
  if (elapsedMicros <= 0) {
    return null;
  }
  const userMicros = usage.user - lastCpuSample.usage.user;
  const systemMicros = usage.system - lastCpuSample.usage.system;
  lastCpuSample = { time: now, usage };
  // Relative to a single core, so a busy 4-core host can legitimately report 400.
  return ((userMicros + systemMicros) / elapsedMicros) * 100;
};

/**
 * Event loop lag: the delay between when a timer was due and when it actually ran. This
 * is the single most useful saturation signal for Angles, because the image engine does
 * CPU-heavy work and a blocked loop shows up here long before it shows up as a failed
 * request.
 *
 * Sampled continuously on an unref()ed timer so it never keeps the process alive.
 */
const LAG_INTERVAL_MS = 1000;
let loopLagMs = 0;
let lagTimer = null;

const startEventLoopMonitor = () => {
  if (lagTimer) {
    return lagTimer;
  }
  let expected = Date.now() + LAG_INTERVAL_MS;
  lagTimer = setInterval(() => {
    const now = Date.now();
    // Negative lag is not meaningful (the timer fired early); clamp at zero.
    loopLagMs = Math.max(0, now - expected);
    expected = now + LAG_INTERVAL_MS;
  }, LAG_INTERVAL_MS);
  lagTimer.unref();
  return lagTimer;
};

const stopEventLoopMonitor = () => {
  if (lagTimer) {
    clearInterval(lagTimer);
    lagTimer = null;
  }
};

/**
 * Disk usage for a directory's filesystem, via fs.statfs (Node 18.15+/20+). Returns null
 * when the path does not exist yet or the call fails, so a missing volume degrades to an
 * absent metric rather than a failed scrape.
 */
const readDiskUsage = async (directory) => {
  try {
    const stats = await fs.promises.statfs(directory);
    // bavail (available to unprivileged users) rather than bfree, which includes the
    // root-reserved blocks that the app can never actually use.
    const total = stats.blocks * stats.bsize;
    const available = stats.bavail * stats.bsize;
    const used = (stats.blocks - stats.bfree) * stats.bsize;
    return { total, available, used };
  } catch (err) {
    log('Could not stat filesystem for %s: %s', directory, err.message);
    return null;
  }
};

/**
 * Recursively totals the size and file count beneath a directory.
 *
 * This walks the tree, so unlike every other collector here its cost grows with the
 * number of stored screenshots. It is only called when ANGLES_METRICS_DISK_USAGE=true and
 * its result is cached by the caller; the filesystem-level gauges above are the cheap
 * always-on alternative.
 */
const measureDirectory = async (directory) => {
  let bytes = 0;
  let files = 0;
  const walk = async (current) => {
    let entries;
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch (err) {
      log('Could not read directory %s: %s', current, err.message);
      return;
    }
    // Sequential rather than Promise.all: a deep screenshots tree would otherwise open
    // thousands of file handles at once and hit EMFILE.
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        // eslint-disable-next-line no-await-in-loop
        await walk(entryPath);
      } else if (entry.isFile()) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const stat = await fs.promises.stat(entryPath);
          bytes += stat.size;
          files += 1;
        } catch (err) {
          // File deleted between readdir and stat (the cleanup cron runs concurrently).
          log('Could not stat %s: %s', entryPath, err.message);
        }
      }
    }
  };
  await walk(directory);
  return { bytes, files };
};

/**
 * Collects process- and host-level resource metrics.
 * @param {Boolean} includeDirectorySizes - whether to walk the image directories
 */
const collect = async (includeDirectorySizes = false) => {
  const memory = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  const [load1, load5, load15] = os.loadavg();

  const resources = {
    process: {
      cpuUserSeconds: cpuUsage.user / 1e6,
      cpuSystemSeconds: cpuUsage.system / 1e6,
      cpuPercent: sampleProcessCpuPercent(),
      residentMemoryBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
      uptimeSeconds: process.uptime(),
      eventLoopLagMs: loopLagMs,
    },
    host: {
      cpuCount: os.cpus().length,
      loadAverage1: load1,
      loadAverage5: load5,
      loadAverage15: load15,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: os.uptime(),
    },
    disk: {},
    directories: {},
  };

  const [screenshotDisk, comparesDisk] = await Promise.all([
    readDiskUsage(SCREENSHOT_ROOT),
    readDiskUsage(COMPARES_ROOT),
  ]);
  if (screenshotDisk) resources.disk.screenshots = screenshotDisk;
  if (comparesDisk) resources.disk.compares = comparesDisk;

  if (includeDirectorySizes) {
    const [screenshotSize, comparesSize] = await Promise.all([
      measureDirectory(SCREENSHOT_ROOT),
      measureDirectory(COMPARES_ROOT),
    ]);
    resources.directories.screenshots = screenshotSize;
    resources.directories.compares = comparesSize;
  }

  return resources;
};

module.exports = {
  collect,
  measureDirectory,
  readDiskUsage,
  startEventLoopMonitor,
  stopEventLoopMonitor,
  SCREENSHOT_ROOT,
  COMPARES_ROOT,
};
