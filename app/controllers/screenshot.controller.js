const { validationResult } = require('express-validator');
const fs = require('fs');
const debug = require('debug');
const path = require('path');
const mongoose = require('mongoose');
const { compare } = require('resemblejs');
const sizeOf = require('image-size');
const jimp = require('jimp');
const Screenshot = require('../models/screenshot.js');
const Build = require('../models/build.js');
const Baseline = require('../models/baseline.js');
const validationUtils = require('../utils/validation-utils.js');
const imageUtils = require('../utils/image-utils.js');
const {
  NotFoundError,
  ServerError,
  InvalidRequestError,
  handleError,
} = require('../exceptions/errors.js');

const log = debug('screenshot:controller');

/**
 * There are only specific values we want to store for platform details.
 * @param platformDetails
 * @returns {{}}
 */
const extractPlatformDetails = (platformDetails) => {
  const {
    platformName,
    platformVersion,
    browserName,
    browserVersion,
    deviceName,
  } = platformDetails;
  let platformToStore = {};
  if (platformName) platformToStore = { platformName, ...platformToStore };
  if (platformVersion) platformToStore = { platformVersion, ...platformToStore };
  if (browserName) platformToStore = { browserName, ...platformToStore };
  if (browserVersion) platformToStore = { browserVersion, ...platformToStore };
  if (deviceName) platformToStore = { deviceName, ...platformToStore };
  return platformToStore;
};

exports.create = (req, res) => {
  // run validation here.
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  let build;
  const {
    buildId,
    timestamp,
    view,
    tags,
  } = req.body;
  return Build.findById(buildId)
    .then((foundBuild) => {
      if (!foundBuild) {
        throw new NotFoundError(`No build found with id ${buildId}`);
      }
      build = foundBuild;
      const promises = [
        jimp.read(req.file.path)
          .then((image) => image
            .scaleToFit(300, 300)
            .quality(72)
            .getBase64Async(image.getMIME())),
        sizeOf(req.file.path),
      ];
      return Promise.all(promises);
    })
    .then((results) => {
      const thumbnailBuffer = results[0];
      const dimensions = results[1];
      const thumbnail = thumbnailBuffer;
      const screenshot = new Screenshot({
        build: build._id,
        timestamp,
        thumbnail,
        height: dimensions.height,
        width: dimensions.width,
        path: req.file.path,
        type: 'DEFAULT',
        view,
      });
      const platform = extractPlatformDetails(req.body);
      if (Object.entries(platform).length > 0) {
        screenshot.platform = platform;
        screenshot.platformId = validationUtils.generatePlatformId(platform, screenshot);
      }
      if (tags) {
        screenshot.tags = JSON.parse(tags);
      }
      return screenshot.save();
    })
    .then((savedScreenshot) => {
      log(`Created screenshot "${savedScreenshot.path}", view "${savedScreenshot.view}" build "${savedScreenshot.build}", with id: "${savedScreenshot._id}"`);
      return res.status(201).send(savedScreenshot);
    })
    .catch((error) => handleError(error, res));
};

exports.createFail = (error, req, res) => res.status(400).send({ error: error.message });

// TODO: check query
exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const {
    buildId,
    view,
    platformId,
    screenshotIds,
  } = req.query;

  const limit = parseInt(req.query.limit, 10) || 0;
  const skip = parseInt(req.query.skip, 10) || 0;
  const options = { skip };
  if (limit > 0) { options.limit = limit; }

  let findScreenshotsPromise;
  // use buildId
  if (buildId) {
    findScreenshotsPromise = Build.findById({ _id: buildId })
      .then((buildFound) => {
        if (!buildFound) {
          throw new NotFoundError(`No build found with id ${buildId}`);
        }
        const query = { build: mongoose.Types.ObjectId(buildId) };
        if (view) { query.view = view; }
        if (platformId) { query.platformId = platformId; }
        return Screenshot.find(query, null, options);
      });
  } else if (screenshotIds) {
    const query = { _id: { $in: screenshotIds.split(',') } };
    if (view) { query.view = view; }
    if (platformId) { query.platformId = platformId; }
    findScreenshotsPromise = Screenshot.find(query, null, options);
  } else {
    // else use view and platform id to find screenshots
    const query = {};
    if (view) { query.view = view; }
    if (platformId) { query.platformId = platformId; }
    options.sort = { _id: -1 };
    findScreenshotsPromise = Screenshot.find(query, null, options);
  }

  return findScreenshotsPromise
    .then((screenshots) => res.status(200).send(screenshots))
    .catch((err) => handleError(err, res));
};

