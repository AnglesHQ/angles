const path = require('path');
const debug = require('debug');
const fsPromises = require('fs').promises;
const jimp = require('jimp');
// OpenCV compiled to WebAssembly: no native build step, but the runtime initialises
// asynchronously, so every entry point below has to wait on getCv() first.
const cvModule = require('@techstark/opencv-js');
const { InvalidRequestError } = require('../exceptions/errors.js');

const log = debug('screenshot:template-matching');

const templateMatching = {};

// Screenshots larger than this (longest edge) are downscaled before searching so a big
// mobile capture cannot exhaust the WASM heap or stall the event loop. Matches are mapped
// back to original-image coordinates before being returned.
const MAX_SEARCH_EDGE = 2000;

// The scale sweep runs in additive steps; anything finer than this roughly doubles the
// cost for no measurable gain in confidence, since NCC tolerates small scale error.
const SCALE_STEP = 0.05;

// Per scale pass, stop harvesting peaks after this many; global non-maximum suppression
// across scales reduces them further to maxMatches.
const MAX_CANDIDATES_PER_SCALE = 20;

const DEFAULT_OPTIONS = {
  minConfidence: 0.8,
  scaleMin: 0.75,
  scaleMax: 1.25,
  maxMatches: 1,
  grayscale: false,
};

let cvReadyPromise;
const getCv = () => {
  if (!cvReadyPromise) {
    cvReadyPromise = new Promise((resolve) => {
      if (cvModule.Mat) {
        resolve(cvModule);
      } else if (typeof cvModule.then === 'function') {
        cvModule.then(resolve);
      } else {
        cvModule.onRuntimeInitialized = () => resolve(cvModule);
      }
    });
  }
  return cvReadyPromise;
};

const toMat = (cv, image) => cv.matFromImageData({
  data: image.bitmap.data,
  width: image.bitmap.width,
  height: image.bitmap.height,
});

/**
 * Normalized cross-correlation divides by the template's variance, so a template that is
 * a single flat colour makes every score meaningless (0/0). Detect that up front and
 * refuse it with an actionable message instead of returning bogus high-confidence matches.
 */
const assertTemplateHasDetail = (template) => {
  const { data } = template.bitmap;
  let sum = 0;
  let sumOfSquares = 0;
  const sampleCount = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const luminance = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sum += luminance;
    sumOfSquares += luminance * luminance;
  }
  const mean = sum / sampleCount;
  const variance = (sumOfSquares / sampleCount) - (mean * mean);
  if (variance < 1) {
    throw new InvalidRequestError('The template image is a flat colour with no visual detail, so it cannot be reliably matched');
  }
};

/**
 * Collect all correlation peaks above minConfidence for one scale pass. Each accepted
 * peak blanks out a template-sized neighbourhood in the result matrix so the same match
 * is not returned twice at near-identical positions.
 */
const harvestPeaks = (cv, result, templateWidth, templateHeight, scale, minConfidence) => {
  const peaks = [];
  for (let i = 0; i < MAX_CANDIDATES_PER_SCALE; i += 1) {
    const { maxVal, maxLoc } = cv.minMaxLoc(result);
    if (maxVal < minConfidence) break;
    peaks.push({
      x: maxLoc.x,
      y: maxLoc.y,
      width: templateWidth,
      height: templateHeight,
      confidence: maxVal,
      scale,
    });
    const x0 = Math.max(0, maxLoc.x - Math.floor(templateWidth / 2));
    const y0 = Math.max(0, maxLoc.y - Math.floor(templateHeight / 2));
    const suppressWidth = Math.min(templateWidth, result.cols - x0);
    const suppressHeight = Math.min(templateHeight, result.rows - y0);
    const region = result.roi(new cv.Rect(x0, y0, suppressWidth, suppressHeight));
    region.setTo(new cv.Scalar(-1));
    region.delete();
  }
  return peaks;
};

const overlapRatio = (a, b) => {
  const intersectWidth = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const intersectHeight = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (intersectWidth <= 0 || intersectHeight <= 0) return 0;
  const intersection = intersectWidth * intersectHeight;
  const smallerArea = Math.min(a.width * a.height, b.width * b.height);
  return intersection / smallerArea;
};

/**
 * Non-maximum suppression across all scale passes: the same on-screen element is found
 * at several neighbouring scales, so keep only the highest-confidence box of each
 * overlapping cluster.
 */
const suppressOverlappingMatches = (candidates, maxMatches) => {
  const sorted = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const kept = [];
  sorted.forEach((candidate) => {
    if (kept.length >= maxMatches) return;
    if (kept.every((match) => overlapRatio(candidate, match) < 0.3)) {
      kept.push(candidate);
    }
  });
  return kept;
};

/**
 * Find occurrences of a template image inside a screenshot image.
 * @param {string} imagePath - path of the screenshot to search in.
 * @param {string|Buffer} templateSource - path or buffer of the template to search for.
 * @param {Object} [searchOptions] - minConfidence (0-1), scaleMin/scaleMax (template
 *   scale sweep bounds), maxMatches, grayscale (match on luminance only, which is more
 *   tolerant of colour shifts between devices).
 * @returns {Promise<Object>} { matches, bestMatch, imageDimensions, templateDimensions,
 *   analysisTime } with coordinates in original-image pixels.
 */
