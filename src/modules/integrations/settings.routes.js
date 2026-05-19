'use strict';
// settings.routes.js — save WhatsApp/Shopify credentials from Settings UI
const express = require('express');
const { query } = require('../../config/db');
const { protect, authorize } = require('../../middleware/auth');

const router = express.Router();
router.use(protect, authorize('admin'));

router.get('/settings', async (req, res, next) => {
  try {
    const rows = await query('SELECT key_name, key_value, is_secret FROM integration_settings');
    const settings = {};
    rows.forEach(r => { settings[r.key_name] = r.is_secret ? (r.key_value ? '***configured***' : '') : r.key_value; });
    res.json({ success: true, settings });
  } catch (err) { next(err); }
});

router.post('/settings', async (req, res, next) => {
  try {
    const { settings } = req.body;
    for (const [k, v] of Object.entries(settings)) {
      await query('INSERT INTO integration_settings (key_name,key_value,updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE key_value=?,updated_by=?',
        [k, v, req.user.id, v, req.user.id]);
    }
    res.json({ success: true, message: 'Settings saved.' });
  } catch (err) { next(err); }
});

module.exports = router;
