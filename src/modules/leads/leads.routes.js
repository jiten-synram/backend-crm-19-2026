'use strict';
const express = require('express');
const { query } = require('../../config/db');
const { protect, authorize, isAdmin, AppError } = require('../../middleware/auth');
const { assignRoundRobin, assignManual, processDelivered } = require('../../services/crm.service');

const router = express.Router();
router.use(protect);

const VALID_STATUSES = ['new','in_process','follow_up','converted','delivered','closed_lost'];

// ── scope filter by role ───────────────────────────────────────
const scopeClause = (user, alias = 'l') => {
  if (isAdmin(user)) return '';
  return ` AND ${alias}.assigned_to = ${user.id}`;
};

// ── GET /api/leads ─────────────────────────────────────────────
// router.get('/', async (req, res, next) => {
//   try {
//     const { search, status, source, category, campaign_id, assigned_to,
//             is_repeat, start_date, end_date, page=1, limit=25 } = req.query;

//     let where = '1=1';
//     const p = [];

//     if (!isAdmin(req.user)) { where += ' AND l.assigned_to=?'; p.push(req.user.id); }
//     else if (assigned_to)   { where += ' AND l.assigned_to=?'; p.push(assigned_to); }

//     if (search) {
//       where += ' AND (l.name LIKE ? OR l.phone LIKE ? OR l.email LIKE ?)';
//       const s = `%${search}%`; p.push(s,s,s);
//     }
//     if (status)      { where += ' AND l.status=?';      p.push(status); }
//     if (source)      { where += ' AND l.source=?';      p.push(source); }
//     if (category)    { where += ' AND l.category=?';    p.push(category); }
//     if (campaign_id) { where += ' AND l.campaign_id=?'; p.push(campaign_id); }
//     if (is_repeat)   { where += ' AND l.is_repeat=?';   p.push(is_repeat==='true'?1:0); }
//     if (start_date)  { where += ' AND l.created_at>=?'; p.push(start_date+' 00:00:00'); }
//     if (end_date)    { where += ' AND l.created_at<=?'; p.push(end_date+' 23:59:59'); }

//     const offset = (Number(page)-1) * Number(limit);
//     const [[{ total }]] = await Promise.all([
//       query(`SELECT COUNT(*) AS total FROM leads l WHERE ${where}`, p)
//     ]);
//     const leads = await query(`
//       SELECT l.*,
//         u.name AS assigned_name, u.email AS assigned_email,
//         c.name AS campaign_name,
//         cu.total_orders AS cust_orders, cu.lifetime_value AS cust_ltv
//       FROM leads l
//       LEFT JOIN users u     ON u.id = l.assigned_to
//       LEFT JOIN campaigns c ON c.id = l.campaign_id
//       LEFT JOIN customers cu ON cu.id = l.linked_customer_id
//       WHERE ${where}
//       ORDER BY l.created_at DESC
//       LIMIT ? OFFSET ?
//     `, [...p, Number(limit), offset]);

//     res.json({ success:true, total: total||0, page:Number(page), pages:Math.ceil((total||0)/Number(limit)), leads });
//   } catch (err) { next(err); }
// });

