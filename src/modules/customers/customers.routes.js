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
    let where='1=1'; const p=[];
    if (!isAdmin(req.user)) { where += ' AND c.assigned_to=?'; p.push(req.user.id); }
    if(search){ where+=' AND (c.name LIKE ? OR c.phone LIKE ?)'; const s=`%${search}%`; p.push(s,s); }
    const [[{total}]] = await Promise.all([query(`SELECT COUNT(*) AS total FROM customers c WHERE ${where}`,p)]);
    const customers = await query(`
      SELECT c.*, u.name AS agent_name
      FROM customers c LEFT JOIN users u ON u.id=c.assigned_to
      WHERE ${where} ORDER BY c.last_purchase DESC LIMIT ${limitNum} OFFSET ${offset}
    `, p);
    res.json({ success:true, total, customers });
  } catch(err){ next(err); }
});

router.get('/lookup', async (req, res, next) => {
  try {
    const { phone, email } = req.query;
    if(!phone&&!email) throw new AppError('phone or email required.');
    const c = await findCustomerByFingerprint(phone,email);
    res.json({ success:true, found:!!c, customer:c||null });
  } catch(err){ next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const [c] = await query('SELECT c.*,u.name AS agent_name FROM customers c LEFT JOIN users u ON u.id=c.assigned_to WHERE c.id=?',[req.params.id]);
    if(!c) throw new AppError('Customer not found.',404);
    // const purchases = await query('SELECT * FROM purchases WHERE customer_id=? ORDER BY order_date DESC',[c.id]);
    const purchases = await query('SELECT p.*, o.cancelled_date, o.remark, o.payment_status FROM purchases p left JOIN orders o ON o.id = p.order_id WHERE p.customer_id=? ORDER BY p.order_date DESC',[c.id]);
    res.json({ success:true, customer:{...c, purchases} });
  } catch(err){ next(err); }
});

router.post('/:id/reorder', async (req, res, next) => {
  try {
    const { product_name, amount, tracking_id, payment_status, shipping_address, remark, order_date, delivery_date } = req.body;
    if(!product_name||!amount) throw new AppError('product_name and amount required.');
    const [c] = await query('SELECT * FROM customers WHERE id=?',[req.params.id]);
    if(!c) throw new AppError('Customer not found.',404);

    const r = await query(`
      INSERT INTO orders (lead_id,customer_id,assigned_to,product_name,amount,tracking_id,payment_status, shipping_address, remark,
                          order_date,delivery_date,status,revenue_countable,is_repeat,source,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,'crm',?)
    `,[c.first_lead_id||null,c.id,req.user.id,product_name,Number(amount),tracking_id||null,payment_status || null, shipping_address || null, remark || null,
       order_date||new Date(),delivery_date||null,delivery_date?'delivered':'pending',delivery_date?1:0,req.user.id]);

    await query(`INSERT INTO purchases (customer_id,order_id,product_name,amount,tracking_id,order_date,delivery_date,source,status) VALUES (?,?,?,?,?,?,?,'crm',?)`,
      [c.id,r.insertId,product_name,Number(amount),tracking_id||null,
       (order_date||new Date()).toString().split('T')[0],
       delivery_date||(null),delivery_date?'delivered':'pending']);

    if(delivery_date){
      await query(`UPDATE customers SET total_orders=total_orders+1,
        total_revenue=total_revenue+?,lifetime_value=lifetime_value+?,
        avg_order_value=(total_revenue+?)/(total_orders+1),last_purchase=? WHERE id=?`,
        [Number(amount),Number(amount),Number(amount),delivery_date,c.id]);
    }
    res.status(201).json({ success:true, orderId:r.insertId });
  } catch(err){ next(err); }
});

// PATCH /api/customers/:customerId/orders/:orderId/cancel
router.patch('/:customerId/orders/:orderId/cancel', async (req, res, next) => {
  try {
    const { cancelled_date, remark } = req.body;
    if (!cancelled_date) throw new AppError('cancelled_date required.');

    const customerId = Number(req.params.customerId);
    const orderId    = Number(req.params.orderId);

    // Order check karo
    const [order] = await query(
      'SELECT * FROM orders WHERE id=? AND customer_id=?',
      [orderId, customerId]
    );
    if (!order) throw new AppError('Order not found.', 404);
    if (order.status === 'cancelled') throw new AppError('Order already cancelled.');

    const wasDelivered = order.status === 'delivered' && order.revenue_countable;

    // Sirf is order ko cancel karo
    await query(
      `UPDATE orders SET status='cancelled', cancelled_date=?, remark=?, revenue_countable=0, updated_at=NOW() WHERE id=?`,
      [cancelled_date, remark, orderId]
    );

    // Purchase record bhi cancel karo
    await query(
      `UPDATE purchases SET status='cancelled' WHERE order_id=?`,
      [orderId]
    );

    // Agar delivered tha toh customer stats se ghataao
    if (wasDelivered) {
      await query(`
        UPDATE customers
        SET total_orders    = GREATEST(total_orders - 1, 0),
            total_revenue   = GREATEST(total_revenue - ?, 0),
            lifetime_value  = GREATEST(lifetime_value - ?, 0),
            avg_order_value = CASE
              WHEN (total_orders - 1) > 0
              THEN (total_revenue - ?) / (total_orders - 1)
              ELSE 0
            END
        WHERE id=?
      `, [order.amount, order.amount, order.amount, customerId]);
    }

    res.json({ success: true, message: 'Order cancelled.' });
  } catch(err) { console.log("ERROR:", err); next(err); }
});

module.exports = router;
