'use strict';

const { query, withTransaction } = require('../config/db');

// ================================================================
// ROUND ROBIN ASSIGNMENT
// ================================================================
const assignRoundRobin = async (category) => {
  return withTransaction(async (conn) => {

    const [[rr]] = await conn.execute(
      'SELECT * FROM round_robin WHERE category=? FOR UPDATE',
      [category]
    );

    if (!rr) {
      await conn.execute(
        'INSERT IGNORE INTO round_robin (category,current_index) VALUES (?,0)',
        [category]
      );
    }

    const [[rrRow]] = await conn.execute(
      'SELECT * FROM round_robin WHERE category=? FOR UPDATE',
      [category]
    );

    const [pool] = await conn.execute(`
      SELECT u.id, u.name
      FROM users u
      INNER JOIN user_categories uc
        ON uc.user_id = u.id
       AND uc.category = ?
      WHERE u.is_active = 1
        AND u.role = 'sales'
      ORDER BY u.id
    `, [category]);

    let users = pool;

    if (!users.length) {
      const [all] = await conn.execute(`
        SELECT id,name
        FROM users
        WHERE is_active=1
          AND role='sales'
        ORDER BY id
      `);

      users = all;
    }

    if (!users.length) return null;

    const idx = rrRow.current_index % users.length;

    const assigned = users[idx];

    await conn.execute(`
      UPDATE round_robin
      SET current_index=current_index+1,
          last_user_id=?
      WHERE category=?
    `, [assigned.id, category]);

    return assigned.id;
  });
};

// ================================================================
// MANUAL ASSIGN
// ================================================================
const assignManual = async (targetUserId) => {

  const [user] = await query(
    'SELECT id,name,is_active FROM users WHERE id=?',
    [targetUserId]
  );

  if (!user || !user.is_active) {
    throw Object.assign(
      new Error('User not found or inactive.'),
      { statusCode: 404 }
    );
  }

  return user.id;
};

// ================================================================
// FIND EXISTING CUSTOMER
// ================================================================
const findCustomerByFingerprint = async (phone, email) => {

  if (!phone && !email) return null;

  const conditions = [];
  const params = [];

  if (phone) {
    conditions.push('phone=?');
    params.push(phone);
  }

  if (email) {
    conditions.push('email=?');
    params.push(email);
  }

  const [cust] = await query(`
    SELECT *
    FROM customers
    WHERE ${conditions.join(' OR ')}
    LIMIT 1
  `, params);

  return cust || null;
};

// ================================================================
// PROCESS CONVERTED
// Lead converted → pending order create
// ================================================================
const processConverted = async (lead) => {

  return withTransaction(async (conn) => {

    // ============================================================
    // 1. CREATE ORDER
    // ============================================================

    const [orderRes] = await conn.execute(`
      INSERT INTO orders (
        lead_id,
        assigned_to,
        product_name,
        amount,
        tracking_id,
        payment_status,
        shipping_address,
        status,
        revenue_countable,
        order_date,
        source,
        created_by
      )
      VALUES (
        ?,?,?,?,?,?,?, 'pending',0,CURDATE(),'crm',?
      )
    `, [
      lead.id,
      lead.assigned_to,
      lead.product_name || lead.category,
      lead.order_amount,
      lead.tracking_id || null,
      lead.payment_status || null,
      lead.shipping_address || null,
      lead.assigned_to,
    ]);

    const orderId = orderRes.insertId;

    // ============================================================
    // 2. FIND CUSTOMER
    // ============================================================

    let existing;

    if (lead.email) {

      [[existing]] = await conn.execute(`
        SELECT *
        FROM customers
        WHERE phone=? OR email=?
        LIMIT 1
      `, [lead.phone, lead.email]);

    } else {

      [[existing]] = await conn.execute(`
        SELECT *
        FROM customers
        WHERE phone=?
        LIMIT 1
      `, [lead.phone]);

    }

    let customerId;

    // ============================================================
    // 3. EXISTING CUSTOMER
    // ============================================================

    if (existing) {

      customerId = existing.id;

      await conn.execute(`
        UPDATE leads
        SET is_repeat=1,
            repeat_count=repeat_count+1,
            linked_customer_id=?
        WHERE id=?
      `, [customerId, lead.id]);

      await conn.execute(`
        UPDATE orders
        SET is_repeat=1,
            order_index=?,
            customer_id=?
        WHERE id=?
      `, [
        existing.total_orders + 1,
        customerId,
        orderId
      ]);

    }

    // ============================================================
    // 4. NEW CUSTOMER
    // ============================================================

    else {

      const [custRes] = await conn.execute(`
        INSERT INTO customers (
          name, phone, alt_phone, email, city, state,
          first_lead_id, assigned_to, shipping_address,
          total_orders, total_revenue, lifetime_value, avg_order_value,
          created_by
        ) VALUES (?,?,?,?,?,?,?,?,?, 0,0,0,0, ?)
      `, [
        lead.name, lead.phone, lead.alt_phone||null, lead.email||null,
        lead.city||null, lead.state||null, lead.id, lead.assigned_to, lead.shipping_address || null,
        lead.assigned_to,   // ← sirf ek value, CURDATE() wale 2 hata diye
      ]);

      customerId = custRes.insertId;

      await conn.execute(`
        UPDATE leads
        SET linked_customer_id=?
        WHERE id=?
      `, [customerId, lead.id]);

      await conn.execute(`
        UPDATE orders
        SET customer_id=?
        WHERE id=?
      `, [customerId, orderId]);
    }

    return {
      orderId,
      customerId
    };
  });
};