templateMatching.findTemplate = async (imagePath, templateSource, searchOptions) => {
  const start = Date.now();
  const options = { ...DEFAULT_OPTIONS, ...searchOptions };
  if (options.scaleMin > options.scaleMax) {
    throw new InvalidRequestError('scaleMin must be less than or equal to scaleMax');
  }
  const cv = await getCv();
  const [image, template] = await Promise.all([jimp.read(imagePath), jimp.read(templateSource)]);
  const imageDimensions = { width: image.bitmap.width, height: image.bitmap.height };
  const templateDimensions = { width: template.bitmap.width, height: template.bitmap.height };

  // Downscale oversized screenshots before searching; searchScale maps results back.
  const longEdge = Math.max(image.bitmap.width, image.bitmap.height);
  const searchScale = longEdge > MAX_SEARCH_EDGE ? MAX_SEARCH_EDGE / longEdge : 1;
  if (searchScale < 1) {
    image.resize(
      Math.round(image.bitmap.width * searchScale),
      Math.round(image.bitmap.height * searchScale),
    );
    template.resize(
      Math.max(1, Math.round(template.bitmap.width * searchScale)),
      Math.max(1, Math.round(template.bitmap.height * searchScale)),
    );
  }
  if (options.grayscale) {
    image.grayscale();
    template.grayscale();
  }
  assertTemplateHasDetail(template);

  const imageMat = toMat(cv, image);
  const candidates = [];
  let scalesSearched = 0;
  try {
    for (let scale = options.scaleMin; scale <= options.scaleMax + 1e-9; scale += SCALE_STEP) {
      const scaledWidth = Math.round(template.bitmap.width * scale);
      const scaledHeight = Math.round(template.bitmap.height * scale);
      // A template that does not fit inside the screenshot at this scale cannot match.
      if (scaledWidth < 2 || scaledHeight < 2
        || scaledWidth > image.bitmap.width || scaledHeight > image.bitmap.height) {
        // eslint-disable-next-line no-continue
        continue;
      }
      scalesSearched += 1;
      const scaledTemplate = template.clone().resize(scaledWidth, scaledHeight);
      const templateMat = toMat(cv, scaledTemplate);
      const result = new cv.Mat();
      try {
        cv.matchTemplate(imageMat, templateMat, result, cv.TM_CCOEFF_NORMED);
        harvestPeaks(cv, result, scaledWidth, scaledHeight, scale, options.minConfidence)
          .forEach((peak) => candidates.push(peak));
      } finally {
        templateMat.delete();
        result.delete();
      }
    }
  } finally {
    imageMat.delete();
  }
  if (scalesSearched === 0) {
    throw new InvalidRequestError('The template image is larger than the screenshot at every requested scale, so it cannot be searched for');
  }

  const matches = suppressOverlappingMatches(candidates, options.maxMatches)
    .map((match) => ({
      x: Math.round(match.x / searchScale),
      y: Math.round(match.y / searchScale),
      width: Math.round(match.width / searchScale),
      height: Math.round(match.height / searchScale),
      confidence: Number(match.confidence.toFixed(4)),
      scale: Number(match.scale.toFixed(2)),
    }));
  log(`Searched ${scalesSearched} scales in ${Date.now() - start}ms, found ${matches.length} match(es)`);
  return {
    matches,
    bestMatch: matches.length > 0 ? matches[0] : null,
    imageDimensions,
    templateDimensions,
    analysisTime: Date.now() - start,
  };
};

// Matched regions are outlined in the same magenta the pixel diff uses, so both kinds of
// result image read the same way in the UI.
const MATCH_BORDER_COLOR = jimp.rgbaToInt(255, 0, 255, 255);
const MATCH_BORDER_THICKNESS = 3;

const drawBorder = (image, match) => {
  const { width, height } = image.bitmap;
  const right = Math.min(match.x + match.width, width - 1);
  const bottom = Math.min(match.y + match.height, height - 1);
  const left = Math.max(match.x, 0);
  const top = Math.max(match.y, 0);
  for (let t = 0; t < MATCH_BORDER_THICKNESS; t += 1) {
    for (let x = left; x <= right; x += 1) {
      if (top + t < height) image.setPixelColor(MATCH_BORDER_COLOR, x, top + t);
      if (bottom - t >= 0) image.setPixelColor(MATCH_BORDER_COLOR, x, bottom - t);
    }
    for (let y = top; y <= bottom; y += 1) {
      if (left + t < width) image.setPixelColor(MATCH_BORDER_COLOR, left + t, y);
      if (right - t >= 0) image.setPixelColor(MATCH_BORDER_COLOR, right - t, y);
    }
  }
};

/**
 * Draw the matched regions onto a copy of the screenshot and write it to outputFile.
 * @returns {Promise<string>} absolute path of the annotated PNG.
 */
templateMatching.annotateMatches = async (imagePath, matches, outputFile) => {
  const image = await jimp.read(imagePath);
  matches.forEach((match) => drawBorder(image, match));
  const buffer = await image.getBufferAsync(jimp.MIME_PNG);
  const absolutePath = path.resolve(outputFile);
  await fsPromises.writeFile(absolutePath, buffer);
  return absolutePath;
};

module.exports = templateMatching;
