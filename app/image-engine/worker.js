const { parentPort } = require('worker_threads');
const pixel = require('./pixel.js');
const templateMatch = require('./template-match.js');

/**
 * Runs the CPU-heavy image work off the main thread. One message per task; the reply
 * carries either the result or a serialised error (message + statusCode) so the main
 * thread can rehydrate typed errors and controllers keep returning 400s for user input
 * problems instead of 500s.
 */
const handlers = {
  'pixel-compare': ({ path1, path2, options }) => pixel.compareStats(path1, path2, options),
  'pixel-compare-image': ({
    path1, path2, outputFile, options,
  }) => pixel.compareAndWriteDiff(path1, path2, outputFile, options),
  'find-template': ({ imagePath, templateSource, options }) => {
    // Buffers arrive as plain Uint8Arrays after the structured clone.
    const source = (templateSource instanceof Uint8Array && !Buffer.isBuffer(templateSource))
      ? Buffer.from(templateSource)
      : templateSource;
    return templateMatch.findTemplate(imagePath, source, options);
  },
};

parentPort.on('message', async ({ id, task, payload }) => {
  try {
    const handler = handlers[task];
    if (!handler) {
      throw new Error(`Unknown image-engine task: ${task}`);
    }
    const result = await handler(payload);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: { message: error.message, statusCode: error.statusCode },
    });
  }
});
