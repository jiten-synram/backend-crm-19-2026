'use strict';
const { query, withTransaction } = require('../config/db');

// ================================================================
// ROUND-ROBIN ASSIGNMENT
// Atomic update using MySQL transactions to prevent race conditions
// ================================================================
const assignRoundRobin = async (category) => {
  return withTransaction(async (conn) => {
    // Lock the row so concurrent webhook calls don't get same index
    const [[rr]] = await conn.execute(
      'SELECT * FROM round_robin WHERE category=? FOR UPDATE', [category]
    );
    if (!rr) {
      await conn.execute('INSERT IGNORE INTO round_robin (category,current_index) VALUES (?,0)', [category]);
      const [[newRr]] = await conn.execute('SELECT * FROM round_robin WHERE category=? FOR UPDATE', [category]);
      if (!newRr) return null;
    }
    const rrRow = rr || { current_index: 0 };

    // Get active sales users for this category
    const [pool] = await conn.execute(`
      SELECT u.id, u.name FROM users u
      INNER JOIN user_categories uc ON uc.user_id = u.id AND uc.category = ?
      WHERE u.is_active = 1 AND u.role = 'sales'
      ORDER BY u.id
    `, [category]);

    let users = pool;

    // Fallback: any active sales user
    if (!users.length) {
      const [all] = await conn.execute(
        "SELECT id,name FROM users WHERE is_active=1 AND role='sales' ORDER BY id"
      );
      users = all;
    }
    if (!users.length) return null;

    const idx      = rrRow.current_index % users.length;
    const assigned = users[idx];

    await conn.execute(
      'UPDATE round_robin SET current_index=current_index+1, last_user_id=? WHERE category=?',
      [assigned.id, category]
    );

    return assigned.id;
  });
};

const assignManual = async (targetUserId) => {
  const [user] = await query('SELECT id,name,is_active FROM users WHERE id=?', [targetUserId]);
  if (!user || !user.is_active) throw Object.assign(new Error('User not found or inactive.'), { statusCode: 404 });
  return user.id;
};

// ================================================================
// CUSTOMER FINGERPRINT — detect returning customers
// ================================================================
const findCustomerByFingerprint = async (phone, email) => {
  if (!phone && !email) return null;
  const conditions = [];
  const params     = [];
  if (phone) { conditions.push('phone=?'); params.push(phone); }
  if (email) { conditions.push('email=?'); params.push(email); }
  const [cust] = await query(
    `SELECT * FROM customers WHERE ${conditions.join(' OR ')} LIMIT 1`, params
  );
  return cust || null;
};

// ================================================================
// PROCESS DELIVERED — order + customer + incentive in one tx
// ================================================================
const processDelivered = async (lead) => {
  return withTransaction(async (conn) => {
    // 1. Create order
    const [orderRes] = await conn.execute(`
      INSERT INTO orders (lead_id,assigned_to,product_name,amount,tracking_id,
                          status,revenue_countable,delivery_date,source,created_by)
      VALUES (?,?,?,?,?,'delivered',1,NOW(),'crm',?)
    `, [lead.id, lead.assigned_to, lead.product_name || lead.category,
        lead.order_amount, lead.tracking_id, lead.assigned_to]);
    const orderId = orderRes.insertId;

    // 2. Find or create customer
    const conditions = lead.email
      ? `phone='${lead.phone}' OR email='${lead.email}'`
      : `phone='${lead.phone}'`;
    const [[existing]] = await conn.execute(
      `SELECT * FROM customers WHERE ${conditions} LIMIT 1`
    );

    let customerId;
    if (existing) {
      // Returning customer
      await conn.execute(`
        UPDATE customers
        SET total_orders    = total_orders + 1,
            total_revenue   = total_revenue + ?,
            lifetime_value  = lifetime_value + ?,
            avg_order_value = (total_revenue + ?) / (total_orders + 1),
            last_purchase   = CURDATE(),
            assigned_to     = ?
        WHERE id = ?
      `, [lead.order_amount, lead.order_amount, lead.order_amount, lead.assigned_to, existing.id]);
      customerId = existing.id;

      // Update lead as repeat
      await conn.execute(
        'UPDATE leads SET is_repeat=1, repeat_count=repeat_count+1, linked_customer_id=? WHERE id=?',
        [customerId, lead.id]
      );
      // Update order as repeat
      await conn.execute(
        'UPDATE orders SET is_repeat=1, order_index=?, customer_id=? WHERE id=?',
        [existing.total_orders + 1, customerId, orderId]
      );
    } else {
      // New customer
      const [custRes] = await conn.execute(`
        INSERT INTO customers (name,phone,alt_phone,email,city,state,
                               first_lead_id,assigned_to,total_orders,total_revenue,
                               lifetime_value,avg_order_value,first_purchase,last_purchase,created_by)
        VALUES (?,?,?,?,?,?,?,?,1,?,?,?,CURDATE(),CURDATE(),?)
      `, [lead.name, lead.phone, lead.alt_phone || null, lead.email || null,
          lead.city || null, lead.state || null, lead.id, lead.assigned_to,
          lead.order_amount, lead.order_amount, lead.order_amount, lead.assigned_to]);
      customerId = custRes.insertId;

      await conn.execute(
        'UPDATE leads SET linked_customer_id=? WHERE id=?', [customerId, lead.id]
      );
      await conn.execute(
        'UPDATE orders SET customer_id=? WHERE id=?', [customerId, orderId]
      );
    }

    // 3. Add to purchases history
    await conn.execute(`
      INSERT INTO purchases (customer_id,lead_id,order_id,product_name,amount,
                             tracking_id,order_date,delivery_date,source,status)
      VALUES (?,?,?,?,?,?,CURDATE(),CURDATE(),'crm','delivered')
    `, [customerId, lead.id, orderId, lead.product_name || lead.category,
        lead.order_amount, lead.tracking_id || null]);

    // 4. Generate incentive
    const [[agent]] = await conn.execute(
      'SELECT incentive_rate FROM users WHERE id=?', [lead.assigned_to]
    );
    if (agent && parseFloat(agent.incentive_rate) > 0) {
      const incAmount = Math.round(parseFloat(lead.order_amount) * parseFloat(agent.incentive_rate) / 100);
      await conn.execute(`
        INSERT IGNORE INTO incentives (user_id,order_id,lead_id,order_amount,rate,incentive_amount)
        VALUES (?,?,?,?,?,?)
      `, [lead.assigned_to, orderId, lead.id, lead.order_amount, agent.incentive_rate, incAmount]);
    }

    return { orderId, customerId };
  });
};

module.exports = { assignRoundRobin, assignManual, findCustomerByFingerprint, processDelivered };