router.get('/', async (req, res, next) => {
  try {
    const { search, status, source, category, campaign_id, assigned_to,
            is_repeat, start_date, end_date, page=1, limit=25 } = req.query;
    
    const limitNum  = parseInt(limit)  || 25;
    const pageNum   = parseInt(page)   || 1;
    const offset    = (pageNum - 1) * limitNum;

    let where = '1=1';
    const p = [];
    if (!isAdmin(req.user)) { where += ' AND l.assigned_to=?'; p.push(req.user.id); }
    else if (assigned_to)   { where += ' AND l.assigned_to=?'; p.push(assigned_to); }
    if (search) {
      where += ' AND (l.name LIKE ? OR l.phone LIKE ? OR l.email LIKE ?)';
      const s = `%${search}%`; p.push(s,s,s);
    }
    if (status)      { where += ' AND l.status=?';      p.push(status); }
    if (source)      { where += ' AND l.source=?';      p.push(source); }
    if (category)    { where += ' AND l.category=?';    p.push(category); }
    if (campaign_id) { where += ' AND l.campaign_id=?'; p.push(campaign_id); }
    if (is_repeat)   { where += ' AND l.is_repeat=?';   p.push(is_repeat==='true'?1:0); }
    if (start_date)  { where += ' AND l.created_at>=?'; p.push(start_date+' 00:00:00'); }
    if (end_date)    { where += ' AND l.created_at<=?'; p.push(end_date+' 23:59:59'); }

    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM leads l WHERE ${where}`, p
    );

    const leads = await query(`
      SELECT l.*,
        u.name AS assigned_name, u.email AS assigned_email,
        c.name AS campaign_name,
        cu.total_orders AS cust_orders, cu.lifetime_value AS cust_ltv
      FROM leads l
      LEFT JOIN users u     ON u.id = l.assigned_to
      LEFT JOIN campaigns c ON c.id = l.campaign_id
      LEFT JOIN customers cu ON cu.id = l.linked_customer_id
      WHERE ${where}
      ORDER BY l.created_at DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `, p);

    res.json({
      success: true,
      total: total || 0,
      page: pageNum,
      pages: Math.ceil((total || 0) / limitNum),
      leads
    });
  } catch (err) { next(err); }
});

// ── GET /api/leads/stats ───────────────────────────────────────
router.get('/stats/summary', async (req, res, next) => {
  try {
    const scope = isAdmin(req.user) ? '' : `AND assigned_to=${req.user.id}`;
    const rows = await query(`
      SELECT status, COUNT(*) AS cnt,
        SUM(CASE WHEN revenue_countable=1 THEN COALESCE(order_amount,0) ELSE 0 END) AS revenue
      FROM leads WHERE 1=1 ${scope}
      GROUP BY status
    `);
    const r = { total:0, new:0, in_process:0, follow_up:0, converted:0, delivered:0, closed_lost:0, repeat_orders:0, total_revenue:0 };
    rows.forEach(s => { r[s.status]=Number(s.cnt); r.total+=Number(s.cnt); r.total_revenue+=Number(s.revenue||0); });
    const [{ rep }] = await query(`SELECT COUNT(*) AS rep FROM leads WHERE is_repeat=1 ${scope}`);
    r.repeat_orders = Number(rep);
    res.json({ success:true, stats:r });
  } catch (err) { next(err); }
});

// ── GET /api/leads/:id ─────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const scope = isAdmin(req.user) ? '' : `AND l.assigned_to=${req.user.id}`;
    const [lead] = await query(`
      SELECT l.*, u.name AS assigned_name, c.name AS campaign_name
      FROM leads l
      LEFT JOIN users u     ON u.id = l.assigned_to
      LEFT JOIN campaigns c ON c.id = l.campaign_id
      WHERE l.id=? ${scope}
    `, [req.params.id]);
    if (!lead) throw new AppError('Lead not found.', 404);

    const [notes, callLogs, history, linkedCust] = await Promise.all([
      query('SELECT n.*, u.name AS added_by_name FROM lead_notes n LEFT JOIN users u ON u.id=n.added_by WHERE n.lead_id=? ORDER BY n.created_at DESC', [lead.id]),
      query('SELECT c.*, u.name AS caller_name FROM call_logs c LEFT JOIN users u ON u.id=c.user_id WHERE c.lead_id=? ORDER BY c.created_at DESC', [lead.id]),
      query('SELECT h.*, u.name AS changed_by_name FROM status_history h LEFT JOIN users u ON u.id=h.changed_by WHERE h.lead_id=? ORDER BY h.changed_at DESC', [lead.id]),
      lead.linked_customer_id ? query('SELECT id,name,total_orders,lifetime_value,last_purchase FROM customers WHERE id=?', [lead.linked_customer_id]) : Promise.resolve([]),
    ]);

    res.json({ success:true, lead:{ ...lead, notes, callLogs, history, linkedCustomer: linkedCust[0]||null } });
  } catch (err) { next(err); }
});

// ── POST /api/leads ────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { name, phone, email, alt_phone, city, state, age, gender,
            source, category, supplement, campaign_id,
            product_name, notes, assigned_to: manualAssign } = req.body;

    if (!name || !phone) throw new AppError('Name and phone are required.');
    const cleanPhone = phone.replace(/\D/g,'').slice(-10);

    // Duplicate check
    const [dup] = await query('SELECT id,name,status FROM leads WHERE phone=?', [cleanPhone]);

    // Assignment
    let assignedTo = null;
    let isManual   = 0;
    if (manualAssign && isAdmin(req.user)) {
      assignedTo = await assignManual(manualAssign);
      isManual   = 1;
    } else {
      assignedTo = await assignRoundRobin(category).catch(() => null);
    }

    const result = await query(`
      INSERT INTO leads (name,phone,alt_phone,email,city,state,age,gender,
                         source,category,supplement,campaign_id,product_name,
                         assigned_to,assigned_at,assigned_by,is_manual_assign,
                         is_duplicate,duplicate_of,created_by,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `, [name, cleanPhone, alt_phone||null, email?.toLowerCase()||null,
        city||null, state||null, age||null, gender||null,
        source, category, supplement||null, campaign_id||null, product_name||null,
        assignedTo, assignedTo?new Date():null, req.user.id, isManual,
        dup?1:0, dup?.id||null, req.user.id, req.user.id]);

    const leadId = result.insertId;

    // Initial status history
    await query('INSERT INTO status_history (lead_id,to_status,changed_by,remark) VALUES (?,?,?,?)',
      [leadId, 'new', req.user.id, 'Lead created']);

    // Note
    if (notes) await query('INSERT INTO lead_notes (lead_id,added_by,note) VALUES (?,?,?)',
      [leadId, req.user.id, notes]);

    const [lead] = await query('SELECT l.*,u.name AS assigned_name FROM leads l LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=?', [leadId]);
    res.status(201).json({ success:true, lead, isDuplicate:!!dup, duplicateOf: dup||null });
  } catch (err) { next(err); }
});

// ── PATCH /api/leads/:id ───────────────────────────────────────
router.patch('/:id', async (req, res, next) => {
  try {
    const allowed = ['name','phone','email','alt_phone','city','state','age','gender',
                     'source','category','supplement','campaign_id','product_name',
                     'order_amount','tracking_id','next_followup_at','remark'];
    const sets=[]; const vals=[];
    allowed.forEach(f => { if(req.body[f]!==undefined){ sets.push(`${f}=?`); vals.push(req.body[f]); } });
    if(!sets.length) throw new AppError('No fields to update.');
    sets.push('updated_by=?'); vals.push(req.user.id);
    vals.push(req.params.id);
    const scope = isAdmin(req.user) ? '' : `AND assigned_to=${req.user.id}`;
    await query(`UPDATE leads SET ${sets.join(',')} WHERE id=? ${scope}`, vals);
    const [lead] = await query('SELECT l.*,u.name AS assigned_name FROM leads l LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=?', [req.params.id]);
    res.json({ success:true, lead });
  } catch (err) { next(err); }
});

// ── PATCH /api/leads/:id/status — STRICT BUSINESS RULES ───────
router.patch('/:id/status', async (req, res, next) => {
  try {
    const { status, remark, order_amount, tracking_id, next_followup_at } = req.body;
    if (!VALID_STATUSES.includes(status)) throw new AppError(`Invalid status.`);

    const scope = isAdmin(req.user) ? '' : `AND assigned_to=${req.user.id}`;
    const [lead] = await query(`SELECT * FROM leads WHERE id=? ${scope}`, [req.params.id]);
    if (!lead) throw new AppError('Lead not found.', 404);

    // Business rules
    if (status==='converted' && !lead.order_amount && !order_amount)
      throw new AppError('Order amount required to Convert a lead.');
    if (status==='delivered' && !tracking_id && !lead.tracking_id)
      throw new AppError('Tracking ID required for Delivered status.');
    if (status==='follow_up' && !next_followup_at && !lead.next_followup_at)
      throw new AppError('Follow-up date required.');

    const updates = { status, updated_by: req.user.id };
    if (order_amount)      updates.order_amount    = order_amount;
    if (tracking_id)       updates.tracking_id     = tracking_id;
    if (next_followup_at)  { updates.next_followup_at = next_followup_at; updates.followup_count = lead.followup_count + 1; updates.last_followup_at = new Date(); }
    if (status==='delivered') { updates.revenue_countable = 1; updates.delivered_at = new Date(); }

    const sets  = Object.keys(updates).map(k=>`${k}=?`).join(',');
    await query(`UPDATE leads SET ${sets} WHERE id=?`, [...Object.values(updates), lead.id]);

    // Status history
    await query('INSERT INTO status_history (lead_id,from_status,to_status,changed_by,remark) VALUES (?,?,?,?,?)',
      [lead.id, lead.status, status, req.user.id, remark||'']);

    // Delivered: create order, customer, incentive
    if (status==='delivered' && lead.status!=='delivered') {
      const fullLead = { ...lead, ...updates };
      await processDelivered(fullLead);
    }

    // Follow-up: create followup record
    if (status==='follow_up' && next_followup_at) {
      await query('INSERT INTO follow_ups (lead_id,assigned_to,scheduled_at,type,notes,created_by) VALUES (?,?,?,?,?,?)',
        [lead.id, lead.assigned_to, next_followup_at, 'call', remark||'', req.user.id]);
    }

    const [updated] = await query('SELECT l.*,u.name AS assigned_name FROM leads l LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=?', [lead.id]);
    res.json({ success:true, lead:updated });
  } catch (err) { next(err); }
});

// ── POST /api/leads/:id/notes ──────────────────────────────────
router.post('/:id/notes', async (req, res, next) => {
  try {
    const { note, is_private } = req.body;
    if (!note?.trim()) throw new AppError('Note text required.');
    const scope = isAdmin(req.user) ? '' : `AND assigned_to=${req.user.id}`;
    const [lead] = await query(`SELECT id FROM leads WHERE id=? ${scope}`, [req.params.id]);
    if (!lead) throw new AppError('Lead not found.', 404);
    const res2 = await query('INSERT INTO lead_notes (lead_id,added_by,note,is_private) VALUES (?,?,?,?)',
      [lead.id, req.user.id, note.trim(), is_private?1:0]);
    const [n] = await query('SELECT n.*,u.name AS added_by_name FROM lead_notes n LEFT JOIN users u ON u.id=n.added_by WHERE n.id=?', [res2.insertId]);
    res.status(201).json({ success:true, note:n });
  } catch (err) { next(err); }
});

// ── POST /api/leads/:id/call-log ───────────────────────────────
router.post('/:id/call-log', async (req, res, next) => {
  try {
    const { call_type, duration, outcome, notes } = req.body;
    const scope = isAdmin(req.user) ? '' : `AND assigned_to=${req.user.id}`;
    const [lead] = await query(`SELECT id FROM leads WHERE id=? ${scope}`, [req.params.id]);
    if (!lead) throw new AppError('Lead not found.', 404);
    const r = await query('INSERT INTO call_logs (lead_id,user_id,call_type,duration,outcome,notes) VALUES (?,?,?,?,?,?)',
      [lead.id, req.user.id, call_type||'outbound', duration||0, outcome||null, notes||null]);
    res.status(201).json({ success:true, id: r.insertId });
  } catch (err) { next(err); }
});

// ── PATCH /api/leads/:id/assign ────────────────────────────────
router.patch('/:id/assign', authorize('admin','sub_admin'), async (req, res, next) => {
  try {
    const { assigned_to } = req.body;
    await assignManual(assigned_to);
    await query('UPDATE leads SET assigned_to=?,assigned_at=NOW(),assigned_by=?,is_manual_assign=1 WHERE id=?',
      [assigned_to, req.user.id, req.params.id]);
    const [lead] = await query('SELECT l.*,u.name AS assigned_name FROM leads l LEFT JOIN users u ON u.id=l.assigned_to WHERE l.id=?', [req.params.id]);
    res.json({ success:true, lead });
  } catch (err) { next(err); }
});

// ── PATCH /api/leads/bulk-assign ─────────────────────────────
router.patch('/bulk-assign', authorize('admin', 'sub_admin'), async (req, res, next) => {
  try {
    const { ids, assigned_to } = req.body;

    if (!ids || !Array.isArray(ids) || ids.length === 0)
      throw new AppError('ids array required.');
    if (!assigned_to)
      throw new AppError('assigned_to required.');

    // User exist karta hai?
    const [agent] = await query('SELECT id, name FROM users WHERE id=? AND is_active=1', [assigned_to]);
    if (!agent) throw new AppError('Agent not found.', 404);

    // Bulk update
    const placeholders = ids.map(() => '?').join(',');
    await query(
      `UPDATE leads SET assigned_to=?, assigned_at=NOW(), assigned_by=?, is_manual_assign=1 WHERE id IN (${placeholders})`,
      [assigned_to, req.user.id, ...ids]
    );

    // Activities log
    for (const id of ids) {
      await query(
        `INSERT INTO activities (entity_type, entity_id, action, description, performed_by) VALUES ('lead', ?, 'assign', ?, ?)`,
        [id, `Bulk assigned to ${agent.name}`, req.user.id]
      );
    }

    res.json({ success: true, message: `${ids.length} leads assigned to ${agent.name}` });
  } catch (err) { next(err); }
});

module.exports = router;
