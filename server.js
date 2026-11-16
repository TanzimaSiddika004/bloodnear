const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { db, initDb, expireRequests, notify } = require('./src/db');
const { hashPassword, verifyPassword, getSession, sessionCookie, clearSessionCookie } = require('./src/auth');
const { BLOOD_GROUPS, uid, nowIso, haversineKm, requestMatchScore, publicUser } = require('./src/utils');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024;
const sseClients = new Map();
const rateBuckets = new Map();

initDb();

function json(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  res.end(body);
}

function error(res, status, message, details) {
  return json(res, status, { error: message, ...(details ? { details } : {}) });
}

async function readJson(req) {
  if (req && req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
      if (!req.body.trim()) return {};
      try { return JSON.parse(req.body); }
      catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
    }
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('Request body too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}

function normalizeEmail(v) { return String(v || '').trim().toLowerCase(); }
function clean(v, max = 500) { return String(v || '').trim().slice(0, max); }
function number(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function validBlood(v) { return BLOOD_GROUPS.includes(v); }
function validLatLng(lat, lng) { return Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180; }
function isEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }

function userFromRequest(req) {
  const session = getSession(req);
  if (!session?.uid) return null;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(session.uid);
  if (!user || user.status !== 'ACTIVE') return null;
  return user;
}

function requireUser(req, res) {
  const user = userFromRequest(req);
  if (!user) {
    error(res, 401, 'Authentication required');
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireUser(req, res);
  if (!user) return null;
  if (user.role !== 'ADMIN') {
    error(res, 403, 'Admin access required');
    return null;
  }
  return user;
}

function rateLimit(req, res, key, limit, windowMs) {
  const forwarded = req.headers?.['x-forwarded-for'];
  const ip = (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) || req.socket?.remoteAddress || 'unknown';
  const bucketKey = `${key}:${ip}`;
  const now = Date.now();
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count++;
  rateBuckets.set(bucketKey, bucket);
  if (bucket.count > limit) {
    error(res, 429, 'Too many requests. Please try again shortly.');
    return false;
  }
  return true;
}

function routeMatch(pathname, pattern) {
  const p = pathname.split('/').filter(Boolean);
  const s = pattern.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const params = {};
  for (let i = 0; i < s.length; i++) {
    if (s[i].startsWith(':')) params[s[i].slice(1)] = decodeURIComponent(p[i]);
    else if (s[i] !== p[i]) return null;
  }
  return params;
}

function serializeRequest(row, viewer = null, lat = null, lng = null) {
  let distance = null;
  let score = null;
  if (validLatLng(lat, lng)) {
    distance = haversineKm(lat, lng, row.lat, row.lng);
    score = requestMatchScore(row, distance);
  }
  return {
    id: row.id,
    bloodGroup: row.blood_group,
    requiredUnits: row.required_units,
    hospitalName: row.hospital_name,
    area: row.area,
    lat: row.lat,
    lng: row.lng,
    urgency: row.urgency,
    neededBy: row.needed_by,
    description: row.description,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    requester: {
      id: row.requester_id,
      name: row.requester_name,
      bloodGroup: row.requester_blood_group,
      area: row.requester_area,
      isVerified: Boolean(row.requester_verified)
    },
    responseCount: Number(row.response_count || 0),
    myResponseStatus: row.my_response_status || null,
    distanceKm: distance == null ? null : Number(distance.toFixed(2)),
    matchScore: score,
    isOwner: viewer ? viewer.id === row.requester_id : false
  };
}

function baseRequestQuery(viewerId = null) {
  return `SELECT br.*, u.name AS requester_name, u.blood_group AS requester_blood_group, u.area AS requester_area,
    u.is_verified AS requester_verified,
    (SELECT COUNT(*) FROM responses rr WHERE rr.request_id=br.id AND rr.status IN ('INTERESTED','ACCEPTED','COMPLETED')) AS response_count,
    ${viewerId ? `(SELECT status FROM responses mr WHERE mr.request_id=br.id AND mr.donor_id='${String(viewerId).replaceAll("'", "''")}')` : 'NULL'} AS my_response_status
    FROM blood_requests br JOIN users u ON u.id=br.requester_id`;
}

function emitTo(userId, event) {
  const set = sseClients.get(userId);
  if (!set) return;
  const payload = `event: notification\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of set) {
    try { res.write(payload); } catch { set.delete(res); }
  }
}

function pushNotification(userId, type, title, message, link = null) {
  const id = notify(userId, type, title, message, link);
  emitTo(userId, { id, type, title, message, link, createdAt: nowIso() });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  rel = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
  };
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'geolocation=(self)',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600'
  });
  res.end(body);
  return true;
}

