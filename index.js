// ============================================================================
//  ebutuoy-campus :: backend
//  Built on the ebutuoy backend. Everything that worked is still here.
//  New for campus:
//    sources    curated channels and course playlists you add by URL
//    /course    pulls a source in order, lecture 1, 2, 3, no view filter
//    /entry     the end-of-video logbook record: status, note, project link
//    /transcript  buckets with credits weighted toward building over watching
//  The database path is now volume-aware via the DB_FILE env var.
// ============================================================================

const express   = require('express');
const cors      = require('cors');
const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// DB_FILE lets Railway point this at a persistent volume, e.g. /data/campus.db
const DB_PATH                  = process.env.DB_FILE || path.join(__dirname, 'campus.db');
const YT_KEY                   = process.env.YOUTUBE_API_KEY;
// Ceiling raised from 1000 so real lessons can surface in stumble mode.
const MAX_VIEWS                = 100000;
const MAX_SUBS                 = 100000;
const FETCH_N                  = 50;
const REVISIT_MIN_HOURS        = 24;
const REVISIT_MIN_VIDEOS_SEEN  = 100;

// Credits. Each status is worth points. Ten points is one credit.
const CREDIT_POINTS = 10;
const STATUS_POINTS = { watched: 1, followed: 2, built: 3, blocked: 1 };
const VALID_STATUS  = Object.keys(STATUS_POINTS);

// Education genres. Every source and every logged entry carries one.
const GENRES = ['history', 'disasters', 'safety', 'trades', 'science', 'tech', 'skills', 'general'];
function cleanGenre(raw, fallback) {
  const g = String(raw || '').trim().toLowerCase();
  return GENRES.includes(g) ? g : fallback;
}

