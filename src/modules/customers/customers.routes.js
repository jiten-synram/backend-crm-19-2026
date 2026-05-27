'use strict';
const express = require('express');
const { query } = require('../../config/db');
const { protect, AppError } = require('../../middleware/auth');
const { findCustomerByFingerprint } = require('../../services/crm.service');
const router = express.Router();
router.use(protect);

router.get('/', async (req, res, next) => {
  try {
    const { search, page=1, limit=25 } = req.query;
    const limitNum = parseInt(limit) || 25;
    const pageNum  = parseInt(page)  || 1;
    const offset   = (pageNum - 1) * limitNum;

    let where = '1=1'; const p = [];
    if (search) {
      where += ' AND (c.name LIKE ? OR c.phone LIKE ?)';
      const s = `%${search}%`; p.push(s, s);
    }

    // ✅ Fix 1
    const [{ total }] = await query(
      `SELECT COUNT(*) AS total FROM customers c WHERE ${where}`, p
    );

    // ✅ Fix 2
    const customers = await query(`
      SELECT c.*, u.name AS agent_name
      FROM customers c LEFT JOIN users u ON u.id = c.assigned_to
      WHERE ${where}
      ORDER BY c.last_purchase DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `, p);

    res.json({ success: true, total, customers });
  } catch(err) { next(err); }
});

router.get('/lookup', async (req, res, next) => {
  try {
    const { phone, email } = req.query;
    if (!phone && !email) throw new AppError('phone or email required.');
    const c = await findCustomerByFingerprint(phone, email);
    res.json({ success: true, found: !!c, customer: c || null });
  } catch(err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [c] = await query(
      'SELECT c.*, u.name AS agent_name FROM customers c LEFT JOIN users u ON u.id=c.assigned_to WHERE c.id=?',
      [req.params.id]
    );
    if (!c) throw new AppError('Customer not found.', 404);
    const purchases = await query(
      'SELECT * FROM purchases WHERE customer_id=? ORDER BY order_date DESC',
      [c.id]
    );
    res.json({ success: true, customer: { ...c, purchases } });
  } catch(err) { next(err); }
});

router.post('/:id/reorder', async (req, res, next) => {
  try {
    const { product_name, amount, tracking_id, order_date, delivery_date } = req.body;
    if (!product_name || !amount) throw new AppError('product_name and amount required.');

    const [c] = await query('SELECT * FROM customers WHERE id=?', [req.params.id]);
    if (!c) throw new AppError('Customer not found.', 404);

    // ✅ Fix 3 — insertId sahi se lo
    const orderDate    = order_date    || new Date().toISOString().split('T')[0];
    const orderStatus  = delivery_date ? 'delivered' : 'pending';
    const revenueCount = delivery_date ? 1 : 0;

    const result = await query(`
      INSERT INTO orders (
        lead_id, customer_id, assigned_to, product_name, amount,
        tracking_id, order_date, delivery_date, status,
        revenue_countable, is_repeat, source, created_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,1,'crm',?)
    `, [
      c.first_lead_id || null, c.id, req.user.id,
      product_name, Number(amount), tracking_id || null,
      orderDate, delivery_date || null,
      orderStatus, revenueCount, req.user.id
    ]);

    const orderId = result?.insertId;

    await query(`
      INSERT INTO purchases (
        customer_id, order_id, product_name, amount,
        tracking_id, order_date, delivery_date, source, status
      ) VALUES (?,?,?,?,?,?,?,'crm',?)
    `, [
      c.id, orderId, product_name, Number(amount),
      tracking_id || null,
      orderDate.toString().split('T')[0],
      delivery_date || null,
      orderStatus
    ]);

    if (delivery_date) {
      await query(`
        UPDATE customers SET
          total_orders    = total_orders + 1,
          total_revenue   = total_revenue + ?,
          lifetime_value  = lifetime_value + ?,
          avg_order_value = (total_revenue + ?) / (total_orders + 1),
          last_purchase   = ?
        WHERE id = ?
      `, [Number(amount), Number(amount), Number(amount), delivery_date, c.id]);
    }

    res.status(201).json({ success: true, orderId });
  } catch(err) { next(err); }
});

module.exports = router;
