import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, chmodSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import {restoreReservationPath} from './state-paths.mjs';
import { validateArtifactHandle } from './artifact-files.mjs';

function assertNotSymlink(path, label) {
  try { if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symlink.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function assertRestorePublished(directory) {
  for (const path of [restoreReservationPath(directory),join(directory,'.restore-incomplete')]) {
    try { lstatSync(path); }
    catch (error) { if (error.code==='ENOENT') continue; throw error; }
    throw new Error('State restore publication is incomplete. Complete or reconcile stopped maintenance before startup.');
  }
}

function assertPrivateLeaseFile(path,label) {
  let stat;
  try {stat=lstatSync(path);}
  catch(error) {if (error.code==='ENOENT') return;throw error;}
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink.`);
  if (!stat.isFile() || stat.nlink!==1 || (stat.mode&0o077) || (process.getuid && stat.uid!==process.getuid())) {
    throw new Error(`${label} must be a private file owned by this runtime user.`);
  }
}

function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('State root must be a private directory.');
  if (process.getuid && stat.uid !== process.getuid()) throw new Error('State root must be owned by this runtime user.');
  chmodSync(directory, 0o700);
}

function acquireDatabaseLock(directory) {
  const path = join(directory, 'owner.sqlite');
  for (const suffix of ['', '-journal', '-wal', '-shm']) assertPrivateLeaseFile(`${path}${suffix}`, 'State ownership database and journal');
  let db;
  let busy;
  try {
    db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    db.exec(`PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS lease (slot INTEGER PRIMARY KEY);
      BEGIN EXCLUSIVE;`);
    return () => { try { db.exec('ROLLBACK'); } finally { db.close(); } };
  } catch (error) {
    // Closing also rolls back any transaction acquired before initialization failed.
    db?.close();
    busy = error.errcode === 5 || error.errcode === 6 || /database is locked/.test(error.message);
    if (!busy) throw error;
  }
  throw new Error('State is already owned or locked.');
}

function acquire(directory) {
  privateDirectory(directory);
  const path = join(directory, 'owner.lock');
  assertPrivateLeaseFile(path, 'State owner lock');
  const releaseDatabase = acquireDatabaseLock(directory);
  const owner = { pid: process.pid, token: randomUUID() };
  try {
    // PID/token are local control metadata. The held SQLite OS lock is authority.
    assertPrivateLeaseFile(path, 'State owner lock');
    writeFileSync(path, JSON.stringify(owner), { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch (error) { releaseDatabase(); throw error; }
  return () => {
    try {
      assertNotSymlink(path, 'State owner lock');
      if (JSON.parse(readFileSync(path, 'utf8')).token !== owner.token) throw new Error('State ownership changed.');
      unlinkSync(path);
    } finally { releaseDatabase(); }
  };
}

/** Maintenance shares ownership, but must not initialize or migrate the application database. */
export function acquireStoppedLease(directory) {
  directory=resolve(directory);
  const stat=lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode&0o077) || (process.getuid && stat.uid!==process.getuid())) {
    throw new Error('Maintenance requires an existing private state directory.');
  }
  return acquire(directory);
}

function initialize(db, identity) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  const existingVersion = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
  if (existingVersion !== undefined && (!Number.isSafeInteger(Number(existingVersion)) || Number(existingVersion) > SCHEMA_VERSION)) {
    throw new Error('State schema version is newer than this runtime supports.');
  }
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;');
  createBaseSchema(db);
  const prior = db.prepare('SELECT value FROM meta WHERE key = ?').get('identity');
  if (prior && prior.value !== identity) throw new Error('State identity does not match this mailbox.');
  db.prepare('INSERT OR IGNORE INTO meta VALUES (?, ?)').run('identity', identity);
  migrateProjection(db);
}

function createBaseSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, message_key TEXT UNIQUE NOT NULL, conversation_key TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS actions (key TEXT PRIMARY KEY, run_id TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, event TEXT NOT NULL, run_id TEXT, actor TEXT, target TEXT, details TEXT NOT NULL);
  `);
}

/** Internal schema reference for offline restore validation; no ownership or runtime recovery. */
export function createStateSchema(db,version) {
  if (!Number.isInteger(version) || version<0 || version>SCHEMA_VERSION) throw new Error('Unsupported state schema reference.');
  createBaseSchema(db);
  if (version>=1) createProjectionVersionOne(db);
  if (version>=2) upgradeProjectionVersionTwo(db);
  if (version>=3) upgradeProjectionVersionThree(db);
  if (version>=5) createArtifactReferenceSchema(db);
}

const SCHEMA_VERSION = 5;
const activeStatuses = ['queued', 'running', 'awaiting_approval', 'ready_to_send', 'sending'];

function migrateProjection(db) {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  const version = row ? Number(row.value) : 0;
  if (!Number.isSafeInteger(version) || version > SCHEMA_VERSION) throw new Error('State schema version is newer than this runtime supports.');
  if (version === SCHEMA_VERSION) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version === 0) createProjectionVersionOne(db);
    if (version < 2) upgradeProjectionVersionTwo(db);
    if (version<3) upgradeProjectionVersionThree(db);
    if (version<5) createArtifactReferenceSchema(db);
    db.prepare("INSERT INTO meta(key,value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function createArtifactReferenceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_refs (
      handle TEXT PRIMARY KEY, run_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK (purpose IN ('image-input','text-output')),
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, metadata TEXT NOT NULL, retired_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS artifact_refs_run ON artifact_refs(run_id,created_at,handle) WHERE retired_at IS NULL;
    CREATE INDEX IF NOT EXISTS artifact_refs_expiry ON artifact_refs(expires_at,handle) WHERE retired_at IS NULL;
    CREATE INDEX IF NOT EXISTS artifact_refs_gc ON artifact_refs(retired_at,handle) WHERE retired_at IS NOT NULL;
  `);
}

function createProjectionVersionOne(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_projection (
      id TEXT PRIMARY KEY, message_key TEXT UNIQUE NOT NULL, conversation_key TEXT NOT NULL,
      status TEXT NOT NULL, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
      sequence INTEGER NOT NULL, sender TEXT, response_kind TEXT, approval_id TEXT,
      approval_json TEXT, requester TEXT, content_expired INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS projection_page ON run_projection(updated_at, id);
    CREATE INDEX IF NOT EXISTS projection_expiry ON run_projection(content_expired, created_at, id);
    CREATE INDEX IF NOT EXISTS projection_status_sequence ON run_projection(status, sequence, id);
    CREATE INDEX IF NOT EXISTS projection_context ON run_projection(conversation_key, sender, status, sequence);
    CREATE INDEX IF NOT EXISTS projection_approval ON run_projection(approval_id, status);
    CREATE TABLE IF NOT EXISTS status_counts (status TEXT PRIMARY KEY, count INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS projection_count_insert AFTER INSERT ON run_projection BEGIN
      INSERT INTO status_counts(status, count) VALUES (NEW.status, 1)
      ON CONFLICT(status) DO UPDATE SET count = count + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS projection_count_delete AFTER DELETE ON run_projection BEGIN
      UPDATE status_counts SET count = count - 1 WHERE status = OLD.status;
      DELETE FROM status_counts WHERE status = OLD.status AND count <= 0;
    END;
    CREATE TRIGGER IF NOT EXISTS projection_count_update AFTER UPDATE OF status ON run_projection WHEN NEW.status <> OLD.status BEGIN
      UPDATE status_counts SET count = count - 1 WHERE status = OLD.status;
      DELETE FROM status_counts WHERE status = OLD.status AND count <= 0;
      INSERT INTO status_counts(status, count) VALUES (NEW.status, 1)
      ON CONFLICT(status) DO UPDATE SET count = count + 1;
    END;
    CREATE INDEX IF NOT EXISTS actions_state_run ON actions(state, run_id);
    CREATE INDEX IF NOT EXISTS actions_run_state ON actions(run_id, state);
    CREATE INDEX IF NOT EXISTS actions_result_presence ON actions(run_id, json_type(data,'$.result'));
    CREATE INDEX IF NOT EXISTS audit_retention ON audit(at,seq);
    CREATE TRIGGER IF NOT EXISTS runs_projection_insert AFTER INSERT ON runs BEGIN
      INSERT INTO run_projection(id,message_key,conversation_key,status,updated_at,created_at,sequence,sender,response_kind,approval_id,approval_json,requester,content_expired)
      VALUES (NEW.id,NEW.message_key,NEW.conversation_key,NEW.status,NEW.updated_at,
        COALESCE(json_extract(NEW.data,'$.createdAt'),0),COALESCE(json_extract(NEW.data,'$.sequence'),0),
        json_extract(NEW.data,'$.mail.sender'),json_extract(NEW.data,'$.responseKind'),json_extract(NEW.data,'$.approval.id'),
        CASE WHEN json_type(NEW.data,'$.approval')='object' THEN json_extract(NEW.data,'$.approval') END,
        json_extract(NEW.data,'$.mail.sender'),COALESCE(json_extract(NEW.data,'$.contentExpired'),0));
    END;
    CREATE TRIGGER IF NOT EXISTS runs_projection_update AFTER UPDATE OF data,message_key,conversation_key,status,updated_at ON runs BEGIN
      INSERT INTO run_projection(id,message_key,conversation_key,status,updated_at,created_at,sequence,sender,response_kind,approval_id,approval_json,requester,content_expired)
      VALUES (NEW.id,NEW.message_key,NEW.conversation_key,NEW.status,NEW.updated_at,
        COALESCE(json_extract(NEW.data,'$.createdAt'),0),COALESCE(json_extract(NEW.data,'$.sequence'),0),
        json_extract(NEW.data,'$.mail.sender'),json_extract(NEW.data,'$.responseKind'),json_extract(NEW.data,'$.approval.id'),
        CASE WHEN json_type(NEW.data,'$.approval')='object' THEN json_extract(NEW.data,'$.approval') END,
        json_extract(NEW.data,'$.mail.sender'),COALESCE(json_extract(NEW.data,'$.contentExpired'),0))
      ON CONFLICT(id) DO UPDATE SET message_key=excluded.message_key,conversation_key=excluded.conversation_key,
        status=excluded.status,updated_at=excluded.updated_at,created_at=excluded.created_at,sequence=excluded.sequence,
        sender=excluded.sender,response_kind=excluded.response_kind,approval_id=excluded.approval_id,
        approval_json=excluded.approval_json,requester=excluded.requester,content_expired=excluded.content_expired;
    END;
  `);
  db.exec(`INSERT OR IGNORE INTO run_projection
    SELECT id,message_key,conversation_key,status,updated_at,
      COALESCE(json_extract(data,'$.createdAt'),0),COALESCE(json_extract(data,'$.sequence'),0),
      json_extract(data,'$.mail.sender'),json_extract(data,'$.responseKind'),json_extract(data,'$.approval.id'),
      CASE WHEN json_type(data,'$.approval')='object' THEN json_extract(data,'$.approval') END,
      json_extract(data,'$.mail.sender'),COALESCE(json_extract(data,'$.contentExpired'),0) FROM runs;`);
}

