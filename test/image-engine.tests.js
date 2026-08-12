/* eslint-disable new-cap */
// jimp exports its constructor in lowercase, which trips new-cap on every `new jimp(...)`.
require('should');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jimp = require('jimp');
const pixel = require('../app/image-engine/pixel.js');
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
