import { list, del } from '@vercel/blob';

const EVENT_PREFIX = 'events-v47/';
const LATEST_PREFIX = 'latest-v47/';

function safeName(value){
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

async function listAll(prefix){
  let cursor = undefined;
  const blobs = [];
  do{
    const page = await list({ prefix, limit: 1000, cursor });
    blobs.push(...(page.blobs || []));
    cursor = page.cursor;
  }while(cursor);
  return blobs;
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Cache-Control','no-store');

  if(req.method === 'OPTIONS') return res.status(200).end();
  if(req.method !== 'POST' && req.method !== 'DELETE'){
    return res.status(405).json({ ok:false, error:'Method not allowed' });
  }

  try{
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const sessionId = body.sessionId || req.query?.sessionId;
    if(!sessionId) return res.status(400).json({ ok:false, error:'Missing sessionId' });

    const safeId = safeName(sessionId);
    const toDelete = [`${LATEST_PREFIX}${safeId}.json`];

    const eventBlobs = await listAll(`${EVENT_PREFIX}${safeId}/`);
    toDelete.push(...eventBlobs.map(b => b.pathname).filter(Boolean));

    const unique = [...new Set(toDelete)];
    await del(unique);

    return res.status(200).json({ ok:true, sessionId, deleted: unique.length });
  }catch(error){
    return res.status(500).json({ ok:false, error:error.message });
  }
}