function numericBudget(data, field) {
  const value = `json_extract(${data},'$.budget.${field}')`;
  return `CASE WHEN json_type(${data},'$.budget.${field}') IN ('integer','real') AND ${value}>=0 AND ${value}<=9007199254740991 THEN ${value} END`;
}

function reuseCount(id, field, expression) {
  return `COALESCE((SELECT ${field} FROM run_projection WHERE id=${id}),${expression})`;
}

function operationValues(data, id, reuse = false) {
  const count = `(SELECT count(*) FROM actions WHERE run_id=${id} AND state='uncertain')`;
  return [
    `CASE WHEN json_type(${data},'$.budget')='object' THEN 1 ELSE 0 END`,
    ...['modelCalls', 'toolCalls', 'activeMs'].map(field => numericBudget(data, field)),
    `CASE WHEN json_type(${data},'$.activeOperation') IS NOT NULL THEN 1 ELSE 0 END`,
    reuse ? reuseCount(id, 'uncertain_actions', count) : count
  ].join(',');
}

function upgradeProjectionVersionTwo(db) {
  db.exec(`
    ALTER TABLE run_projection ADD COLUMN budget_present INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE run_projection ADD COLUMN model_calls NUMERIC;
    ALTER TABLE run_projection ADD COLUMN tool_calls NUMERIC;
    ALTER TABLE run_projection ADD COLUMN active_ms NUMERIC;
    ALTER TABLE run_projection ADD COLUMN active_operation INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE run_projection ADD COLUMN uncertain_actions INTEGER NOT NULL DEFAULT 0 CHECK (uncertain_actions>=0);
    UPDATE run_projection AS p SET (budget_present,model_calls,tool_calls,active_ms,active_operation,uncertain_actions)=
      (SELECT ${operationValues('r.data', 'r.id')} FROM runs r WHERE r.id=p.id);
    CREATE INDEX projection_status_page ON run_projection(status,updated_at,id);
    CREATE INDEX projection_sequence ON run_projection(sequence,id);
    CREATE INDEX projection_active_sequence ON run_projection(sequence,id) WHERE status IN ('queued','running','awaiting_approval','ready_to_send','sending');
    CREATE INDEX projection_active_operation ON run_projection(sequence,id) WHERE active_operation=1;
    CREATE INDEX projection_uncertain_recovery ON run_projection(sequence,id) WHERE uncertain_actions>0 AND status<>'uncertain';
    CREATE INDEX actions_state_key ON actions(state,key);
    DROP TRIGGER IF EXISTS runs_projection_insert;
    DROP TRIGGER IF EXISTS runs_projection_update;
  `);
  createRunProjectionTriggers(db);
  db.exec(`
    CREATE TRIGGER actions_uncertainty_insert AFTER INSERT ON actions WHEN NEW.state='uncertain' BEGIN
      UPDATE run_projection SET uncertain_actions=uncertain_actions+1 WHERE id=NEW.run_id;
    END;
    CREATE TRIGGER actions_uncertainty_delete AFTER DELETE ON actions WHEN OLD.state='uncertain' BEGIN
      UPDATE run_projection SET uncertain_actions=uncertain_actions-1 WHERE id=OLD.run_id;
    END;
    CREATE TRIGGER actions_uncertainty_update AFTER UPDATE OF state,run_id ON actions BEGIN
      UPDATE run_projection SET uncertain_actions=uncertain_actions-1 WHERE id=OLD.run_id AND OLD.state='uncertain';
      UPDATE run_projection SET uncertain_actions=uncertain_actions+1 WHERE id=NEW.run_id AND NEW.state='uncertain';
    END;
  `);
}