/* This method will find the latest image for a specific view on every unique platform */
exports.findLatestForViewGroupedByPlatform = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { view, numberOfDays } = req.query;
  const searchDate = new Date();
  searchDate.setDate(searchDate.getDate() - numberOfDays);
  return Screenshot.aggregate([
    { $match: { view, createdAt: { $gt: searchDate } } },
    { $sort: { _id: 1 } },
    { $group: { _id: { view: '$view', platformId: '$platformId' }, lastId: { $last: '$_id' } } },
    { $project: { _id: '$lastId' } },
  ])
    .then((screenshotsIdsArray) => {
      const latestScreenshotIds = screenshotsIdsArray.map(({ _id }) => _id);
      return Screenshot.find({ _id: { $in: latestScreenshotIds } });
    })
    .then((screenshots) => res.status(200).send(screenshots))
    .catch((err) => handleError(err, res));
};

exports.findLatestForTagGroupedByView = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { tag, numberOfDays } = req.query;
  const searchDate = new Date();
  searchDate.setDate(searchDate.getDate() - numberOfDays);
  return Screenshot.aggregate([
    { $match: { tags: { $in: [tag] }, createdAt: { $gt: searchDate } } },
    { $sort: { view: 1, _id: 1 } },
    { $group: { _id: { view: '$view', platformId: '$platformId' }, lastId: { $last: '$_id' } } },
    { $project: { _id: '$lastId' } },
  ])
    .then((screenshotsIdsArray) => {
      const latestScreenshotIds = screenshotsIdsArray.map(({ _id }) => _id);
      return Screenshot.find({ _id: { $in: latestScreenshotIds } });
    })
    .then((screenshots) => res.status(200).send(screenshots))
    .catch((err) => handleError(err, res));
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { screenshotId } = req.params;
  return Screenshot.findById(screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        throw new NotFoundError(`No screenshot found with id ${screenshotId}`);
      }
      return res.status(200).send(screenshot);
    })
    .catch((err) => handleError(err, res));
};

exports.findOneImage = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { screenshotId } = req.params;
  return Screenshot.findById(screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        throw new NotFoundError(`No screenshot found with id ${screenshotId}`);
      }
      return res.sendFile(path.resolve(`${screenshot.path}`));
    }).catch((err) => handleError(err, res));
};

exports.compareImages = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  // find both images
  const { screenshotId, screenshotCompareId } = req.params;
  const promises = [
    Screenshot.findById(screenshotId).exec(),
    Screenshot.findById(screenshotCompareId).exec(),
  ];
  return Promise.all(promises).then((results) => {
    const screenshot = results[0];
    const screenshotCompare = results[1];
    const options = {
      // if there is more than 50% difference then just return it.
      returnEarlyThreshold: 50,
      ignoreAreasColoredWith: { r: 255, g: 0, b: 255 },
      ignore: 'less',
    };
    compare(screenshot.path, screenshotCompare.path, options, (err, data) => {
      if (err) {
        throw new ServerError(`Something went wrong comparing the images ${err}`);
      }
      return res.status(200).send(data);
    });
  }).catch((err) => handleError(err, res));
};

