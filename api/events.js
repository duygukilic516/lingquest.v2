import { list } from '@vercel/blob';

const LATEST_PREFIX = 'latest-v47/';
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

async function readJsonFromUrl(blobUrl){
  if(!TOKEN) throw new Error('Missing BLOB_READ_WRITE_TOKEN');
  const res = await fetch(blobUrl, {
    method:'GET',
    headers:{ authorization:`Bearer ${TOKEN}` },
    cache:'no-store'
  });
  if(!res.ok) return null;
  const text = await res.text();
  try{ return JSON.parse(text); }catch(e){ return null; }
}

async function listAll(prefix){
  let cursor = undefined;
  const blobs = [];
  do{
    const page = await list({prefix, limit:1000, cursor});
    blobs.push(...(page.blobs || []));
    cursor = page.cursor;
  }while(cursor);
  return blobs;
}

function normalizeLatestSession(item){
  if(!item || typeof item !== 'object') return null;

  const id = item.id || item.sessionId || item.sessionSnapshot?.id || item.patch?.id;
  if(!id) return null;

  const s = Object.assign({}, item);

  s.id = id;
  s.appVersion = s.appVersion || 'v47';
  s.statsNamespace = s.statsNamespace || 'events-v47';
  s.events = Array.isArray(s.events) ? s.events : [];

  // Keep important booleans stable even if a latest snapshot is partial.
  if(s.lastEventType === 'listening_started') s.listeningStarted = true;
  if(s.lastEventType === 'listening_complete') s.listeningComplete = true;

  if(
    s.lastEventType === 'quiz_answer_selected' ||
    s.lastEventType === 'quiz_submitted' ||
    s.lastEventType === 'grammar_answer_selected' ||
    s.lastEventType === 'grammar_submitted' ||
    s.lastEventType === 'matching_progress' ||
    s.lastEventType === 'activities_complete'
  ){
    s.activitiesStarted = true;
  }

  if(s.lastEventType === 'activities_complete'){
    s.activitiesComplete = true;
  }

  if(s.lastEventType === 'speaking_started') s.conversationStarted = true;

  if(s.lastEventType === 'feedback_viewed'){
    s.feedbackViewed = true;
  }

  if(s.lastEventType === 'completed'){
    s.conversationComplete = true;
    s.completedAt = s.completedAt || s.updatedAt || new Date().toISOString();
  }

  if(s.lastEventType === 'save_clicked'){
    s.saveClicked = true;
    s.savedAt = s.savedAt || s.updatedAt || new Date().toISOString();
  }

  // If a user reached feedback or saved, count the flow as completed for admin.
  if(s.feedbackViewed || s.saveClicked || s.conversationComplete){
    s.activitiesComplete = s.activitiesComplete || !!s.activitySummary || true;
  }

  return s;
}

export default async function handler(req, res){
  res.setHeader('Cache-Control','no-store, no-cache, must-revalidate, max-age=0');

  try{
    const latestBlobs = await listAll(LATEST_PREFIX);

    const latestItems = [];
    for(const b of latestBlobs){
      try{
        const item = await readJsonFromUrl(b.url);
        if(item) latestItems.push(item);
      }catch(e){}
    }

    const sessions = latestItems
      .map(normalizeLatestSession)
      .filter(Boolean)
      .sort((a,b)=>new Date(b.updatedAt || b.savedAt || b.completedAt || b.startedAt || 0) - new Date(a.updatedAt || a.savedAt || a.completedAt || a.startedAt || 0));

    return res.status(200).json({
      ok:true,
      namespace:'latest-v47',
      source:'latest-only',
      access:'private',
      count:sessions.length,
      eventCount:0,
      blobCount:latestBlobs.length,
      latestCount:latestBlobs.length,
      sessions,
      events:[],
      generatedAt:new Date().toISOString()
    });
  }catch(error){
    return res.status(500).json({
      ok:false,
      source:'latest-only',
      error:error.message,
      sessions:[],
      events:[]
    });
  }
}