function upgradeProjectionVersionThree(db) {
  db.exec(`
    ALTER TABLE run_projection ADD COLUMN result_actions INTEGER NOT NULL DEFAULT 0 CHECK (result_actions>=0);
    UPDATE run_projection AS p SET result_actions=(SELECT count(*) FROM actions WHERE run_id=p.id AND json_type(data,'$.result') IS NOT NULL);
    CREATE INDEX projection_result_expiry ON run_projection(created_at,id) WHERE result_actions>0;
    CREATE INDEX actions_results ON actions(run_id,key) WHERE json_type(data,'$.result') IS NOT NULL;
    DROP TRIGGER IF EXISTS runs_projection_insert;
    DROP TRIGGER IF EXISTS runs_projection_update;
  `);
  createRunProjectionTriggers(db, true);
  db.exec(`
    CREATE TRIGGER actions_result_insert AFTER INSERT ON actions WHEN json_type(NEW.data,'$.result') IS NOT NULL BEGIN
      UPDATE run_projection SET result_actions=result_actions+1 WHERE id=NEW.run_id;
    END;
    CREATE TRIGGER actions_result_delete AFTER DELETE ON actions WHEN json_type(OLD.data,'$.result') IS NOT NULL BEGIN
      UPDATE run_projection SET result_actions=result_actions-1 WHERE id=OLD.run_id;
    END;
    CREATE TRIGGER actions_result_update AFTER UPDATE OF data,run_id ON actions BEGIN
      UPDATE run_projection SET result_actions=result_actions-1 WHERE id=OLD.run_id AND json_type(OLD.data,'$.result') IS NOT NULL;
      UPDATE run_projection SET result_actions=result_actions+1 WHERE id=NEW.run_id AND json_type(NEW.data,'$.result') IS NOT NULL;
    END;
  `);
}