exports.compareImagesAndReturnImage = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  // find both images
  const promises = [
    Screenshot.findById(req.params.screenshotId).exec(),
    Screenshot.findById(req.params.screenshotCompareId).exec(),
  ];

  const { useCache } = req.query;

  return Promise.all(promises)
    .then((results) => {
      const screenshot = results[0];
      const screenshotToCompare = results[1];
      if (screenshot === null || screenshotToCompare === null) {
        throw new NotFoundError('Unable to retrieve one or both images');
      }
      return imageUtils.compareImages(screenshot, screenshotToCompare, undefined, useCache);
    })
    .then((tempFileName) => res.sendFile(path.resolve(tempFileName)))
    .catch((err) => handleError(err, res));
};

exports.generateDynamicBaselineImage = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  // 1. request should contain image, you want to generate baseline
  // 2. retrieve the image and ensure it has a view and platform set.
  // 3. based on this retrieve its history (ensure we have as many images as requested)
  // 4. loop through images and generate dynamic image (and store as image for the same build)
  // 5. ensure type is set as dynamic.

  const { screenshotId } = req.params;
  const { numberOfImagesToCompare } = req.query;
  const queryHistory = numberOfImagesToCompare || 5;
  let originalScreenshot;
  return Screenshot.findById(screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        throw new NotFoundError(`No screenshot found with id ${screenshotId}`);
      }
      originalScreenshot = screenshot;
      const options = { skip: 0 };
      if (queryHistory > 0) {
        options.limit = queryHistory;
      }
      const {
        view,
        platformId,
      } = screenshot;
      const query = {
        view,
        platformId,
        _id: { $ne: screenshot.id },
      };
      options.sort = { _id: -1 };
      return Screenshot.find(query, null, options);
    })
    .then(async (screenshots) => {
      // check if there are enough images to generate dynamic history
      if (!screenshots || screenshots.length < queryHistory) {
        throw new ServerError('Unable to generate dynamic history as there aren\'t enough images to generate a dynamic image');
      }
      return imageUtils.generateDynamicBaseline(originalScreenshot, screenshots);
    })
    .then((baselineScreenshot) => baselineScreenshot.save())
    .then((savedBaselineScreenshot) => res.status(201).send(savedBaselineScreenshot))
    .catch((err) => handleError(err, res));
};

exports.compareImageAgainstBaseline = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  let screenshot;
  const { screenshotId } = req.params;
  return Screenshot.findById(screenshotId)
    .then((screenshotFound) => {
      if (!screenshotFound) {
        throw new NotFoundError(`No screenshot found with id ${screenshotId}`);
      }
      if (!screenshotFound.view) {
        throw new InvalidRequestError(`Screenshot with id ${screenshotId} does not have a view set, so can not be compared.`);
      }
      screenshot = screenshotFound;
      const {
        view,
        platform,
        height,
        width,
      } = screenshot;
      // generate baseline query using screenshot details.
      const baseLineQuery = {
        view,
        'platform.platformName': platform.platformName,
      };
      if (platform.deviceName) baseLineQuery['platform.deviceName'] = platform.deviceName;
      if (platform.browserName) {
        baseLineQuery['platform.browserName'] = platform.browserName;
        baseLineQuery.screenHeight = height;
        baseLineQuery.screenWidth = width;
      }
      return Baseline.findOne(baseLineQuery).populate('screenshot');
    })
    .then((baseline) => {
      // compare image with baseline and return result.
      if (!baseline) {
        throw new NotFoundError(`No baseline found for screenshot with id ${screenshotId}`);
      }
      const { ignoreBoxes: baseLineIgnoredBoxes } = baseline;
      // these are set as percentages so have to be converted.
      const ignoredBoxes = [];
      const { height, width } = screenshot;
      baseLineIgnoredBoxes.forEach((baselineIgnoreBox) => {
        const ignoreBox = {};
        ignoreBox.left = width * (baselineIgnoreBox.left / 100);
        ignoreBox.right = width * (1 - (baselineIgnoreBox.right / 100));
        ignoreBox.top = height * (baselineIgnoreBox.top / 100);
        ignoreBox.bottom = height * (1 - (baselineIgnoreBox.bottom / 100));
        ignoredBoxes.push(ignoreBox);
      });
      const options = {
        output: {
          returnEarlyThreshold: 50,
          ignoredBoxes,
          ignoreAreasColoredWith: { r: 255, g: 0, b: 255 },
          ignore: 'less',
        },
      };
      return compare(
        screenshot.path,
        baseline.screenshot.path,
        options,
        (err, data) => {
          if (err) {
            throw new ServerError(`Unable to compare images due to [${err}]`);
          }
          return res.status(200).send(data);
        },
      );
    })
    .catch((error) => handleError(error, res));
};

