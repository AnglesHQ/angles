const { validationResult } = require('express-validator');
const debug = require('debug');
const settingsService = require('../utils/auth-settings-service.js');
const { configureProviders } = require('../utils/passport-setup.js');
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
    // Rebuild the provider strategies so configuration changes take effect without a
    // restart. The per-provider outcome is returned alongside the settings so the admin
    // UI can show which providers failed to configure (bad issuer, unreachable IdP,
    // unparseable certificate) instead of only discovering it at first login.
    const results = await configureProviders();
    log('Auth settings updated by admin.');
    return res.status(200).json({
      ...settings,
      providerStatus: results.reduce((acc, result) => {
        acc[result.id] = { ready: result.ok, error: result.error };
        return acc;
      }, {}),
    });
  } catch (err) {
    return handleError(err, res);
  }
};