function createRunProjectionTriggers(db, includeResults = false) {
  const fields = 'id,message_key,conversation_key,status,updated_at,created_at,sequence,sender,response_kind,approval_id,approval_json,requester,content_expired,budget_present,model_calls,tool_calls,active_ms,active_operation,uncertain_actions' + (includeResults ? ',result_actions' : '');
  const results = includeResults ? `,${reuseCount('NEW.id', 'result_actions', "(SELECT count(*) FROM actions WHERE run_id=NEW.id AND json_type(data,'$.result') IS NOT NULL)")}` : '';
  const values = `NEW.id,NEW.message_key,NEW.conversation_key,NEW.status,NEW.updated_at,
    COALESCE(json_extract(NEW.data,'$.createdAt'),0),COALESCE(json_extract(NEW.data,'$.sequence'),0),
    json_extract(NEW.data,'$.mail.sender'),json_extract(NEW.data,'$.responseKind'),json_extract(NEW.data,'$.approval.id'),
    CASE WHEN json_type(NEW.data,'$.approval')='object' THEN json_extract(NEW.data,'$.approval') END,
    json_extract(NEW.data,'$.mail.sender'),COALESCE(json_extract(NEW.data,'$.contentExpired'),0),${operationValues('NEW.data', 'NEW.id', true)}${results}`;
  const counters = new Set(['id', 'uncertain_actions', 'result_actions']);
  const updates = fields.split(',').filter(field => !counters.has(field)).map(field => `${field}=excluded.${field}`).join(',');
  db.exec(`
    CREATE TRIGGER runs_projection_insert AFTER INSERT ON runs BEGIN
      INSERT INTO run_projection(${fields}) VALUES (${values});
    END;
    CREATE TRIGGER runs_projection_update AFTER UPDATE OF data,message_key,conversation_key,status,updated_at ON runs BEGIN
      INSERT INTO run_projection(${fields}) VALUES (${values}) ON CONFLICT(id) DO UPDATE SET ${updates};
    END;
  `);
}

function assertSupportedVersion(directory) {
  const path = join(directory, 'agent.sqlite');
  for (const suffix of ['', '-wal', '-shm']) assertNotSymlink(`${path}${suffix}`, 'State database and sidecars');
  try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value;
    if (version !== undefined && (!Number.isSafeInteger(Number(version)) || Number(version) > SCHEMA_VERSION)) {
      throw new Error('State schema version is newer than this runtime supports.');
    }
  } catch (error) {
    if (/no such table: meta|no such table: main\.meta/.test(error.message)) return;
    if (error.code === 'ENOENT') return;
    throw error;
  } finally { db?.close(); }
}

function parse(row) { return row ? JSON.parse(row.data) : undefined; }

function validArtifactHandle(purpose, handle, createdAt) {
  try {
    return ['image-input', 'text-output'].includes(purpose) && Number.isSafeInteger(createdAt) && createdAt >= 0
      && validateArtifactHandle(handle).expiresAt >= createdAt;
  } catch { return false; }
}

function artifactFromRow(row) {
  const handle = JSON.parse(row.metadata);
  if (!validArtifactHandle(row.purpose, handle, row.created_at) || (row.id && row.id !== handle.id)
    || (row.run_id && row.run_id !== handle.runId)) throw new Error('Artifact reference is invalid.');
  return { purpose: row.purpose, handle, createdAt: row.created_at };
}

const terminalStatuses = new Set(['completed', 'failed', 'ignored', 'uncertain']);
const contentFields = ['mail', 'reply', 'messages', 'instructionSnapshot', 'pending', 'approval', 'grants', 'imageArtifacts', 'outputArtifact', 'deliveryIntent', 'replyKind'];
const artifactUuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

function expireRun(run) {
  for (const field of contentFields) delete run[field];
  run.contentExpired = true;
  if (run.status === 'sending') {
    run.status = 'uncertain';
    run.uncertainty ??= { kind: 'send' };
  } else if (!terminalStatuses.has(run.status)) run.status = 'failed';
  return run;
}

function purgeRuns(store, cutoff) {
  let runsExpired = 0;
  const expiredRunIds = [];
  const candidates = store.reapBatch({ cutoff, limit: 100 });
  const expired = new Set(candidates.map(run => run.id));
  for (const run of candidates) {
    if (run.contentExpired) continue;
    store.saveRun(expireRun(run));
    runsExpired++;
    expiredRunIds.push(run.id);
  }
  let actionsExpired = 0;
  const artifactsToCollect = [];
  for (const action of store.reapActionsBatch({ runIds: [...expired], limit: 100 })) {
    if (!Object.hasOwn(action, 'result')) continue;
    delete action.result;
    store.saveAction(action);
    actionsExpired++;
  }
  for (const id of expired) artifactsToCollect.push(...store.retireArtifactsForRun(id));
  return { runsExpired, actionsExpired, ...(expiredRunIds.length ? { expiredRunIds } : {}),
    ...(artifactsToCollect.length ? { artifactsToCollect } : {}) };
}

