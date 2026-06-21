require('dotenv').config();
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// GHL helper
async function callGHL(endpoint, method='GET', body=null) {
  const fetch = (await import('node-fetch')).default;
  const opts = {
    method,
    headers: {
      'Authorization': 'Bearer ' + process.env.GHL_API_KEY,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch('https://services.leadconnectorhq.com' + endpoint, opts);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('GHL ' + res.status + ' ' + endpoint + ' — ' + errText.substring(0, 200));
  }
  return res.json();
}
const ghl = callGHL; // alias used by upload/scrape endpoints

// Instantly helper
async function callInstantly(endpoint, method='GET', body=null) {
  const fetch = (await import('node-fetch')).default;
  const base = endpoint.startsWith('/api/v1') ? 'https://api.instantly.ai' : 'https://api.instantly.ai/api/v2';
  const opts = {
    method,
    headers: {
      'Authorization': 'Bearer ' + process.env.INSTANTLY_API_KEY,
      'Content-Type': 'application/json'
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(base + endpoint, opts);
  if (!res.ok) throw new Error('Instantly ' + res.status + ' ' + endpoint);
  return res.json();
}
const instantly = callInstantly; // alias

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
app.get(['/api/dashboard', '/api/data'], async (req, res) => {
  const data = {
    timestamp: new Date().toISOString(),
    pipeline: { cold: 0, emailed: 0, replied: 0, demo: 0, customer: 0 },
    leads: [],
    campaign: { sent: 0, opens: 0, replies: 0, open_rate: 0, reply_rate: 0 },
    revenue: { mrr: 0, arr: 0, new_signups: 0, cancellations: 0, failed_payments: 0 },
    coo: [],
    services: [],
    health: { ghl: false, instantly: false, stripe: false, anthropic: !!process.env.ANTHROPIC_API_KEY, apollo: !!process.env.APOLLO_API_KEY }
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

    // Get ALL leads — pull ca-gc and ut-gc and any sms-sent contacts
    const [caContacts, utContacts] = await Promise.all([
      callGHL('/contacts/?locationId=' + locationId + '&query=ca-gc&limit=100').catch(() => ({ contacts: [] })),
      callGHL('/contacts/?locationId=' + locationId + '&query=ut-gc&limit=100').catch(() => ({ contacts: [] }))
    ]);
    // Merge and deduplicate by id
    const allContacts = [...(caContacts.contacts || []), ...(utContacts.contacts || [])];
    const seen = new Set();
    const uniqueContacts = allContacts.filter(c => { if (seen.has(c.id)) return false; seen.add(c.id); return true; });
    const contacts = { contacts: uniqueContacts };
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
      sms: c.tags?.includes('sms-sent') || c.tags?.includes('sms-day1') || false,
      added: c.dateAdded
    }));

    data.health.ghl = true;
  } catch(e) { console.error('GHL error:', e.message); }

  // Instantly campaign
  try {
    const campaignId = process.env.INSTANTLY_CAMPAIGN_ID || 'bb1d4655-8d06-4218-89d4-ec196bc8ca81';
    const analyticsRaw = await callInstantly('/campaigns/analytics?campaign_id=' + campaignId);
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
  // Campaign is live — no launch countdown needed
  if (data.revenue.mrr === 0) data.coo.push({ priority:'high', icon:'PARTNER', action:'Call one construction lender this week', detail:'One lender with 200 GC borrowers recommending SubDraw is worth $360K ARR. Agent 27 has their contacts ready.', category:'partner' });
  if (totalLeads < 20) data.coo.push({ priority:'medium', icon:'PIPELINE', action:'Pipeline thin — trigger prospect run manually', detail:'Only ' + totalLeads + ' leads. Monday prospector adds more. Consider running node scripts/prospector-cron.js manually.', category:'pipeline' });
  if (data.campaign.sent > 50 && data.campaign.reply_rate < 2) data.coo.push({ priority:'medium', icon:'COPY', action:'Reply rate below 2% — confirm canonical line is in email 1', detail:'"If SubDraw catches one invoice overrun this year, it paid for itself." Confirm this is in email 1 subject or opening line.', category:'outreach' });
  data.coo.push({ priority:'low', icon:'INTEL', action:'Check Agent 20 output this Sunday night', detail:'A/B analyzer surfaces winning subject lines weekly. Review config/winning-variants.json before Monday prospector runs.', category:'intel' });
  data.coo.push({ priority:'low', icon:'EXPAND', action:'Review Agent 29 expansion report — Texas next', detail:'Agent 29 ranked Texas, Florida, Arizona for expansion. Check config/expansion-plan.json and decide when to create the Texas campaign.', category:'intel' });

  res.json(data);
});

// Alias /api/data → /api/dashboard for frontend
app.get('/api/data', (req, res, next) => { req.url = '/api/dashboard'; next('route'); });

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


// ── REAL-TIME WEBHOOK ──────────────────────────────────────────────────────
// Receives events from GHL and Instantly — updates live state
// Register this URL in GHL: Settings → Webhooks → https://dashboard-production-f04a.up.railway.app/webhook/ghl
// Register in Instantly: Settings → Webhooks → https://dashboard-production-f04a.up.railway.app/webhook/instantly

const liveEvents = []; // Ring buffer of last 50 events
const MAX_EVENTS = 50;

// SMS blast tracking
const smsStats = { sent: 0, failed: 0, skipped: 0, lastBlast: null, inProgress: false };

function pushEvent(source, type, data) {
  const event = { ts: new Date().toISOString(), source, type, data };
  liveEvents.unshift(event);
  if (liveEvents.length > MAX_EVENTS) liveEvents.pop();
  console.log('[Webhook]', source, type, JSON.stringify(data).substring(0, 100));
}

// Critical alert keywords — immediate banner notification on dashboard
const CRITICAL_KEYWORDS = ['stop', 'unsubscribe', 'remove me', 'dont contact', "don't contact", 'opt out', 'optout', 'cancel', 'not interested'];
const POSITIVE_KEYWORDS = ['interested', 'yes', 'tell me more', 'sounds good', 'let me see', 'demo', 'how much', 'pricing', 'sign up', 'trial'];

function detectAlertLevel(messageBody) {
  const lower = (messageBody || '').toLowerCase();
  if (CRITICAL_KEYWORDS.some(k => lower.includes(k))) return 'critical';
  if (POSITIVE_KEYWORDS.some(k => lower.includes(k))) return 'hot';
  return 'normal';
}

// GHL Webhook — fires on contact updates, SMS, pipeline changes, opportunities
app.post('/webhook/ghl', (req, res) => {
  res.sendStatus(200); // Acknowledge immediately
  const body = req.body || {};
  const type = body.type || body.event || 'unknown';
  const msgBody = body.body || body.message || '';
  // Extract contact name from multiple possible payload shapes
  // Agent events send: { type, source, state, city, company, pushed }
  // GHL events send: { contact: { name }, contactName }
  const contactName = body.contact?.name 
    || body.contactName 
    || body.contact_name
    || body.firstName && body.lastName ? `${body.firstName || ''} ${body.lastName || ''}`.trim() : null
    || body.name
    || body.company
    || body.organization_name
    || (body.city && body.state ? `${body.city}, ${body.state}` : null)
    || 'Unknown';
  
  // Parse meaningful events
  if (type === 'sms_blast_start') {
    smsStats.inProgress = true;
    smsStats.lastBlast = new Date().toISOString();
    pushEvent('agent', 'sms_blast_start', { contact: `SMS blast started — tag: ${body.tag || 'gc-prospect'}, cap: ${body.cap || 0}` });

  } else if (type === 'sms_blast_complete') {
    smsStats.sent += (body.sent || 0);
    smsStats.failed += (body.failed || 0);
    smsStats.skipped += (body.skipped || 0);
    smsStats.inProgress = false;
    pushEvent('agent', 'sms_blast_complete', {
      contact: `✅ Blast done — ${body.sent} sent · ${body.failed} failed · ${body.skipped} skipped`
    });

  } else if (type === 'sms_sent') {
    smsStats.sent++;
    pushEvent('agent', 'sms_sent', {
      contact: `SMS → ${body.contact || ''} · ${body.company || ''} · ${body.state || ''}`
    });

  } else if (type === 'prospect_found' || type.includes('prospect_found')) {
    // Agent 01 sends: { type, source, state, city, pushed, found }
    const state = body.state || '';
    const city = body.city || '';
    const pushed = body.pushed || body.count || 1;
    pushEvent('ghl', 'prospect_found', { 
      contact: city && state ? `${pushed} GCs — ${city}, ${state}` : `${pushed} GC prospect(s)`,
      state, 
      city,
      pushed,
      source: body.source || 'agent'
    });

  } else if (type.includes('ContactCreate') || type.includes('contact.create')) {
    pushEvent('ghl', 'new_lead', { name: body.contact?.name || body.firstName, company: body.contact?.companyName });

  } else if (type.includes('SMS') || type.includes('sms') || body.messageType === 'TYPE_SMS') {
    const direction = body.direction || (type.includes('Inbound') ? 'inbound' : 'outbound');
    const alertLevel = direction === 'inbound' ? detectAlertLevel(msgBody) : 'normal';
    
    pushEvent('ghl', direction === 'inbound' ? 'sms_reply' : 'sms_sent', {
      contact: contactName,
      body: msgBody.substring(0, 120),
      direction,
      alert: alertLevel
    });

    // Critical: STOP reply — fire immediate alert
    if (alertLevel === 'critical') {
      pushEvent('ghl', 'CRITICAL_STOP', {
        contact: contactName,
        message: msgBody,
        action_required: 'Mark as do-not-contact immediately',
        phone: body.phone || body.from
      });
      broadcastAlert({ level: 'critical', title: '🚨 STOP Reply — ' + contactName, body: msgBody, contact: contactName });
    }

    // Hot lead reply
    if (alertLevel === 'hot') {
      pushEvent('ghl', 'HOT_REPLY', {
        contact: contactName,
        message: msgBody,
        action_required: 'Respond immediately'
      });
      broadcastAlert({ level: 'hot', title: '🔥 Hot Reply — ' + contactName, body: msgBody, contact: contactName });
    }

  } else if (type.includes('InboundMessage') || body.direction === 'inbound') {
    const alertLevel = detectAlertLevel(msgBody);
    pushEvent('ghl', 'reply', {
      channel: body.messageType || 'unknown',
      contact: contactName,
      body: msgBody.substring(0, 120),
      alert: alertLevel
    });
    if (alertLevel === 'critical') broadcastAlert({ level: 'critical', title: '🚨 Opt-out — ' + contactName, body: msgBody });
    if (alertLevel === 'hot') broadcastAlert({ level: 'hot', title: '🔥 Interested — ' + contactName, body: msgBody });

  } else if (type.includes('OpportunityStage') || type.includes('opportunity.stageUpdate')) {
    pushEvent('ghl', 'stage_change', { contact: contactName, stage: body.pipelineStage?.name || body.stage });
  } else if (type.includes('OutboundMessage')) {
    pushEvent('ghl', 'outbound', { channel: body.messageType, contact: contactName, body: msgBody.substring(0, 80) });
  } else {
    pushEvent('ghl', type, { contact: contactName, raw: JSON.stringify(body).substring(0, 100) });
  }
});

// Broadcast urgent alerts to all connected SSE clients
function broadcastAlert(alert) {
  const payload = JSON.stringify({ type: 'alert', alert, ts: new Date().toISOString() });
  global.sseClients?.forEach(client => {
    try { client.write('data: ' + payload + '\n\n'); } catch(e) {}
  });
}

// Instantly Webhook — fires on email opens, replies, bounces, campaign events
app.post('/webhook/instantly', (req, res) => {
  res.sendStatus(200);
  const body = req.body || {};
  const event = body.event_type || body.type || 'unknown';

  if (event.includes('replied') || event.includes('reply')) {
    pushEvent('instantly', 'reply', { email: body.lead_email, subject: body.subject?.substring(0, 60) });
  } else if (event.includes('opened') || event.includes('open')) {
    pushEvent('instantly', 'open', { email: body.lead_email, campaign: body.campaign_name });
  } else if (event.includes('bounced') || event.includes('bounce')) {
    pushEvent('instantly', 'bounce', { email: body.lead_email });
  } else if (event.includes('unsubscribed')) {
    pushEvent('instantly', 'unsubscribe', { email: body.lead_email });
  } else {
    pushEvent('instantly', event, {});
  }
});

// SSE endpoint — dashboard subscribes to this for real-time push
// No polling needed — server pushes events as they happen
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  // Send current events immediately
  res.write('data: ' + JSON.stringify({ type: 'init', events: liveEvents.slice(0, 10) }) + '\n\n');
  
  // Keep connection alive with heartbeat
  const heartbeat = setInterval(() => {
    res.write('data: ' + JSON.stringify({ type: 'ping', ts: new Date().toISOString() }) + '\n\n');
  }, 15000);
  
  // Store reference so we can push to active connections
  if (!global.sseClients) global.sseClients = new Set();
  global.sseClients.add(res);
  
  req.on('close', () => {
    clearInterval(heartbeat);
    global.sseClients?.delete(res);
  });
});

