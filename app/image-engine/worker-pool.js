const os = require('os');
const path = require('path');
const debug = require('debug');
const { Worker } = require('worker_threads');

const log = debug('image-engine:worker-pool');

// Small by default: image work is memory-heavy (WASM heap per worker for template
// matching) and a deep queue is preferable to an exhausted host.
const DEFAULT_POOL_SIZE = parseInt(process.env.IMAGE_ENGINE_WORKERS, 10)
  || Math.max(1, Math.min(2, os.cpus().length - 1));

// A single search/compare on capped-resolution images takes seconds, not minutes; a task
// running this long has hung and its worker is replaced.
const TASK_TIMEOUT_MS = parseInt(process.env.IMAGE_ENGINE_TASK_TIMEOUT_MS, 10) || 120000;

/**
 * Fixed-size worker_threads pool with a FIFO queue. Workers are spawned lazily on first
 * use and unref()ed so they never keep the process alive on their own; every pending
 * task holds a (ref'ed) timeout, which keeps the event loop alive until it settles.
 */
class WorkerPool {
  constructor(size = DEFAULT_POOL_SIZE, workerFile = path.join(__dirname, 'worker.js')) {
    this.size = size;
    this.workerFile = workerFile;
    this.workers = [];
    this.idleWorkers = [];
    this.queue = [];
    this.tasks = new Map();
    this.nextTaskId = 1;
  }

  spawnWorker() {
    const worker = new Worker(this.workerFile);
    worker.unref();
    worker.on('message', ({ id, result, error }) => {
      const entry = this.tasks.get(id);
      if (!entry) return; // task already timed out
      this.tasks.delete(id);
      clearTimeout(entry.timer);
      this.releaseWorker(worker);
      if (error) {
        const rehydrated = new Error(error.message);
        if (error.statusCode) rehydrated.statusCode = error.statusCode;
        entry.reject(rehydrated);
      } else {
        entry.resolve(result);
      }
    });
    worker.on('error', (workerError) => {
      log(`Image engine worker crashed: ${workerError}`);
      this.discardWorker(worker, workerError);
    });
    this.workers.push(worker);
    return worker;
  }

  /** Fails every task assigned to the worker and removes it from the pool. */
  discardWorker(worker, workerError) {
    this.workers = this.workers.filter((known) => known !== worker);
    this.idleWorkers = this.idleWorkers.filter((known) => known !== worker);
    this.tasks.forEach((entry, id) => {
      if (entry.worker === worker) {
        this.tasks.delete(id);
        clearTimeout(entry.timer);
        entry.reject(workerError instanceof Error
          ? workerError
          : new Error(`Image engine worker failed: ${workerError}`));
      }
    });
    worker.terminate();
    this.drainQueue();
  }

  releaseWorker(worker) {
    this.idleWorkers.push(worker);
    this.drainQueue();
  }

  drainQueue() {
    while (this.queue.length > 0) {
      let worker = this.idleWorkers.pop();
      if (!worker && this.workers.length < this.size) {
        worker = this.spawnWorker();
      }
      if (!worker) return; // every worker is busy - the task waits in the queue
      const job = this.queue.shift();
      const id = this.nextTaskId;
      this.nextTaskId += 1;
      const timer = setTimeout(() => {
        const entry = this.tasks.get(id);
        if (!entry) return;
        this.tasks.delete(id);
        const timeoutError = new Error(`Image engine task timed out after ${TASK_TIMEOUT_MS}ms`);
        entry.reject(timeoutError);
        // The worker is still grinding on the hung task, so it cannot be reused.
        this.discardWorker(entry.worker, timeoutError);
      }, TASK_TIMEOUT_MS);
      this.tasks.set(id, { ...job, timer, worker });
      worker.postMessage({ id, task: job.task, payload: job.payload });
    }
  }

  runTask(task, payload) {
    return new Promise((resolve, reject) => {
      this.queue.push({
        task, payload, resolve, reject,
      });
      this.drainQueue();
    });
  }
}

module.exports = new WorkerPool();
module.exports.WorkerPool = WorkerPool;
