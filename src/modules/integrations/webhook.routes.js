'use strict';
const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const { query } = require('../../config/db');
const { protect, authorize } = require('../../middleware/auth');
const { assignRoundRobin, findCustomerByFingerprint, processDelivered } = require('../../services/crm.service');

const router = express.Router();

// ── Get a setting (DB first, then .env fallback) ────────────────
const getSetting = async (key) => {
  const rows = await query('SELECT key_value FROM integration_settings WHERE key_name=?', [key]);
  return rows[0]?.key_value || process.env[key.toUpperCase()] || '';
};

// ── Log webhook ──────────────────────────────────────────────────
const logWH = async (source, event, payload) => {
  const r = await query('INSERT INTO webhook_logs (source,event,payload,status) VALUES (?,?,?,?)',
    [source, event, JSON.stringify(payload), 'received']);
  return r.insertId;
};

// ── Send WhatsApp message ────────────────────────────────────────
const sendWA = async (phone, message) => {
  const phoneId = await getSetting('wa_phone_number_id');
  const token   = await getSetting('wa_access_token');
  if (!phoneId || !token) throw new Error('WhatsApp API not configured.');
  const to = phone.replace(/\D/g, '').slice(-10);
  return axios.post(
    `https://graph.facebook.com/v18.0/${phoneId}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: message } },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
};

// ================================================================
// POST /api/webhooks/meta-leads  — Make.com posts Meta leads here
// ================================================================
router.post('/meta-leads', async (req, res, next) => {
  const logId = await logWH('meta', 'lead.created', req.body);
  try {
    const { name, phone, email, city, state, category, campaign_id } = req.body;
    if (!name || !phone) {
      await query('UPDATE webhook_logs SET status=?,error_msg=? WHERE id=?',['failed','Missing name or phone',logId]);
      return res.status(400).json({ success: false, message: 'name and phone required' });
    }

    const cleanPhone = phone.replace(/\D/g, '').slice(-10);

    const CATS = ['Kidney Stone Treatment','Gall Stone Treatment','UTI Treatment','CKD Treatment',
      'Thyroid Treatment','Piles Treatment','PCOS/PCOD Treatment','Arthritis Treatment',
      'Diabetes Treatment','High Blood Pressure','Heart Treatment','Prostate Treatment','Supplements','General'];
    const mappedCat = category
      ? CATS.find(c => c.toLowerCase().includes((category||'').toLowerCase())) || 'General'
      : 'General';

    // Check duplicate
    const [dup] = await query('SELECT id FROM leads WHERE phone=?', [cleanPhone]);

    // Round-robin assign
    const assignedTo = await assignRoundRobin(mappedCat).catch(() => null);

    const r = await query(`
      INSERT INTO leads (name,phone,email,city,state,source,category,
                         assigned_to,assigned_at,is_duplicate,duplicate_of,
                         external_id,external_source,created_by)
      VALUES (?,?,?,?,?,'meta_ads',?,?,?,?,?,?,?,NULL)
    `, [name.trim(), cleanPhone, email?.toLowerCase()||null, city||null, state||null,
        mappedCat, assignedTo, assignedTo?new Date():null,
        dup?1:0, dup?.id||null,
        req.body.form_id||req.body.lead_id||null, 'meta']);

    const leadId = r.insertId;
    await query('INSERT INTO status_history (lead_id,to_status,remark) VALUES (?,?,?)',
      [leadId, 'new', 'Auto-created via Make.com / Meta Ads webhook']);

    await query('UPDATE webhook_logs SET status=?,lead_id=?,processed_at=NOW() WHERE id=?',
      ['success', leadId, logId]);

    // WhatsApp auto-reply (non-blocking)
    sendWA(cleanPhone, `Namaste ${name}! 🙏 Thank you for contacting Yogveda Healthcare. Our specialist will call you shortly for ${mappedCat}.`).catch(() => {});

    res.json({ success: true, leadId, isDuplicate: !!dup });
  } catch (err) {
    await query('UPDATE webhook_logs SET status=?,error_msg=? WHERE id=?', ['failed', err.message, logId]);
    next(err);
  }
});

// ================================================================
// POST /api/webhooks/shopify/orders  — Shopify order.paid webhook
// ================================================================
router.post('/shopify/orders',
  express.json({ type: '*/*', verify: (req, _, buf) => { req.rawBody = buf; } }),
  async (req, res, next) => {
    const logId = await logWH('shopify', 'order.paid', req.body);
    try {
      // Signature verify
      const secret = await getSetting('shopify_webhook_secret');
      if (secret) {
        const hmac   = req.headers['x-shopify-hmac-sha256'];
        const digest = crypto.createHmac('sha256', secret).update(req.rawBody||'').digest('base64');
        if (hmac !== digest) {
          await query('UPDATE webhook_logs SET status=?,error_msg=? WHERE id=?',['failed','Invalid Shopify signature',logId]);
          return res.status(401).json({ success: false, message: 'Invalid signature' });
        }
      }

      const order    = req.body;
      const cust     = order.customer || {};
      const phone    = (cust.phone || order.billing_address?.phone || '').replace(/\D/g,'').slice(-10);
      const email    = (cust.email || '').toLowerCase();
      const name     = `${cust.first_name||''} ${cust.last_name||''}`.trim() || 'Shopify Customer';
      const amount   = parseFloat(order.total_price) || 0;
      const prodName = (order.line_items||[]).map(i=>i.name).join(', ');

      // Check existing customer
      const existing = await findCustomerByFingerprint(phone, email);

      if (existing) {
        // Add repeat order
        const r = await query(`
          INSERT INTO orders (lead_id,customer_id,assigned_to,product_name,amount,
            status,revenue_countable,is_repeat,shopify_order_id,source,delivery_date,created_by)
          VALUES (?,?,?,?,?,'delivered',1,1,?,'shopify',NOW(),?)
        `, [existing.first_lead_id||null, existing.id, existing.assigned_to||1,
            prodName, amount, String(order.id), existing.assigned_to||1]);

        await query(`INSERT INTO purchases (customer_id,order_id,product_name,amount,order_date,source,shopify_order_id,status) VALUES (?,?,?,?,CURDATE(),'shopify',?,'delivered')`,
          [existing.id, r.insertId, prodName, amount, String(order.id)]);

        await query(`UPDATE customers SET total_orders=total_orders+1,total_revenue=total_revenue+?,lifetime_value=lifetime_value+?,avg_order_value=(total_revenue+?)/(total_orders+1),last_purchase=CURDATE(),shopify_cust_id=? WHERE id=?`,
          [amount,amount,amount,String(cust.id||''),existing.id]);

        await query('UPDATE webhook_logs SET status=?,processed_at=NOW() WHERE id=?',['success',logId]);
        return res.json({ success:true, type:'repeat', customerId:existing.id });
      }

      // New customer via Shopify
      const leadR = await query(`
        INSERT INTO leads (name,phone,email,source,category,status,order_amount,product_name,
          revenue_countable,delivered_at,external_id,external_source)
        VALUES (?,?,?,'shopify','General','delivered',?,?,1,NOW(),?,'shopify')
      `, [name, phone, email||null, amount, prodName, String(order.id)]);

      await query('INSERT INTO status_history (lead_id,to_status,remark) VALUES (?,?,?)',
        [leadR.insertId,'delivered','Shopify order.paid webhook']);

      const fakeLead = { id:leadR.insertId, name, phone, email, assigned_to:1,
        order_amount:amount, product_name:prodName, tracking_id:null,
        city:null, state:null, alt_phone:null };
      const { orderId, customerId } = await processDelivered(fakeLead);

      await query('UPDATE webhook_logs SET status=?,lead_id=?,processed_at=NOW() WHERE id=?',
        ['success', leadR.insertId, logId]);
      res.json({ success:true, type:'new', leadId:leadR.insertId, orderId, customerId });
    } catch (err) {
      await query('UPDATE webhook_logs SET status=?,error_msg=? WHERE id=?',['failed',err.message,logId]);
      next(err);
    }
  }
);

// ── WhatsApp send (protected) ────────────────────────────────────
router.post('/whatsapp/send', protect, async (req, res, next) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) throw new Error('phone and message required.');
    const result = await sendWA(phone, message);
    await logWH('whatsapp', 'message.sent', { phone });
    res.json({ success: true, messageId: result?.data?.messages?.[0]?.id });
  } catch (err) { next(err); }
});

// ── WhatsApp broadcast (admin only) ──────────────────────────────
router.post('/whatsapp/broadcast', protect, authorize('admin'), async (req, res, next) => {
  try {
    const { phones, message } = req.body;
    if (!phones?.length || !message) throw new Error('phones[] and message required.');
    let sent=0, failed=0;
    for (const p of phones) {
      try { await sendWA(p, message); sent++; await new Promise(r=>setTimeout(r,250)); }
      catch { failed++; }
    }
    await logWH('whatsapp','broadcast.sent',{total:phones.length,sent,failed});
    res.json({ success:true, sent, failed, total:phones.length });
  } catch (err) { next(err); }
});

// ── Webhook status (for Settings page) ───────────────────────────
router.get('/status', protect, authorize('admin'), async (req, res) => {
  const base = process.env.API_BASE_URL || 'https://yourdomain.com/api';
  const [waPhoneId, shSecret] = await Promise.all([
    getSetting('wa_phone_number_id'), getSetting('shopify_webhook_secret')
  ]);
  res.json({
    success: true,
    endpoints: {
      meta_leads:     `${base}/webhooks/meta-leads`,
      shopify_orders: `${base}/webhooks/shopify/orders`
    },
    configured: { whatsapp: !!waPhoneId, shopify: !!shSecret, makecom: true }
  });
});

// ── Webhook logs ──────────────────────────────────────────────────
router.get('/logs', protect, authorize('admin'), async (req, res, next) => {
  try {
    const logs = await query('SELECT * FROM webhook_logs ORDER BY created_at DESC LIMIT 100');
    res.json({ success:true, logs });
  } catch(err){ next(err); }
});

module.exports = router;
