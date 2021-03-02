
const fs = require('fs');
const path = require('path');
const debug = require('debug');
const fsPromises = require('fs').promises;
const compareImages = require('resemblejs/compareImages');

const imageUtils = {};

const log = debug('screenshot:utility');

const defaultOptions = {
  output: {
    errorColor: { red: 255, green: 0, blue: 255 },
    errorType: 'movement',
    transparency: 0.3,
    largeImageThreshold: 1200,
    useCrossOrigin: false,
    outputDiff: true,
  },
  scaleToSameSize: true,
  ignore: 'less',
};

imageUtils.compareImages = (screenshot, screenshotToCompare, ignoreBoxes, useCache) => {
  // create name based on the two id's
  const tempFileName = `compares/${screenshotToCompare.id}_${screenshot.id}-compare.png`;
  // set ignore boxes to use.
  if (screenshotToCompare) defaultOptions.output.ignoreBoxes = ignoreBoxes;
  // check if the file already exists
  return new Promise((resolve) => {
    fs.access(tempFileName, fs.F_OK, (err) => {
      // file doesn't exists then create it by doing the compare.
      if (err || useCache === 'false') {
        const loadImagesPromises = [
          fsPromises.readFile(screenshotToCompare.path),
          fsPromises.readFile(screenshot.path),
        ];
        return Promise.all(loadImagesPromises)
          .then((imageLoadResults) => {
            compareImages(
              imageLoadResults[0],
              imageLoadResults[1],
              defaultOptions,
            )
              .then((data) => fsPromises.writeFile(path.resolve(tempFileName), data.getBuffer()))
              .then(() => resolve(path.resolve(tempFileName)));
          });
      }
      // if file exists and useCache is true
      return resolve(path.resolve(tempFileName));
    });
  });
};

module.exports = imageUtils;
