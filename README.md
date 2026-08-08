# skyup-leads-backend

Standalone lead-capture API (Express + MongoDB Atlas) for the SkyUp ads landing page.
The landing page (hosted separately) POSTs form submissions here.

## Endpoints
- `GET  /`            → health check
- `POST /api/lead`    → `{ name, business, phone, budget, timeline, source, company_website }`
- `GET  /api/leads?key=ADMIN_KEY`            → JSON export
- `GET  /api/leads?key=ADMIN_KEY&format=csv` → CSV download

## Deploy on Railway
1. Push this folder to its own GitHub repo (e.g. `skyup-leads-backend`).
2. Railway → **New Project → Deploy from GitHub repo** → pick it.
   Railway runs `npm install` then `npm start` (see `railway.json`).
3. Add **Variables** (copy from `.env.example`):
   - `MONGODB_URI`  → your Atlas connection string
   - `MONGODB_DB`   → `skyup`
   - `LEADS_COLLECTION` → `website_leads`
   - `ADMIN_KEY`    → a long random string
   - `ALLOW_ORIGIN` → your landing page URL (or `*`)
   - optional: `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, `CRM_WEBHOOK_URL` / `CRM_WEBHOOK_TOKEN`
4. **MongoDB Atlas → Network Access → add `0.0.0.0/0`** (Railway IPs are dynamic).
5. Railway → **Settings → Networking → Generate Domain** → this is your API URL.

## Connect the landing page
In the landing page's `src/main.js`, set:
```js
const API_BASE = 'https://YOUR-BACKEND.up.railway.app'
```
Rebuild & redeploy the landing page. The form will POST to `${API_BASE}/api/lead`.
Make sure `ALLOW_ORIGIN` here matches the landing page's domain.

## Local run
```bash
npm install
node --env-file=.env server.js      # Node 20+ reads .env
```
