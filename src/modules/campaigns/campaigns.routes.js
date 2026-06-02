'use strict';
const express = require('express');
const { query } = require('../../config/db');
const { protect, authorize, AppError } = require('../../middleware/auth');

const router = express.Router();
router.use(protect);

// ── GET /api/campaigns ─────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const campaigns = await query(`
      SELECT
        c.*,
        COUNT(l.id)                                                      AS total_leads,
        SUM(l.status IN ('converted','delivered'))                       AS converted,
        SUM(l.status = 'delivered')                                      AS delivered,
        SUM(CASE WHEN l.revenue_countable=1 THEN COALESCE(l.order_amount,0) ELSE 0 END) AS revenue,
        ROUND(
          SUM(l.status IN ('converted','delivered')) /
          NULLIF(COUNT(l.id),0) * 100, 1
        )                                                                AS conversion_rate
      FROM campaigns c
      LEFT JOIN leads l ON l.campaign_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    res.json({ success: true, campaigns });
  } catch (err) { next(err); }
});

// ── GET /api/campaigns/:id ─────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const [campaign] = await query(`
      SELECT
        c.*,
        COUNT(l.id)                                                      AS total_leads,
        SUM(l.status IN ('converted','delivered'))                       AS converted,
        SUM(l.status = 'delivered')                                      AS delivered,
        SUM(CASE WHEN l.revenue_countable=1 THEN COALESCE(l.order_amount,0) ELSE 0 END) AS revenue,
        ROUND(
          SUM(l.status IN ('converted','delivered')) /
          NULLIF(COUNT(l.id),0) * 100, 1
        )                                                                AS conversion_rate
      FROM campaigns c
      LEFT JOIN leads l ON l.campaign_id = c.id
      WHERE c.id = ?
      GROUP BY c.id
    `, [req.params.id]);

    if (!campaign) throw new AppError('Campaign not found.', 404);

    // Last 10 leads of this campaign
    const leads = await query(`
      SELECT l.id, l.name, l.phone, l.status, l.order_amount,
             l.created_at, u.name AS assigned_name
      FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_to
      WHERE l.campaign_id = ?
      ORDER BY l.created_at DESC
      LIMIT 10
    `, [req.params.id]);

    res.json({ success: true, campaign, leads });
  } catch (err) { next(err); }
});

// ── POST /api/campaigns ────────────────────────────────────────
router.post('/', authorize('admin', 'sub_admin'), async (req, res, next) => {
  try {
    const { name, platform, status, budget, start_date, end_date, external_id, notes } = req.body;
    if (!name?.trim()) throw new AppError('Campaign name is required.');

    const result = await query(`
      INSERT INTO campaigns
        (name, platform, status, budget, start_date, end_date, external_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name.trim(),
      platform  || 'meta',
      status    || 'active',
      budget    || 0,
      start_date || null,
      end_date   || null,
      external_id || null,
      notes      || null,
      req.user.id,
    ]);

    const [campaign] = await query('SELECT * FROM campaigns WHERE id = ?', [result.insertId]);
    res.status(201).json({ success: true, campaign });
  } catch (err) { next(err); }
});

// ── PATCH /api/campaigns/:id ───────────────────────────────────
router.patch('/:id', authorize('admin', 'sub_admin'), async (req, res, next) => {
  try {
    const fields  = ['name', 'platform', 'status', 'budget', 'start_date', 'end_date', 'external_id', 'notes'];
    const sets    = [];
    const values  = [];
    fields.forEach(f => {
      if (req.body[f] !== undefined) { sets.push(`${f}=?`); values.push(req.body[f]); }
    });
    if (!sets.length) throw new AppError('No fields to update.');
    values.push(req.params.id);
    await query(`UPDATE campaigns SET ${sets.join(',')} WHERE id = ?`, values);
    const [campaign] = await query('SELECT * FROM campaigns WHERE id = ?', [req.params.id]);
    res.json({ success: true, campaign });
  } catch (err) { next(err); }
});

// ── DELETE /api/campaigns/:id ──────────────────────────────────
router.delete('/:id', authorize('admin'), async (req, res, next) => {
  try {
    // Unlink leads first
    await query('UPDATE leads SET campaign_id = NULL WHERE campaign_id = ?', [req.params.id]);
    await query('DELETE FROM campaigns WHERE id = ?', [req.params.id]);
    res.json({ success: true, message: 'Campaign deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
