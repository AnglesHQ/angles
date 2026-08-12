/* eslint-disable new-cap */
// jimp exports its constructor in lowercase, which trips new-cap on every `new jimp(...)`.
require('should');
const fs = require('fs');
const os = require('os');
const path = require('path');
const jimp = require('jimp');
const templateMatching = require('../app/image-engine/template-match.js');
const { InvalidRequestError } = require('../app/exceptions/errors.js');

// These tests exercise the matching engine directly with generated fixtures; they do not
// need the API server or the database.
describe('Template matching engine', () => {
  let fixtureDir;
  let screenshotPath;
  let templatePath;

  // The sprite is drawn with structure (not a flat colour) so normalized cross-correlation
  // has a real signal to lock on to.
  const drawSprite = (sprite) => {
    const { width, height } = sprite.bitmap;
    for (let x = 0; x < width; x += 1) {
      for (let y = 0; y < height; y += 1) {
        const checker = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
        sprite.setPixelColor(checker ? 0xdd3311ff : 0x22ddaaff, x, y);
      }
    }
  };

  const SPRITE_WIDTH = 90;
  const SPRITE_HEIGHT = 60;
  const SPRITE_LOCATION = { x: 260, y: 140 };
  const SPRITE_SCALE = 1.2;

  before(async function generateFixtures() {
    this.timeout(30000);
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'angles-template-matching-'));
    screenshotPath = path.join(fixtureDir, 'screenshot.png');
    templatePath = path.join(fixtureDir, 'template.png');

    const sprite = new jimp(SPRITE_WIDTH, SPRITE_HEIGHT, 0xffffffff);
    drawSprite(sprite);
    await sprite.writeAsync(templatePath);

    // Background with deterministic texture, plus the sprite composited at a known
    // location and scale — the engine has to recover both.
    const screenshot = new jimp(640, 400, 0x202030ff);
    for (let x = 0; x < 640; x += 1) {
      for (let y = 0; y < 400; y += 1) {
        if ((x * 7 + y * 13) % 97 === 0) {
          screenshot.setPixelColor(0x8888ccff, x, y);
        }
      }
    }
    const scaledSprite = sprite.clone().resize(
      Math.round(SPRITE_WIDTH * SPRITE_SCALE),
      Math.round(SPRITE_HEIGHT * SPRITE_SCALE),
    );
    screenshot.composite(scaledSprite, SPRITE_LOCATION.x, SPRITE_LOCATION.y);
    await screenshot.writeAsync(screenshotPath);
  });

  after(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('finds a scaled template at the correct location', async function test() {
    this.timeout(30000);
    const result = await templateMatching.findTemplate(screenshotPath, templatePath, {
      scaleMin: 0.8,
      scaleMax: 1.4,
    });
    result.matches.length.should.equal(1);
    const match = result.bestMatch;
    match.confidence.should.be.above(0.9);
    match.x.should.be.approximately(SPRITE_LOCATION.x, 3);
    match.y.should.be.approximately(SPRITE_LOCATION.y, 3);
    match.scale.should.be.approximately(SPRITE_SCALE, 0.06);
    result.imageDimensions.should.deepEqual({ width: 640, height: 400 });
    result.templateDimensions.should.deepEqual({ width: SPRITE_WIDTH, height: SPRITE_HEIGHT });
  });

  it('finds multiple occurrences when maxMatches allows it', async function test() {
    this.timeout(30000);
    const screenshot = await jimp.read(screenshotPath);
    const sprite = await jimp.read(templatePath);
    screenshot.composite(sprite, 30, 250);
    const multiPath = path.join(fixtureDir, 'screenshot-multi.png');
    await screenshot.writeAsync(multiPath);

    const result = await templateMatching.findTemplate(multiPath, templatePath, {
      scaleMin: 0.8,
      scaleMax: 1.4,
      maxMatches: 5,
    });
    result.matches.length.should.equal(2);
    const sortedByX = [...result.matches].sort((a, b) => a.x - b.x);
    sortedByX[0].x.should.be.approximately(30, 3);
    sortedByX[0].y.should.be.approximately(250, 3);
    sortedByX[1].x.should.be.approximately(SPRITE_LOCATION.x, 3);
  });

  it('returns no matches when the template is not present', async function test() {
    this.timeout(30000);
    // Structured (diagonal stripes) so the correlation is well-defined, but nothing like
    // the checkerboard sprite in the screenshot.
    const absentSprite = new jimp(SPRITE_WIDTH, SPRITE_HEIGHT, 0xffffffff);
    for (let x = 0; x < SPRITE_WIDTH; x += 1) {
      for (let y = 0; y < SPRITE_HEIGHT; y += 1) {
        if ((x + y) % 14 < 7) {
          absentSprite.setPixelColor(0x1144ffff, x, y);
        }
      }
    }
    const absentPath = path.join(fixtureDir, 'absent-template.png');
    await absentSprite.writeAsync(absentPath);
    const result = await templateMatching.findTemplate(screenshotPath, absentPath, {
      minConfidence: 0.95,
    });
    result.matches.length.should.equal(0);
    (result.bestMatch === null).should.be.true();
  });

  it('rejects a flat-colour template that cannot be matched', async function test() {
    this.timeout(30000);
    const flatSprite = new jimp(SPRITE_WIDTH, SPRITE_HEIGHT, 0xffffffff);
    const flatPath = path.join(fixtureDir, 'flat-template.png');
    await flatSprite.writeAsync(flatPath);
    await templateMatching.findTemplate(screenshotPath, flatPath, {})
      .should.be.rejectedWith(InvalidRequestError);
  });

  it('rejects a template larger than the screenshot at every scale', async function test() {
    this.timeout(30000);
    await templateMatching.findTemplate(templatePath, screenshotPath, { scaleMin: 1, scaleMax: 1 })
      .should.be.rejectedWith(InvalidRequestError);
  });

  it('rejects scaleMin greater than scaleMax', async function test() {
    this.timeout(30000);
    await templateMatching.findTemplate(screenshotPath, templatePath, { scaleMin: 2, scaleMax: 1 })
      .should.be.rejectedWith(InvalidRequestError);
  });

  it('annotates matches onto a copy of the screenshot', async function test() {
    this.timeout(30000);
    const result = await templateMatching.findTemplate(screenshotPath, templatePath, {
      scaleMin: 0.8,
      scaleMax: 1.4,
    });
    const outputPath = path.join(fixtureDir, 'annotated.png');
    const annotatedPath = await templateMatching.annotateMatches(
      screenshotPath,
      result.matches,
      outputPath,
    );
    fs.existsSync(annotatedPath).should.be.true();
    const annotated = await jimp.read(annotatedPath);
    // The border pixel at the top-left corner of the match should be the magenta marker.
    const corner = annotated.getPixelColor(result.bestMatch.x, result.bestMatch.y);
    corner.should.equal(jimp.rgbaToInt(255, 0, 255, 255));
  });
});