function purgeStore(store, db, clock, { contentHours, auditDays }) {
  if (!Number.isSafeInteger(contentHours) || contentHours < 1 || !Number.isSafeInteger(auditDays) || auditDays < 1) {
    throw new Error('Invalid retention limits.');
  }
  const now = clock();
  const result = store.transaction(() => {
    const expired = purgeRuns(store, now - contentHours * 3_600_000);
    const expiredArtifacts = store.retireExpiredArtifacts(now, 100);
    if (expiredArtifacts.length) expired.artifactsToCollect = [...(expired.artifactsToCollect ?? []), ...expiredArtifacts];
    const removed = db.prepare('DELETE FROM audit WHERE seq IN (SELECT seq FROM audit WHERE at <= ? ORDER BY at,seq LIMIT 100)').run(now - auditDays * 86_400_000);
    return { ...expired, auditDeleted: Number(removed.changes) };
  });
  if (result.runsExpired || result.actionsExpired || result.auditDeleted || (result.artifactsToCollect?.length ?? 0)) {
    // Clears live SQLite pages and WAL; filesystem snapshots/backups have separate retention.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  return result;
}

export function openStore(directory, { identity, clock = Date.now } = {}) {
  if (resolve(directory) === '/') throw new Error('Invalid state root.');
  directory = resolve(directory);
  assertRestorePublished(directory);
  assertSupportedVersion(directory);
  const release = acquire(directory);
  let db;
  try {
    assertRestorePublished(directory);
    const dbPath = join(directory, 'agent.sqlite');
    for (const suffix of ['', '-wal', '-shm']) assertNotSymlink(`${dbPath}${suffix}`, 'State database and sidecars');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA trusted_schema=OFF;');
    chmodSync(dbPath, 0o600);
    initialize(db, identity);
  } catch (error) { db?.close(); release(); throw error; }
  let closed = false;
  db.function('recovery_digest',{deterministic:true,directOnly:true},value=>createHash('sha256').update(value).digest('hex'));
  const store = {
    getRun: id => parse(db.prepare('SELECT data FROM runs WHERE id = ?').get(id)),
    runFingerprint:id=>db.prepare('SELECT recovery_digest(data) AS fingerprint FROM runs WHERE id=?').get(id)?.fingerprint,
    byMessage: key => parse(db.prepare('SELECT data FROM runs WHERE message_key = ?').get(key)),
    listRuns: () => db.prepare('SELECT data FROM runs ORDER BY updated_at, id').all().map(parse),
    summary() {
      const counts = Object.fromEntries(['queued','running','awaiting_approval','ready_to_send','sending','completed','failed','ignored','uncertain'].map(status => [status, 0]));
      for (const row of db.prepare('SELECT status,count FROM status_counts WHERE count > 0').all()) counts[row.status] = row.count;
      const cursor = db.prepare("SELECT value FROM meta WHERE key = 'cursor'").get()?.value;
      let baselineComplete = false;
      try { baselineComplete = Boolean(cursor && JSON.parse(cursor).initialComplete); } catch { /* malformed cursors remain an incomplete baseline */ }
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      return { counts, total, backlog: counts.queued + counts.running + counts.ready_to_send + counts.sending,
        approvals: counts.awaiting_approval, uncertainty: counts.uncertain, baselineComplete,
        lastPollError: db.prepare("SELECT value FROM meta WHERE key = 'last_poll_error'").get()?.value || null };
    },
    runPage({ limit = 100, after, status } = {}) {
      limit = boundedLimit(limit, 100, 500);
      const columns = 'id,status,updated_at,created_at,sequence,budget_present,model_calls,tool_calls,active_ms,response_kind,approval_id,content_expired';
      const rows = status
        ? after
          ? db.prepare(`SELECT ${columns} FROM run_projection WHERE status = ? AND (sequence,id)>(?,?) ORDER BY sequence,id LIMIT ?`).all(status, after.sequence, after.id, limit)
          : db.prepare(`SELECT ${columns} FROM run_projection WHERE status = ? ORDER BY sequence,id LIMIT ?`).all(status, limit)
        : after
          ? db.prepare(`SELECT ${columns} FROM run_projection WHERE (sequence,id)>(?,?) ORDER BY sequence,id LIMIT ?`).all(after.sequence, after.id, limit)
          : db.prepare(`SELECT ${columns} FROM run_projection ORDER BY sequence,id LIMIT ?`).all(limit);
      const items = rows.map(safeProjection);
      return { items, nextCursor: items.length === limit ? { sequence: items.at(-1).sequence, id: items.at(-1).id } : null };
    },
    recoveryPage({limit=100,after}={}) {
      limit=boundedLimit(limit,100,100);
      const rows=recoveryPageRows(db,limit,after);
      const items=rows.map(row=>({...safeProjection(row),messageKey:row.message_key,conversationKey:row.conversation_key,
        approved:Boolean(row.approved),activeOperation:Boolean(row.active_operation),fingerprint:row.fingerprint}));
      return {items,nextCursor:items.length===limit?{sequence:items.at(-1).sequence,id:items.at(-1).id}:null};
    },
    actionPage({limit=100,after}={}) {
      limit=boundedLimit(limit,100,100);
      const rows=actionPageRows(db,limit,after);
      return {items:rows.map(safeRecoveryAction),nextCursor:rows.length===limit?rows.at(-1).key:null};
    },
    approvalPage({ limit = 100, after } = {}) {
      limit = boundedLimit(limit, 100, 100);
      const rows = after
        ? db.prepare(`SELECT id,sequence,approval_json,requester FROM run_projection WHERE status='awaiting_approval' AND (sequence,id)>(?,?) ORDER BY sequence,id LIMIT ?`).all(after.sequence, after.id, limit)
        : db.prepare("SELECT id,sequence,approval_json,requester FROM run_projection WHERE status='awaiting_approval' ORDER BY sequence,id LIMIT ?").all(limit);
      const items = rows.map(row => ({ ...JSON.parse(row.approval_json), runId: row.id, requester: row.requester ?? undefined }));
      const last = items.at(-1);
      return { items, nextCursor: items.length === limit && last ? { sequence: rows.at(-1).sequence, id: last.runId } : null };
    },
    findApproval(id) {
      const row = db.prepare("SELECT r.data FROM runs r JOIN run_projection p ON p.id=r.id WHERE p.approval_id=? AND p.status='awaiting_approval' LIMIT 1").get(id);
      return parse(row);
    },
    activeBatch({ limit = 100, after } = {}) { return batchRuns(activeStatuses, limit, after); },
    activeRecoveryPage({limit=100,after}={}) {
      limit=boundedLimit(limit,100,100);
      const predicate="p.status IN ('queued','running','awaiting_approval','ready_to_send','sending')";
      const select=`SELECT p.id,p.sequence,recovery_digest(r.data) AS fingerprint FROM run_projection p
        INDEXED BY projection_active_sequence JOIN runs r ON r.id=p.id WHERE ${predicate}`;
      const rows=after
        ? db.prepare(`${select} AND (p.sequence,p.id)>(?,?) ORDER BY p.sequence,p.id LIMIT ?`).all(after.sequence,after.id,limit)
        : db.prepare(`${select} ORDER BY p.sequence,p.id LIMIT ?`).all(limit);
      const items=rows.map(row=>({id:row.id,sequence:row.sequence,fingerprint:row.fingerprint}));
      return {items,nextCursor:items.length===limit?{sequence:items.at(-1).sequence,id:items.at(-1).id}:null};
    },
    queuedBatch({ limit = 100, after } = {}) { return batchRuns(['queued'], limit, after); },
    hasEarlierBlocker(run) {
      return Boolean(db.prepare(`SELECT 1 FROM run_projection WHERE id<>? AND conversation_key=?
        AND (status NOT IN ('completed','failed','ignored','uncertain') OR status='uncertain')
        AND (sequence < ? OR (sequence = ? AND id < ?)) LIMIT 1`).get(run.id, run.conversationKey, run.sequence ?? 0, run.sequence ?? 0, run.id));
    },
    recentContext({ conversationKey, sender, excludeId, limit = 8 } = {}) {
      limit = boundedLimit(limit, 8, 8);
      return db.prepare(`SELECT r.data FROM runs r JOIN run_projection p ON p.id=r.id
        WHERE p.conversation_key=? AND p.sender=? AND p.id<>? AND p.status='completed' AND p.response_kind IS NOT 'unsupported'
        ORDER BY p.sequence DESC,p.id DESC LIMIT ?`).all(conversationKey, sender, excludeId, limit).map(parse).reverse();
    },
    recoveryBatch({ limit = 100, after } = {}) {
      limit = boundedLimit(limit, 100, 500);
      const rows = recoveryRows(db, limit, after);
      return { items: rows.map(parse), nextCursor: rows.length === limit ? { sequence: rows.at(-1).sequence, id: rows.at(-1).id } : null };
    },
    executingActionsBatch({ limit = 100, after } = {}) {
      limit = boundedLimit(limit, 100, 500);
      const rows = after
        ? db.prepare("SELECT key,data FROM actions WHERE state='executing' AND key>? ORDER BY key LIMIT ?").all(after,limit)
        : db.prepare("SELECT key,data FROM actions WHERE state='executing' ORDER BY key LIMIT ?").all(limit);
      return { items: rows.map(parse), nextCursor: rows.length === limit ? rows.at(-1).key : null };
    },
    findUncertainAction(runId) { return parse(db.prepare("SELECT data FROM actions WHERE run_id=? AND state='uncertain' ORDER BY key LIMIT 1").get(runId)); },
    hasExpiredContent({ contentHours, auditDays } = {}) {
      validateRetention(contentHours, auditDays);
      const now = clock();
      return Boolean(
        db.prepare('SELECT 1 FROM run_projection WHERE created_at<=? AND content_expired=0 LIMIT 1').get(now - contentHours * 3_600_000)
      || db.prepare('SELECT 1 FROM run_projection INDEXED BY projection_result_expiry WHERE result_actions>0 AND created_at<=? LIMIT 1').get(now - contentHours * 3_600_000)
        || db.prepare('SELECT 1 FROM artifact_refs WHERE retired_at IS NULL AND expires_at<=? LIMIT 1').get(now)
        || db.prepare('SELECT 1 FROM audit WHERE at<=? LIMIT 1').get(now - auditDays * 86_400_000)
      );
    },
    expireRunById(id, { contentHours } = {}) {
      if (!Number.isSafeInteger(contentHours) || contentHours < 1) throw new Error('Invalid retention limits.');
      const cutoff = clock() - contentHours * 3_600_000;
      const run = parse(db.prepare('SELECT data FROM runs WHERE id=?').get(id));
      if (!run || !Number.isFinite(run.createdAt) || run.createdAt > cutoff || run.contentExpired) return false;
      return store.transaction(() => {
        store.saveRun(expireRun(run));
        let actionsExpired = 0;
        for (;;) {
          const actions = store.reapActionsBatch({ runIds: [id], limit: 100 });
          if (!actions.length) break;
          for (const action of actions) { delete action.result; store.saveAction(action); actionsExpired++; }
        }
        const artifactsToCollect = store.retireArtifactsForRun(id);
        return { runExpired: true, actionsExpired, expiredRunIds: [id], ...(artifactsToCollect.length ? { artifactsToCollect } : {}) };
      });
    },
    reapBatch({ cutoff, limit = 100 } = {}) {
      limit = boundedLimit(limit, 100, 500);
      return retentionRows(db, cutoff, limit).map(parse);
    },
    reapActionsBatch({ runIds, limit = 100 } = {}) {
      if (!runIds?.length) return [];
      limit = boundedLimit(limit, 100, 500);
      const placeholders = runIds.map(() => '?').join(',');
      return db.prepare(`SELECT data FROM actions INDEXED BY actions_results WHERE run_id IN (${placeholders}) AND json_type(data,'$.result') IS NOT NULL ORDER BY key LIMIT ?`).all(...runIds, limit).map(parse);
    },
    saveArtifact({ purpose, handle, createdAt } = {}) {
      if (!validArtifactHandle(purpose, handle, createdAt) || !store.getRun(handle.runId)) throw new Error('Invalid artifact reference.');
      db.prepare('INSERT INTO artifact_refs(handle,run_id,purpose,created_at,expires_at,metadata,retired_at) VALUES (?,?,?,?,?,?,NULL)')
        .run(handle.id, handle.runId, purpose, createdAt, handle.expiresAt, JSON.stringify(handle));
      return structuredClone(handle);
    },
    artifactsForRun(runId) {
      if (!artifactUuid.test(runId)) throw new Error('Invalid artifact reference.');
      const rows = db.prepare('SELECT purpose,created_at,metadata FROM artifact_refs WHERE run_id=? AND retired_at IS NULL ORDER BY created_at,handle LIMIT 101').all(runId);
      if (rows.length > 100) throw new Error('Artifact reference limit exceeded.');
      return rows.map(row => artifactFromRow(row));
    },
    artifactIdsForRun(runId) {
      if (!artifactUuid.test(runId)) throw new Error('Invalid artifact reference.');
      const rows = db.prepare('SELECT handle FROM artifact_refs WHERE run_id=? ORDER BY handle LIMIT 101').all(runId);
      if (rows.length > 100) throw new Error('Artifact reference limit exceeded.');
      return rows.map(row => row.handle);
    },
    artifactsBatch({ limit = 100, after } = {}) {
      limit = boundedLimit(limit, 100, 100);
      if (after !== undefined && (typeof after !== 'string' || !artifactUuid.test(after))) throw new Error('Invalid artifact cursor.');
      const rows = after
        ? db.prepare('SELECT handle AS id,run_id,purpose,created_at,metadata FROM artifact_refs WHERE retired_at IS NULL AND handle>? ORDER BY handle LIMIT ?').all(after, limit)
        : db.prepare('SELECT handle AS id,run_id,purpose,created_at,metadata FROM artifact_refs WHERE retired_at IS NULL ORDER BY handle LIMIT ?').all(limit);
      return { items: rows.map(row => artifactFromRow(row)), nextCursor: rows.length === limit ? rows.at(-1).id : null };
    },
    retireArtifactsForRun(runId) {
      const rows = db.prepare('SELECT handle AS id,run_id,purpose,created_at,metadata FROM artifact_refs WHERE run_id=? AND retired_at IS NULL ORDER BY handle LIMIT 101').all(runId);
      if (rows.length > 100) throw new Error('Artifact reference limit exceeded.');
      if (rows.length) db.prepare('UPDATE artifact_refs SET retired_at=? WHERE run_id=? AND retired_at IS NULL').run(clock(), runId);
      return rows.map(row => artifactFromRow(row));
    },
    retireExpiredArtifacts(now = clock(), limit = 100) {
      limit = boundedLimit(limit, 100, 100);
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid artifact expiry.');
      const rows = db.prepare('SELECT handle AS id,run_id,purpose,created_at,metadata FROM artifact_refs WHERE retired_at IS NULL AND expires_at<=? ORDER BY expires_at,handle LIMIT ?').all(now, limit);
      if (rows.length) db.prepare(`UPDATE artifact_refs SET retired_at=? WHERE handle IN (${rows.map(() => '?').join(',')}) AND retired_at IS NULL`).run(now, ...rows.map(row => row.id));
      return rows.map(row => artifactFromRow(row));
    },
    artifactGcBatch({ limit = 100, after } = {}) {
      limit = boundedLimit(limit, 100, 100);
      if (after !== undefined && (typeof after !== 'string' || !artifactUuid.test(after))) throw new Error('Invalid artifact cursor.');
      const rows = after
        ? db.prepare('SELECT handle AS id,run_id,purpose,created_at,metadata,retired_at FROM artifact_refs WHERE retired_at IS NOT NULL AND handle>? ORDER BY handle LIMIT ?').all(after, limit)
        : db.prepare('SELECT handle AS id,run_id,purpose,created_at,metadata,retired_at FROM artifact_refs WHERE retired_at IS NOT NULL ORDER BY handle LIMIT ?').all(limit);
      return { items: rows.map(row => ({ ...artifactFromRow(row), retiredAt: row.retired_at })), nextCursor: rows.length === limit ? rows.at(-1).id : null };
    },
    deleteRetiredArtifact(handle) {
      if (typeof handle !== 'string' || !artifactUuid.test(handle)) throw new Error('Invalid artifact reference.');
      return Number(db.prepare('DELETE FROM artifact_refs WHERE handle=? AND retired_at IS NOT NULL').run(handle).changes);
    },
    saveRun(run) {
      run.updatedAt = clock();
      db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, updated_at=excluded.updated_at, data=excluded.data').run(run.id, run.messageKey, run.conversationKey, run.status, run.updatedAt, JSON.stringify(run));
      return run;
    },
    getAction: key => parse(db.prepare('SELECT data FROM actions WHERE key = ?').get(key)),
    actionFingerprint:key=>db.prepare('SELECT recovery_digest(data) AS fingerprint FROM actions WHERE key=?').get(key)?.fingerprint,
    unresolvedActions(runId,{limit=101}={}) {
      limit=boundedLimit(limit,101,101);
      return db.prepare(`SELECT key,state,CASE WHEN json_valid(data) THEN json_extract(data,'$.effect') END AS effect
        FROM actions INDEXED BY actions_run_state WHERE run_id=? AND state IN ('executing','uncertain') LIMIT ?`).all(runId,limit)
        .map(row=>({key:row.key,state:row.state,effect:row.effect}));
    },
    actions: () => db.prepare('SELECT data FROM actions').all().map(parse),
    saveAction(action) {
      db.prepare('INSERT INTO actions VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET state=excluded.state,data=excluded.data').run(action.key, action.runId, action.state, JSON.stringify(action));
    },
    getMeta: key => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value,
    getMetaBounded(key,maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes<1 || maxBytes>1_048_576) throw new Error('Invalid metadata byte limit.');
      return db.prepare("SELECT CASE WHEN typeof(value)='text' AND length(CAST(value AS BLOB))<=? THEN value END AS value FROM meta WHERE key=?").get(maxBytes,key)?.value;
    },
    setMeta: (key, value) => db.prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value),
    deleteMeta: key => db.prepare('DELETE FROM meta WHERE key=?').run(key),
    audit(event, run, { actor = null, target = null, ...details } = {}) {
      db.prepare('INSERT INTO audit(at,event,run_id,actor,target,details) VALUES (?,?,?,?,?,?)').run(clock(), event, run?.id ?? null, actor, target, JSON.stringify(details));
    },
    transaction(callback) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = callback(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    purge: settings => purgeStore(store, db, clock, settings),
    close() { if (!closed) { closed = true; db.close(); release(); } }
  };
  function batchRuns(statuses, limit, after) {
    limit = boundedLimit(limit, 100, 500);
    // These private call sites supply fixed statuses; literal predicates match the partial active index.
    const predicate = statuses === activeStatuses ? "p.status IN ('queued','running','awaiting_approval','ready_to_send','sending')" : "p.status='queued'";
    const index = statuses === activeStatuses ? ' INDEXED BY projection_active_sequence' : '';
    const rows = after
      ? db.prepare(`SELECT r.data,p.sequence,p.id FROM run_projection p${index} JOIN runs r ON r.id=p.id WHERE ${predicate} AND (p.sequence,p.id)>(?,?) ORDER BY p.sequence,p.id LIMIT ?`).all(after.sequence,after.id,limit)
      : db.prepare(`SELECT r.data,p.sequence,p.id FROM run_projection p${index} JOIN runs r ON r.id=p.id WHERE ${predicate} ORDER BY p.sequence,p.id LIMIT ?`).all(limit);
    return { items: rows.map(parse), nextCursor: rows.length === limit ? { sequence: rows.at(-1).sequence, id: rows.at(-1).id } : null };
  }
  return store;
}

