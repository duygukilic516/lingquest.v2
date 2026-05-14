// DEBUG — sorun tespiti için. Test sonrası silebilirsin.
import { list } from '@vercel/blob';

const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const log = [];

  try {
    log.push({ step: '1_token', hasToken: !!TOKEN });
    if (!TOKEN) return res.status(200).json({ ok: false, log });

    // list() çalışıyor mu?
    let blobs = [];
    try {
      const page = await list({ prefix: 'events-v47/', limit: 5 });
      blobs = page.blobs || [];
      log.push({ step: '2_list', ok: true, count: blobs.length, firstUrl: blobs[0]?.url?.slice(0, 60) + '...' });
    } catch (e) {
      log.push({ step: '2_list', ok: false, error: e.message });
      return res.status(200).json({ ok: false, log });
    }

    // İlk dosyayı token ile fetch edebiliyor muyuz?
    if (blobs.length > 0) {
      try {
        const r = await fetch(blobs[0].url, { headers: { authorization: `Bearer ${TOKEN}` } });
        log.push({ step: '3_fetch', ok: r.ok, status: r.status });
        if (r.ok) {
          const text = await r.text();
          const parsed = JSON.parse(text);
          log.push({ step: '4_parse', ok: true, keys: Object.keys(parsed).slice(0, 8), eventType: parsed.eventType });
        }
      } catch (e) {
        log.push({ step: '3_fetch', ok: false, error: e.message });
      }
    }

    // latest-v47/ var mı?
    try {
      const lp = await list({ prefix: 'latest-v47/', limit: 5 });
      log.push({ step: '5_latest', ok: true, count: (lp.blobs || []).length });
    } catch (e) {
      log.push({ step: '5_latest', ok: false, error: e.message });
    }

    return res.status(200).json({ ok: true, log });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message, log });
  }
}
