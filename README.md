# SubDraw Agent Command Center

Live dashboard for the SubDraw 31-agent outreach system.

## What it shows
- MRR, leads, campaign stats, new signups
- Lead pipeline stages (Cold → Emailed → Replied → Demo → Customer)
- All 8 CA GC leads with status and lead score
- All 6 Railway services and their agent assignments
- Instantly campaign performance
- System health for all 6 APIs
- July 7th launch countdown

## Deploy to Railway
1. Create new Railway service
2. Connect to this repo
3. Add env vars (same as agent system)
4. Deploy — accessible at your Railway URL

## Run locally
```bash
npm install
cp env.example .env
# fill in your keys
npm start
```
Open http://localhost:3000