function boundedLimit(limit, fallback, maximum) {
  return Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, maximum) : fallback;
}

function recoveryPageRows(db,limit,after) {
  const position=after?'WHERE (p.sequence,p.id)>(?,?)':'';
  const args=after?[after.sequence,after.id,limit]:[limit];
  return db.prepare(`WITH selected AS (SELECT p.* FROM run_projection p ${position} ORDER BY p.sequence,p.id LIMIT ?)
    SELECT p.*,recovery_digest(r.data) AS fingerprint,
      CASE WHEN json_valid(r.data) THEN CASE WHEN json_type(r.data,'$.grants')='object'
        THEN EXISTS(SELECT 1 FROM json_each(r.data,'$.grants') LIMIT 1) ELSE 0 END ELSE 0 END AS approved
    FROM selected p JOIN runs r ON r.id=p.id ORDER BY p.sequence,p.id`).all(...args);
}

function actionPageRows(db,limit,after) {
  const position=after?'WHERE key>?':'';
  const args=after?[after,limit]:[limit];
  return db.prepare(`WITH selected AS (SELECT * FROM actions ${position} ORDER BY key LIMIT ?)
    SELECT key,run_id,state,recovery_digest(data) AS fingerprint,
      CASE WHEN json_valid(data) THEN json_extract(data,'$.effect') END AS effect,
      CASE WHEN json_valid(data) THEN json_extract(data,'$.tool') END AS tool
    FROM selected ORDER BY key`).all(...args);
}

