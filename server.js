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

// ── CSV UPLOAD ──────────────────────────────────────────────────────────────
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Parse any CSV format into normalized prospect objects
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];

  // Detect delimiter
  const delim = lines[0].includes('\t') ? '\t' : ',';

  // Parse header — normalize column names
  const raw_headers = lines[0].split(delim).map(h => h.replace(/^["']|["']$/g, '').trim().toLowerCase());

  const normalize = h => {
    if (/first.?name|fname/.test(h)) return 'first_name';
    if (/last.?name|lname|surname/.test(h)) return 'last_name';
    if (/^name$|full.?name|contact.?name|owner/.test(h)) return 'name';
    if (/company|business|organization|org.?name/.test(h)) return 'company';
    if (/email|e-mail/.test(h)) return 'email';
    if (/phone|mobile|cell|tel/.test(h)) return 'phone';
    if (/website|url|web|site/.test(h)) return 'website';
    if (/city|town/.test(h)) return 'city';
    if (/state|province/.test(h)) return 'state';
    if (/zip|postal/.test(h)) return 'zip';
    if (/title|position|role/.test(h)) return 'title';
    if (/license|lic/.test(h)) return 'license';
    if (/rating|stars/.test(h)) return 'rating';
    if (/reviews|review.?count/.test(h)) return 'reviews';
    if (/address|addr/.test(h)) return 'address';
    return h;
  };

  const headers = raw_headers.map(normalize);

  return lines.slice(1).map(line => {
    const vals = line.split(delim).map(v => v.replace(/^["']|["']$/g, '').trim());
    const row = {};
    headers.forEach((h, i) => { if (vals[i]) row[h] = vals[i]; });

    // Build normalized prospect
    const first = row.first_name || '';
    const last = row.last_name || '';
    const fullName = row.name || (first + ' ' + last).trim() || row.company || '';

    return {
      name: fullName,
      first_name: first || fullName.split(' ')[0] || '',
      last_name: last || fullName.split(' ').slice(1).join(' ') || '',
      title: row.title || 'Owner',
      email: row.email || '',
      phone: row.phone || '',
      website: row.website || '',
      company: row.company || row.organization || fullName,
      city: row.city || '',
      state: row.state || 'California',
      zip: row.zip || '',
      address: row.address || '',
      license: row.license || '',
      rating: row.rating || '',
      reviews: row.reviews || '',
      source: 'csv_upload'
    };
  }).filter(p => p.company || p.email || p.phone);
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
      // Push to GHL
      const contactRes = await ghl('/contacts/', 'POST', {
        locationId: locId,
        firstName: p.first_name,
        lastName: p.last_name,
        name: p.name,
        companyName: p.company,
        email: p.email,
        phone: p.phone,
        website: p.website,
        address1: p.address,
        city: p.city,
        state: p.state,
        postalCode: p.zip,
        source: 'CSV Upload',
        tags: ['csv-upload', 'ca-gc', 'cold-outreach', 'agent-outreach', 'gc-prospect', 'subdraw-ca'],
        customFields: [
          { key: 'license_number', field_value: p.license },
          { key: 'csv_rating', field_value: p.rating },
          { key: 'csv_reviews', field_value: p.reviews }
        ].filter(f => f.field_value)
      });

      const contactId = contactRes.contact?.id;
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
          await instantly('/api/v1/lead/add', 'POST', {
            campaign_id: campaignId,
            skip_if_in_workspace: true,
            leads: [{
              email: p.email,
              first_name: p.first_name,
              last_name: p.last_name,
              company_name: p.company,
              phone: p.phone,
              website: p.website,
              city: p.city,
              state: p.state,
              personalization: '',
              custom_variables: {
                company: p.company,
                city: p.city || 'California',
                current_tool: 'spreadsheets',
                pain_point: 'invoice protection',
                demo_url: 'https://subdraw.com/login'
              }
            }]
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

