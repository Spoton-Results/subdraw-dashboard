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
  const res = await fetch('https://api.instantly.ai/api/v2' + endpoint, {
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
    revenue: { mrr: 0, arr: 0, new_signups: 0, cancellations: 0, failed_payments: 0 },
    coo: [],
    services: [],
    health: { ghl: false, instantly: false, stripe: false }
  };

  // GHL pipeline counts
  try {
    const locationId = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
    const pipelineId = process.env.GHL_PIPELINE_ID || 'lu4BTmjYjJC2hZVKxj1t';
    const opps = await callGHL('/opportunities/search?pipeline_id=' + pipelineId + '&location_id=' + locationId + '&limit=100');
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
      followup: c.customFields?.find(f => f.key === 'follow_up_date')?.field_value || null,
      sms: c.tags?.includes('sms-sent') || false,
      added: c.dateAdded
    }));

    data.health.ghl = true;
  } catch(e) { console.error('GHL error:', e.message); }

  // Instantly campaign
  try {
    const campaignId = process.env.INSTANTLY_CAMPAIGN_ID || 'bb1d4655-8d06-4218-89d4-ec196bc8ca81';
    const analyticsRaw = await callInstantly('/campaigns/analytics?id=' + campaignId);
    const analytics = Array.isArray(analyticsRaw) ? (analyticsRaw[0] || {}) : analyticsRaw;
    const sent = analytics.emails_sent_count || 0;
    const opens = analytics.open_count || 0;
    const replies = analytics.reply_count || 0;
    const statusMap = { 0: 'draft', 1: 'active', 2: 'paused', 3: 'completed' };
    data.campaign = {
      sent,
      opens,
      replies,
      open_rate: sent ? Math.round((opens / sent) * 10000) / 100 : 0,
      reply_rate: sent ? Math.round((replies / sent) * 10000) / 100 : 0,
      launch_date: '2026-07-07',
      status: statusMap[analytics.campaign_status] || 'warming'
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
    data.revenue.mrr = Math.round((subs.data || []).reduce((a, s) => a + (s.items?.data?.[0]?.price?.unit_amount || 0) / 100, 0));
    data.revenue.arr = data.revenue.mrr * 12;
    data.revenue.new_signups = (events.data || []).filter(e => e.type === 'customer.subscription.created').length;
    data.revenue.cancellations = (events.data || []).filter(e => e.type === 'customer.subscription.deleted').length;
    data.revenue.failed_payments = (events.data || []).filter(e => e.type === 'invoice.payment_failed').length;
    data.health.stripe = true;
  } catch(e) { console.error('Stripe error:', e.message); }


  // COO Intelligence Engine — strategic recommendations from live data
  const totalLeads = Object.values(data.pipeline).reduce((a,b)=>a+b,0);
  const hotLeads = data.leads.filter(l=>l.tags.includes('replied')).length;
  const scheduledFollowups = data.leads.filter(l=>l.followup).length;
  const daysToLaunch = Math.max(0,Math.ceil((new Date('2026-07-07')-new Date())/86400000));

  if (data.revenue.failed_payments > 0) data.coo.push({ priority:'critical', icon:'PAYMENT', action:'Recover ' + data.revenue.failed_payments + ' failed payment(s) now', detail:'Log into Stripe and contact these customers today. Each one is MRR walking out the door.', category:'revenue' });
  if (data.revenue.cancellations > 0) data.coo.push({ priority:'critical', icon:'CANCEL', action: data.revenue.cancellations + ' cancellation(s) — read the exit survey', detail:'Agent 28 fired a churn interview automatically. Check GHL for the response within 24hrs.', category:'revenue' });
  if (!data.health.ghl) data.coo.push({ priority:'critical', icon:'DOWN', action:'GHL API down — pipeline is blind', detail:'Agents 09, 10, 11, 12, 13, 15, 17, 19 are all failing silently. Fix API key immediately.', category:'infra' });
  if (!data.health.instantly) data.coo.push({ priority:'critical', icon:'DOWN', action:'Instantly API down — outreach stopped', detail:'No reply classification, no campaign data. Check API key and Instantly status page.', category:'infra' });
  if (hotLeads > 0) data.coo.push({ priority:'high', icon:'TARGET', action: hotLeads + ' hot lead(s) — personal outreach today', detail:'These GCs engaged with your sequence. A direct email from your personal address today converts at 10x the automated rate.', category:'pipeline' });
  if (scheduledFollowups > 0) data.coo.push({ priority:'high', icon:'SCHED', action: scheduledFollowups + ' follow-ups scheduled by Agent 32', detail:'GCs who said not now have auto-scheduled re-engagement dates. Review in GHL to confirm dates are accurate.', category:'pipeline' });
  if (daysToLaunch <= 7 && daysToLaunch > 0) data.coo.push({ priority:'high', icon:'LAUNCH', action: daysToLaunch + ' days to July 7 launch — run final checklist', detail:'Confirm: warmup score above 80, all 8 CA GC contacts have correct variables, reply-handler running every 30 min.', category:'launch' });
  if (data.revenue.mrr === 0) data.coo.push({ priority:'high', icon:'PARTNER', action:'Call one construction lender this week', detail:'One lender with 200 GC borrowers recommending SubDraw is worth $360K ARR. Agent 27 has their contacts ready.', category:'partner' });
  if (totalLeads < 20) data.coo.push({ priority:'medium', icon:'PIPELINE', action:'Pipeline thin — trigger prospect run manually', detail:'Only ' + totalLeads + ' leads. Monday prospector adds more. Consider running node scripts/prospector-cron.js manually.', category:'pipeline' });
  if (data.campaign.sent > 50 && data.campaign.reply_rate < 2) data.coo.push({ priority:'medium', icon:'COPY', action:'Reply rate below 2% — confirm canonical line is in email 1', detail:'"If SubDraw catches one invoice overrun this year, it paid for itself." Confirm this is in email 1 subject or opening line.', category:'outreach' });
  data.coo.push({ priority:'low', icon:'INTEL', action:'Check Agent 20 output this Sunday night', detail:'A/B analyzer surfaces winning subject lines weekly. Review config/winning-variants.json before Monday prospector runs.', category:'intel' });
  data.coo.push({ priority:'low', icon:'EXPAND', action:'Review Agent 29 expansion report — Texas next', detail:'Agent 29 ranked Texas, Florida, Arizona for expansion. Check config/expansion-plan.json and decide when to create the Texas campaign.', category:'intel' });

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
