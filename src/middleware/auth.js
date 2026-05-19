'use strict';
const jwt   = require('jsonwebtoken');
const { query } = require('../config/db');

const protect = async (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
      return res.status(401).json({ success: false, message: 'Not authenticated.' });

    const token   = header.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const [user]  = await query('SELECT id,name,email,phone,role,is_active,incentive_rate FROM users WHERE id=?', [decoded.id]);

    if (!user || !user.is_active)
      return res.status(401).json({ success: false, message: 'User not found or inactive.' });

    req.user = user;
    next();
  } catch {
    return res.status(401).json({ success: false, message: 'Token invalid or expired.' });
  }
};

const authorize = (...roles) => (req, res, next) => {
  if (!roles.includes(req.user.role))
    return res.status(403).json({ success: false, message: `Access denied. Required role: ${roles.join(' or ')}` });
  next();
};

// isAdmin helper
const isAdmin = (user) => ['admin','sub_admin'].includes(user.role);

class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = { protect, authorize, isAdmin, AppError };
