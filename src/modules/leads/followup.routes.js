'use strict';
const express = require('express');
const { query } = require('../../config/db');
const { protect, isAdmin } = require('../../middleware/auth');

const fuRouter = express.Router();
fuRouter.use(protect);

// ✅ Helper: Date → 'YYYY-MM-DD HH:MM:SS' (MySQL format, T nahi)
const fmtDt = (d) => d.toISOString().slice(0, 19).replace('T', ' ');

// ── GET /follow-ups ────────────────────────────────────────────
fuRouter.get('/follow-ups', async (req, res, next) => {
  try {
    const { tab = 'today', page = 1, limit = 20 } = req.query;
    const scope = isAdmin(req.user) ? '' : `AND f.assigned_to=${req.user.id}`;

    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const s = new Date(istNow); s.setUTCHours(0, 0, 0, 0);
    const e = new Date(istNow); e.setUTCHours(23, 59, 59, 999);

    // ✅ fmtDt use kiya — T nahi aayega
    const dateC = tab === 'overdue'
      ? `AND f.scheduled_at < '${fmtDt(s)}'`
      : tab === 'today'
      ? `AND f.scheduled_at BETWEEN '${fmtDt(s)}' AND '${fmtDt(e)}'`
      : `AND f.scheduled_at > '${fmtDt(e)}'`;

    const offset = (Number(page) - 1) * Number(limit);
    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM follow_ups f WHERE f.status='pending' ${scope} ${dateC}`
    );
    const items = await query(`
      SELECT f.*, l.name AS lead_name, l.phone AS lead_phone,
             l.status AS lead_status, l.category,
             u.name AS agent_name
      FROM follow_ups f
      LEFT JOIN leads l ON l.id = f.lead_id
      LEFT JOIN users u ON u.id = f.assigned_to
      WHERE f.status='pending' ${scope} ${dateC}
      ORDER BY f.scheduled_at ${tab === 'upcoming' ? 'ASC' : 'DESC'}
      LIMIT ? OFFSET ?
    `, [Number(limit), offset]);

    res.json({ success: true, total, tab, items });
  } catch (err) { next(err); }
});

// ── GET /follow-ups/counts ─────────────────────────────────────
fuRouter.get('/follow-ups/counts', async (req, res, next) => {
  try {
    const scope = isAdmin(req.user) ? '' : `AND assigned_to=${req.user.id}`;
    // const now = new Date();
    // const s = new Date(now); s.setHours(0, 0, 0, 0);
    // const e = new Date(now); e.setHours(23, 59, 59, 999);
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(now.getTime() + istOffset);
    const s = new Date(istNow); s.setUTCHours(0, 0, 0, 0);
    const e = new Date(istNow); e.setUTCHours(23, 59, 59, 999);

    const [[ov], [td], [up]] = await Promise.all([
      query(`SELECT COUNT(*) AS c FROM follow_ups WHERE status='pending' ${scope} AND scheduled_at < ?`, [s]),
      query(`SELECT COUNT(*) AS c FROM follow_ups WHERE status='pending' ${scope} AND scheduled_at BETWEEN ? AND ?`, [s, e]),
      query(`SELECT COUNT(*) AS c FROM follow_ups WHERE status='pending' ${scope} AND scheduled_at > ?`, [e]),
    ]);

    res.json({ success: true, counts: { overdue: Number(ov.c), today: Number(td.c), upcoming: Number(up.c) } });
  } catch (err) { next(err); }
});

// ── PATCH /follow-ups/:id/complete ────────────────────────────
fuRouter.patch('/follow-ups/:id/complete', async (req, res, next) => {
  try {
    const { notes, rescheduled_to } = req.body;
    const [fu] = await query('SELECT * FROM follow_ups WHERE id=?', [req.params.id]);
    if (!fu) return res.status(404).json({ success: false, message: 'Not found.' });

    await query(
      'UPDATE follow_ups SET status=?, completed_at=NOW(), notes=?, rescheduled_to=? WHERE id=?',
      [rescheduled_to ? 'rescheduled' : 'done', notes || fu.notes, rescheduled_to || null, fu.id]
    );

    if (rescheduled_to) {
      await query(
        'INSERT INTO follow_ups (lead_id, assigned_to, scheduled_at, type, notes, created_by) VALUES (?,?,?,?,?,?)',
        [fu.lead_id, fu.assigned_to, rescheduled_to, fu.type, notes || '', fu.assigned_to]
      );
    }

    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = fuRouter;