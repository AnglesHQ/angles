const User = require('../models/user');
const bcrypt = require('bcryptjs');

exports.create = async (req, res) => {
  try {
    const { username, password, role, teams, authProvider } = req.body;
    
    // Check if user exists
    const existing = await User.findOne({ username: username.toLowerCase() });
    if (existing) {
      return res.status(400).json({ error: 'Username already exists' });
    }

    const user = new User({
      username: username.toLowerCase(),
      role: role || 'user',
      teams: teams || [],
      authProvider: authProvider || 'local',
    });

    if (user.authProvider === 'local') {
      if (!password) {
        return res.status(400).json({ error: 'Password is required for local users' });
      }
      user.password = await bcrypt.hash(password, 10);
    }

    await user.save();
    
    // return user without password
    const userResponse = user.toObject();
    delete userResponse.password;
    
    res.status(201).json(userResponse);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.findAll = async (req, res) => {
  try {
    const users = await User.find({}, '-password').populate('teams', 'name');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.findOne = async (req, res) => {
  try {
    const user = await User.findById(req.params.userId, '-password').populate('teams', 'name');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const { role, teams, password } = req.body;
    const user = await User.findById(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (role) user.role = role;
    if (teams) user.teams = teams;
    if (password && user.authProvider === 'local') {
      user.password = await bcrypt.hash(password, 10);
    }

    await user.save();
    const userResponse = user.toObject();
    delete userResponse.password;
    res.json(userResponse);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

exports.delete = async (req, res) => {
  try {
    const user = await User.findByIdAndRemove(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