// ================================================================
// PROCESS ORDER DELIVERED
// ================================================================
const processOrderDelivered = async (leadId, deliveryDate, trackingId = null) => {

  return withTransaction(async (conn) => {

    // ============================================================
    // GET ORDER
    // ============================================================

    const [[order]] = await conn.execute(`
      SELECT *
      FROM orders
      WHERE lead_id=?
      ORDER BY id DESC
      LIMIT 1
    `, [leadId]);

    if (!order) return;

    if (order.status === 'delivered') return;

    // ============================================================
    // UPDATE ORDER
    // ============================================================

    await conn.execute(`
      UPDATE orders
      SET status='delivered',
          delivery_date=?,
          revenue_countable=1,
          ${trackingId ? 'tracking_id=?,' : ''}
          updated_at=NOW()
      WHERE id=?
    `, trackingId ? [deliveryDate, trackingId, order.id] : [deliveryDate, order.id]);

    // ============================================================
    // UPDATE CUSTOMER
    // ============================================================

    if (order.customer_id) {

      await conn.execute(`
        UPDATE customers
        SET total_orders   = total_orders + 1,
            total_revenue  = total_revenue + ?,
            lifetime_value = lifetime_value + ?,
            last_purchase  = ?,
            avg_order_value =
              (total_revenue + ?) / (total_orders + 1)
        WHERE id = ?
      `, [
        order.amount,
        order.amount,
        deliveryDate,
        order.amount,
        order.customer_id
      ]);
    }

    // ============================================================
    // PURCHASE HISTORY
    // ============================================================

    await conn.execute(`
      INSERT INTO purchases (
        customer_id,
        lead_id,
        order_id,
        product_name,
        amount,
        tracking_id,
        order_date,
        delivery_date,
        source,
        status
      )
      VALUES (
        ?,?,?,?,?,?,
        CURDATE(),
        ?,
        'crm',
        'delivered'
      )
    `, [
      order.customer_id,
      leadId,
      order.id,
      order.product_name,
      order.amount,
      order.tracking_id || null,
      deliveryDate
    ]);

    // ============================================================
    // INCENTIVE
    // ============================================================

    const [[agent]] = await conn.execute(`
      SELECT incentive_rate
      FROM users
      WHERE id=?
    `, [order.assigned_to]);

    if (agent && parseFloat(agent.incentive_rate) > 0) {

      const incAmount = Math.round(
        parseFloat(order.amount)
        * parseFloat(agent.incentive_rate)
        / 100
      );

      await conn.execute(`
        INSERT IGNORE INTO incentives (
          user_id,
          order_id,
          lead_id,
          order_amount,
          rate,
          incentive_amount
        )
        VALUES (?,?,?,?,?,?)
      `, [
        order.assigned_to,
        order.id,
        leadId,
        order.amount,
        agent.incentive_rate,
        incAmount
      ]);
    }

    // ============================================================
    // UPDATE LEAD
    // ============================================================

    await conn.execute(`
      UPDATE leads
      SET delivery_date=?,
          updated_at=NOW()
      WHERE id=?
    `, [deliveryDate, leadId]);

  });
};

module.exports = {
  assignRoundRobin,
  assignManual,
  findCustomerByFingerprint,
  processConverted,
  processOrderDelivered,
};
