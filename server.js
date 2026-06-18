require('dotenv').config();
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// GHL helper
async function callGHL(endpoint) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://services.leadconnectorhq.com' + endpoint, {
    headers: {
      'Authorization': 'Bearer ' + process.env.GHL_API_KEY,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    }
  });
  if (!res.ok) throw new Error('GHL ' + res.status);
  return res.json();
}

// Instantly helper
async function callInstantly(endpoint) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.instantly.ai/api/v1' + endpoint, {
    headers: {
      'Authorization': 'Bearer ' + process.env.INSTANTLY_API_KEY,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error('Instantly ' + res.status);
  return res.json();
}

// Stripe helper
async function callStripe(endpoint) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://api.stripe.com/v1' + endpoint, {
    headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY }
  });
  if (!res.ok) throw new Error('Stripe ' + res.status);
  return res.json();
}

// Railway helper
async function callRailway(query) {
  const fetch = (await import('node-fetch')).default;
  const res = await fetch('https://backboard.railway.app/graphql/v2', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RAILWAY_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query })
  });
  if (!res.ok) throw new Error('Railway ' + res.status);
  return res.json();
}

// API: full dashboard data
app.get('/api/dashboard', async (req, res) => {
  const data = {
    timestamp: new Date().toISOString(),
    pipeline: { cold: 0, emailed: 0, replied: 0, demo: 0, customer: 0 },
    leads: [],
    campaign: { sent: 0, opens: 0, replies: 0, open_rate: 0, reply_rate: 0 },
    revenue: { mrr: 0, new_signups: 0, cancellations: 0, failed_payments: 0 },
    services: [],
    health: { ghl: false, instantly: false, stripe: false }
  };

  // GHL pipeline counts
  try {
    const locationId = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
    const pipelineId = process.env.GHL_PIPELINE_ID || 'lu4BTmjYjJC2hZVKxj1t';
    const opps = await callGHL('/opportunities/search?pipeline_id=' + pipelineId + '&locationId=' + locationId + '&limit=100');
    const opportunities = opps.opportunities || [];

    const stageMap = {
      [process.env.GHL_STAGE_COLD || '751975e9-c7f2-46a4-b821-e053bf505d8a']: 'cold',
      [process.env.GHL_STAGE_EMAILED || 'a9cb193d-c634-41e2-b7eb-e0c6a24065ca']: 'emailed',
      [process.env.GHL_STAGE_REPLIED || '32e745b6-97f5-4ad1-8b59-4652995f2176']: 'replied'
    };

    opportunities.forEach(o => {
      const stage = stageMap[o.pipelineStageId] || 'cold';
      data.pipeline[stage]++;
      const tags = o.contact?.tags || [];
      if (tags.includes('customer')) data.pipeline.customer++;
      if (tags.includes('demo-clicked')) data.pipeline.demo++;
    });

    // Get leads list — search by ca-gc tag using contacts search
    const contacts = await callGHL('/contacts/?locationId=' + locationId + '&query=ca-gc&limit=50');
    data.leads = (contacts.contacts || []).map(c => ({
      id: c.id,
      name: c.firstName + ' ' + c.lastName,
      company: c.companyName || '',
      email: c.email,
      tags: c.tags || [],
      score: c.customFields?.find(f => f.key === 'lead_score')?.field_value || '—',
      tier: c.customFields?.find(f => f.key === 'lead_tier')?.field_value || 'cold',
      plan: c.customFields?.find(f => f.key === 'recommended_plan')?.field_value || '—',
      pain: c.customFields?.find(f => f.key === 'pain_point')?.field_value || '—',
      added: c.dateAdded
    }));

    data.health.ghl = true;
  } catch(e) { console.error('GHL error:', e.message); }

  // Instantly campaign
  try {
    const campaignId = process.env.INSTANTLY_CAMPAIGN_ID || 'bb1d4655-8d06-4218-89d4-ec196bc8ca81';
    const analytics = await callInstantly('/analytics/campaign?campaign_id=' + campaignId);
    data.campaign = {
      sent: analytics.total_emails_sent || 0,
      opens: analytics.total_opened || 0,
      replies: analytics.total_replied || 0,
      open_rate: Math.round((analytics.open_rate || 0) * 100) / 100,
      reply_rate: Math.round((analytics.reply_rate || 0) * 100) / 100,
      launch_date: '2026-07-07',
      status: analytics.status || 'warming'
    };
    data.health.instantly = true;
  } catch(e) { console.error('Instantly error:', e.message); }

  // Stripe revenue
  try {
    const since24h = Math.floor(Date.now() / 1000) - 86400;
    const [subs, events] = await Promise.all([
      callStripe('/subscriptions?limit=100&status=active'),
      callStripe('/events?created[gte]=' + since24h + '&limit=100')
    ]);
    data.revenue.mrr = (subs.data || []).reduce((a, s) => a + (s.items?.data?.[0]?.price?.unit_amount || 0) / 100, 0);
    data.revenue.new_signups = (events.data || []).filter(e => e.type === 'customer.subscription.created').length;
    data.revenue.cancellations = (events.data || []).filter(e => e.type === 'customer.subscription.deleted').length;
    data.revenue.failed_payments = (events.data || []).filter(e => e.type === 'invoice.payment_failed').length;
    data.health.stripe = true;
  } catch(e) { console.error('Stripe error:', e.message); }

  res.json(data);
});

// API: Railway service status
app.get('/api/services', async (req, res) => {
  const services = [
    { name: 'health-monitor', schedule: 'Every 60 min', agents: ['25'] },
    { name: 'reply-handler', schedule: 'Every 30 min', agents: ['10','11','13'] },
    { name: 'revenue-monitor', schedule: 'Every 2 hrs', agents: ['14','15','16','18','21','22'] },
    { name: 'daily-briefing', schedule: 'Daily 5am', agents: ['12','17','19','25','31'] },
    { name: 'prospector', schedule: 'Weekly Mon', agents: ['01','02','03','04','05','06','07','08','09','24','26','29'] },
    { name: 'weekly-analyzer', schedule: 'Weekly Sun', agents: ['20','23','27','28','30'] }
  ];
  res.json(services);
});

// Serve dashboard HTML
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

app.listen(port, () => console.log('SubDraw Dashboard running on port ' + port));
