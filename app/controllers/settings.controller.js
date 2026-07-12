const { validationResult } = require('express-validator');
const debug = require('debug');
const settingsService = require('../utils/auth-settings-service');
const { configureOktaStrategy } = require('../utils/passport-setup');
const { handleError } = require('../exceptions/errors.js');

const log = debug('settings:controller');

exports.getAuthSettings = async (req, res) => {
  try {
    const settings = await settingsService.getAuthSettings();
    return res.status(200).json(settings);
  } catch (err) {
    return handleError(err, res);
  }
};

exports.updateAuthSettings = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  try {
    const settings = await settingsService.updateAuthSettings(req.body);
    // Re-register the Okta strategy (via OIDC discovery) so issuer/client changes take
    // effect without a restart.
    await configureOktaStrategy();
    log('Auth settings updated by admin.');
    return res.status(200).json(settings);
  } catch (err) {
    return handleError(err, res);
  }
};
