'use strict';
const express  = require('express');
const ExcelJS  = require('exceljs');
const { Parser } = require('json2csv');
const { query } = require('../../config/db');
const { protect, authorize, isAdmin, AppError } = require('../../middleware/auth');

// ================================================================
// ORDERS
// ================================================================
const ordersRouter = express.Router();
ordersRouter.use(protect);

ordersRouter.get('/', async (req, res, next) => {
  try {
    // ✅ Fix 1 — limitNum/offset define karo
    const limitNum = parseInt(req.query.limit) || 25;
    const pageNum  = parseInt(req.query.page)  || 1;
    const offset   = (pageNum - 1) * limitNum;

    let where = '1=1'; const p = [];
    if (!isAdmin(req.user)) { where += ' AND o.assigned_to=?'; p.push(req.user.id); }
    if (req.query.status)    { where += ' AND o.status=?';     p.push(req.query.status); }
    if (req.query.is_repeat) { where += ' AND o.is_repeat=?';  p.push(req.query.is_repeat === 'true' ? 1 : 0); }

    // ✅ Fix 2 — [[{total}]] → [{total}]
    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM orders o WHERE ${where}`, p
    );

    // ✅ Fix 3 — LIMIT/OFFSET directly
    const orders = await query(`
      SELECT o.*, l.name AS lead_name, l.phone AS lead_phone,
             c.name AS customer_name, u.name AS agent_name
      FROM orders o
      LEFT JOIN leads l     ON l.id = o.lead_id
      LEFT JOIN customers c ON c.id = o.customer_id
      LEFT JOIN users u     ON u.id = o.assigned_to
      WHERE ${where}
      ORDER BY o.created_at DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `, p);

    res.json({ success: true, total, orders });
  } catch(err) { next(err); }
});

ordersRouter.patch('/:id/tracking', async (req, res, next) => {
  try {
    const { status, tracking_id, courier, dispatch_date, delivery_date, cancelled_date } = req.body;

    const sets = []; const vals = [];

    if (tracking_id  !== undefined) { sets.push('tracking_id=?');   vals.push(tracking_id || null); }
    if (courier      !== undefined) { sets.push('courier=?');        vals.push(courier || null); }
    if (dispatch_date)              { sets.push('dispatch_date=?');  vals.push(dispatch_date); }
    if (delivery_date)              { sets.push('delivery_date=?');  vals.push(delivery_date); }
    if (cancelled_date)             { sets.push('cancelled_date=?'); vals.push(cancelled_date); }

    if (status) {
      sets.push('status=?'); vals.push(status);
      if (status === 'delivered') { sets.push('revenue_countable=?'); vals.push(1); }
      if (status === 'cancelled') { sets.push('revenue_countable=?'); vals.push(0); }
    }

    sets.push('updated_at=NOW()');
    vals.push(req.params.id);

    await query(`UPDATE orders SET ${sets.join(',')} WHERE id=?`, vals);

    if (status === 'delivered' && delivery_date) {
      const { processOrderDelivered } = require('../../services/crm.service');
      const [order] = await query('SELECT lead_id FROM orders WHERE id=?', [req.params.id]);
      if (order?.lead_id) await processOrderDelivered(order.lead_id, delivery_date);
    }

    const [updated] = await query('SELECT * FROM orders WHERE id=?', [req.params.id]);
    res.json({ success: true, order: updated });
  } catch(err) { next(err); }
});

// ================================================================
// TEAM
// ================================================================
const teamRouter = express.Router();
teamRouter.use(protect, authorize('admin','sub_admin'));

teamRouter.get('/round-robin', async (req, res, next) => {
  try {
    const status = await query(`
      SELECT rr.*, u.name AS last_user_name,
        COUNT(uc.user_id) AS total_members,
        SUM(u2.is_active) AS active_members
      FROM round_robin rr
      LEFT JOIN users u  ON u.id  = rr.last_user_id
      LEFT JOIN user_categories uc ON uc.category = rr.category
      LEFT JOIN users u2 ON u2.id = uc.user_id AND u2.is_active = 1
      GROUP BY rr.id, rr.category, rr.current_index, rr.last_user_id, rr.updated_at, u.name
      ORDER BY rr.category
    `);
    res.json({ success: true, status });
  } catch(err) { next(err); }
});

teamRouter.post('/assign-category', async (req, res, next) => {
  try {
    const { user_id, category } = req.body;
    await query('INSERT IGNORE INTO user_categories (user_id,category) VALUES (?,?)', [user_id, category]);
    await query('INSERT IGNORE INTO round_robin (category,current_index) VALUES (?,0)', [category]);
    res.json({ success: true, message: `User added to ${category} pool` });
  } catch(err) { next(err); }
});

teamRouter.delete('/assign-category', async (req, res, next) => {
  try {
    const { user_id, category } = req.body;
    await query('DELETE FROM user_categories WHERE user_id=? AND category=?', [user_id, category]);
    res.json({ success: true });
  } catch(err) { next(err); }
});

teamRouter.patch('/reset-index/:category', authorize('admin'), async (req, res, next) => {
  try {
    await query('UPDATE round_robin SET current_index=0 WHERE category=?', [req.params.category]);
    res.json({ success: true, message: 'Round-robin index reset.' });
  } catch(err) { next(err); }
});

// ================================================================
// DASHBOARD
// ================================================================
const dashRouter = express.Router();
dashRouter.use(protect);

dashRouter.get('/admin', authorize('admin','sub_admin'), async (req, res, next) => {
  try {
    const { start_date, end_date } = req.query;
    const dateWhere = start_date
      ? `AND created_at BETWEEN '${start_date} 00:00:00' AND '${end_date || new Date().toISOString().split('T')[0]} 23:59:59'`
      : '';

    const [kpis, repCnt, custCnt, monthlyRev, byStatus, bySource, userPerf, fuCounts] = await Promise.all([
      query(`SELECT status, COUNT(*) AS cnt, SUM(CASE WHEN revenue_countable=1 THEN COALESCE(order_amount,0) ELSE 0 END) AS revenue FROM leads WHERE 1=1 ${dateWhere} GROUP BY status`),
      query(`SELECT COUNT(*) AS c FROM orders WHERE is_repeat=1`),
      query(`SELECT COUNT(*) AS cus FROM customers WHERE is_active=1`),
      query(`SELECT YEAR(delivery_date) AS yr, MONTH(delivery_date) AS mo, SUM(amount) AS revenue, COUNT(*) AS orders FROM orders WHERE revenue_countable=1 AND delivery_date>=DATE_SUB(NOW(),INTERVAL 12 MONTH) GROUP BY yr,mo ORDER BY yr,mo`),
      query(`SELECT status, COUNT(*) AS cnt FROM leads WHERE 1=1 ${dateWhere} GROUP BY status`),
      query(`SELECT source, COUNT(*) AS cnt FROM leads WHERE 1=1 ${dateWhere} GROUP BY source`),
      query(`SELECT u.id, u.name, COUNT(l.id) AS total_leads,
        SUM(l.status IN ('converted','delivered')) AS converted,
        SUM(l.status='delivered') AS delivered,
        SUM(CASE WHEN l.revenue_countable=1 THEN COALESCE(l.order_amount,0) ELSE 0 END) AS revenue
        FROM users u LEFT JOIN leads l ON l.assigned_to=u.id ${dateWhere ? 'AND ' + dateWhere.slice(4) : ''}
        WHERE u.role='sales' GROUP BY u.id, u.name ORDER BY revenue DESC`),

      // ✅ Fix 4 — [[ov],[td],[up]] → [ov,td,up] then [0]
      (async () => {
        const n = new Date();
        const s = new Date(n); s.setHours(0, 0, 0, 0);
        const e = new Date(n); e.setHours(23, 59, 59, 999);
        const [ov, td, up] = await Promise.all([
          query(`SELECT COUNT(*) AS c FROM leads WHERE status='follow_up' AND next_followup_at<?`, [s]),
          query(`SELECT COUNT(*) AS c FROM leads WHERE status='follow_up' AND next_followup_at BETWEEN ? AND ?`, [s, e]),
          query(`SELECT COUNT(*) AS c FROM leads WHERE status='follow_up' AND next_followup_at>?`, [e]),
        ]);
        return {
          overdue:  Number(ov[0].c),
          today:    Number(td[0].c),
          upcoming: Number(up[0].c)
        };
      })()
    ]);

    const cards = {
      total: 0, new: 0, in_process: 0, follow_up: 0, converted: 0,
      delivered: 0, closed_lost: 0,
      repeat_orders: Number(repCnt[0]?.c || 0),
      customers:     Number(custCnt[0]?.cus || 0),
      total_revenue: 0
    };
    kpis.forEach(k => {
      cards[k.status] = Number(k.cnt);
      cards.total     += Number(k.cnt);
      cards.total_revenue += Number(k.revenue || 0);
    });
    const userPerfWithRate = userPerf.map(u => ({
      ...u,
      conversionRate: u.total_leads > 0 ? +(u.converted / u.total_leads * 100).toFixed(1) : 0
    }));

    res.json({ success: true, cards, monthlyRevenue: monthlyRev, byStatus, bySource, userPerformance: userPerfWithRate, followUpCounts: fuCounts });
  } catch(err) { next(err); }
});

dashRouter.get('/user', async (req, res, next) => {
  try {
    const uid = req.user.id;
    const [kpis, monthly, byStatus, incSummary] = await Promise.all([
      query(`SELECT status, COUNT(*) AS cnt, SUM(CASE WHEN revenue_countable=1 THEN COALESCE(order_amount,0) ELSE 0 END) AS revenue FROM leads WHERE assigned_to=? GROUP BY status`, [uid]),
      query(`SELECT YEAR(delivery_date) AS yr, MONTH(delivery_date) AS mo, SUM(amount) AS revenue, COUNT(*) AS orders FROM orders WHERE assigned_to=? AND revenue_countable=1 AND delivery_date>=DATE_SUB(NOW(),INTERVAL 6 MONTH) GROUP BY yr,mo ORDER BY yr,mo`, [uid]),
      query(`SELECT status, COUNT(*) AS cnt FROM leads WHERE assigned_to=? GROUP BY status`, [uid]),
      query(`SELECT status, SUM(incentive_amount) AS total, COUNT(*) AS cnt FROM incentives WHERE user_id=? GROUP BY status`, [uid]),
    ]);

    const cards = { assigned: 0, converted: 0, delivered: 0, pending: 0, total_revenue: 0, total: 0, in_process: 0, follow_up: 0, new: 0 };
    kpis.forEach(k => {
      cards.assigned      += Number(k.cnt);
      cards.total         += Number(k.cnt);
      cards.total_revenue += Number(k.revenue || 0);
      if (['converted','delivered'].includes(k.status)) cards.converted  += Number(k.cnt);
      if (['new','in_process','follow_up'].includes(k.status)) cards.pending += Number(k.cnt);
      if (k.status === 'delivered')  cards.delivered  = Number(k.cnt);
      if (k.status === 'in_process') cards.in_process = Number(k.cnt);
      if (k.status === 'follow_up')  cards.follow_up  = Number(k.cnt);
      if (k.status === 'new')        cards.new        = Number(k.cnt);
    });

    const inc = { pending: 0, approved: 0, paid: 0 };
    incSummary.forEach(i => { inc[i.status] = Number(i.total || 0); });

    // ✅ Fix 5 — [[ov],[td],[up]] → [ov,td,up] then [0]
    const n = new Date();
    const s = new Date(n); s.setHours(0, 0, 0, 0);
    const e = new Date(n); e.setHours(23, 59, 59, 999);
    const [ov, td, up] = await Promise.all([
      query(`SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND status='follow_up' AND next_followup_at<?`, [uid, s]),
      query(`SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND status='follow_up' AND next_followup_at BETWEEN ? AND ?`, [uid, s, e]),
      query(`SELECT COUNT(*) AS c FROM leads WHERE assigned_to=? AND status='follow_up' AND next_followup_at>?`, [uid, e]),
    ]);

    res.json({
      success: true, cards, monthlyGraph: monthly, byStatus,
      incentiveSummary: inc,
      followUps: {
        overdue:  Number(ov[0].c),
        today:    Number(td[0].c),
        upcoming: Number(up[0].c)
      }
    });
  } catch(err) { next(err); }
});

// ================================================================
// REPORTS
// ================================================================
const repRouter = express.Router();
repRouter.use(protect);

const buildWhere = (q, user) => {
  let w = '1=1'; const p = [];
  if (user.role === 'sales') { w += ' AND l.assigned_to=?'; p.push(user.id); }
  else if (q.assigned_to)   { w += ' AND l.assigned_to=?'; p.push(q.assigned_to); }
  if (q.status)      { w += ' AND l.status=?';      p.push(q.status); }
  if (q.source)      { w += ' AND l.source=?';      p.push(q.source); }
  if (q.category)    { w += ' AND l.category=?';    p.push(q.category); }
  if (q.campaign_id) { w += ' AND l.campaign_id=?'; p.push(q.campaign_id); }
  if (q.start_date)  { w += ' AND l.created_at>=?'; p.push(q.start_date + ' 00:00:00'); }
  if (q.end_date)    { w += ' AND l.created_at<=?'; p.push(q.end_date   + ' 23:59:59'); }
  if (q.search) {
    w += ' AND (l.name LIKE ? OR l.phone LIKE ? OR l.email LIKE ?)';
    const s = `%${q.search}%`; p.push(s, s, s);
  }
  if (q.ids) {
    const ids = q.ids.split(',').map(id => parseInt(id)).filter(Boolean);
    if (ids.length) { w += ` AND l.id IN (${ids.map(() => '?').join(',')})`; p.push(...ids); }
  }
  return { w, p };
};

repRouter.get('/revenue', async (req, res, next) => {
  try {
    const { start_date, end_date, assigned_to } = req.query;
    const effectiveUser = req.user.role === 'sales' ? req.user.id : (assigned_to ? Number(assigned_to) : null);
    const userWhere  = effectiveUser ? `AND o.assigned_to = ${effectiveUser}` : '';
    const dateStart  = start_date ? `AND o.delivery_date >= '${start_date}'` : '';
    const dateEnd    = end_date   ? `AND o.delivery_date <= '${end_date}'`   : '';

    const data = await query(`
      SELECT YEAR(o.delivery_date) AS yr, MONTH(o.delivery_date) AS mo,
             SUM(o.amount) AS revenue, COUNT(*) AS orders, AVG(o.amount) AS avg_order
      FROM orders o
      WHERE o.revenue_countable = 1 ${dateStart} ${dateEnd} ${userWhere}
      GROUP BY yr, mo ORDER BY yr, mo
    `);
    const [summary] = await query(`
      SELECT SUM(o.amount) AS total, COUNT(*) AS cnt
      FROM orders o
      WHERE o.revenue_countable = 1 ${dateStart} ${dateEnd} ${userWhere}
    `);
    res.json({ success: true, data, summary });
  } catch(err) { next(err); }
});

repRouter.get('/team-performance', async (req, res, next) => {
  try {
    const assignedTo = req.query.assigned_to ? Number(req.query.assigned_to) : null;
    const userFilter = req.user.role === 'sales'
      ? `AND u.id = ${req.user.id}`
      : (assignedTo ? `AND u.id = ${assignedTo}` : '');

    const performance = await query(`
      SELECT u.id, u.name, u.email,
        COUNT(l.id) AS total_leads,
        SUM(l.status='new') AS new_cnt,
        SUM(l.status='in_process') AS in_process,
        SUM(l.status='follow_up') AS follow_up,
        SUM(l.status IN ('converted','delivered')) AS converted,
        SUM(l.status='delivered') AS delivered,
        SUM(l.status IN ('cancelled','dead')) AS closed_lost,
        SUM(CASE WHEN l.revenue_countable=1 THEN COALESCE(l.order_amount,0) ELSE 0 END) AS revenue,
        ROUND(SUM(l.status IN ('converted','delivered'))/NULLIF(COUNT(l.id),0)*100,1) AS conversion_rate
      FROM users u LEFT JOIN leads l ON l.assigned_to=u.id
      WHERE u.role='sales' ${userFilter}
      GROUP BY u.id, u.name, u.email
      ORDER BY revenue DESC
    `);
    res.json({ success: true, performance });
  } catch(err) { next(err); }
});

repRouter.get('/campaign-performance', async (req, res, next) => {
  try {
    const userWhere = req.user.role === 'sales'
      ? `AND l.assigned_to = ${req.user.id}`
      : (req.query.assigned_to ? `AND l.assigned_to = ${Number(req.query.assigned_to)}` : '');

    const data = await query(`
      SELECT c.id, c.name, c.platform, c.status,
        COUNT(l.id) AS total_leads,
        SUM(l.status IN ('converted','delivered')) AS converted,
        SUM(CASE WHEN l.revenue_countable=1 THEN COALESCE(l.order_amount,0) ELSE 0 END) AS revenue,
        ROUND(SUM(l.status IN ('converted','delivered'))/NULLIF(COUNT(l.id),0)*100,1) AS conversion_rate
      FROM campaigns c LEFT JOIN leads l ON l.campaign_id=c.id ${userWhere}
      GROUP BY c.id, c.name, c.platform, c.status
      ORDER BY revenue DESC
    `);
    res.json({ success: true, data });
  } catch(err) { next(err); }
});

repRouter.get('/incentives', async (req, res, next) => {
  try {
    let where  = isAdmin(req.user) ? '1=1' : `i.user_id=${req.user.id}`;
    let where2 = isAdmin(req.user) ? '1=1' : `user_id=${req.user.id}`;

    if (req.query.user_id && isAdmin(req.user)) {
      where  += ` AND i.user_id=${req.query.user_id}`;
      where2 += ` AND user_id=${req.query.user_id}`;
    }
    if (req.query.status) {
      where  += ` AND i.status='${req.query.status}'`;
      where2 += ` AND status='${req.query.status}'`;
    }

    const [incentives, summary] = await Promise.all([
      query(`SELECT i.*, u.name AS user_name, u.email AS user_email, l.name AS lead_name, l.phone AS lead_phone, o.product_name FROM incentives i LEFT JOIN users u ON u.id=i.user_id LEFT JOIN leads l ON l.id=i.lead_id LEFT JOIN orders o ON o.id=i.order_id WHERE ${where} ORDER BY i.created_at DESC`),
      query(`SELECT status, SUM(incentive_amount) AS total, COUNT(*) AS cnt FROM incentives WHERE ${where2} GROUP BY status`),
    ]);
    res.json({ success: true, incentives, summary });
  } catch(err) { next(err); }
});

repRouter.get('/export', async (req, res, next) => {
  try {
    const { format = 'excel' } = req.query;
    const { w, p } = buildWhere(req.query, req.user);
    const leads = await query(`
      SELECT l.*, u.name AS assigned_name, c.name AS campaign_name
      FROM leads l
      LEFT JOIN users u     ON u.id = l.assigned_to
      LEFT JOIN campaigns c ON c.id = l.campaign_id
      WHERE ${w} ORDER BY l.created_at DESC
    `, p);

    const rows = leads.map(l => ({
      Name:           l.name,
      Phone:          l.phone,
      Email:          l.email || '',
      Status:         l.status,
      Source:         l.source,
      Category:       l.category,
      'Assigned To':  l.assigned_name || '',
      'Product':      l.product_name || '',
      'Order Amount': l.order_amount || 0,
      'Payment':      l.payment_status || '',
      'Tracking ID':  l.tracking_id || '',
      'Close Date':   l.close_date || '',
      'Shipping':     l.shipping_address || '',
      'Repeat':       l.is_repeat ? 'Yes' : 'No',
      'Campaign':     l.campaign_name || '',
      'Created':      new Date(l.created_at).toLocaleDateString('en-IN'),
      'Follow-up':    l.next_followup_at ? new Date(l.next_followup_at).toLocaleDateString('en-IN') : '',
    }));

    if (format === 'csv') {
      const parser = new Parser({ fields: Object.keys(rows[0] || {}) });
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="yogveda-leads-${Date.now()}.csv"`);
      return res.send(parser.parse(rows));
    }

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Leads');
    if (rows.length) {
      ws.columns = Object.keys(rows[0]).map(k => ({ header: k, key: k, width: 20 }));
      ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF162B20' } };
      rows.forEach(r => ws.addRow(r));
      ws.eachRow((row, i) => {
        if (i > 1 && i % 2 === 0) row.eachCell(c => {
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F5F3' } };
        });
      });
    }
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="yogveda-leads-${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch(err) { next(err); }
});

module.exports = { ordersRouter, teamRouter, dashRouter, repRouter };
