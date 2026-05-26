const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { User } = require('./models');

const router = express.Router();

// Helper to generate a token
const generateToken = (user) => {
  return jwt.sign(
    { userId: user._id, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: '7d' }
  );
};

// ── POST /api/auth/register ───────────────────────────
router.post('/register', async (req, res, next) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password, and name are required' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Enforce password minimum 8 characters with at least one number and one special character
    const passwordRegex = /^(?=.*[0-9])(?=.*[!@#$%^&*])[a-zA-Z0-9!@#$%^&*]{8,}$/;
    if (!passwordRegex.test(password)) {
      return res.status(400).json({ 
        error: 'Password must be at least 8 characters long and contain at least one number and one special character' 
      });
    }

    // Check if user exists
    const existingUser = await User.findOne({ email: email.toLowerCase().trim() });
    if (existingUser) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Hash password with bcrypt (12 salt rounds)
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Save new User document
    const user = await User.create({
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      role: 'user',
      // walletBalance defaults to 0 as per schema
      details: { name: name.trim() }
    });

    const token = generateToken(user);

    res.status(201).json({
      userId: user._id,
      email: user.email,
      token
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/auth/login ──────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() }).select('+password');
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);

    res.status(200).json({
      userId: user._id,
      email: user.email,
      token
    });
  } catch (error) {
    next(error);
  }
});

// ── POST /api/auth/refresh ────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'Token is required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        // If expired within the last 24 hours still allow refresh (grace window). Otherwise return 401.
        const decodedExpired = jwt.decode(token);
        if (decodedExpired && decodedExpired.exp) {
          const now = Math.floor(Date.now() / 1000);
          const gracePeriod = 24 * 60 * 60; // 24 hours
          if (now - decodedExpired.exp < gracePeriod) {
            decoded = decodedExpired;
          } else {
            return res.status(401).json({ error: 'Token expired beyond grace period' });
          }
        } else {
          return res.status(401).json({ error: 'Invalid token' });
        }
      } else {
        return res.status(401).json({ error: 'Invalid token' });
      }
    }

    const user = await User.findById(decoded.userId);
    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    const newToken = generateToken(user);

    res.status(200).json({
      userId: user._id,
      email: user.email,
      token: newToken
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
