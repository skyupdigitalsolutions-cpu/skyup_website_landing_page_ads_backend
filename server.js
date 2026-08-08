// SkyUp — standalone lead-capture backend (Express + MongoDB Atlas)
// Deploy on Railway as its own service. The static landing page calls this API.

import express from 'express'
import cors from 'cors'
import { MongoClient } from 'mongodb'

const app = express()
app.use(express.json({ limit: '32kb' }))

const PORT = process.env.PORT || 3000
const URI = process.env.MONGODB_URI
const DB_NAME = process.env.MONGODB_DB || 'skyup'
const COLL = process.env.LEADS_COLLECTION || 'website_leads'
const ADMIN_KEY = process.env.ADMIN_KEY || ''

// Allow the landing page's origin(s) to POST here. Comma-separated, or "*" for any.
const ORIGINS = (process.env.ALLOW_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean)
app.use(cors({ origin: ORIGINS.includes('*') ? true : ORIGINS, methods: ['GET', 'POST'] }))

// --- Mongo (lazy connect, reused across requests) ---
let leadsColl = null
async function leads() {
  if (leadsColl) return leadsColl
  if (!URI) throw new Error('MONGODB_URI not set')
  const client = new MongoClient(URI)
  await client.connect()
  const coll = client.db(DB_NAME).collection(COLL)
  coll.createIndex({ createdAt: -1 }).catch(() => {})
  leadsColl = coll
  console.log(`Mongo connected → ${DB_NAME}.${COLL}`)
  return leadsColl
}

const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

// health check
app.get('/', (req, res) => res.json({ ok: true, service: 'skyup-leads-backend' }))

// --- Capture a lead ---
app.post('/api/lead', async (req, res) => {
  const b = req.body || {}
  if (clean(b.company_website)) return res.json({ ok: true }) // honeypot: silently drop bots

  const lead = {
    name: clean(b.name, 120),
    business: clean(b.business, 160),
    phone: clean(b.phone, 40),
    budget: clean(b.budget, 60),
    timeline: clean(b.timeline, 60),
    source: clean(b.source, 60) || 'ads-landing',
    createdAt: new Date(),
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
    ua: clean(req.headers['user-agent'] || '', 300),
  }
  if (!lead.name || !lead.phone) return res.status(400).json({ ok: false, error: 'missing_fields' })

  try {
    const coll = await leads()
    await coll.insertOne(lead)
  } catch (e) {
    console.error('db_error:', e.message)
    return res.status(500).json({ ok: false, error: 'db_error' })
  }

  notifyTelegram(lead)
  forwardToCrm(lead)
  res.json({ ok: true })
})

// --- Protected leads export ---
app.get('/api/leads', async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' })
  const coll = await leads()
  const rows = await coll.find({}, { projection: { ua: 0 } }).sort({ createdAt: -1 }).limit(2000).toArray()

  if (req.query.format === 'csv') {
    const cols = ['createdAt', 'name', 'business', 'phone', 'budget', 'timeline', 'source', 'ip']
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const out = [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\n')
    res.setHeader('content-type', 'text/csv; charset=utf-8')
    res.setHeader('content-disposition', 'attachment; filename="skyup-leads.csv"')
    return res.send(out)
  }
  res.json({ ok: true, count: rows.length, leads: rows })
})

// --- Google Ads Lead Form webhook ---
// In Google Ads: Lead Form → Lead delivery → Webhook
//   URL  → https://YOUR-BACKEND.up.railway.app/google-webhook
//   Key  → value of GOOGLE_WEBHOOK_KEY env var (any secret string you choose)
app.post('/google-webhook', async (req, res) => {
  const key = process.env.GOOGLE_WEBHOOK_KEY
  if (key && req.query.key !== key && req.headers['x-goog-webhook-key'] !== key) {
    return res.status(401).json({ ok: false, error: 'unauthorized' })
  }

  // Google sends an array of lead_data objects; handle both single and batch
  const raw = req.body || {}
  const items = Array.isArray(raw) ? raw : [raw]

  for (const item of items) {
    // Google Ads payload shape:
    // { lead_id, campaign_id, campaign_name, ad_group_id, form_id,
    //   column_data: [{ column_id, string_value }], ... }
    const cols = {}
    for (const c of (item.column_data || [])) {
      cols[c.column_id] = c.string_value || ''
    }

    const lead = {
      name:       clean(cols['FULL_NAME'] || cols['FIRST_NAME'] || '', 120),
      business:   clean(cols['COMPANY_NAME'] || cols['BUSINESS_NAME'] || '', 160),
      phone:      clean(cols['PHONE_NUMBER'] || '', 40),
      email:      clean(cols['EMAIL'] || '', 160),
      budget:     clean(cols['BUDGET'] || '', 60),
      timeline:   clean(cols['TIMELINE'] || '', 60),
      source:     'google-ads',
      googleLeadId:   item.lead_id    || '',
      campaignId:     item.campaign_id ? String(item.campaign_id) : '',
      campaignName:   item.campaign_name || '',
      formId:         item.form_id    ? String(item.form_id) : '',
      rawCols:        cols,
      createdAt:  new Date(),
      ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
    }

    try {
      const coll = await leads()
      await coll.insertOne(lead)
    } catch (e) {
      console.error('google_webhook db_error:', e.message)
      // still return 200 so Google doesn't retry infinitely
    }

    notifyTelegramGoogle(lead)
    forwardToCrm(lead)
  }

  res.json({ ok: true })
})

function notifyTelegramGoogle(lead) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) return
  const text =
    `🟢 New Google Ads lead\n` +
    `Name: ${lead.name || '—'}\n` +
    `Business: ${lead.business || '—'}\n` +
    `Phone: ${lead.phone || '—'}\n` +
    `Email: ${lead.email || '—'}\n` +
    `Campaign: ${lead.campaignName || lead.campaignId || '—'}`
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
  }).catch(() => {})
}

function forwardToCrm(lead) {
  if (!process.env.CRM_WEBHOOK_URL) return
  fetch(process.env.CRM_WEBHOOK_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.CRM_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.CRM_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify(lead),
  }).catch(() => {})
}

function notifyTelegram(lead) {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chat = process.env.TELEGRAM_CHAT_ID
  if (!token || !chat) return
  const text =
    `🟠 New website lead\n` +
    `Name: ${lead.name}\n` +
    `Business: ${lead.business || '—'}\n` +
    `Phone: ${lead.phone}\n` +
    `Budget: ${lead.budget || '—'}\n` +
    `Start: ${lead.timeline || '—'}`
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text }),
  }).catch(() => {})
}

app.listen(PORT, () => console.log(`skyup-leads-backend running on :${PORT}`))