// Push new events to all connected SSE clients
function broadcastEvent(event) {
  global.sseClients?.forEach(client => {
    try { client.write('data: ' + JSON.stringify({ type: 'event', event }) + '\n\n'); } catch(e) {}
  });
}

// Override pushEvent to also broadcast
const _pushEvent = pushEvent;

// GET /api/events/recent — dashboard polls this as fallback
app.get('/api/events/recent', (req, res) => {
  res.json({ events: liveEvents.slice(0, 20) });
});




// ── SMS STATS ENDPOINT ─────────────────────────────────────────────────────
app.get('/api/sms-stats', (req, res) => {
  res.json({ ...smsStats, timestamp: new Date().toISOString() });
});

// ── SCRAPY TRIGGER ─────────────────────────────────────────────────────────
// Triggers Scrapy spider on the scraper service
app.post('/api/scrapy-scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  
  const scraperUrl = process.env.SCRAPER_SERVICE_URL;
  if (!scraperUrl) {
    return res.status(503).json({ 
      error: 'Scraper service not configured',
      message: 'Set SCRAPER_SERVICE_URL in Railway environment variables once scraper service is deployed'
    });
  }

  try {
    const fetch2 = (await import('node-fetch')).default;
    const r = await fetch2(scraperUrl + '/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      timeout: 5000
    });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: 'Scraper service error: ' + e.message });
  }
});