function validateRequestInput(body, partial = false) {
  const out = {};
  if (!partial || body.bloodGroup !== undefined) {
    if (!validBlood(body.bloodGroup)) return { error: 'Choose a valid blood group.' };
    out.blood_group = body.bloodGroup;
  }
  if (!partial || body.requiredUnits !== undefined) {
    const units = Number(body.requiredUnits);
    if (!Number.isInteger(units) || units < 1 || units > 20) return { error: 'Required units must be between 1 and 20.' };
    out.required_units = units;
  }
  if (!partial || body.area !== undefined) {
    const area = clean(body.area, 120);
    if (area.length < 2) return { error: 'Location/area is required.' };
    out.area = area;
  }
  if (!partial || body.lat !== undefined || body.lng !== undefined) {
    const lat = number(body.lat); const lng = number(body.lng);
    if (!validLatLng(lat, lng)) return { error: 'Valid latitude and longitude are required.' };
    out.lat = lat; out.lng = lng;
  }
  if (!partial || body.neededBy !== undefined) {
    const date = new Date(body.neededBy);
    if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return { error: 'Needed-by time must be in the future.' };
    out.needed_by = date.toISOString();
  }
  if (!partial || body.urgency !== undefined) {
    if (!['NORMAL','EMERGENCY'].includes(body.urgency)) return { error: 'Invalid urgency.' };
    out.urgency = body.urgency;
  }
  if (body.hospitalName !== undefined || !partial) out.hospital_name = clean(body.hospitalName, 140) || null;
  if (body.description !== undefined || !partial) out.description = clean(body.description, 700) || null;
  if (body.contactPreference !== undefined || !partial) {
    const cp = body.contactPreference || 'AFTER_ACCEPT';
    if (!['AFTER_ACCEPT','MESSAGE_ONLY'].includes(cp)) return { error: 'Invalid contact preference.' };
    out.contact_preference = cp;
  }
  return { data: out };
}

