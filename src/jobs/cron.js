'use strict';
const cron  = require('node-cron');
const { query } = require('../config/db');

// Every hour — mark pending follow-ups as missed if overdue by 1+ hour
// cron.schedule('0 * * * *', async () => {
//   try {
//     const r = await query(`
//       UPDATE follow_ups SET status='missed'
//       WHERE status='pending' AND scheduled_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)
//     `);
//     if (r.affectedRows) console.log(`[CRON] Marked ${r.affectedRows} follow-ups as missed`);
//   } catch (e) { console.error('[CRON] followup job error:', e.message); }
// });

cron.schedule('* * * * * *', async () => {
  try {
    const r = await query(`
      UPDATE follow_ups fu
      INNER JOIN leads l ON l.id = fu.lead_id
      SET 
        fu.status = 'missed'
      WHERE 
        fu.status = 'pending'
        AND fu.scheduled_at < NOW()
        AND l.status != 'follow_up'
    `);

    if (r.affectedRows) {
      console.log(`[CRON] Updated ${r.affectedRows} follow-ups`);
    }

  } catch (e) {
    console.error('[CRON] followup job error:', e.message);
  }
});

// Daily 8:00 AM IST (2:30 UTC) — log overdue summary
cron.schedule('30 2 * * *', async () => {
  try {
    const [{ cnt }] = await query(`SELECT COUNT(*) AS cnt FROM leads WHERE status='follow_up' AND next_followup_at < CURDATE()`);
    console.log(`[CRON] Daily summary — ${cnt} overdue follow-ups`);
  } catch (e) { console.error('[CRON] daily summary error:', e.message); }
});

console.log('✅  Cron jobs registered');