// ── URL SCRAPER — FIRECRAWL ────────────────────────────────────────────────
// Firecrawl handles JS rendering, pagination, bot detection automatically
// Set FIRECRAWL_API_KEY in Railway dashboard service variables

app.post('/api/fetch-page', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'FIRECRAWL_API_KEY not set in Railway variables' });

  try {
    const fetch2 = (await import('node-fetch')).default;

    const r = await fetch2('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url,
        formats: ['markdown', 'html'],
        onlyMainContent: false,
        waitFor: 2000
      }),
      timeout: 60000
    });

    const data = await r.json();

    if (!r.ok || !data.success) {
      return res.status(400).json({ error: data.error || 'Firecrawl failed: ' + r.status });
    }

    // Return both markdown (clean text) and html
    const html = data.data?.html || '';
    const markdown = data.data?.markdown || '';
    const text = markdown || html;

    res.json({ html: text, method: 'firecrawl', length: text.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Browser-friendly note about Railway network

app.post('/api/extract-contacts', async (req, res) => {
  const { html, url } = req.body;
  if (!html) return res.status(400).json({ error: 'No HTML provided' });

  try {
    const fetch2 = (await import('node-fetch')).default;

    // Strip HTML to text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 25000);

    if (text.length < 100) return res.json({ contacts: [], message: 'Page has no readable text' });

    // Send to Claude in chunks
    const chunkSize = 6000;
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.substring(i, i + chunkSize));

    const allContacts = [];
    const seen = new Set();

    for (const chunk of chunks.slice(0, 5)) {
      try {
        const r = await fetch2('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            system: `You are a lead extraction agent for SubDraw — a subcontractor invoice management SaaS for General Contractors.

Your job: extract ONLY General Contractors (GCs) who likely manage subcontractors and would benefit from draw management software.

TARGET: General contractors, custom home builders, commercial builders, construction companies that manage multiple subcontractors on jobs.

SKIP: Specialty trades (electricians, plumbers, roofers, HVAC, painters, landscapers) UNLESS they also do general contracting. Skip suppliers, architects, engineers, real estate agents.

WHY they need SubDraw: GCs who manage 3+ subs on a job have invoice approval problems — subs overbill, bill for incomplete work, bill twice. SubDraw catches that automatically.

Return ONLY a JSON array. No markdown. No explanation.`,
            messages: [{
              role: 'user',
              content: `Extract General Contractor companies from this page that manage subcontractors.

For each GC return:
{
  "organization_name": "company name",
  "name": "owner/contact full name if found",
  "first_name": "first name",
  "last_name": "last name",
  "email": "email or null",
  "phone": "phone number or null",
  "website": "website URL or null",
  "city": "city or null",
  "state": "2-letter state code or null",
  "license_number": "contractor license # or null",
  "rating": "star rating if shown or null",
  "reviews": "number of reviews if shown or null",
  "why_a_fit": "one sentence on why they need SubDraw based on what you see"
}

Source URL: ${url}

Page content:
${chunk}

Return [] if no GC companies found. Never include specialty-only trades.`
            }]
          })
        });
        const d = await r.json();
        const txt = (d.content?.[0]?.text || '[]').replace(/```json|```/g,'').trim();
        const contacts = JSON.parse(txt);
        if (Array.isArray(contacts)) {
          contacts.forEach(c => {
            if (!c.organization_name) return;
            const key = c.organization_name.toLowerCase().replace(/[^a-z0-9]/g,'');
            if (key.length > 2 && !seen.has(key)) {
              seen.add(key);
              allContacts.push({ ...c, source_url: url });
            }
          });
        }
      } catch(e) { console.log('[Extract] Claude error:', e.message); }
    }

    // Push to GHL
    const locId = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
    const pipId = process.env.GHL_PIPELINE_ID || 'lu4BTmjYjJC2hZVKxj1t';
    const coldId = process.env.GHL_STAGE_COLD || '751975e9-c7f2-46a4-b821-e053bf505d8a';
    let pushed = 0;

    for (const c of allContacts) {
      try {
        const st = (c.state || '').toUpperCase();
        const contactRes = await ghl('/contacts/', 'POST', {
          locationId: locId,
          firstName: c.first_name || '',
          lastName: c.last_name || '',
          name: c.name || c.organization_name,
          companyName: c.organization_name,
          email: c.email || '',
          phone: c.phone || '',
          website: c.website || '',
          city: c.city || '',
          state: c.state || '',
          source: 'URL Scrape',
          tags: ['agent-outreach','gc-prospect','web-scrape','cold-outreach',
            st==='CA'?'ca-gc':st==='UT'?'ut-gc':'gc-prospect']
        });
        if (contactRes.contact?.id) {
          await ghl('/opportunities/', 'POST', {
            pipelineId: pipId, pipelineStageId: coldId,
            contactId: contactRes.contact.id,
            name: c.organization_name + ' — SubDraw Outreach', status: 'open'
          }).catch(()=>{});
          pushed++;
        }
      } catch(e) {}
      await new Promise(r => setTimeout(r, 150));
    }

    res.json({ contacts: allContacts, pushed, found: allContacts.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});



// ── VOICE AI CALL WEBHOOK ──────────────────────────────────────────────────
// Receives post-call data from GHL Voice AI after every outbound call
// Logs transcript, outcome, and sentiment to Live Activity feed

app.post('/webhook/voice', (req, res) => {
  res.sendStatus(200);
  const body = req.body || {};

  const contact = body.contact_name || body.contactName || 'Unknown';
  const phone = body.phone || body.to || '';
  const duration = body.call_duration || body.duration || 0;
  const transcript = body.transcript || body.call_transcript || '';
  const outcome = body.outcome || body.call_outcome || 'unknown';
  const agentId = body.agent_id || '';

  // Detect outcome from transcript if not explicitly set
  const lower = transcript.toLowerCase();
  let detectedOutcome = outcome;
  let alertLevel = 'normal';

  if (lower.includes('send') && lower.includes('link') || lower.includes('yes') || lower.includes('interested')) {
    detectedOutcome = 'interested';
    alertLevel = 'hot';
  } else if (lower.includes('not interested') || lower.includes('stop calling') || lower.includes('remove')) {
    detectedOutcome = 'not_interested';
    alertLevel = 'critical';
  } else if (lower.includes('call back') || lower.includes('not now') || lower.includes('later')) {
    detectedOutcome = 'callback_requested';
  } else if (lower.includes('voicemail') || lower.includes('no answer')) {
    detectedOutcome = 'no_answer';
  }

  console.log('[Voice] Call completed:', contact, '| Outcome:', detectedOutcome, '| Duration:', duration + 's');

  // Log to activity feed
  pushEvent('ghl', 'voice_call', {
    contact,
    phone,
    outcome: detectedOutcome,
    duration: duration + 's',
    transcript: transcript.substring(0, 200)
  });

  // Fire alert for hot outcomes
  if (alertLevel === 'hot') {
    broadcastAlert({
      level: 'hot',
      title: '🔥 Voice AI — ' + contact + ' is interested!',
      body: 'Call duration: ' + duration + 's — Demo link sent via SMS'
    });
  }

  if (alertLevel === 'critical') {
    broadcastAlert({
      level: 'critical',
      title: '🚨 Voice AI — ' + contact + ' said not interested',
      body: 'Tagged do-not-contact automatically'
    });
    // Auto tag in GHL if we have contact ID
    if (body.contact_id || body.contactId) {
      callGHL('/contacts/' + (body.contact_id || body.contactId) + '/tags', 'POST', {
        tags: ['voice-not-interested', 'do-not-contact']
      }).catch(() => {});
    }
  }
});

// ── SMS REPLY POLLER ───────────────────────────────────────────────────────
// Polls GHL conversations every 2 minutes for inbound SMS replies
// Fires instant alerts on STOP or hot replies
// Runs server-side so dashboard always knows — even when no browser is open

const CRITICAL_WORDS = ['stop', 'unsubscribe', 'remove', 'dont contact', "don't contact", 'opt out'];
const HOT_WORDS = ['interested', 'yes', 'tell me more', 'sounds good', 'demo', 'pricing', 'how much', 'sign up', 'trial', 'let me see'];

let lastSMSCheck = Date.now() - (2 * 60 * 1000); // Start by checking last 2 min
const alertedMessages = new Set(); // Don't alert same message twice

async function pollSMSReplies() {
  try {
    const locId = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
    
    // Get recent conversations via correct v2 search endpoint
    const data = await callGHL('/conversations/search?locationId=' + locId + '&limit=20&sortBy=last_message_date&sort=desc', 'GET');
    const convos = data.conversations || [];

    for (const convo of convos) {
      // Only check conversations updated since last poll
      const updatedAt = new Date(convo.lastMessageDate || convo.dateUpdated).getTime();
      if (updatedAt < lastSMSCheck) continue;

      // Get messages for this conversation
      const msgData = await callGHL('/conversations/' + convo.id + '/messages?limit=5');
      const messages = msgData.messages || [];

      for (const msg of messages) {
        if (alertedMessages.has(msg.id)) continue;
        if (msg.direction !== 'inbound') continue;
        
        const msgTime = new Date(msg.dateAdded || msg.createdAt).getTime();
        if (msgTime < lastSMSCheck) continue;

        const body = (msg.body || msg.text || '').toLowerCase().trim();
        if (!body) continue;

        alertedMessages.add(msg.id);

        const contactName = convo.contactName || convo.fullName || 'Unknown';
        const isCritical = CRITICAL_WORDS.some(w => body.includes(w));
        const isHot = HOT_WORDS.some(w => body.includes(w));

        if (isCritical) {
          console.log('[SMS Poller] 🚨 STOP reply from:', contactName, '—', body);
          pushEvent('ghl', 'CRITICAL_STOP', {
            contact: contactName,
            message: msg.body || msg.text,
            action_required: 'Mark as do-not-contact',
            contact_id: convo.contactId
          });
          broadcastAlert({
            level: 'critical',
            title: '🚨 STOP — ' + contactName,
            body: msg.body || msg.text,
            contact_id: convo.contactId
          });
          // Auto-tag contact as do-not-contact
          if (convo.contactId) {
            callGHL('/contacts/' + convo.contactId + '/tags', 'POST', {
              tags: ['sms-unsubscribed', 'do-not-contact']
            }).catch(() => {});
          }
        } else if (isHot) {
          console.log('[SMS Poller] 🔥 Hot reply from:', contactName, '—', body);
          pushEvent('ghl', 'HOT_REPLY', {
            contact: contactName,
            message: msg.body || msg.text,
            action_required: 'Respond immediately'
          });
          broadcastAlert({
            level: 'hot',
            title: '🔥 Hot Reply — ' + contactName,
            body: msg.body || msg.text
          });
        } else {
          // Normal inbound — just log to activity feed
          pushEvent('ghl', 'sms_reply', {
            contact: contactName,
            body: (msg.body || msg.text || '').substring(0, 100),
            direction: 'inbound'
          });
        }
      }
    }

    lastSMSCheck = Date.now();
  } catch(e) {
    console.log('[SMS Poller] Error:', e.message);
  }
}

// Run immediately on startup then every 2 minutes
pollSMSReplies();
setInterval(pollSMSReplies, 2 * 60 * 1000);

// Manual trigger endpoint
app.get('/api/poll-sms', async (req, res) => {
  await pollSMSReplies();
  res.json({ checked: true, alerts: [...alertedMessages].slice(-5) });
});


// ── HUNTER EMAIL ENRICHMENT ────────────────────────────────────────────────
// Finds emails for GHL contacts that only have phone/domain, pushes to Instantly

app.post('/api/hunter-enrich', async (req, res) => {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'HUNTER_API_KEY not set in Railway variables' });

  const fetch2 = (await import('node-fetch')).default;
  const locId = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
  const caId = process.env.INSTANTLY_CA_CAMPAIGN_ID || process.env.INSTANTLY_CAMPAIGN_ID || 'bb1d4655-8d06-4218-89d4-ec196bc8ca81';
  const utId = process.env.INSTANTLY_UT_CAMPAIGN_ID || '1c57cd85-5694-444d-9b03-8978c628ab8d';

  const results = { enriched: 0, skipped: 0, failed: 0, found: [] };

  // Check Hunter credits first
  const creditRes = await fetch2(`https://api.hunter.io/v2/account?api_key=${apiKey}`);
  const creditData = await creditRes.json();
  const available = creditData.data?.requests?.searches?.available || 0;
  if (available === 0) return res.status(429).json({ error: 'No Hunter credits remaining this month' });

  // Get contacts without emails from both tags
  for (const tag of ['ut-gc', 'ca-gc']) {
    const data = await callGHL(`/contacts/?locationId=${locId}&query=${tag}&limit=100`);
    const contacts = (data.contacts || []).filter(c => !c.email && (c.website || c.companyName));

    for (const contact of contacts) {
      if (results.enriched + results.failed >= available) break;

      let domain = null;
      if (contact.website) {
        try { domain = new URL(contact.website.startsWith('http') ? contact.website : 'https://' + contact.website).hostname.replace('www.',''); } catch {}
      }
      if (!domain && contact.companyName) {
        domain = contact.companyName.toLowerCase().replace(/[^a-z0-9]/g,'').substring(0,20) + '.com';
      }
      if (!domain) { results.skipped++; continue; }

      try {
        // Hunter domain search
        const hr = await fetch2(`https://api.hunter.io/v2/domain-search?domain=${domain}&api_key=${apiKey}&limit=3`);
        const hd = await hr.json();
        const emails = hd.data?.emails || [];
        if (!emails.length) {
          // Try email finder
          if (contact.firstName && contact.lastName) {
            const fr = await fetch2(`https://api.hunter.io/v2/email-finder?domain=${domain}&first_name=${encodeURIComponent(contact.firstName)}&last_name=${encodeURIComponent(contact.lastName)}&api_key=${apiKey}`);
            const fd = await fr.json();
            if (fd.data?.email) emails.push({ value: fd.data.email, confidence: fd.data.score });
          }
        }
        if (!emails.length) { results.skipped++; continue; }

        const best = emails.sort((a,b) => (b.confidence||0)-(a.confidence||0))[0];
        const email = best.value;

        // Update GHL
        await callGHL(`/contacts/${contact.id}`, 'PUT', { email });

        // Push to Instantly
        const campId = tag === 'ca-gc' ? caId : utId;
        await callInstantly('/leads', 'POST', {
          campaign_id: campId, skip_if_in_workspace: true,
          email, first_name: contact.firstName||'', last_name: contact.lastName||'',
          company_name: contact.companyName||'', phone: contact.phone||'',
          city: contact.city||'', state: contact.state||''
        }).catch(()=>{});

        results.enriched++;
        results.found.push({ company: contact.companyName, email, confidence: best.confidence });
        pushEvent('ghl', 'email_found', { company: contact.companyName, email, source: 'hunter' });

        await new Promise(r => setTimeout(r, 1200)); // Rate limit
      } catch(e) {
        results.failed++;
      }
    }
  }

  res.json({ ...results, credits_remaining: available - results.enriched });
});

// ── CSV UPLOAD ──────────────────────────────────────────────────────────────
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Parse any CSV — handles Vibe exports with JSON arrays in fields
function parseCSV(text) {
  const lines2 = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines2.length < 2) return [];
  const delim = lines2[0].includes('\t') ? '\t' : ',';

  // Normalize header names
  const normalize = h => {
    h = h.toLowerCase().replace(/^["']|["']$/g,'').trim();
    if (/first.?name|fname|prospect_first/.test(h)) return 'first_name';
    if (/last.?name|lname|prospect_last/.test(h)) return 'last_name';
    if (/full.?name|prospect_full/.test(h)) return 'full_name';
    if (/company.*(name|website.*no)|prospect_company_name/.test(h)) return 'company';
    if (/company.*website|prospect_company_web/.test(h)) return 'website';
    if (/contact_professions_email|professional.*email/.test(h)) return 'pro_email';
    if (/contact_emails/.test(h)) return 'emails_json';
    if (/contact_mobile/.test(h)) return 'mobile';
    if (/contact_phone/.test(h)) return 'phones_json';
    if (/^email/.test(h)) return 'email';
    if (/^phone|^tel|^cell/.test(h)) return 'phone';
    if (/prospect_city|^city/.test(h)) return 'city';
    if (/prospect_region|^state/.test(h)) return 'state';
    if (/job_title|^title/.test(h)) return 'title';
    if (/prospect_job_title/.test(h)) return 'title';
    return h;
  };

  const headers = lines2[0].split(delim).map(normalize);

  // Extract email from Vibe JSON: [{"address":"x@y.com","type":"current_professional"}]
  function extractEmail(emailsJson, proEmail) {
    if (proEmail && proEmail.includes('@') && !proEmail.startsWith('[') && !proEmail.startsWith('{')) return proEmail.trim();
    if (!emailsJson) return '';
    const match = emailsJson.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    return match ? match[0] : '';
  }

  // Extract phone from Vibe JSON: [{"phone_number":"+15551234567"}]
  function extractPhone(phonesJson, mobile) {
    if (mobile && mobile.match(/^\+?\d{10,}/)) return mobile.trim();
    if (!phonesJson) return '';
    const match = phonesJson.match(/\+\d{10,}/);
    return match ? match[0] : (mobile || '');
  }

  // Parse CSV line respecting quoted fields with embedded commas
  function parseLine(line) {
    const vals = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; }
      else if (line[i] === delim && !inQ) { vals.push(cur); cur = ''; }
      else { cur += line[i]; }
    }
    vals.push(cur);
    return vals.map(v => v.trim());
  }

  return lines2.slice(1).map(line => {
    const vals = parseLine(line);
    const row = {};
    headers.forEach((h, i) => { if (vals[i] !== undefined && vals[i] !== '') row[h] = vals[i]; });

    const email = extractEmail(row.emails_json, row.pro_email || row.email || '');
    const phone = extractPhone(row.phones_json, row.mobile || row.phone || '');
    const first = row.first_name || (row.full_name || '').split(' ')[0] || '';
    const last  = row.last_name  || (row.full_name || '').split(' ').slice(1).join(' ') || '';
    const name  = row.full_name  || (first + ' ' + last).trim() || row.company || '';
    const company = row.company || name || '';

    // Skip JSON garbage rows and rows with nothing useful
    if (!email && !phone) return null;
    if (!company || company.startsWith('[') || company.startsWith('{')) return null;

    const stateRaw = (row.state || 'CA');
    const stateMap = { california:'CA', utah:'UT', texas:'TX', florida:'FL', arizona:'AZ' };
    const state = stateMap[stateRaw.toLowerCase()] || stateRaw.substring(0,2).toUpperCase() || 'CA';

    return { name, first_name: first, last_name: last, title: row.title || 'Owner',
             email, phone, website: row.website || '', company, city: row.city || '',
             state, zip: '', address: '', source: 'csv_upload' };
  }).filter(Boolean);
}

// POST /api/upload-csv — parse CSV and push to GHL + Instantly
app.post('/api/upload-csv', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const text = req.file.buffer.toString('utf8');
  const prospects = parseCSV(text);

  if (!prospects.length) return res.status(400).json({ error: 'No valid rows found in CSV' });

  const locId = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
  const pipelineId = process.env.GHL_PIPELINE_ID || 'lu4BTmjYjJC2hZVKxj1t';
  const coldStageId = process.env.GHL_STAGE_COLD || '751975e9-c7f2-46a4-b821-e053bf505d8a';
  const campaignId = process.env.INSTANTLY_CAMPAIGN_ID || 'bb1d4655-8d06-4218-89d4-ec196bc8ca81';

  const results = { pushed_ghl: 0, pushed_instantly: 0, skipped: 0, errors: [] };

  for (const p of prospects) {
    try {
      // Push to GHL — only send fields GHL v2 accepts, strip nulls/empty
      const contactPayload = { locationId: locId, source: 'CSV Upload',
        tags: ['csv-upload', 'ca-gc', 'cold-outreach', 'agent-outreach', 'gc-prospect', 'subdraw-ca'] };
      if (p.first_name) contactPayload.firstName = p.first_name;
      if (p.last_name)  contactPayload.lastName  = p.last_name;
      if (p.email)      contactPayload.email      = p.email;
      if (p.phone)      contactPayload.phone      = p.phone;
      if (p.company)    contactPayload.companyName = p.company;
      if (p.website)    contactPayload.website    = p.website;
      if (p.city)       contactPayload.city       = p.city;
      if (p.state)      contactPayload.state      = p.state;
      let contactId = null;
      try {
        const contactRes = await ghl('/contacts/', 'POST', contactPayload);
        contactId = contactRes.contact?.id;
      } catch(e) {
        // 400 duplicate = contact already exists — extract their ID and continue to Instantly
        const dupMatch = e.message.match(/"contactId":"([^"]+)"/);
        if (dupMatch) {
          contactId = dupMatch[1];
          console.log('[Upload] Duplicate — reusing existing GHL contact:', contactId, 'for', p.company);
          results.skipped++; // Count as skipped not error
        } else {
          results.errors.push((p.company || p.email) + ': ' + e.message);
          results.skipped++;
          continue;
        }
      }
      if (contactId) {
        results.pushed_ghl++;

        // Add to pipeline
        await ghl('/opportunities/', 'POST', {
          pipelineId,
          pipelineStageId: coldStageId,
          contactId,
          name: p.company + ' — SubDraw Outreach',
          status: 'open',
          source: 'CSV Upload'
        }).catch(() => {}); // Pipeline add is non-blocking

        // Push to Instantly if has email
        if (p.email) {
          await instantly('/leads', 'POST', {
            campaign_id: campaignId,
            skip_if_in_workspace: true,
            email: p.email,
            first_name: p.first_name,
            last_name: p.last_name,
            company_name: p.company,
            phone: p.phone || '',
            website: p.website || '',
            city: p.city || '',
            state: p.state || 'CA',
            personalization: '',
            variables: {
              company: p.company,
              city: p.city || 'California',
              current_tool: 'spreadsheets',
              pain_point: 'invoice protection',
              demo_url: 'https://subdraw.com/login'
            }
          }).then(() => results.pushed_instantly++)
            .catch(e => results.errors.push(p.email + ': ' + e.message));
        }
      }
    } catch(e) {
      results.errors.push((p.company || p.email) + ': ' + e.message);
      results.skipped++;
    }

    // Small delay to avoid rate limits
    await new Promise(r => setTimeout(r, 200));
  }

  res.json({
    total_rows: prospects.length,
    pushed_ghl: results.pushed_ghl,
    pushed_instantly: results.pushed_instantly,
    skipped: results.skipped,
    errors: results.errors.slice(0, 10),
    sample: prospects.slice(0, 3)
  });
});