let db;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
  } else {
    db = new SQL.Database();
  }
  db.run(`CREATE TABLE IF NOT EXISTS seen_videos (
    video_id TEXT PRIMARY KEY,
    seen_at  INTEGER NOT NULL,
    title    TEXT,
    channel  TEXT
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS tag_actions (
    video_id   TEXT NOT NULL,
    tag        TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    title      TEXT,
    channel    TEXT,
    PRIMARY KEY (video_id, tag, applied_at)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS revisit_queue (
    video_id           TEXT PRIMARY KEY,
    title              TEXT,
    channel            TEXT,
    tagged_at          INTEGER NOT NULL,
    videos_seen_at_tag INTEGER NOT NULL,
    last_replayed_at   INTEGER
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS clips (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id   TEXT NOT NULL,
    title      TEXT,
    channel    TEXT,
    start_sec  INTEGER NOT NULL,
    end_sec    INTEGER NOT NULL,
    clip_list  TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // NEW: curated sources (channels and course playlists)
  db.run(`CREATE TABLE IF NOT EXISTS sources (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    kind      TEXT NOT NULL,
    ref       TEXT NOT NULL,
    title     TEXT,
    added_at  INTEGER NOT NULL,
    UNIQUE (kind, ref)
  )`);
  // NEW: the logbook. One row per video you finished and bucketed.
  db.run(`CREATE TABLE IF NOT EXISTS entries (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id     TEXT NOT NULL,
    title        TEXT,
    channel      TEXT,
    bucket       TEXT NOT NULL,
    status       TEXT NOT NULL,
    note         TEXT,
    project_link TEXT,
    source_kind  TEXT,
    profile      TEXT,
    created_at   INTEGER NOT NULL
  )`);
  // For databases created before profiles existed, add the column if missing.
  // Throws "duplicate column" on fresh databases, which we safely ignore.
  try { db.run('ALTER TABLE entries ADD COLUMN profile TEXT'); } catch (e) {}
  // Genre columns. Same safe pattern: added when missing, ignored when present.
  try { db.run('ALTER TABLE entries ADD COLUMN genre TEXT'); } catch (e) {}
  try { db.run('ALTER TABLE sources ADD COLUMN genre TEXT'); } catch (e) {}
  saveDb();
}

function saveDb() {
  fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
}

function getSeenSet() {
  const stmt = db.prepare('SELECT video_id FROM seen_videos');
  const set  = new Set();
  while (stmt.step()) set.add(stmt.getAsObject().video_id);
  stmt.free();
  return set;
}

function getSeenCount() {
  const stmt = db.prepare('SELECT COUNT(*) AS c FROM seen_videos');
  stmt.step();
  const c = stmt.getAsObject().c;
  stmt.free();
  return c;
}

function randomLand() {
  const regions = [
    [25,  50,  -125, -70],
    [-40, 10,  -80,  -40],
    [36,  60,  -10,  40],
    [-30, 35,  -15,  45],
    [10,  40,  35,   90],
    [20,  45,  100,  145],
    [-40, 20,  95,   155],
  ];
  const r = regions[Math.floor(Math.random() * regions.length)];
  return {
    lat: Number((r[0] + Math.random() * (r[1] - r[0])).toFixed(4)),
    lng: Number((r[2] + Math.random() * (r[3] - r[2])).toFixed(4))
  };
}

function isLikelyEnglish(video) {
  const langField = video.snippet?.defaultAudioLanguage || video.snippet?.defaultLanguage;
  if (langField) {
    return langField.toLowerCase().startsWith('en');
  }
  const title = video.snippet?.title || '';
  if (!title) return true;

  const nonLatinRanges = [
    [0x0400, 0x04FF], [0x0500, 0x052F], [0x0600, 0x06FF], [0x0700, 0x074F],
    [0x0900, 0x097F], [0x0E00, 0x0E7F], [0x3040, 0x309F], [0x30A0, 0x30FF],
    [0x3400, 0x4DBF], [0x4E00, 0x9FFF], [0xAC00, 0xD7AF], [0x0590, 0x05FF],
  ];
  let nonLatin = 0;
  let total    = 0;
  for (const ch of title) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x20 || (cp >= 0x21 && cp <= 0x2F) || (cp >= 0x3A && cp <= 0x40)) continue;
    total++;
    for (const [lo, hi] of nonLatinRanges) {
      if (cp >= lo && cp <= hi) { nonLatin++; break; }
    }
  }
  if (total === 0) return true;
  return (nonLatin / total) < 0.30;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'ebutuoy-campus', has_key: !!YT_KEY });
});

// ---------------------------------------------------------------------------
//  seen / tag / revisit / search / playlist / clips  (carried over, unchanged
//  except the raised view ceiling already set in the constants above)
// ---------------------------------------------------------------------------

app.get('/seen', (req, res) => {
  const ids = Array.from(getSeenSet());
  res.json({ count: ids.length, video_ids: ids });
});

app.post('/seen', (req, res) => {
  const { video_id, title, channel } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  db.run(
    'INSERT OR IGNORE INTO seen_videos (video_id, seen_at, title, channel) VALUES (?, ?, ?, ?)',
    [video_id, Date.now(), title || null, channel || null]
  );
  saveDb();
  res.json({ ok: true });
});

app.post('/tag', (req, res) => {
  const { video_id, tags, title, channel } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  if (!Array.isArray(tags) || tags.length === 0) {
    return res.status(400).json({ error: 'tags array required' });
  }
  const now          = Date.now();
  const seenSnapshot = getSeenCount();

  for (const rawTag of tags) {
    const tag = String(rawTag).trim().toLowerCase();
    if (!tag) continue;
    db.run(
      'INSERT OR IGNORE INTO tag_actions (video_id, tag, applied_at, title, channel) VALUES (?, ?, ?, ?, ?)',
      [video_id, tag, now, title || null, channel || null]
    );
    if (tag === 'revisit') {
      const existing = db.prepare('SELECT video_id FROM revisit_queue WHERE video_id = ?');
      existing.bind([video_id]);
      const exists = existing.step();
      existing.free();
      if (exists) {
        db.run('UPDATE revisit_queue SET tagged_at = ?, videos_seen_at_tag = ? WHERE video_id = ?', [now, seenSnapshot, video_id]);
      } else {
        db.run('INSERT INTO revisit_queue (video_id, title, channel, tagged_at, videos_seen_at_tag) VALUES (?, ?, ?, ?, ?)', [video_id, title || null, channel || null, now, seenSnapshot]);
      }
    }
  }
  saveDb();
  res.json({ ok: true });
});

app.get('/revisit-eligible', (req, res) => {
  const now       = Date.now();
  const minTagAge = REVISIT_MIN_HOURS * 60 * 60 * 1000;
  const seenCount = getSeenCount();
  const stmt = db.prepare(`SELECT video_id, title, channel, tagged_at, videos_seen_at_tag, last_replayed_at FROM revisit_queue WHERE (? - tagged_at) >= ? AND (? - videos_seen_at_tag) >= ? ORDER BY tagged_at ASC`);
  stmt.bind([now, minTagAge, seenCount, REVISIT_MIN_VIDEOS_SEEN]);
  const eligible = [];
  while (stmt.step()) eligible.push(stmt.getAsObject());
  stmt.free();
  res.json({ eligible, count: eligible.length, now_seen_count: seenCount });
});

app.post('/revisit-played', (req, res) => {
  const { video_id } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  const now       = Date.now();
  const seenCount = getSeenCount();
  db.run('UPDATE revisit_queue SET last_replayed_at = ?, tagged_at = ?, videos_seen_at_tag = ? WHERE video_id = ?', [now, now, seenCount, video_id]);
  saveDb();
  res.json({ ok: true });
});

app.get('/search', async (req, res) => {
  if (!YT_KEY) return res.status(500).json({ error: 'no api key configured on server' });
  let { q, lat, lng, radius } = req.query;
  const wantRandom = req.query.random === 'true';

  let chosenLocation = null;
  if (wantRandom) {
    const pick = randomLand();
    lat = String(pick.lat); lng = String(pick.lng); chosenLocation = pick;
  }
  if (!q && (!lat || !lng)) {
    const pick = randomLand();
    lat = String(pick.lat); lng = String(pick.lng); chosenLocation = pick;
  }

  try {
    const searchUrl = new URL('https://www.googleapis.com/youtube/v3/search');
    searchUrl.searchParams.set('part',       'snippet');
    searchUrl.searchParams.set('type',       'video');
    searchUrl.searchParams.set('maxResults', String(FETCH_N));
    searchUrl.searchParams.set('order',      'date');
    searchUrl.searchParams.set('key',        YT_KEY);
    if (q) searchUrl.searchParams.set('q', q);
    if (lat && lng) {
      searchUrl.searchParams.set('location',       `${lat},${lng}`);
      searchUrl.searchParams.set('locationRadius', radius || '50km');
    }

    const searchResp = await fetch(searchUrl);
    const searchData = await searchResp.json();
    if (searchData.error) return res.status(500).json({ error: searchData.error.message });

    const videoIds = (searchData.items || []).map(i => i.id.videoId).filter(Boolean);
    if (videoIds.length === 0) return res.json({ videos: [], location: chosenLocation });

    const seen     = getSeenSet();
    const freshIds = videoIds.filter(id => !seen.has(id));
    if (freshIds.length === 0) return res.json({ videos: [], location: chosenLocation });

    const videoUrl = new URL('https://www.googleapis.com/youtube/v3/videos');
    videoUrl.searchParams.set('part', 'snippet,statistics,contentDetails');
    videoUrl.searchParams.set('id',   freshIds.join(','));
    videoUrl.searchParams.set('key',  YT_KEY);
    const videoResp = await fetch(videoUrl);
    const videoData = await videoResp.json();

    const englishVideos = (videoData.items || []).filter(isLikelyEnglish);
    if (englishVideos.length === 0) {
      return res.json({ videos: [], location: chosenLocation });
    }

    const channelIds = [...new Set(englishVideos.map(v => v.snippet.channelId))];
    const channelUrl = new URL('https://www.googleapis.com/youtube/v3/channels');
    channelUrl.searchParams.set('part', 'statistics');
    channelUrl.searchParams.set('id',   channelIds.join(','));
    channelUrl.searchParams.set('key',  YT_KEY);
    const channelResp = await fetch(channelUrl);
    const channelData = await channelResp.json();
    const subsByChannel = {};
    (channelData.items || []).forEach(c => {
      subsByChannel[c.id] = parseInt(c.statistics.subscriberCount || '0', 10);
    });

    const filtered = englishVideos.filter(v => {
      const views = parseInt(v.statistics.viewCount || '0', 10);
      const subs  = subsByChannel[v.snippet.channelId] || 0;
      return views < MAX_VIEWS && subs < MAX_SUBS;
    }).map(v => ({
      id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle,
      channel_id: v.snippet.channelId, published: v.snippet.publishedAt,
      duration: v.contentDetails.duration,
      views: parseInt(v.statistics.viewCount || '0', 10),
      subs: subsByChannel[v.snippet.channelId] || 0,
      thumbnail: v.snippet.thumbnails.medium?.url,
      lang: v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || null
    }));

    res.json({ videos: filtered, location: chosenLocation, after_popularity_filter: filtered.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/tag-counts', (req, res) => {
  const stmt = db.prepare('SELECT tag, COUNT(DISTINCT video_id) AS count FROM tag_actions GROUP BY tag ORDER BY count DESC');
  const tags = [];
  while (stmt.step()) tags.push(stmt.getAsObject());
  stmt.free();
  res.json({ tags });
});

app.get('/playlist', (req, res) => {
  const tag = (req.query.tag || '').trim().toLowerCase();
  if (!tag) return res.status(400).json({ error: 'tag param required' });
  const stmt = db.prepare('SELECT DISTINCT video_id, title, channel, MAX(applied_at) AS tagged_at FROM tag_actions WHERE tag = ? GROUP BY video_id ORDER BY tagged_at DESC');
  stmt.bind([tag]);
  const videos = [];
  while (stmt.step()) videos.push(stmt.getAsObject());
  stmt.free();
  res.json({ tag, count: videos.length, videos });
});

app.get('/clip-lists', (req, res) => {
  const stmt = db.prepare('SELECT clip_list, COUNT(*) AS count FROM clips GROUP BY clip_list ORDER BY count DESC');
  const lists = [];
  while (stmt.step()) lists.push(stmt.getAsObject());
  stmt.free();
  res.json({ lists });
});

app.get('/clips', (req, res) => {
  const list = (req.query.list || '').trim().toLowerCase();
  let stmt;
  if (list) {
    stmt = db.prepare('SELECT id, video_id, title, channel, start_sec, end_sec, clip_list, created_at FROM clips WHERE clip_list = ? ORDER BY created_at DESC');
    stmt.bind([list]);
  } else {
    stmt = db.prepare('SELECT id, video_id, title, channel, start_sec, end_sec, clip_list, created_at FROM clips ORDER BY created_at DESC');
  }
  const clips = [];
  while (stmt.step()) clips.push(stmt.getAsObject());
  stmt.free();
  res.json({ list: list || 'all', count: clips.length, clips });
});

app.post('/clip', (req, res) => {
  const { video_id, title, channel, start_sec, end_sec, clip_list } = req.body;
  if (!video_id)  return res.status(400).json({ error: 'video_id required' });
  if (!clip_list) return res.status(400).json({ error: 'clip_list required' });
  if (start_sec == null || end_sec == null) return res.status(400).json({ error: 'start_sec and end_sec required' });
  db.run('INSERT INTO clips (video_id, title, channel, start_sec, end_sec, clip_list, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [video_id, title || null, channel || null, Math.round(start_sec), Math.round(end_sec), String(clip_list).trim().toLowerCase(), Date.now()]);
  saveDb();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  NEW :: sources
//  You add a source by pasting any YouTube channel or playlist URL. The server
//  works out whether it is a channel or a course playlist and stores the id.
// ---------------------------------------------------------------------------

async function ytJson(url) {
  const r = await fetch(url);
  return r.json();
}

// Turn a pasted URL or handle into { kind, ref, title }.
async function resolveSource(raw) {
  const input = String(raw || '').trim();
  if (!input) throw new Error('empty source');

  // A playlist link, e.g. ...list=PLxxxx
  const listMatch = input.match(/[?&]list=([A-Za-z0-9_-]+)/);
  if (listMatch || /^(PL|UU|FL|OL)[A-Za-z0-9_-]+$/.test(input)) {
    const ref = listMatch ? listMatch[1] : input;
    const data = await ytJson(`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${ref}&key=${YT_KEY}`);
    const title = data.items && data.items[0] ? data.items[0].snippet.title : ref;
    return { kind: 'playlist', ref, title };
  }

  // A direct channel id link, e.g. /channel/UCxxxx, or a bare UC id
  const chanMatch = input.match(/\/channel\/(UC[A-Za-z0-9_-]+)/) || input.match(/^(UC[A-Za-z0-9_-]+)$/);
  if (chanMatch) {
    const ref = chanMatch[1];
    const data = await ytJson(`https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${ref}&key=${YT_KEY}`);
    const title = data.items && data.items[0] ? data.items[0].snippet.title : ref;
    return { kind: 'channel', ref, title };
  }

  // A handle, e.g. youtube.com/@mitocw or just @mitocw
  const handleMatch = input.match(/@([A-Za-z0-9._-]+)/);
  if (handleMatch) {
    const data = await ytJson(`https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=${handleMatch[1]}&key=${YT_KEY}`);
    if (data.items && data.items[0]) {
      return { kind: 'channel', ref: data.items[0].id, title: data.items[0].snippet.title };
    }
  }

  // Legacy /user/NAME
  const userMatch = input.match(/\/user\/([^/?]+)/);
  if (userMatch) {
    const data = await ytJson(`https://www.googleapis.com/youtube/v3/channels?part=snippet&forUsername=${userMatch[1]}&key=${YT_KEY}`);
    if (data.items && data.items[0]) {
      return { kind: 'channel', ref: data.items[0].id, title: data.items[0].snippet.title };
    }
  }

  // Last resort: treat the whole string as a channel name search
  const nameQuery = (input.match(/\/c\/([^/?]+)/) || [])[1] || input;
  const search = await ytJson(`https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(nameQuery)}&key=${YT_KEY}`);
  if (search.items && search.items[0]) {
    return { kind: 'channel', ref: search.items[0].id.channelId, title: search.items[0].snippet.title };
  }
  throw new Error('could not resolve that URL to a channel or playlist');
}