exports.compareImageAgainstBaselineAndReturnImage = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { useCache } = req.query;
  const { screenshotId } = req.params;
  let screenshotToCompare;
  return Screenshot.findById(screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        throw new NotFoundError(`No screenshot found with id ${screenshotId}`);
      }
      if (!screenshot.view) {
        throw new InvalidRequestError(`Screenshot with id ${screenshotId} does not have a view set, so can not be compared.`);
      }
      screenshotToCompare = screenshot;
      const {
        view,
        height,
        width,
        platform,
      } = screenshotToCompare;
      const baseLineQuery = {
        view,
        'platform.platformName': platform.platformName,
      };
      if (platform.deviceName) baseLineQuery['platform.deviceName'] = platform.deviceName;
      if (platform.browserName) {
        baseLineQuery['platform.browserName'] = platform.browserName;
        baseLineQuery.screenHeight = height;
        baseLineQuery.screenWidth = width;
      }
      return Baseline.findOne(baseLineQuery).populate('screenshot');
    })
    .then((baselineFound) => {
      if (!baselineFound) {
        throw new NotFoundError(`No baseline found for screenshot with id ${screenshotId}`);
      }
      const { screenshot, ignoreBoxes: baseLineIgnoredBoxes } = baselineFound;
      const ignoredBoxes = [];
      const { height, width } = screenshot;
      baseLineIgnoredBoxes.forEach((baselineIgnoreBox) => {
        const ignoreBox = {};
        ignoreBox.left = width * (baselineIgnoreBox.left / 100);
        ignoreBox.right = width * (1 - (baselineIgnoreBox.right / 100));
        ignoreBox.top = height * (baselineIgnoreBox.top / 100);
        ignoreBox.bottom = height * (1 - (baselineIgnoreBox.bottom / 100));
        ignoredBoxes.push(ignoreBox);
      });
      return imageUtils.compareImages(screenshot, screenshotToCompare, ignoredBoxes, useCache);
    })
    .then((tempFileName) => res.sendFile(tempFileName))
    .catch((err) => handleError(err, res));
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { platform, tags } = req.body;
  const { screenshotId } = req.params;
  return Screenshot.findById(screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        throw new NotFoundError(`No screenshot found with id ${screenshotId}`);
      }
      const screenshotToModify = screenshot;
      if (tags) screenshotToModify.tags = tags;
      if (platform) {
        const platformToStore = extractPlatformDetails(platform);
        screenshotToModify.platform = platformToStore;
        screenshotToModify.platformId = validationUtils
          .generatePlatformId(platformToStore, screenshot);
      }
      return screenshotToModify.save();
    }).then((savedScreenshot) => res.status(200).send(savedScreenshot))
    .catch((err) => handleError(err, res));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { screenshotId } = req.params;
  return Screenshot.findByIdAndRemove(screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        throw new NotFoundError(`No screenshot found with id ${screenshotId}`);
      }
      fs.unlinkSync(screenshot.path);
      return res.status(200).send({ message: 'Screenshot deleted successfully!' });
    }).catch((err) => handleError(err, res));
};
