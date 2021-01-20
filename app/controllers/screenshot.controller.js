const { validationResult } = require('express-validator');
const imageThumbnail = require('image-thumbnail');
const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const mongoose = require('mongoose');
const { compare } = require('resemblejs');
const compareImages = require('resemblejs/compareImages');
const sizeOf = require('image-size');

const Screenshot = require('../models/screenshot.js');
const Build = require('../models/build.js');
const Baseline = require('../models/baseline.js');

/* platformId will allow for quicker identifications of what platform a screenshot was taken on */
const extractPlatformId = (platform, screenshot) => {
  if (platform.deviceName) {
    /* if device name is given we assume it's a mobile device */
    return `${platform.platformName}_${platform.deviceName}`.toLowerCase();
  }
  if (platform.browserName) {
    /* otherwise we assume it's desktop and use the browser/resolution combination */
    return `${platform.platformName}_${platform.browserName}_${screenshot.width}x${screenshot.height}`.toLowerCase();
  }
  return undefined;
};

exports.create = (req, res) => {
  const errors = validationResult(req);
  let build;
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Build.findById(req.headers.buildid)
    .then((foundBuild) => {
      if (!foundBuild) {
        const error = new Error(`No build found with id ${req.headers.buildid}`);
        error.status = 404;
        return Promise.reject(error);
      }
      build = foundBuild;
      const options = {
        width: 300,
        height: 300,
        responseType: 'base64',
      };
      const promises = [
        imageThumbnail(req.file.path, options),
        sizeOf(req.file.path),
      ];
      return Promise.all(promises).then((results) => {
        const thumbnail = results[0];
        const dimensions = results[1];
        // with the thumbnail and the dimension store the details.
        const screenshot = new Screenshot({
          build: build._id,
          timestamp: req.headers.timestamp,
          thumbnail,
          height: dimensions.height,
          width: dimensions.width,
          path: req.file.path,
          view: req.headers.view,
        });
        return screenshot.save();
      });
    })
    .then((savedScreenshot) => {
      res.status(201).send(savedScreenshot);
    })
    .catch((error) => {
      if (error.status === 404) {
        res.status(404).send({
          message: error.message,
        });
      } else {
        res.status(500).send({
          message: `Error creating screenshot [${error}]`,
        });
      }
    });
};

exports.createFail = (error, req, res) => {
  res.status(400).send({ error: error.message });
};

exports.findAll = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { buildId, view, platformId } = req.query;
  const limit = parseInt(req.query.limit, 10) || 10;
  const skip = parseInt(req.query.skip, 10) || 0;

  if (buildId) {
    return Build.findById({ _id: buildId })
      .then((buildFound) => {
        if (!buildFound) {
          const error = new Error(`No build found with id ${buildId}`);
          error.status = 404;
          return Promise.reject(error);
        }
        const query = { build: mongoose.Types.ObjectId(buildId) };
        if (view) { query.view = view; }
        if (platformId) { query.platformId = platformId; }
        return Screenshot.find(
          query, null, {
            limit,
            skip,
          },
        );
      })
      .then((screenshots) => {
        res.send(screenshots);
      }).catch((err) => {
        res.status(500).send({
          message: err.message || 'Some error occurred while retrieving screenshots.',
        });
      });
  }
  const query = {};
  if (view) { query.view = view; }
  if (platformId) { query.platformId = platformId; }
  return Screenshot.find(
    query, null, { sort: { _id: -1 }, limit, skip },
  ).then((screenshots) => {
    res.send(screenshots);
  }).catch((err) => {
    res.status(500).send({
      message: err.message || 'Some error occurred while retrieving screenshots.',
    });
  });
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
  ]).then((screenshotsIdsArray) => {
    const latestScreenshotIds = screenshotsIdsArray.map(({ _id }) => _id);
    return Screenshot.find({ _id: { $in: latestScreenshotIds } });
  }).then((screenshots) => {
    res.send(screenshots);
  }).catch((err) => {
    res.status(500).send({
      message: err.message || 'Some error occurred while retrieving screenshots.',
    });
  });
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
  ]).then((screenshotsIdsArray) => {
    const latestScreenshotIds = screenshotsIdsArray.map(({ _id }) => _id);
    return Screenshot.find({ _id: { $in: latestScreenshotIds } });
  }).then((screenshots) => {
    res.send(screenshots);
  }).catch((err) => {
    res.status(500).send({
      message: err.message || 'Some error occurred while retrieving screenshots.',
    });
  });
};

exports.findOne = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Screenshot.findById(req.params.screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        return res.status(404).send({
          message: `Screenshot not found with id ${req.params.screenshotId}`,
        });
      }
      return res.status(200).send(screenshot);
    }).catch((err) => res.status(500).send({
      message: `Error retrieving screenshot with id ${req.params.screenshotId} due to [${err}]`,
    }));
};

exports.findOneImage = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Screenshot.findById(req.params.screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        return res.status(404).send({
          message: `Screenshot not found with id ${req.params.screenshotId}`,
        });
      }
      return res.sendFile(path.resolve(`${screenshot.path}`));
    }).catch((err) => res.status(500).send({
      message: `Error retrieving screenshot with id ${req.params.screenshotId} due to [${err}]`,
    }));
};