app.get('/sources', (req, res) => {
  const genre = cleanGenre(req.query.genre, '');
  let stmt;
  if (genre) {
    stmt = db.prepare("SELECT id, kind, ref, title, COALESCE(genre, 'general') AS genre, added_at FROM sources WHERE COALESCE(genre, 'general') = ? ORDER BY added_at DESC");
    stmt.bind([genre]);
  } else {
    stmt = db.prepare("SELECT id, kind, ref, title, COALESCE(genre, 'general') AS genre, added_at FROM sources ORDER BY added_at DESC");
  }
  const sources = [];
  while (stmt.step()) sources.push(stmt.getAsObject());
  stmt.free();
  res.json({ genres: GENRES, sources });
});

app.post('/sources', async (req, res) => {
  if (!YT_KEY) return res.status(500).json({ error: 'no api key configured on server' });
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  const genre = cleanGenre(req.body.genre, 'general');
  try {
    const { kind, ref, title } = await resolveSource(url);
    db.run('INSERT OR IGNORE INTO sources (kind, ref, title, genre, added_at) VALUES (?, ?, ?, ?, ?)', [kind, ref, title, genre, Date.now()]);
    db.run('UPDATE sources SET genre = ? WHERE kind = ? AND ref = ?', [genre, kind, ref]);
    saveDb();
    res.json({ ok: true, kind, ref, title, genre });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/sources/genre', (req, res) => {
  const { id } = req.body;
  if (id == null) return res.status(400).json({ error: 'id required' });
  const genre = cleanGenre(req.body.genre, 'general');
  db.run('UPDATE sources SET genre = ? WHERE id = ?', [genre, id]);
  saveDb();
  res.json({ ok: true, id, genre });
});

app.get('/genres', (req, res) => {
  res.json({ genres: GENRES });
});

app.post('/sources/remove', (req, res) => {
  const { id } = req.body;
  if (id == null) return res.status(400).json({ error: 'id required' });
  db.run('DELETE FROM sources WHERE id = ?', [id]);
  saveDb();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
//  NEW :: /course
//  Pull one source in order. For a playlist, that is the course order. For a
//  channel, that is its uploads, newest first. Paginated for long courses.
//  No view filter here, because the sources are already curated by you.
// ---------------------------------------------------------------------------

app.get('/course', async (req, res) => {
  if (!YT_KEY) return res.status(500).json({ error: 'no api key configured on server' });
  const sourceId = req.query.source_id;
  const pageToken = req.query.page_token || '';
  if (!sourceId) return res.status(400).json({ error: 'source_id required' });

  const stmt = db.prepare('SELECT id, kind, ref, title FROM sources WHERE id = ?');
  stmt.bind([sourceId]);
  if (!stmt.step()) { stmt.free(); return res.status(404).json({ error: 'source not found' }); }
  const source = stmt.getAsObject();
  stmt.free();

  // A channel's ordered list lives in its uploads playlist: UC... becomes UU...
  const playlistId = source.kind === 'channel' ? 'UU' + source.ref.slice(2) : source.ref;

  try {
    const u = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    u.searchParams.set('part', 'snippet,contentDetails');
    u.searchParams.set('maxResults', '50');
    u.searchParams.set('playlistId', playlistId);
    u.searchParams.set('key', YT_KEY);
    if (pageToken) u.searchParams.set('pageToken', pageToken);

    const data = await ytJson(u);
    if (data.error) return res.status(500).json({ error: data.error.message });

    const videos = (data.items || [])
      .filter(it => it.contentDetails && it.contentDetails.videoId)
      .filter(it => it.snippet && it.snippet.title !== 'Private video' && it.snippet.title !== 'Deleted video')
      .map(it => ({
        id: it.contentDetails.videoId,
        title: it.snippet.title,
        channel: it.snippet.videoOwnerChannelTitle || it.snippet.channelTitle || source.title,
        position: it.snippet.position,
        embeddable: true
      }));

    // Ask YouTube which of these allow embedding. One batched call, up to 50 ids.
    // Videos with embedding off play on YouTube only, so we mark them rather than
    // skip them, and the frontend turns them into an Open in YouTube link.
    if (videos.length) {
      const ids = videos.map(v => v.id).join(',');
      const su = new URL('https://www.googleapis.com/youtube/v3/videos');
      su.searchParams.set('part', 'status');
      su.searchParams.set('id', ids);
      su.searchParams.set('key', YT_KEY);
      const statusData = await ytJson(su);
      const embedById = {};
      (statusData.items || []).forEach(it => { embedById[it.id] = !!(it.status && it.status.embeddable); });
      videos.forEach(v => { if (v.id in embedById) v.embeddable = embedById[v.id]; });
    }

    res.json({
      source: { id: source.id, kind: source.kind, title: source.title },
      total: data.pageInfo ? data.pageInfo.totalResults : videos.length,
      videos,
      nextPageToken: data.nextPageToken || null,
      prevPageToken: data.prevPageToken || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
//  NEW :: /entry and /transcript
//  An entry is what you log at the end of a video. The transcript rolls those
//  entries into buckets and turns them into weighted credits.
// ---------------------------------------------------------------------------

app.post('/entry', (req, res) => {
  const { video_id, title, channel, bucket, status, note, project_link, source_kind, profile } = req.body;
  if (!video_id) return res.status(400).json({ error: 'video_id required' });
  const cleanBucket = String(bucket || '').trim().toLowerCase();
  if (!cleanBucket) return res.status(400).json({ error: 'bucket required' });
  const cleanStatus = VALID_STATUS.includes(status) ? status : 'watched';
  const cleanProfile = String(profile || 'default').trim().toLowerCase() || 'default';
  const genre = cleanGenre(req.body.genre, 'general');

  db.run(
    `INSERT INTO entries (video_id, title, channel, bucket, status, note, project_link, source_kind, profile, genre, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [video_id, title || null, channel || null, cleanBucket, cleanStatus,
     (note || '').trim() || null, (project_link || '').trim() || null, source_kind || null, cleanProfile, genre, Date.now()]
  );
  saveDb();
  res.json({ ok: true, bucket: cleanBucket, status: cleanStatus, profile: cleanProfile, genre });
});

function pointsFor(r) {
  return r.watched  * STATUS_POINTS.watched
       + r.followed * STATUS_POINTS.followed
       + r.built    * STATUS_POINTS.built
       + r.blocked  * STATUS_POINTS.blocked;
}

app.get('/transcript', (req, res) => {
  const profile = String(req.query.profile || 'default').trim().toLowerCase() || 'default';
  const genreFilter = cleanGenre(req.query.genre, '');
  // Rows saved before profiles or genres existed count as 'default' and 'general'.
  let sql = `
    SELECT COALESCE(genre, 'general') AS genre,
           bucket,
           COUNT(*) AS videos,
           SUM(CASE status WHEN 'watched'  THEN 1 ELSE 0 END) AS watched,
           SUM(CASE status WHEN 'followed' THEN 1 ELSE 0 END) AS followed,
           SUM(CASE status WHEN 'built'    THEN 1 ELSE 0 END) AS built,
           SUM(CASE status WHEN 'blocked'  THEN 1 ELSE 0 END) AS blocked
    FROM entries WHERE COALESCE(profile, 'default') = ?`;
  const params = [profile];
  if (genreFilter) { sql += " AND COALESCE(genre, 'general') = ?"; params.push(genreFilter); }
  sql += ' GROUP BY COALESCE(genre, \'general\'), bucket';
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  const buckets = rows.map(r => {
    const points = pointsFor(r);
    return {
      genre: r.genre,
      bucket: r.bucket,
      videos: r.videos,
      watched: r.watched, followed: r.followed, built: r.built, blocked: r.blocked,
      points,
      credits: Math.floor(points / CREDIT_POINTS),
      toward_next: points % CREDIT_POINTS
    };
  }).sort((a, b) => b.points - a.points);

  // Totals per genre, so the transcript can show credits by field of study.
  const byGenre = {};
  buckets.forEach(b => {
    if (!byGenre[b.genre]) byGenre[b.genre] = { genre: b.genre, videos: 0, built: 0, points: 0 };
    byGenre[b.genre].videos += b.videos;
    byGenre[b.genre].built  += b.built;
    byGenre[b.genre].points += b.points;
  });
  const genres = Object.values(byGenre).map(g => ({
    ...g, credits: Math.floor(g.points / CREDIT_POINTS), toward_next: g.points % CREDIT_POINTS
  })).sort((a, b) => b.points - a.points);

  res.json({ profile, genre: genreFilter || 'all', credit_points: CREDIT_POINTS, status_points: STATUS_POINTS, genres, buckets });
});

app.get('/entries', (req, res) => {
  const profile = String(req.query.profile || 'default').trim().toLowerCase() || 'default';
  const bucket = (req.query.bucket || '').trim().toLowerCase();
  const genreFilter = cleanGenre(req.query.genre, '');
  let sql = "SELECT id, video_id, title, channel, bucket, status, note, project_link, COALESCE(genre, 'general') AS genre, created_at FROM entries WHERE COALESCE(profile, 'default') = ?";
  const params = [profile];
  if (bucket) { sql += ' AND bucket = ?'; params.push(bucket); }
  if (genreFilter) { sql += " AND COALESCE(genre, 'general') = ?"; params.push(genreFilter); }
  sql += ' ORDER BY created_at DESC';
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const entries = [];
  while (stmt.step()) entries.push(stmt.getAsObject());
  stmt.free();
  res.json({ profile, bucket: bucket || 'all', genre: genreFilter || 'all', count: entries.length, entries });
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  app.listen(PORT, () => console.log(`campus backend on :${PORT}`));
});
