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
    let where='1=1'; const p=[];
    if(search){ where+=' AND (c.name LIKE ? OR c.phone LIKE ?)'; const s=`%${search}%`; p.push(s,s); }
    const [[{total}]] = await Promise.all([query(`SELECT COUNT(*) AS total FROM customers c WHERE ${where}`,p)]);
    const customers = await query(`
      SELECT c.*, u.name AS agent_name
      FROM customers c LEFT JOIN users u ON u.id=c.assigned_to
      WHERE ${where} ORDER BY c.last_purchase DESC LIMIT ? OFFSET ?
    `,[...p,Number(limit),(Number(page)-1)*Number(limit)]);
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
    const purchases = await query('SELECT * FROM purchases WHERE customer_id=? ORDER BY order_date DESC',[c.id]);
    res.json({ success:true, customer:{...c, purchases} });
  } catch(err){ next(err); }
});

router.post('/:id/reorder', async (req, res, next) => {
  try {
    const { product_name, amount, tracking_id, order_date, delivery_date } = req.body;
    if(!product_name||!amount) throw new AppError('product_name and amount required.');
    const [c] = await query('SELECT * FROM customers WHERE id=?',[req.params.id]);
    if(!c) throw new AppError('Customer not found.',404);

    const r = await query(`
      INSERT INTO orders (lead_id,customer_id,assigned_to,product_name,amount,tracking_id,
                          order_date,delivery_date,status,revenue_countable,is_repeat,source,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,1,'crm',?)
    `,[c.first_lead_id||null,c.id,req.user.id,product_name,Number(amount),tracking_id||null,
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

module.exports = router;
