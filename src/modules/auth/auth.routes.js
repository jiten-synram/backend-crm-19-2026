'use strict';
const express  = require('express');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const { query } = require('../../config/db');
const { protect, authorize, AppError } = require('../../middleware/auth');

const router = express.Router();

const signAccess  = id => jwt.sign({ id }, process.env.JWT_SECRET,         { expiresIn: process.env.JWT_EXPIRES_IN || '15m' });
const signRefresh = id => jwt.sign({ id }, process.env.JWT_REFRESH_SECRET, { expiresIn: '30d' });

// ── POST /api/auth/login ───────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new AppError('Email and password required.');

    const [user] = await query('SELECT * FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user || !user.is_active)
      throw new AppError('Invalid credentials.', 401);

    const match = await bcrypt.compare(password, user.password);
    console.log(match);
    if (!match) throw new AppError('Invalid credentials.', 401);

    const accessToken  = signAccess(user.id);
    const refreshToken = signRefresh(user.id);

    await query('UPDATE users SET refresh_token=?, last_login=NOW() WHERE id=?', [refreshToken, user.id]);

    delete user.password; delete user.refresh_token;
    res.json({ success: true, accessToken, refreshToken, user });
  } catch (err) { next(err); }
});

// ── POST /api/auth/refresh ────────────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new AppError('Refresh token required.', 401);

    const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const [user]  = await query('SELECT * FROM users WHERE id=? AND refresh_token=?', [decoded.id, refreshToken]);
    if (!user) throw new AppError('Invalid refresh token.', 401);

    const newAccess  = signAccess(user.id);
    const newRefresh = signRefresh(user.id);
    await query('UPDATE users SET refresh_token=? WHERE id=?', [newRefresh, user.id]);

    delete user.password; delete user.refresh_token;
    res.json({ success: true, accessToken: newAccess, refreshToken: newRefresh, user });
  } catch (err) { next(err); }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post('/logout', protect, async (req, res, next) => {
  try {
    await query('UPDATE users SET refresh_token=NULL WHERE id=?', [req.user.id]);
    res.json({ success: true, message: 'Logged out.' });
  } catch (err) { next(err); }
});

// ── GET /api/auth/me ──────────────────────────────────────────
router.get('/me', protect, (req, res) => res.json({ success: true, user: req.user }));

// ── GET /api/auth/users ───────────────────────────────────────
router.get('/users', protect, authorize('admin','sub_admin'), async (req, res, next) => {
  try {
    const { role, is_active } = req.query;
    let sql  = 'SELECT id,name,email,phone,role,is_active,incentive_rate,designation,last_login,created_at FROM users WHERE 1=1';
    const p  = [];
    if (role)      { sql += ' AND role=?';      p.push(role); }
    if (is_active !== undefined) { sql += ' AND is_active=?'; p.push(is_active === 'true' ? 1 : 0); }
    sql += ' ORDER BY created_at DESC';
    const users = await query(sql, p);
    res.json({ success: true, users });
  } catch (err) { next(err); }
});

// ── POST /api/auth/users ──────────────────────────────────────
router.post('/users', protect, authorize('admin'), async (req, res, next) => {
  try {
    const { name, email, phone, password, role, incentive_rate, categories } = req.body;
    if (!name || !email || !phone || !password) throw new AppError('name, email, phone, password required.');

    const hashed = await bcrypt.hash(password, 12);
    const result = await query(
      'INSERT INTO users (name,email,phone,password,role,incentive_rate,created_by) VALUES (?,?,?,?,?,?,?)',
      [name, email.toLowerCase(), phone, hashed, role || 'sales', incentive_rate || 0, req.user.id]
    );
    const userId = result.insertId;

    // Add category assignments
    if (categories?.length) {
      for (const cat of categories) {
        await query('INSERT IGNORE INTO user_categories (user_id,category) VALUES (?,?)', [userId, cat]);
        await query('INSERT IGNORE INTO round_robin (category,current_index) VALUES (?,0)', [cat]);
      }
    }

    const [user] = await query('SELECT id,name,email,phone,role,is_active,incentive_rate FROM users WHERE id=?', [userId]);
    res.status(201).json({ success: true, user });
  } catch (err) { next(err); }
});

// ── PATCH /api/auth/users/:id ─────────────────────────────────
router.patch('/users/:id', protect, authorize('admin'), async (req, res, next) => {
  try {
    const fields  = ['name','phone','role','is_active','incentive_rate','designation'];
    const updates = []; const values = [];
    fields.forEach(f => { if (req.body[f] !== undefined) { updates.push(`${f}=?`); values.push(req.body[f]); } });
    if (!updates.length) throw new AppError('No fields to update.');
    values.push(req.params.id);
    await query(`UPDATE users SET ${updates.join(',')} WHERE id=?`, values);

    // Sync categories if provided
    if (req.body.categories) {
      await query('DELETE FROM user_categories WHERE user_id=?', [req.params.id]);
      for (const cat of req.body.categories) {
        await query('INSERT IGNORE INTO user_categories (user_id,category) VALUES (?,?)', [req.params.id, cat]);
        await query('INSERT IGNORE INTO round_robin (category,current_index) VALUES (?,0)', [cat]);
      }
    }
    const [user] = await query('SELECT id,name,email,phone,role,is_active,incentive_rate FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true, user });
  } catch (err) { next(err); }
});

// ── PATCH /api/auth/change-password ───────────────────────────
router.patch('/change-password', protect, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const [user] = await query('SELECT password FROM users WHERE id=?', [req.user.id]);
    if (!(await bcrypt.compare(currentPassword, user.password)))
      throw new AppError('Current password incorrect.', 401);
    const hashed = await bcrypt.hash(newPassword, 12);
    await query('UPDATE users SET password=? WHERE id=?', [hashed, req.user.id]);
    res.json({ success: true, message: 'Password updated.' });
  } catch (err) { next(err); }
});

module.exports = router;
