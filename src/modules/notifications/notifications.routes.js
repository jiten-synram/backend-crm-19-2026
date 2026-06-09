'use strict';
const express = require('express');
const { query } = require('../../config/db');
const { protect } = require('../../middleware/auth');

const router = express.Router();
router.use(protect);

// GET /api/notifications — apni notifications lo
router.get('/', async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const notifications = await query(`
      SELECT n.*, l.name AS lead_name, l.phone AS lead_phone, l.category AS lead_category
      FROM notifications n
      LEFT JOIN leads l ON l.id = n.lead_id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC
      LIMIT ?
    `, [req.user.id, limit]);

    const [{ unread }] = await query(
      'SELECT COUNT(*) AS unread FROM notifications WHERE user_id=? AND is_read=0',
      [req.user.id]
    );

    res.json({ success: true, notifications, unread: Number(unread) });
  } catch(err) { next(err); }
});

// PATCH /api/notifications/:id/read — ek notification read karo
router.patch('/:id/read', async (req, res, next) => {
  try {
    await query(
      'UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?',
      [req.params.id, req.user.id]
    );
    res.json({ success: true });
  } catch(err) { next(err); }
});

// PATCH /api/notifications/read-all — saari read karo
router.patch('/read-all', async (req, res, next) => {
  try {
    await query(
      'UPDATE notifications SET is_read=1 WHERE user_id=?',
      [req.user.id]
    );
    res.json({ success: true });
  } catch(err) { next(err); }
});

module.exports = router;
