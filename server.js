require('dotenv').config();
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(__dirname));

async function ghl(endpoint) {
  const fetch = (await import('node-fetch')).default;
  const r = await fetch('https://services.leadconnectorhq.com' + endpoint, {
    headers: { 'Authorization': 'Bearer ' + process.env.GHL_API_KEY, 'Content-Type': 'application/json', 'Version': '2021-07-28' }
  });
  if (!r.ok) throw new Error('GHL ' + r.status);
  return r.json();
}
async function instantly(endpoint) {
  const fetch = (await import('node-fetch')).default;
  const r = await fetch('https://api.instantly.ai/api/v2' + endpoint, {
    headers: { 'Authorization': 'Bearer ' + process.env.INSTANTLY_API_KEY, 'Content-Type': 'application/json' }
  });
  if (!r.ok) throw new Error('Instantly ' + r.status);
  return r.json();
}
async function stripe(endpoint) {
  const fetch = (await import('node-fetch')).default;
  const r = await fetch('https://api.stripe.com/v1' + endpoint, {
    headers: { 'Authorization': 'Bearer ' + process.env.STRIPE_SECRET_KEY }
  });
  if (!r.ok) throw new Error('Stripe ' + r.status);
  return r.json();
}

app.get('/api/data', async (req, res) => {
  const out = {
    ts: new Date().toISOString(),
    pipeline: { cold:0, emailed:0, replied:0, demo:0, customer:0 },
    leads: [],
    revenue: { mrr:0, arr:0, signups_24h:0, cancels_24h:0, failed_24h:0 },
    campaign: { sent:0, opens:0, replies:0, open_rate:0, reply_rate:0, status:'warming', warmup:null },
    health: { ghl:false, instantly:false, stripe:false, apollo:!!process.env.APOLLO_API_KEY, anthropic:!!process.env.ANTHROPIC_API_KEY },
    coo: []
  };

  try {
    const locId = process.env.GHL_LOCATION_ID || 'oe1TpmlDynQGFNdYLkaK';
    const pipId = process.env.GHL_PIPELINE_ID || 'lu4BTmjYjJC2hZVKxj1t';
    const opps = await ghl('/opportunities/search?pipeline_id=' + pipId + '&locationId=' + locId + '&limit=100');
    const sm = {
      [process.env.GHL_STAGE_COLD||'751975e9-c7f2-46a4-b821-e053bf505d8a']:'cold',
      [process.env.GHL_STAGE_EMAILED||'a9cb193d-c634-41e2-b7eb-e0c6a24065ca']:'emailed',
      [process.env.GHL_STAGE_REPLIED||'32e745b6-97f5-4ad1-8b59-4652995f2176']:'replied'
    };
    (opps.opportunities||[]).forEach(o => {
      const s = sm[o.pipelineStageId]||'cold';
      out.pipeline[s]++;
      if (o.contact?.tags?.includes('customer')) out.pipeline.customer++;
      if (o.contact?.tags?.includes('demo-clicked')) out.pipeline.demo++;
    });
    const contacts = await ghl('/contacts/?locationId=' + locId + '&query=ca-gc&limit=50');
    out.leads = (contacts.contacts||[]).map(c => ({
      id: c.id, name: (c.firstName||'')+' '+(c.lastName||''), company: c.companyName||'',
      email: c.email||'', phone: c.phone||'', tags: c.tags||[],
      score: c.customFields?.find(f=>f.key==='lead_score')?.field_value||'—',
      tier: c.customFields?.find(f=>f.key==='lead_tier')?.field_value||'cold',
      plan: c.tags?.find(t=>t.startsWith('plan-target-'))?.replace('plan-target-','')||'—',
      pain: c.customFields?.find(f=>f.key==='pain_point')?.field_value||'—',
      followup: c.customFields?.find(f=>f.key==='follow_up_date')?.field_value||null,
      added: c.dateAdded, sms: c.tags?.includes('sms-sent')
    }));
    out.health.ghl = true;
  } catch(e) { console.error('GHL:', e.message); }

  try {
    const cid = process.env.INSTANTLY_CAMPAIGN_ID||'bb1d4655-8d06-4218-89d4-ec196bc8ca81';
    const a = await instantly('/analytics/campaigns?id=' + cid);
    const cd = a[0] || a;
    out.campaign = {
      sent: cd.total_emails_sent||cd.emails_sent_count||0,
      opens: cd.total_opened||cd.unique_opens_count||0,
      replies: cd.total_replied||cd.reply_count||0,
      open_rate: Math.round((cd.open_rate||0)*100)/100,
      reply_rate: Math.round((cd.reply_rate||0)*100)/100,
      status: cd.status||'warming',
      warmup: cd.warmup_score||cd.health_score||null
    };
    out.health.instantly = true;
  } catch(e) { console.error('Instantly:', e.message); }

  try {
    const since = Math.floor(Date.now()/1000)-86400;
    const [subs, evts] = await Promise.all([
      stripe('/subscriptions?limit=100&status=active'),
      stripe('/events?created[gte]='+since+'&limit=100')
    ]);
    out.revenue.mrr = Math.round((subs.data||[]).reduce((a,s)=>a+(s.items?.data?.[0]?.price?.unit_amount||0)/100,0));
    out.revenue.arr = out.revenue.mrr * 12;
    out.revenue.signups_24h = (evts.data||[]).filter(e=>e.type==='customer.subscription.created').length;
    out.revenue.cancels_24h = (evts.data||[]).filter(e=>e.type==='customer.subscription.deleted').length;
    out.revenue.failed_24h = (evts.data||[]).filter(e=>e.type==='invoice.payment_failed').length;
    out.health.stripe = true;
  } catch(e) { console.error('Stripe:', e.message); }

  // COO Intelligence Engine
  const totalLeads = Object.values(out.pipeline).reduce((a,b)=>a+b,0);
  const hotLeads = out.leads.filter(l=>l.tier==='hot'||l.tags.includes('replied')).length;
  const scheduledFollowups = out.leads.filter(l=>l.followup).length;
  const daysToLaunch = Math.max(0,Math.ceil((new Date('2026-07-07')-new Date())/86400000));

  if (out.revenue.failed_24h > 0) out.coo.push({ priority:'critical', icon:'PAYMENT', action:'Recover ' + out.revenue.failed_24h + ' failed payment(s) now', detail:'Log into Stripe, contact these customers today. Each one is MRR walking out the door. Agent 14 flagged this automatically.', category:'revenue' });
  if (out.revenue.cancels_24h > 0) out.coo.push({ priority:'critical', icon:'CANCEL', action: out.revenue.cancels_24h + ' cancellation(s) — read the exit survey', detail:'Agent 28 fired a churn interview automatically. Check GHL for the response within 24hrs. Every cancellation teaches you something.', category:'revenue' });
  if (!out.health.ghl) out.coo.push({ priority:'critical', icon:'DOWN', action:'GHL API down — pipeline is blind', detail:'Agents 09, 10, 11, 12, 13, 15, 17, 19 are all failing silently. Fix API key or check GHL status immediately.', category:'infra' });
  if (!out.health.instantly) out.coo.push({ priority:'critical', icon:'DOWN', action:'Instantly API down — outreach stopped', detail:'No reply classification, no campaign data. Check API key and Instantly status page.', category:'infra' });
  if (out.campaign.warmup && out.campaign.warmup < 70) out.coo.push({ priority:'critical', icon:'WARM', action:'Warmup score ' + out.campaign.warmup + '/100 — pause outreach', detail:'Below safe threshold of 70. If you launch July 7th with this score, emails land in spam. Fix warmup now or delay launch.', category:'outreach' });
  if (hotLeads > 0) out.coo.push({ priority:'high', icon:'TARGET', action: hotLeads + ' hot lead(s) — personal outreach today', detail:'These GCs engaged with your sequence. A direct email from your personal address today converts at 10x the automated rate. Check their reply in GHL and respond personally.', category:'pipeline' });
  if (scheduledFollowups > 0) out.coo.push({ priority:'high', icon:'SCHED', action: scheduledFollowups + ' follow-ups scheduled by Agent 32', detail:'GCs who said not now have auto-scheduled re-engagement dates. Review in GHL to confirm dates and context notes are accurate before they fire.', category:'pipeline' });
  if (daysToLaunch <= 7 && daysToLaunch > 0) out.coo.push({ priority:'high', icon:'LAUNCH', action: daysToLaunch + ' days to July 7 launch — run final checklist', detail:'Confirm: warmup score above 80, 8 CA GC contacts have correct variables in Instantly, email sequence previews look right, reply-handler running every 30 min.', category:'launch' });
  if (out.revenue.mrr === 0) out.coo.push({ priority:'high', icon:'PARTNER', action:'Call one construction lender this week', detail:'One lender with 200 GC borrowers recommending SubDraw is worth $360K ARR at $149/mo average. Agent 27 has their contacts ready. This one call beats 20 cold email campaigns.', category:'partner' });
  if (totalLeads < 20) out.coo.push({ priority:'medium', icon:'PIPELINE', action:'Pipeline thin — trigger prospect run manually', detail:'Only ' + totalLeads + ' leads. Monday prospector adds more. Consider manually triggering `node scripts/prospector-cron.js` or expanding to Texas for volume.', category:'pipeline' });
  if (out.campaign.sent > 50 && out.campaign.reply_rate < 2) out.coo.push({ priority:'medium', icon:'COPY', action:'Reply rate below 2% — test invoice overrun angle', detail:'Your canonical line: "If SubDraw catches one invoice overrun this year, it paid for itself." Confirm this is in email 1, subject line. Agent 20 analyzes Sunday — check winning-variants.json Monday morning.', category:'outreach' });
  if (out.campaign.open_rate > 40 && out.campaign.reply_rate < 5) out.coo.push({ priority:'medium', icon:'CTA', action:'High opens, low replies — CTA needs testing', detail:'People read but do not click. Test: "8 minutes to see it — subdraw.com/login" vs "Try it free." Be more specific about what they see inside. Agent 20 will pick the winner Sunday.', category:'outreach' });
  out.coo.push({ priority:'low', icon:'INTEL', action:'Check Agent 20 output this Sunday night', detail:'The A/B analyzer surfaces winning subject lines and email angles weekly. Review config/winning-variants.json after midnight Sunday before Monday prospector runs.', category:'intel' });
  out.coo.push({ priority:'low', icon:'EXPAND', action:'Review Agent 29 expansion report — Texas next', detail:'Agent 29 ran Monday and ranked Texas, Florida, Arizona for expansion. Check config/expansion-plan.json and decide when to create the Texas Instantly campaign.', category:'intel' });

  res.json(out);
});

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.listen(port, () => console.log('SubDraw COO Dashboard running on port ' + port));