async function handleApi(req, res, url) {
  expireRequests();
  const method = req.method || 'GET';
  const pathname = url.pathname;
  const viewer = userFromRequest(req);

  if (method === 'GET' && (pathname === '/api/health' || pathname === '/api' || pathname === '/api/')) {
    return json(res, 200, { ok: true, service: 'BloodNear Community API', version: '2.0.0', time: nowIso() });
  }

  if (method === 'POST' && pathname === '/api/auth/register') {
    if (!rateLimit(req, res, 'register', 12, 15 * 60 * 1000)) return;
    const body = await readJson(req);
    const name = clean(body.name, 80);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const bloodGroup = body.bloodGroup;
    const area = clean(body.area, 120);
    const lat = number(body.lat); const lng = number(body.lng);
    if (name.length < 2) return error(res, 400, 'Name must be at least 2 characters.');
    if (!isEmail(email)) return error(res, 400, 'Enter a valid email address.');
    if (password.length < 8) return error(res, 400, 'Password must be at least 8 characters.');
    if (!validBlood(bloodGroup)) return error(res, 400, 'Choose a valid blood group.');
    if (!area || !validLatLng(lat, lng)) return error(res, 400, 'A valid general location is required.');
    if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) return error(res, 409, 'An account with this email already exists.');
    const id = uid('u-');
    db.prepare(`INSERT INTO users(id,name,email,password_hash,blood_group,phone,area,lat,lng,is_verified,role,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,0,'USER','ACTIVE',?)`)
      .run(id, name, email, hashPassword(password), bloodGroup, clean(body.phone, 30) || null, area, lat, lng, nowIso());
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    return json(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(id) });
  }

  if (method === 'POST' && pathname === '/api/auth/login') {
    if (!rateLimit(req, res, 'login', 20, 15 * 60 * 1000)) return;
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) return error(res, 401, 'Invalid email or password.');
    if (user.status !== 'ACTIVE') return error(res, 403, 'This account is suspended.');
    return json(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(user.id) });
  }

  if (method === 'POST' && pathname === '/api/auth/logout') {
    return json(res, 200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
  }

  if (method === 'GET' && pathname === '/api/auth/me') {
    if (!viewer) return json(res, 200, { user: null });
    const unread = db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id=? AND is_read=0').get(viewer.id).c;
    const availability = db.prepare('SELECT * FROM donor_availability WHERE user_id=?').get(viewer.id) || null;
    return json(res, 200, {
      user: { ...publicUser(viewer), email: viewer.email, phone: viewer.phone, status: viewer.status, unreadNotifications: Number(unread), availability }
    });
  }

  if (method === 'GET' && pathname === '/api/events') {
    const user = requireUser(req, res); if (!user) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    if (!sseClients.has(user.id)) sseClients.set(user.id, new Set());
    sseClients.get(user.id).add(res);
    const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch {} }, 25000);
    let serverlessTimeout = null;
    if (process.env.VERCEL) {
      serverlessTimeout = setTimeout(() => { try { res.end(); } catch {} }, 9500);
    }
    req.on('close', () => {
      clearInterval(heartbeat);
      if (serverlessTimeout) clearTimeout(serverlessTimeout);
      sseClients.get(user.id)?.delete(res);
      if (sseClients.get(user.id)?.size === 0) sseClients.delete(user.id);
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/stats') {
    const activeRequests = db.prepare(`SELECT COUNT(*) AS c FROM blood_requests WHERE status IN ('OPEN','MATCHED')`).get().c;
    const emergency = db.prepare(`SELECT COUNT(*) AS c FROM blood_requests WHERE status IN ('OPEN','MATCHED') AND urgency='EMERGENCY'`).get().c;
    const donors = db.prepare(`SELECT COUNT(*) AS c FROM donor_availability WHERE status='ACTIVE' AND available_until >= ?`).get(nowIso()).c;
    const fulfilled = db.prepare(`SELECT COUNT(*) AS c FROM blood_requests WHERE status='FULFILLED'`).get().c;
    const users = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE status='ACTIVE'`).get().c;
    return json(res, 200, { activeRequests: Number(activeRequests), emergencyRequests: Number(emergency), activeDonors: Number(donors), fulfilledRequests: Number(fulfilled), members: Number(users) });
  }

  if (method === 'GET' && pathname === '/api/requests') {
    const group = url.searchParams.get('bloodGroup');
    const status = url.searchParams.get('status') || 'ACTIVE';
    const urgency = url.searchParams.get('urgency');
    const mine = url.searchParams.get('mine') === '1';
    const lat = number(url.searchParams.get('lat')); const lng = number(url.searchParams.get('lng'));
    const radius = Math.min(100, Math.max(1, number(url.searchParams.get('radius')) || 25));
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 40)));
    const conditions = [];
    const args = [];
    if (group && validBlood(group)) { conditions.push('br.blood_group=?'); args.push(group); }
    if (urgency && ['NORMAL','EMERGENCY'].includes(urgency)) { conditions.push('br.urgency=?'); args.push(urgency); }
    if (mine) {
      if (!viewer) return error(res, 401, 'Authentication required');
      conditions.push('br.requester_id=?'); args.push(viewer.id);
    } else if (status === 'ACTIVE') conditions.push(`br.status IN ('OPEN','MATCHED')`);
    else if (['OPEN','MATCHED','FULFILLED','CANCELLED','EXPIRED'].includes(status)) { conditions.push('br.status=?'); args.push(status); }
    const sql = `${baseRequestQuery(viewer?.id)} ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY br.created_at DESC LIMIT ?`;
    args.push(limit * 3);
    let rows = db.prepare(sql).all(...args).map(r => serializeRequest(r, viewer, lat, lng));
    if (validLatLng(lat, lng)) rows = rows.filter(r => r.distanceKm <= radius).sort((a,b) => (b.matchScore ?? 0) - (a.matchScore ?? 0) || a.distanceKm - b.distanceKm);
    rows = rows.slice(0, limit);
    if (validLatLng(lat, lng)) db.prepare(`INSERT INTO search_history(id,user_id,blood_group,lat,lng,radius,result_count,searched_at) VALUES(?,?,?,?,?,?,?,?)`)
      .run(uid('s-'), viewer?.id || null, group || null, lat, lng, radius, rows.length, nowIso());
    return json(res, 200, { requests: rows, count: rows.length });
  }

  if (method === 'POST' && pathname === '/api/requests') {
    const user = requireUser(req, res); if (!user) return;
    if (!rateLimit(req, res, `post:${user.id}`, 15, 60 * 60 * 1000)) return;
    const body = await readJson(req);
    const validation = validateRequestInput(body, false);
    if (validation.error) return error(res, 400, validation.error);
    const v = validation.data;
    const id = uid('r-');
    const created = nowIso();
    const neededTime = new Date(v.needed_by).getTime();
    const requestedExpiry = body.expiresAt ? new Date(body.expiresAt).getTime() : neededTime + 2 * 60 * 60 * 1000;
    const expiresAt = new Date(Math.max(neededTime, requestedExpiry)).toISOString();
    db.prepare(`INSERT INTO blood_requests(id,requester_id,blood_group,required_units,hospital_name,area,lat,lng,urgency,needed_by,description,contact_preference,status,expires_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'OPEN',?,?,?)`)
      .run(id, user.id, v.blood_group, v.required_units, v.hospital_name, v.area, v.lat, v.lng, v.urgency, v.needed_by, v.description, v.contact_preference, expiresAt, created, created);

    const nearby = db.prepare(`SELECT da.user_id, da.area, da.lat, da.lng FROM donor_availability da JOIN users u ON u.id=da.user_id
      WHERE da.status='ACTIVE' AND da.available_until>=? AND da.blood_group=? AND da.user_id<>? AND u.status='ACTIVE'`).all(created, v.blood_group, user.id);
    for (const donor of nearby) {
      const dist = haversineKm(v.lat, v.lng, donor.lat, donor.lng);
      if (dist <= 20) pushNotification(donor.user_id, 'MATCHING_REQUEST', `New ${v.blood_group} request nearby`, `${v.urgency === 'EMERGENCY' ? 'Emergency request' : 'Blood request'} about ${dist.toFixed(1)} km from your availability location.`, `#request=${id}`);
    }
    const row = db.prepare(`${baseRequestQuery(user.id)} WHERE br.id=?`).get(id);
    return json(res, 201, { request: serializeRequest(row, user) });
  }

  let params = routeMatch(pathname, '/api/requests/:id');
  if (params && method === 'GET') {
    const row = db.prepare(`${baseRequestQuery(viewer?.id)} WHERE br.id=?`).get(params.id);
    if (!row) return error(res, 404, 'Request not found');
    const result = serializeRequest(row, viewer);
    if (viewer) {
      const accepted = db.prepare(`SELECT r.*, u.name donor_name, u.email donor_email, u.phone donor_phone FROM responses r JOIN users u ON u.id=r.donor_id WHERE r.request_id=? AND r.status IN ('ACCEPTED','COMPLETED')`).all(params.id);
      if (viewer.id === row.requester_id) result.acceptedConnections = accepted.map(a => ({ responseId: a.id, donorId: a.donor_id, name: a.donor_name, email: a.donor_email, phone: a.donor_phone, status: a.status }));
      else {
        const mine = accepted.find(a => a.donor_id === viewer.id);
        if (mine) {
          const requester = db.prepare('SELECT name,email,phone FROM users WHERE id=?').get(row.requester_id);
          result.connection = { requesterName: requester.name, email: requester.email, phone: requester.phone, status: mine.status };
        }
      }
    }
    return json(res, 200, { request: result });
  }

  if (params && method === 'PATCH') {
    const user = requireUser(req, res); if (!user) return;
    const existing = db.prepare('SELECT * FROM blood_requests WHERE id=?').get(params.id);
    if (!existing) return error(res, 404, 'Request not found');
    if (existing.requester_id !== user.id && user.role !== 'ADMIN') return error(res, 403, 'You cannot edit this request.');
    const body = await readJson(req);
    const allowedStatus = ['OPEN','FULFILLED','CANCELLED'];
    if (body.status !== undefined) {
      if (!allowedStatus.includes(body.status)) return error(res, 400, 'Invalid status transition.');
      db.prepare('UPDATE blood_requests SET status=?, updated_at=? WHERE id=?').run(body.status, nowIso(), params.id);
      if (body.status === 'FULFILLED') {
        db.prepare(`UPDATE responses SET status='COMPLETED', updated_at=? WHERE request_id=? AND status='ACCEPTED'`).run(nowIso(), params.id);
        const connected = db.prepare(`SELECT donor_id FROM responses WHERE request_id=? AND status='COMPLETED'`).all(params.id);
        for (const r of connected) pushNotification(r.donor_id, 'REQUEST_FULFILLED', 'Request marked fulfilled', 'The requester marked the blood request as fulfilled. Thank you for responding.', `#request=${params.id}`);
      }
    }
    const editableKeys = ['bloodGroup','requiredUnits','hospitalName','area','lat','lng','urgency','neededBy','description','contactPreference'];
    if (editableKeys.some(k => body[k] !== undefined)) {
      if (!['OPEN','MATCHED'].includes(existing.status)) return error(res, 409, 'Closed requests cannot be edited.');
      const validation = validateRequestInput(body, true);
      if (validation.error) return error(res, 400, validation.error);
      const data = validation.data;
      const map = { blood_group:'blood_group', required_units:'required_units', hospital_name:'hospital_name', area:'area', lat:'lat', lng:'lng', urgency:'urgency', needed_by:'needed_by', description:'description', contact_preference:'contact_preference' };
      const sets = Object.keys(data).map(k => `${map[k]}=?`);
      if (sets.length) db.prepare(`UPDATE blood_requests SET ${sets.join(',')}, updated_at=? WHERE id=?`).run(...Object.values(data), nowIso(), params.id);
    }
    const row = db.prepare(`${baseRequestQuery(user.id)} WHERE br.id=?`).get(params.id);
    return json(res, 200, { request: serializeRequest(row, user) });
  }

  params = routeMatch(pathname, '/api/requests/:id/respond');
  if (params && method === 'POST') {
    const user = requireUser(req, res); if (!user) return;
    const request = db.prepare('SELECT * FROM blood_requests WHERE id=?').get(params.id);
    if (!request) return error(res, 404, 'Request not found');
    if (!['OPEN','MATCHED'].includes(request.status)) return error(res, 409, 'This request is no longer accepting responses.');
    if (request.requester_id === user.id) return error(res, 400, 'You cannot respond to your own request.');
    if (user.blood_group !== request.blood_group) return error(res, 400, 'For safety, this prototype only allows exact registered blood-group matches. Medical eligibility must still be confirmed by healthcare professionals.');
    const body = await readJson(req);
    const id = uid('resp-');
    const existing = db.prepare('SELECT * FROM responses WHERE request_id=? AND donor_id=?').get(params.id, user.id);
    if (existing) {
      if (['DECLINED','CANCELLED'].includes(existing.status)) {
        db.prepare(`UPDATE responses SET status='INTERESTED', message=?, updated_at=? WHERE id=?`).run(clean(body.message, 300) || null, nowIso(), existing.id);
      } else return error(res, 409, 'You already responded to this request.');
    } else {
      db.prepare(`INSERT INTO responses(id,request_id,donor_id,status,message,created_at,updated_at) VALUES(?,?,?,'INTERESTED',?,?,?)`)
        .run(id, params.id, user.id, clean(body.message, 300) || null, nowIso(), nowIso());
    }
    pushNotification(request.requester_id, 'DONOR_INTERESTED', `${user.name} can donate ${request.blood_group}`, `${user.name} responded to your blood request. Review the response before sharing contact details.`, `#request=${params.id}`);
    return json(res, 201, { ok: true });
  }

  params = routeMatch(pathname, '/api/requests/:id/responses');
  if (params && method === 'GET') {
    const user = requireUser(req, res); if (!user) return;
    const request = db.prepare('SELECT * FROM blood_requests WHERE id=?').get(params.id);
    if (!request) return error(res, 404, 'Request not found');
    if (request.requester_id !== user.id && user.role !== 'ADMIN') return error(res, 403, 'Only the requester can view responses.');
    const responses = db.prepare(`SELECT r.*, u.name, u.blood_group, u.area, u.is_verified, u.email, u.phone FROM responses r JOIN users u ON u.id=r.donor_id WHERE r.request_id=? ORDER BY r.created_at DESC`).all(params.id)
      .map(r => ({ id:r.id, status:r.status, message:r.message, createdAt:r.created_at, donor:{ id:r.donor_id, name:r.name, bloodGroup:r.blood_group, area:r.area, isVerified:Boolean(r.is_verified), ...(r.status==='ACCEPTED'||r.status==='COMPLETED'?{email:r.email,phone:r.phone}:{}) } }));
    return json(res, 200, { responses });
  }

  params = routeMatch(pathname, '/api/responses/:id');
  if (params && method === 'PATCH') {
    const user = requireUser(req, res); if (!user) return;
    const response = db.prepare(`SELECT r.*, br.requester_id, br.blood_group, br.status request_status FROM responses r JOIN blood_requests br ON br.id=r.request_id WHERE r.id=?`).get(params.id);
    if (!response) return error(res, 404, 'Response not found');
    const body = await readJson(req);
    const desired = body.status;
    if (user.id === response.requester_id) {
      if (!['ACCEPTED','DECLINED'].includes(desired)) return error(res, 400, 'Requester may accept or decline a response.');
      if (!['OPEN','MATCHED'].includes(response.request_status)) return error(res, 409, 'Request is closed.');
      db.prepare('UPDATE responses SET status=?, updated_at=? WHERE id=?').run(desired, nowIso(), params.id);
      if (desired === 'ACCEPTED') {
        db.prepare(`UPDATE blood_requests SET status='MATCHED', updated_at=? WHERE id=?`).run(nowIso(), response.request_id);
        pushNotification(response.donor_id, 'RESPONSE_ACCEPTED', 'Your donor response was accepted', `Your response for ${response.blood_group} was accepted. Contact details are now available in the request.`, `#request=${response.request_id}`);
      } else pushNotification(response.donor_id, 'RESPONSE_DECLINED', 'Donor response update', 'The requester declined this response. You can continue browsing other requests.', `#request=${response.request_id}`);
    } else if (user.id === response.donor_id) {
      if (desired !== 'CANCELLED') return error(res, 400, 'Donor may only cancel their response.');
      if (response.status === 'COMPLETED') return error(res, 409, 'Completed responses cannot be cancelled.');
      db.prepare(`UPDATE responses SET status='CANCELLED', updated_at=? WHERE id=?`).run(nowIso(), params.id);
      pushNotification(response.requester_id, 'RESPONSE_CANCELLED', 'Donor response cancelled', 'A donor cancelled their response to your request.', `#request=${response.request_id}`);
    } else return error(res, 403, 'You cannot update this response.');
    return json(res, 200, { ok: true });
  }

  if (method === 'GET' && pathname === '/api/donors') {
    const group = url.searchParams.get('bloodGroup');
    const lat = number(url.searchParams.get('lat')); const lng = number(url.searchParams.get('lng'));
    const radius = Math.min(100, Math.max(1, number(url.searchParams.get('radius')) || 25));
    const args = [nowIso()];
    let where = `da.status='ACTIVE' AND da.available_until>=? AND u.status='ACTIVE'`;
    if (group && validBlood(group)) { where += ' AND da.blood_group=?'; args.push(group); }
    let donors = db.prepare(`SELECT da.*, u.name, u.is_verified, u.created_at FROM donor_availability da JOIN users u ON u.id=da.user_id WHERE ${where} ORDER BY da.updated_at DESC LIMIT 150`).all(...args)
      .map(r => ({ id:r.user_id, name:r.name, bloodGroup:r.blood_group, area:r.area, lat:r.lat, lng:r.lng, availableUntil:r.available_until, note:r.note, isVerified:Boolean(r.is_verified), updatedAt:r.updated_at,
        distanceKm: validLatLng(lat,lng) ? Number(haversineKm(lat,lng,r.lat,r.lng).toFixed(2)) : null }))
      .filter(d => d.distanceKm == null || d.distanceKm <= radius)
      .sort((a,b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0));
    return json(res, 200, { donors, count: donors.length });
  }

  if (method === 'PUT' && pathname === '/api/donor-availability') {
    const user = requireUser(req, res); if (!user) return;
    const body = await readJson(req);
    const bloodGroup = body.bloodGroup || user.blood_group;
    const area = clean(body.area || user.area, 120);
    const lat = number(body.lat ?? user.lat); const lng = number(body.lng ?? user.lng);
    const until = new Date(body.availableUntil);
    if (!validBlood(bloodGroup) || bloodGroup !== user.blood_group) return error(res, 400, 'Availability must use your registered blood group.');
    if (!validLatLng(lat,lng)) return error(res, 400, 'A valid location is required.');
    if (Number.isNaN(until.getTime()) || until.getTime() <= Date.now() || until.getTime() > Date.now()+14*24*60*60*1000) return error(res, 400, 'Availability end time must be within the next 14 days.');
    db.prepare(`INSERT INTO donor_availability(user_id,blood_group,area,lat,lng,available_until,status,note,updated_at) VALUES(?,?,?,?,?,?,'ACTIVE',?,?)
      ON CONFLICT(user_id) DO UPDATE SET blood_group=excluded.blood_group,area=excluded.area,lat=excluded.lat,lng=excluded.lng,available_until=excluded.available_until,status='ACTIVE',note=excluded.note,updated_at=excluded.updated_at`)
      .run(user.id,bloodGroup,area,lat,lng,until.toISOString(),clean(body.note,240)||null,nowIso());
    return json(res, 200, { availability: db.prepare('SELECT * FROM donor_availability WHERE user_id=?').get(user.id) });
  }

  if (method === 'DELETE' && pathname === '/api/donor-availability') {
    const user = requireUser(req, res); if (!user) return;
    db.prepare(`UPDATE donor_availability SET status='PAUSED', updated_at=? WHERE user_id=?`).run(nowIso(), user.id);
    return json(res, 200, { ok: true });
  }

  params = routeMatch(pathname, '/api/requests/:id/matches');
  if (params && method === 'GET') {
    const user = requireUser(req, res); if (!user) return;
    const request = db.prepare('SELECT * FROM blood_requests WHERE id=?').get(params.id);
    if (!request) return error(res, 404, 'Request not found');
    if (request.requester_id !== user.id && user.role !== 'ADMIN') return error(res, 403, 'Only the requester can view suggested donors.');
    const donors = db.prepare(`SELECT da.*, u.name, u.is_verified FROM donor_availability da JOIN users u ON u.id=da.user_id WHERE da.status='ACTIVE' AND da.available_until>=? AND da.blood_group=? AND u.status='ACTIVE' AND u.id<>?`).all(nowIso(), request.blood_group, user.id)
      .map(r => ({ id:r.user_id,name:r.name,bloodGroup:r.blood_group,area:r.area,isVerified:Boolean(r.is_verified),availableUntil:r.available_until,note:r.note,distanceKm:Number(haversineKm(request.lat,request.lng,r.lat,r.lng).toFixed(2)) }))
      .sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,30);
    return json(res, 200, { donors });
  }

  if (method === 'GET' && pathname === '/api/notifications') {
    const user = requireUser(req, res); if (!user) return;
    const notifications = db.prepare(`SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 80`).all(user.id)
      .map(n => ({ id:n.id,type:n.type,title:n.title,message:n.message,link:n.link,isRead:Boolean(n.is_read),createdAt:n.created_at }));
    return json(res, 200, { notifications });
  }

  params = routeMatch(pathname, '/api/notifications/:id/read');
  if (params && method === 'POST') {
    const user = requireUser(req, res); if (!user) return;
    db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?').run(params.id, user.id);
    return json(res, 200, { ok:true });
  }

  if (method === 'POST' && pathname === '/api/notifications/read-all') {
    const user = requireUser(req, res); if (!user) return;
    db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(user.id);
    return json(res, 200, { ok:true });
  }

  if (method === 'POST' && pathname === '/api/reports') {
    const user = requireUser(req, res); if (!user) return;
    const body = await readJson(req);
    if (!['REQUEST','USER'].includes(body.targetType)) return error(res, 400, 'Invalid report target.');
    const reason = clean(body.reason, 500);
    if (reason.length < 5) return error(res, 400, 'Please provide a short reason.');
    db.prepare(`INSERT INTO reports(id,reporter_id,target_type,target_id,reason,status,created_at) VALUES(?,?,?,?,?,'OPEN',?)`).run(uid('rep-'),user.id,body.targetType,clean(body.targetId,100),reason,nowIso());
    return json(res, 201, { ok:true });
  }

  if (method === 'GET' && pathname === '/api/admin/overview') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const overview = {
      users: Number(db.prepare('SELECT COUNT(*) c FROM users').get().c),
      activeRequests: Number(db.prepare(`SELECT COUNT(*) c FROM blood_requests WHERE status IN ('OPEN','MATCHED')`).get().c),
      activeDonors: Number(db.prepare(`SELECT COUNT(*) c FROM donor_availability WHERE status='ACTIVE' AND available_until>=?`).get(nowIso()).c),
      fulfilled: Number(db.prepare(`SELECT COUNT(*) c FROM blood_requests WHERE status='FULFILLED'`).get().c),
      openReports: Number(db.prepare(`SELECT COUNT(*) c FROM reports WHERE status='OPEN'`).get().c),
      searches: Number(db.prepare('SELECT COUNT(*) c FROM search_history').get().c)
    };
    overview.bloodDemand = db.prepare(`SELECT blood_group bloodGroup, COUNT(*) count FROM blood_requests GROUP BY blood_group ORDER BY count DESC`).all();
    overview.recentRequests = db.prepare(`${baseRequestQuery(admin.id)} ORDER BY br.created_at DESC LIMIT 8`).all().map(r=>serializeRequest(r,admin));
    return json(res, 200, { overview });
  }

  if (method === 'GET' && pathname === '/api/admin/users') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const users = db.prepare(`SELECT id,name,email,blood_group,area,is_verified,role,status,created_at FROM users ORDER BY created_at DESC LIMIT 200`).all().map(u=>({id:u.id,name:u.name,email:u.email,bloodGroup:u.blood_group,area:u.area,isVerified:Boolean(u.is_verified),role:u.role,status:u.status,createdAt:u.created_at}));
    return json(res, 200, { users });
  }

  params = routeMatch(pathname, '/api/admin/users/:id/status');
  if (params && method === 'PATCH') {
    const admin = requireAdmin(req, res); if (!admin) return;
    if (params.id === admin.id) return error(res, 400, 'You cannot suspend your own admin account.');
    const body = await readJson(req);
    if (!['ACTIVE','SUSPENDED'].includes(body.status)) return error(res, 400, 'Invalid account status.');
    db.prepare('UPDATE users SET status=? WHERE id=?').run(body.status, params.id);
    return json(res, 200, { ok:true });
  }

  if (method === 'GET' && pathname === '/api/admin/reports') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const reports = db.prepare(`SELECT r.*, u.name reporter_name FROM reports r JOIN users u ON u.id=r.reporter_id ORDER BY r.created_at DESC LIMIT 200`).all().map(r=>({id:r.id,targetType:r.target_type,targetId:r.target_id,reason:r.reason,status:r.status,createdAt:r.created_at,reporter:r.reporter_name}));
    return json(res, 200, { reports });
  }

  params = routeMatch(pathname, '/api/admin/reports/:id');
  if (params && method === 'PATCH') {
    const admin = requireAdmin(req, res); if (!admin) return;
    const body = await readJson(req);
    if (!['RESOLVED','DISMISSED'].includes(body.status)) return error(res, 400, 'Invalid report status.');
    db.prepare('UPDATE reports SET status=? WHERE id=?').run(body.status, params.id);
    return json(res, 200, { ok:true });
  }

  return error(res, 404, 'API route not found');
}

async function handleRequest(req, res) {
  let rawUrl = req.url || '/';
  if (rawUrl.includes('__url=')) {
    try {
      const dummy = new URL(rawUrl, 'http://localhost');
      const originalPath = dummy.searchParams.get('__url');
      dummy.searchParams.delete('__url');
      const remainingSearch = dummy.searchParams.toString();
      rawUrl = originalPath + (remainingSearch ? '?' + remainingSearch : '');
    } catch {}
  }
  const url = new URL(rawUrl, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/') || url.pathname === '/api') return await handleApi(req, res, url);
    if (serveStatic(req, res, url.pathname)) return;
    if (req.method === 'GET' && !path.extname(url.pathname)) return serveStatic(req, res, '/');
    return error(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) return error(res, err.status || 500, err.status ? err.message : 'Internal server error');
    try { res.end(); } catch {}
  }
}

const server = http.createServer(handleRequest);

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`BloodNear Community running on http://localhost:${PORT}`);
    if (!process.env.SESSION_SECRET) console.log('Note: set SESSION_SECRET before production deployment.');
  });
}

module.exports = handleRequest;
module.exports.server = server;
module.exports.handleRequest = handleRequest;
