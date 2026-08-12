/* eslint-disable new-cap */
// jimp exports its constructor in lowercase, which trips new-cap on every `new jimp(...)`.
require('should');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jimp = require('jimp');
const pixel = require('../app/image-engine/pixel.js');
const ssim = require('../app/image-engine/ssim.js');
const phash = require('../app/image-engine/phash.js');
const engine = require('../app/image-engine/index.js');
const { optionsHash } = require('../app/image-engine/cache.js');
const { InvalidRequestError } = require('../app/exceptions/errors.js');

// Exercises the pixel comparison strategy directly, and the worker pool through the
// engine facade; no API server or database is required.
describe('Image engine', () => {
  let fixtureDir;

  const writeImage = async (name, width, height, painter) => {
    const image = new jimp(width, height, 0xffffffff);
    if (painter) painter(image);
    const filePath = path.join(fixtureDir, name);
    await image.writeAsync(filePath);
    return filePath;
  };

  const paintCheckerboard = (image) => {
    const { width, height } = image.bitmap;
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) {
        const checker = (Math.floor(x / 10) + Math.floor(y / 10)) % 2 === 0;
        image.setPixelColor(checker ? 0x336699ff : 0xddaa22ff, x, y);
      }
    }
  };

  before(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'angles-image-engine-'));
  });

  after(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  describe('pixel comparison', () => {
    it('reports zero mismatch for identical images', async () => {
      const a = await writeImage('identical-a.png', 200, 100, paintCheckerboard);
      const b = await writeImage('identical-b.png', 200, 100, paintCheckerboard);
      const result = await pixel.compareStats(a, b);
      result.isSameDimensions.should.be.true();
      result.rawMisMatchPercentage.should.equal(0);
    });

    it('letterboxes different aspect ratios instead of stretching', async () => {
      // Same checkerboard content; the second image is taller. Stretch-resizing (the old
      // behaviour) would misalign the pattern and report a huge mismatch; comparing the
      // shared region reports (near) zero.
      const a = await writeImage('letterbox-a.png', 200, 100, paintCheckerboard);
      const b = await writeImage('letterbox-b.png', 200, 160, paintCheckerboard);
      const result = await pixel.compareStats(a, b);
      result.isSameDimensions.should.be.false();
      result.dimensionDifference.should.deepEqual({ width: 0, height: -60 });
      result.rawMisMatchPercentage.should.be.below(1);
    });

    it('writes a union-sized diff image for mismatched dimensions', async () => {
      const a = await writeImage('union-a.png', 200, 100, paintCheckerboard);
      const b = await writeImage('union-b.png', 150, 160, paintCheckerboard);
      const outputFile = path.join(fixtureDir, 'union-diff.png');
      const result = await pixel.compareAndWriteDiff(a, b, outputFile);
      fs.existsSync(result.diffPath).should.be.true();
      const diffImage = await jimp.read(result.diffPath);
      diffImage.bitmap.width.should.equal(200);
      diffImage.bitmap.height.should.equal(160);
    });

    it('honours the threshold option', async () => {
      // Second image gets a subtle uniform colour shift: visible at threshold 0,
      // ignored at a lenient threshold.
      const a = await writeImage('threshold-a.png', 100, 100, paintCheckerboard);
      const b = await writeImage('threshold-b.png', 100, 100, (image) => {
        paintCheckerboard(image);
        image.color([{ apply: 'lighten', params: [4] }]);
      });
      const strict = await pixel.compareStats(a, b, { threshold: 0 });
      const lenient = await pixel.compareStats(a, b, { threshold: 0.5 });
      strict.rawMisMatchPercentage.should.be.above(50);
      lenient.rawMisMatchPercentage.should.equal(0);
    });

    it('skips differences inside ignored boxes', async () => {
      const a = await writeImage('ignore-a.png', 100, 100, paintCheckerboard);
      const b = await writeImage('ignore-b.png', 100, 100, (image) => {
        paintCheckerboard(image);
        for (let x = 10; x < 40; x += 1) {
          for (let y = 10; y < 40; y += 1) {
            image.setPixelColor(0xff0000ff, x, y);
          }
        }
      });
      const unmasked = await pixel.compareStats(a, b);
      const masked = await pixel.compareStats(a, b, {
        ignoredBoxes: [{
          left: 10, right: 40, top: 10, bottom: 40,
        }],
      });
      unmasked.rawMisMatchPercentage.should.be.above(4);
      masked.rawMisMatchPercentage.should.equal(0);
    });
  });

  describe('pixel diff regions', () => {
    it('clusters changed pixels into distinct bounding regions', async () => {
      const a = await writeImage('regions-a.png', 300, 200, paintCheckerboard);
      const b = await writeImage('regions-b.png', 300, 200, (image) => {
        paintCheckerboard(image);
        // Two separate changes, far apart.
        for (let x = 20; x < 60; x += 1) {
          for (let y = 20; y < 50; y += 1) image.setPixelColor(0xff0000ff, x, y);
        }
        for (let x = 220; x < 260; x += 1) {
          for (let y = 140; y < 170; y += 1) image.setPixelColor(0x00ff00ff, x, y);
        }
      });
      const result = await pixel.compareStats(a, b, { threshold: 0.1, regions: true });
      result.regions.length.should.equal(2);
      const sorted = [...result.regions].sort((r1, r2) => r1.x - r2.x);
      sorted[0].x.should.be.belowOrEqual(20);
      (sorted[0].x + sorted[0].width).should.be.aboveOrEqual(60);
      sorted[1].x.should.be.belowOrEqual(220);
      sorted[0].pixels.should.be.above(0);
    });

    it('returns no regions for identical images', async () => {
      const a = await writeImage('regions-same-a.png', 100, 100, paintCheckerboard);
      const b = await writeImage('regions-same-b.png', 100, 100, paintCheckerboard);
      const result = await pixel.compareStats(a, b, { regions: true });
      result.regions.length.should.equal(0);
    });
  });

  describe('ssim comparison', () => {
    it('scores identical images as fully similar', async () => {
      const a = await writeImage('ssim-a.png', 120, 90, paintCheckerboard);
      const b = await writeImage('ssim-b.png', 120, 90, paintCheckerboard);
      const result = await ssim.compareStats(a, b);
      result.algorithm.should.equal('ssim');
      result.ssim.should.equal(1);
      result.rawMisMatchPercentage.should.equal(0);
    });

    it('tolerates subtle uniform shifts better than a strict pixel compare', async () => {
      const a = await writeImage('ssim-shift-a.png', 120, 90, paintCheckerboard);
      const b = await writeImage('ssim-shift-b.png', 120, 90, (image) => {
        paintCheckerboard(image);
        image.color([{ apply: 'lighten', params: [4] }]);
      });
      const ssimResult = await ssim.compareStats(a, b);
      const strictPixel = await pixel.compareStats(a, b, { threshold: 0 });
      // The uniform lighten floods a strict pixel compare but barely moves SSIM.
      strictPixel.rawMisMatchPercentage.should.be.above(50);
      ssimResult.rawMisMatchPercentage.should.be.below(5);
    });

    it('letterboxes mismatched dimensions and writes a diff image', async () => {
      const a = await writeImage('ssim-lb-a.png', 120, 90, paintCheckerboard);
      const b = await writeImage('ssim-lb-b.png', 120, 140, paintCheckerboard);
      const outputFile = path.join(fixtureDir, 'ssim-diff.png');
      const result = await ssim.compareAndWriteDiff(a, b, outputFile);
      result.isSameDimensions.should.be.false();
      fs.existsSync(result.diffPath).should.be.true();
      const diffImage = await jimp.read(result.diffPath);
      diffImage.bitmap.height.should.equal(140);
    });
  });

  describe('phash comparison', () => {
    it('reports near-zero distance for a resized copy of the same image', async () => {
      const a = await writeImage('phash-a.png', 200, 150, paintCheckerboard);
      const original = await jimp.read(a);
      const resizedPath = path.join(fixtureDir, 'phash-a-resized.png');
      await original.resize(100, 75).writeAsync(resizedPath);
      const result = await phash.compareStats(a, resizedPath);
      result.algorithm.should.equal('phash');
      result.distance.should.be.below(0.1);
      result.isSameDimensions.should.be.false();
    });

    it('reports a clear distance for different content', async () => {
      // pHash captures low-frequency structure, so the second image needs a genuinely
      // different layout (asymmetric blocks), not just a different repeating texture.
      const a = await writeImage('phash-diff-a.png', 100, 100, paintCheckerboard);
      const b = await writeImage('phash-diff-b.png', 100, 100, (image) => {
        for (let x = 0; x < 45; x += 1) {
          for (let y = 0; y < 70; y += 1) image.setPixelColor(0x111111ff, x, y);
        }
        for (let x = 60; x < 100; x += 1) {
          for (let y = 80; y < 100; y += 1) image.setPixelColor(0x666666ff, x, y);
        }
      });
      const result = await phash.compareStats(a, b);
      result.distance.should.be.above(0.15);
    });
  });

  describe('worker pool facade', () => {
    it('runs pixel comparisons on the pool', async function test() {
      this.timeout(30000);
      const a = await writeImage('pool-a.png', 100, 100, paintCheckerboard);
      const b = await writeImage('pool-b.png', 100, 100, paintCheckerboard);
      const result = await engine.compareStats(a, b);
      result.rawMisMatchPercentage.should.equal(0);
    });

    it('runs concurrent tasks without mixing up results', async function test() {
      this.timeout(30000);
      const a = await writeImage('concurrent-a.png', 100, 100, paintCheckerboard);
      const b = await writeImage('concurrent-b.png', 100, 100, paintCheckerboard);
      const c = await writeImage('concurrent-c.png', 100, 100, (image) => {
        paintCheckerboard(image);
        image.invert();
      });
      const [same, different] = await Promise.all([
        engine.compareStats(a, b),
        engine.compareStats(a, c),
      ]);
      same.rawMisMatchPercentage.should.equal(0);
      different.rawMisMatchPercentage.should.be.above(40);
    });

    it('routes algorithm selection through the pool', async function test() {
      this.timeout(30000);
      const a = await writeImage('pool-algo-a.png', 100, 100, paintCheckerboard);
      const b = await writeImage('pool-algo-b.png', 100, 100, paintCheckerboard);
      const result = await engine.compareStats(a, b, { algorithm: 'ssim' });
      result.algorithm.should.equal('ssim');
      result.ssim.should.equal(1);
    });

    it('rejects an unknown algorithm with a 400 statusCode', async function test() {
      this.timeout(30000);
      const a = await writeImage('pool-bad-algo.png', 50, 50, paintCheckerboard);
      try {
        await engine.compareStats(a, a, { algorithm: 'nope' });
        throw new Error('expected compareStats to reject');
      } catch (error) {
        error.statusCode.should.equal(400);
      }
    });

    it('preserves statusCode on errors crossing the thread boundary', async function test() {
      this.timeout(30000);
      const image = await writeImage('error-image.png', 100, 100, paintCheckerboard);
      const flatTemplate = await writeImage('error-flat.png', 30, 30);
      try {
        await engine.findTemplate(image, flatTemplate, {});
        throw new Error('expected findTemplate to reject');
      } catch (error) {
        error.statusCode.should.equal(new InvalidRequestError('x').statusCode);
        error.message.should.match(/flat colour/);
      }
    });
  });

  describe('cache keys', () => {
    it('changes when the options change', () => {
      const base = optionsHash({ threshold: 0.5 });
      optionsHash({ threshold: 0.1 }).should.not.equal(base);
      optionsHash({ threshold: 0.5 }).should.equal(base);
      optionsHash(undefined).should.equal(optionsHash({}));
    });
  });
});