exports.compareImages = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  // find both images
  const promises = [
    Screenshot.findById(req.params.screenshotId).exec(),
    Screenshot.findById(req.params.screenshotCompareId).exec(),
  ];

  return Promise.all(promises).then((results) => {
    const screenshot = results[0];
    const screenshotCompare = results[1];
    const options = {
      // if there is more than 50% difference then just return it.
      returnEarlyThreshold: 50,
    };
    compare(screenshot.path, screenshotCompare.path, options, (err, data) => {
      if (err) {
        return res.status(404).send({
          message: 'Something went wrong comparing the images',
        });
      }
      return res.status(200).send(
        data,
      );
    });
  }).catch((err) => {
    res.status(500).send({
      message: err.message || 'Some error occurred while creating the build.',
    });
  });
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

  return Promise.all(promises).then((results) => {
    const screenshot = results[0];
    const screenshotCompare = results[1];
    if (screenshot === null || screenshotCompare === null) {
      res.status(404).send({
        message: 'Unable to retrieve one or both images',
      });
    }
    // create name based on the two id's
    const tempFileName = `compares/${screenshot.id}_${screenshotCompare.id}-compare.png`;
    // check if the file already exists
    fs.access(tempFileName, fs.F_OK, (err) => {
      // file doesn't exists then create it by doing the compare.
      if (err) {
        const options = {
          output: {
            errorColor: {
              red: 255,
              green: 0,
              blue: 255,
            },
            errorType: 'movement',
            transparency: 0.3,
            largeImageThreshold: 1200,
            useCrossOrigin: false,
            outputDiff: true,
          },
          scaleToSameSize: true,
          ignore: 'less',
        };
        const loadImagesPromises = [
          fsPromises.readFile(screenshot.path),
          fsPromises.readFile(screenshotCompare.path),
        ];
        return Promise.all(loadImagesPromises).then((imageLoadResults) => {
          compareImages(
            imageLoadResults[0],
            imageLoadResults[1],
            options,
          ).then((data) => {
            fsPromises.writeFile(path.resolve(tempFileName), data.getBuffer())
              .then(() => res.sendFile(path.resolve(tempFileName)));
          });
        }).catch((compareError) => {
          res.status(500).send({
            message: compareError.message || 'Some error occurred comparing the images',
          });
        });
      }
      // if file does exist just return it.
      return res.sendFile(path.resolve(tempFileName));
    });
  }).catch((err) => {
    res.status(500).send({
      message: err.message || 'Some error occurred while creating the build.',
    });
  });
};

exports.compareImageAgainstBaseline = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  let screenshotToCompare;
  return Screenshot.findById(req.params.screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        const error = new Error(`No Screenshot found with id ${req.body.build}`);
        error.status = 404;
        return Promise.reject(error);
      }
      if (!screenshot.view) {
        const error = new Error(`Screenshot with id ${req.params.screenshotId} does not have a view set, so can not be compared.`);
        error.status = 422;
        return Promise.reject(error);
      }
      screenshotToCompare = screenshot;
      // generate baseline query using screenshot details.
      const baseLineQuery = {
        view: screenshotToCompare.view,
        'platform.platformName': screenshotToCompare.platform.platformName,
      };
      if (screenshotToCompare.platform.deviceName) baseLineQuery['platform.deviceName'] = screenshotToCompare.platform.deviceName;
      if (screenshotToCompare.platform.browserName) {
        baseLineQuery['platform.browserName'] = screenshotToCompare.platform.browserName;
        baseLineQuery.screenHeight = screenshotToCompare.height;
        baseLineQuery.screenWidth = screenshotToCompare.width;
      }
      return Baseline.find(baseLineQuery).populate('screenshot');
    })
    .then((baselines) => {
      // compare image with baseline and return result.
      if (!baselines || baselines.length === 0) {
        const error = new Error(`No baselines found for screenshot with id ${req.params.screenshotId}`);
        error.status = 404;
        return Promise.reject(error);
      }
      const options = {
        // if there is more than 50% difference then just return it.
        returnEarlyThreshold: 50,
      };
      return compare(screenshotToCompare.path, baselines[0].screenshot.path, options,
        (err, data) => {
          if (err) {
            return res.status(404).send({
              message: 'Something went wrong comparing the images',
            });
          }
          return res.status(200).send(
            data,
          );
        });
    })
    .catch((error) => {
      if (error.status !== 500) {
        res.status(error.status).send({
          message: error.message,
        });
      } else {
        res.status(500).send({
          message: `Error creating execution [${error}]`,
        });
      }
    });
};

exports.update = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  const { platform, tags } = req.body;

  return Screenshot.findById(req.params.screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        return res.status(404).send({
          message: `Screenshot not found with id ${req.params.screenshotId}`,
        });
      }
      const screenshotToModify = screenshot;
      if (tags) screenshotToModify.tags = tags;
      if (platform) {
        screenshotToModify.platform = platform;
        screenshotToModify.platformId = extractPlatformId(platform, screenshot);
      }
      return screenshotToModify.save();
    }).then((savedScreenshot) => res.status(200).send(savedScreenshot))
    .catch((err) => res.status(500).send({
      message: `Error updating screenshot with id ${req.params.screenshotId} due to [${err}]`,
    }));
};

exports.delete = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }
  return Screenshot.findByIdAndRemove(req.params.screenshotId)
    .then((screenshot) => {
      if (!screenshot) {
        return res.status(404).send({
          message: `Screenshot not found with id ${req.params.screenshotId}`,
        });
      }
      fs.unlinkSync(screenshot.path);
      return res.status(200).send({ message: 'Screenshot deleted successfully!' });
    }).catch((err) => res.status(500).send({
      message: `Could not delete screenshot with id ${req.params.screenshotId} due to [${err}]`,
    }));
};