function safeRecoveryAction(row) {
  const states=['pending','executing','completed','failed','uncertain'];
  return {key:row.key,runId:row.run_id,state:states.includes(row.state)?row.state:'unknown',
    effect:['read','write'].includes(row.effect)?row.effect:'unknown',
    tool:typeof row.tool==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(row.tool)?row.tool:null,fingerprint:row.fingerprint};
}

function validateRetention(contentHours, auditDays) {
  if (!Number.isSafeInteger(contentHours) || contentHours < 1 || !Number.isSafeInteger(auditDays) || auditDays < 1) throw new Error('Invalid retention limits.');
}

function recoveryRows(db, limit, after) {
  const args = [];
  const branches = ["status='running'", "status='sending'", 'active_operation=1', "uncertain_actions>0 AND status<>'uncertain'"].map(predicate => {
    const cursor = after ? ' AND (sequence,id)>(?,?)' : '';
    if (after) args.push(after.sequence, after.id);
    args.push(limit);
    return `SELECT id,sequence FROM (SELECT id,sequence FROM run_projection WHERE ${predicate}${cursor} ORDER BY sequence,id LIMIT ?)`;
  });
  args.push(limit);
  // Each indexed branch contributes at most limit metadata rows, before deduplication and the content join.
  return db.prepare(`WITH candidates AS (${branches.join(' UNION ')})
    SELECT r.data,p.sequence,p.id FROM (SELECT id,sequence FROM candidates ORDER BY sequence,id LIMIT ?) p
    JOIN runs r ON r.id=p.id ORDER BY p.sequence,p.id`).all(...args);
}

