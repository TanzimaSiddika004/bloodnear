const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  throw new Error('BloodNear requires Node.js 22.5.0 or newer with node:sqlite support. Currently running Node ' + process.version);
}
const { hashPassword } = require('./auth');
const { uid, nowIso, addHoursIso } = require('./utils');

function resolveDbPath() {
  if (process.env.DB_PATH) {
    try {
      fs.mkdirSync(path.dirname(process.env.DB_PATH), { recursive: true });
    } catch {}
    return process.env.DB_PATH;
  }

  // On Vercel / AWS Lambda / Serverless environments, /var/task is read-only.
  // /tmp is the writable directory in Linux serverless.
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    const tmpDir = process.platform === 'win32' ? os.tmpdir() : '/tmp';
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
    } catch {}
    return path.join(tmpDir, 'bloodnear.sqlite');
  }

  // Standard local environment
  const localDir = path.join(__dirname, '..', 'data');
  try {
    fs.mkdirSync(localDir, { recursive: true });
    return path.join(localDir, 'bloodnear.sqlite');
  } catch {
    const tmp = os.tmpdir();
    return path.join(tmp, 'bloodnear.sqlite');
  }
}

const dbPath = resolveDbPath();
try {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
} catch {}
let db;
try {
  db = new DatabaseSync(dbPath);
} catch (err) {
  console.warn('Could not open file database at', dbPath, err.message, '- falling back to :memory:');
  db = new DatabaseSync(':memory:');
}
try {
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA journal_mode = WAL;');
} catch {
  try { db.exec('PRAGMA journal_mode = DELETE;'); } catch {}
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      blood_group TEXT NOT NULL,
      phone TEXT,
      area TEXT NOT NULL,
      lat REAL,
      lng REAL,
      is_verified INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'USER' CHECK(role IN ('USER','ADMIN')),
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blood_requests (
      id TEXT PRIMARY KEY,
      requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blood_group TEXT NOT NULL,
      required_units INTEGER NOT NULL CHECK(required_units BETWEEN 1 AND 20),
      hospital_name TEXT,
      area TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      urgency TEXT NOT NULL DEFAULT 'NORMAL' CHECK(urgency IN ('NORMAL','EMERGENCY')),
      needed_by TEXT NOT NULL,
      description TEXT,
      contact_preference TEXT NOT NULL DEFAULT 'AFTER_ACCEPT' CHECK(contact_preference IN ('AFTER_ACCEPT','MESSAGE_ONLY')),
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','MATCHED','FULFILLED','CANCELLED','EXPIRED')),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS donor_availability (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      blood_group TEXT NOT NULL,
      area TEXT NOT NULL,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      available_until TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','PAUSED')),
      note TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS responses (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL REFERENCES blood_requests(id) ON DELETE CASCADE,
      donor_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'INTERESTED' CHECK(status IN ('INTERESTED','ACCEPTED','DECLINED','CANCELLED','COMPLETED')),
      message TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(request_id, donor_id)
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      link TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL CHECK(target_type IN ('REQUEST','USER')),
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVED','DISMISSED')),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      blood_group TEXT,
      lat REAL,
      lng REAL,
      radius REAL,
      result_count INTEGER NOT NULL DEFAULT 0,
      searched_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_status_group ON blood_requests(status, blood_group, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_responses_request ON responses(request_id, status);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
  `);
  seedIfEmpty();
}

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;
  const created = nowIso();
  const users = [
    { id: 'u-admin', name: 'BloodNear Admin', email: 'admin@bloodnear.local', password: 'Admin123!', blood: 'O+', area: 'Kandirpar, Cumilla', lat: 23.4607, lng: 91.1809, verified: 1, role: 'ADMIN' },
    { id: 'u-nabila', name: 'Nabila Rahman', email: 'nabila@example.com', password: 'Demo123!', blood: 'B+', area: 'Kandirpar, Cumilla', lat: 23.4608, lng: 91.1815, verified: 1, role: 'USER' },
    { id: 'u-arif', name: 'Arif Hasan', email: 'arif@example.com', password: 'Demo123!', blood: 'O-', area: 'Jhautola, Cumilla', lat: 23.4664, lng: 91.1885, verified: 1, role: 'USER' },
    { id: 'u-sadia', name: 'Sadia Karim', email: 'sadia@example.com', password: 'Demo123!', blood: 'A+', area: 'Race Course, Cumilla', lat: 23.4682, lng: 91.1762, verified: 0, role: 'USER' },
    { id: 'u-tanvir', name: 'Tanvir Ahmed', email: 'tanvir@example.com', password: 'Demo123!', blood: 'AB-', area: 'Tomsom Bridge, Cumilla', lat: 23.4459, lng: 91.1776, verified: 1, role: 'USER' }
  ];
  const insertUser = db.prepare(`INSERT INTO users(id,name,email,password_hash,blood_group,phone,area,lat,lng,is_verified,role,status,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'ACTIVE',?)`);
  for (const u of users) insertUser.run(u.id, u.name, u.email, hashPassword(u.password), u.blood, null, u.area, u.lat, u.lng, u.verified, u.role, created);

  const requests = [
    ['r-1','u-nabila','O-',2,'Cumilla Medical College Hospital','Medical College Area, Cumilla',23.4374,91.1855,'EMERGENCY',addHoursIso(8),'Urgent surgery support needed. Please respond if you can donate.',addHoursIso(10)],
    ['r-2','u-sadia','B+',1,'Moon Hospital, Cumilla','Race Course, Cumilla',23.4680,91.1765,'NORMAL',addHoursIso(20),'One unit required for a scheduled procedure.',addHoursIso(24)],
    ['r-3','u-arif','A+',2,'Cumilla General Hospital','Kandirpar, Cumilla',23.4618,91.1820,'EMERGENCY',addHoursIso(5),'Family is coordinating with the hospital blood bank; donor support requested.',addHoursIso(8)],
    ['r-4','u-tanvir','AB-',1,'Central Medical Area','Tomsom Bridge, Cumilla',23.4468,91.1780,'NORMAL',addHoursIso(30),'Rare group request; please respond only if available to coordinate.',addHoursIso(36)]
  ];
  const insertReq = db.prepare(`INSERT INTO blood_requests(id,requester_id,blood_group,required_units,hospital_name,area,lat,lng,urgency,needed_by,description,contact_preference,status,expires_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'AFTER_ACCEPT','OPEN',?,?,?)`);
  for (const r of requests) insertReq.run(...r.slice(0,11), r[11], created, created);

  const insertAvail = db.prepare(`INSERT INTO donor_availability(user_id,blood_group,area,lat,lng,available_until,status,note,updated_at) VALUES(?,?,?,?,?,?,'ACTIVE',?,?)`);
  insertAvail.run('u-arif','O-','Jhautola, Cumilla',23.4664,91.1885,addHoursIso(48),'Available after 4 PM. Hospital screening required.',created);
  insertAvail.run('u-nabila','B+','Kandirpar, Cumilla',23.4608,91.1815,addHoursIso(48),'Can travel within central Cumilla.',created);
  insertAvail.run('u-sadia','A+','Race Course, Cumilla',23.4682,91.1762,addHoursIso(24),'Available today.',created);
}

function expireRequests() {
  const now = nowIso();
  db.prepare(`UPDATE blood_requests SET status='EXPIRED', updated_at=? WHERE status IN ('OPEN','MATCHED') AND expires_at < ?`).run(now, now);
  db.prepare(`UPDATE donor_availability SET status='PAUSED', updated_at=? WHERE status='ACTIVE' AND available_until < ?`).run(now, now);
}

function notify(userId, type, title, message, link = null) {
  const id = uid('n-');
  db.prepare(`INSERT INTO notifications(id,user_id,type,title,message,link,is_read,created_at) VALUES(?,?,?,?,?,?,0,?)`)
    .run(id, userId, type, title, message, link, nowIso());
  return id;
}

module.exports = { db, dbPath, initDb, expireRequests, notify };
