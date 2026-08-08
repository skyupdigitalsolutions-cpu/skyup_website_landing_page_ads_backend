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

// health check — Railway pings this to confirm the container is alive
app.get('/', (req, res) => res.json({ ok: true, service: 'skyup-leads-backend' }))
app.get('/health', (req, res) => res.json({ ok: true }))

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

  // Dedup window: only block re-submission of the same phone within 10 minutes.
  // This stops double-clicks and retries without permanently blocking a real
  // returning visitor who fills the form again months later.
  const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000)

  try {
    const coll = await leads()

    const recent = await coll.findOne(
      { phone: lead.phone, createdAt: { $gte: TEN_MINUTES_AGO } },
      { projection: { _id: 1 } }
    )
    if (recent) {
      console.log(`[dedup] phone ${lead.phone} submitted within last 10 min — skipping`)
      return res.json({ ok: true })
    }

    await coll.insertOne(lead)
    console.log(`[lead] saved — ${lead.name} | ${lead.phone}`)
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

function forwardToCrm(lead) {
  if (!process.env.CRM_WEBHOOK_URL) return

  // Append GOOGLE_WEBHOOK_KEY as ?google_key=... so the CRM can match the campaign config
  let url = process.env.CRM_WEBHOOK_URL
  const key = process.env.GOOGLE_WEBHOOK_KEY
  if (key) {
    const separator = url.includes('?') ? '&' : '?'
    url = `${url}${separator}google_key=${encodeURIComponent(key)}`
  }

  console.log(`[crm-forward] → ${url}`)

  fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(process.env.CRM_WEBHOOK_TOKEN ? { authorization: `Bearer ${process.env.CRM_WEBHOOK_TOKEN}` } : {}),
    },
    body: JSON.stringify(lead),
  }).catch((e) => console.error('[crm-forward] error:', e.message))
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

// Bind to 0.0.0.0 so Railway's health check can reach the container externally.
// Without this Node.js defaults to 127.0.0.1 (localhost only) and Railway
// sees the port as unreachable → sends SIGTERM → restart loop.
app.listen(PORT, '0.0.0.0', () => console.log(`skyup-leads-backend running on :${PORT}`))