function retentionRows(db, cutoff, limit) {
  // Both branches seek an expiry index and contribute at most limit metadata candidates.
  return db.prepare(`WITH candidates AS (
    SELECT id,created_at FROM (SELECT id,created_at FROM run_projection WHERE content_expired=0 AND created_at<=? ORDER BY created_at,id LIMIT ?)
    UNION
    SELECT id,created_at FROM (SELECT id,created_at FROM run_projection INDEXED BY projection_result_expiry WHERE result_actions>0 AND created_at<=? ORDER BY created_at,id LIMIT ?)
  ) SELECT r.data FROM (SELECT id,created_at FROM candidates ORDER BY created_at,id LIMIT ?) p
    JOIN runs r ON r.id=p.id ORDER BY p.created_at,p.id`).all(cutoff,limit,cutoff,limit,limit);
}

function safeBudget(row) {
  if (!row.budget_present) return undefined;
  return Object.fromEntries([['modelCalls', row.model_calls], ['toolCalls', row.tool_calls], ['activeMs', row.active_ms]].filter(([, value]) => value !== null));
}

function safeProjection(row) {
  return { id: row.id, status: row.status, updatedAt: row.updated_at, createdAt: row.created_at, sequence: row.sequence,
    budget: safeBudget(row), responseKind: row.response_kind, approvalId: row.approval_id, contentExpired: Boolean(row.content_expired) };
}
