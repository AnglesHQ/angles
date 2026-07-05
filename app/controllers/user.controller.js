const { validationResult } = require('express-validator');
const debug = require('debug');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/user');
const { handleError, NotFoundError, ConflictError } = require('../exceptions/errors.js');

const log = debug('user:controller');

exports.create = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { username, password, role, teams, authProvider } = req.body;

  try {
    const existing = await User.findOne({ username: username.toLowerCase() }).select('_id').lean();
    if (existing) {
      throw new ConflictError(`User with username "${username}" already exists.`);
    }

    const user = new User({
      username: username.toLowerCase(),
      role: role || 'user',
      teams: teams || [],
      authProvider: authProvider || 'local',
    });

    if (user.authProvider === 'local') {
      if (!password) {
        return res.status(422).json({ errors: [{ msg: 'Password is required for local users.' }] });
      }
      user.password = await bcrypt.hash(password, 10);
    }

    await user.save();
    log(`Created user "${user.username}" with id: "${user._id}".`);

    const userResponse = user.toObject();
    delete userResponse.password;
    return res.status(201).json(userResponse);
  } catch (err) {
    return handleError(err, res);
  }
};

exports.findAll = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  try {
    const users = await User.find({}, '-password').populate('teams', 'name').lean();
    return res.status(200).json(users);
  } catch (err) {
    return handleError(err, res);
  }
};

exports.findOne = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { userId } = req.params;
  try {
    const user = await User.findById(userId, '-password').populate('teams', 'name').lean();
    if (!user) {
      throw new NotFoundError(`User not found with id ${userId}`);
    }
    return res.status(200).json(user);
  } catch (err) {
    return handleError(err, res);
  }
};

exports.update = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { userId } = req.params;
  const { role, teams, password } = req.body;

  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new NotFoundError(`User not found with id ${userId}`);
    }

    if (role) user.role = role;
    if (teams) user.teams = teams;
    if (password && user.authProvider === 'local') {
      user.password = await bcrypt.hash(password, 10);
    }

    await user.save();
    log(`Updated user "${user.username}" with id: "${user._id}".`);

    const userResponse = user.toObject();
    delete userResponse.password;
    return res.status(200).json(userResponse);
  } catch (err) {
    return handleError(err, res);
  }
};

exports.delete = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { userId } = req.params;
  try {
    const user = await User.findByIdAndRemove(userId);
    if (!user) {
      throw new NotFoundError(`User not found with id ${userId}`);
    }
    log(`Deleted user "${user.username}" with id: "${user._id}".`);
    return res.status(200).json({ message: 'User deleted successfully' });
  } catch (err) {
    return handleError(err, res);
  }
};

exports.generateToken = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { userId } = req.params;
  const { name, expiresInDays } = req.body;

  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new NotFoundError(`User not found with id ${userId}`);
    }

    if (req.user._id.toString() !== user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const tokenString = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(tokenString).digest('hex');

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + parseInt(expiresInDays, 10));

    user.apiTokens.push({ name, tokenHash, expiresAt });
    await user.save();
    log(`Generated token "${name}" for user "${user.username}".`);

    return res.status(201).json({ token: tokenString, name, expiresAt });
  } catch (err) {
    return handleError(err, res);
  }
};

exports.getTokens = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { userId } = req.params;
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new NotFoundError(`User not found with id ${userId}`);
    }

    if (req.user._id.toString() !== user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const tokens = user.apiTokens.map((t) => ({
      _id: t._id,
      name: t.name,
      expiresAt: t.expiresAt,
      createdAt: t.createdAt,
    }));

    return res.status(200).json(tokens);
  } catch (err) {
    return handleError(err, res);
  }
};

exports.revokeToken = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ errors: errors.array() });
  }

  const { userId, tokenId } = req.params;
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new NotFoundError(`User not found with id ${userId}`);
    }

    if (req.user._id.toString() !== user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const token = user.apiTokens.id(tokenId);
    if (!token) {
      throw new NotFoundError(`Token not found with id ${tokenId}`);
    }

    token.remove();
    await user.save();
    log(`Revoked token "${tokenId}" for user "${user.username}".`);

    return res.status(200).json({ message: 'Token revoked successfully' });
  } catch (err) {
    return handleError(err, res);
  }
};
