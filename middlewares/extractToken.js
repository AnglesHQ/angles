const jwt = require('jsonwebtoken');

module.exports = async (req, res, next) => {
  try {
    // Decode access token
    const bearerToken = req.headers.authorization;
    // bearerToken would return "Bearer <access_token>"

    const token = bearerToken.split(' ');
    // token would return ["Bearer", "<access_token>"]

    const tokenData = jwt.decode(token[1]);
    // tokenData would return user's data

    // Store decoded token data in request
    req.tokenData = tokenData;
    next();
  } catch (error) {
    next(error);
  }
};
