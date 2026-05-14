import { list } from '@vercel/blob';

const EVENT_PREFIX  = 'events-v47/';
const LATEST_PREFIX = 'latest-v47/';

// ─── Private Blob JSON okuyucu ────────────────────────────────────────────────
// get() stream okuma Vercel runtime'da güvenilir değil.
// Bunun yerine: list() zaten b.url (blob URL) döndürür.
// Aynı URL'e BLOB_READ_WRITE_TOKEN ile Authorization header ekleyerek
// native fetch() yapıyoruz — response.text() ile okuyoruz, stream yok.
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

async function readJsonFromUrl(blobUrl) {
  const res = await fetch(blobUrl, {
    method: 'GET',
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) return null;
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function listAll(prefix) {
  let cursor;
  const blobs = [];
  do {
    const page = await list({ prefix, limit: 1000, cursor });
    blobs.push(...(page.blobs || []));
    cursor = page.cursor;
  } while (cursor);
  return blobs;
}

// ─── Session merge ────────────────────────────────────────────────────────────
function mergeEventsIntoSessions(events) {
  const sessions = {};

  const sorted = events.slice().sort((a, b) => {
    const as = Number(a.statsSeq || a.patch?.statsSeq || 0);
    const bs = Number(b.statsSeq || b.patch?.statsSeq || 0);
    if (as !== bs) return as - bs;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  });

  for (const e of sorted) {
    const id = e.sessionId || e.sessionSnapshot?.id || e.patch?.id;
    if (!id) continue;

    if (!sessions[id]) {
      sessions[id] = {
        id,
        appVersion: 'v47',
        statsNamespace: 'events-v47',
        startedAt: e.createdAt,
        events: []
      };
    }

    const s = sessions[id];

    if (e.sessionSnapshot && typeof e.sessionSnapshot === 'object') Object.assign(s, e.sessionSnapshot);
    if (e.patch && typeof e.patch === 'object') Object.assign(s, e.patch);

    s.id             = id;
    s.appVersion     = 'v47';
    s.statsNamespace = 'events-v47';
    s.statsSeq       = Math.max(Number(s.statsSeq || 0), Number(e.statsSeq || e.patch?.statsSeq || 0));
    s.updatedAt      = e.createdAt || s.updatedAt;
    s.lastEventType  = e.eventType || s.lastEventType;
    s.events         = Array.isArray(s.events) ? s.events : [];
    s.events.push({ eventType: e.eventType, patch: e.patch || {}, createdAt: e.createdAt, statsSeq: e.statsSeq });

    if (e.eventType === 'start' && !s.startedAt)    s.startedAt           = e.createdAt;
    if (e.eventType === 'listening_started')         s.listeningStarted    = true;
    if (e.eventType === 'listening_complete')        s.listeningComplete   = true;
    if (['quiz_answer_selected','quiz_submitted','grammar_answer_selected',
         'grammar_submitted','matching_progress'].includes(e.eventType))   s.activitiesStarted = true;
    if (e.eventType === 'activities_complete')       s.activitiesComplete  = true;
    if (e.eventType === 'speaking_started')          s.conversationStarted = true;
    if (e.eventType === 'feedback_viewed')           s.feedbackViewed      = true;
    if (e.eventType === 'completed') {
      s.conversationComplete = true;
      if (!s.completedAt) s.completedAt = e.patch?.completedAt || e.createdAt;
    }
    if (e.eventType === 'save_clicked') {
      s.saveClicked = true;
      if (!s.savedAt) s.savedAt = e.patch?.savedAt || e.createdAt;
    }
  }

  return Object.values(sessions);
}

// ─── latest-v47/ snapshot'larını üzerine uygula ───────────────────────────────
// latest-v47/<id>.json her event'te üzerine yazılır → her zaman en güncel hali taşır.
// Event dosyalarında kaçırılan completed/save alanlarını buradan kurtarıyoruz.
function applyLatestSnapshots(sessions, latestMap) {
  const byId = {};
  for (const s of sessions) byId[s.id] = s;

  for (const [id, snap] of Object.entries(latestMap)) {
    if (!byId[id]) {
      byId[id] = Object.assign({ id, appVersion: 'v47', statsNamespace: 'events-v47', events: [] }, snap);
    } else {
      const s = byId[id];
      // Sadece "sticky" alanları promote et — zaten true ise dokunma
      const promote = (field) => { if (snap[field] && !s[field]) s[field] = snap[field]; };
      promote('conversationComplete');
      promote('completedAt');
      promote('saveClicked');
      promote('savedAt');
      promote('feedbackViewed');
      promote('activitiesComplete');
      promote('listeningComplete');
      if (Number(snap.statsSeq) > Number(s.statsSeq || 0)) {
        s.statsSeq      = snap.statsSeq;
        s.updatedAt     = snap.updatedAt || s.updatedAt;
        s.lastEventType = snap.lastEventType || s.lastEventType;
      }
    }
  }

  return Object.values(byId);
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');

  if (!TOKEN) {
    return res.status(500).json({ ok: false, error: 'Missing BLOB_READ_WRITE_TOKEN' });
  }

  try {
    // 1. Her iki prefix'i paralel listele
    const [eventBlobs, latestBlobs] = await Promise.all([
      listAll(EVENT_PREFIX),
      listAll(LATEST_PREFIX)
    ]);

    // 2. Paralel oku — b.url + Bearer token ile native fetch
    const [eventItems, latestItems] = await Promise.all([
      Promise.all(eventBlobs.map(b => readJsonFromUrl(b.url).catch(() => null))),
      Promise.all(latestBlobs.map(b => readJsonFromUrl(b.url).catch(() => null)))
    ]);

    const events = eventItems.filter(Boolean);

    const latestMap = {};
    for (const snap of latestItems.filter(Boolean)) {
      const id = snap.id || snap.sessionId;
      if (id) latestMap[id] = snap;
    }

    // 3. Event'lerden session'ları derle, sonra latest'i üzerine uygula
    const merged    = mergeEventsIntoSessions(events);
    const sessions  = applyLatestSnapshots(merged, latestMap);
    const allEvents = sessions.flatMap(s => Array.isArray(s.events) ? s.events : []);

    return res.status(200).json({
      ok:          true,
      mode:        'fresh-v47-append-only',
      namespace:   'events-v47',
      access:      'private',
      count:       sessions.length,
      eventCount:  allEvents.length,
      blobCount:   eventBlobs.length,
      latestCount: latestBlobs.length,
      sessions,
      events:      allEvents,
      generatedAt: new Date().toISOString()
    });

  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message, sessions: [], events: [] });
  }
}
