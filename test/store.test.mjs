import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile,chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { openStore } from '../src/store.mjs';

async function fixture() {
  return mkdtemp(join(tmpdir(), 'ma-store-'));
}

function run(id, createdAt, status = 'completed') {
  return {
    id, messageKey: `message-${id}`, conversationKey: `conversation-${id}`, status, createdAt,
    configHash: 'synthetic-config-hash', budget: { modelCalls: 2, toolCalls: 1, activeMs: 25 },
    mail: { body: 'SYNTHETIC_PRIVATE_CONTENT' }, reply: 'SYNTHETIC_PRIVATE_CONTENT',
    messages: [{ role: 'user', content: 'SYNTHETIC_PRIVATE_CONTENT' }], instructionSnapshot: 'SYNTHETIC_PRIVATE_CONTENT',
    pending: [{ args: { note: 'SYNTHETIC_PRIVATE_CONTENT' } }], approval: { args: { note: 'SYNTHETIC_PRIVATE_CONTENT' } },
    grants: { grant: { args: { note: 'SYNTHETIC_PRIVATE_CONTENT' } } },
  };
}

test('retention expires content at the exact boundary and permanently preserves run/action fences', async (t) => {
  const root = await fixture(t);
  let now = 0;
  const store = openStore(root, { identity: 'synthetic', clock: () => now });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.saveRun(run('expired', now));
  store.saveAction({ key: 'action-1', runId: 'expired', state: 'completed', effect: 'write', tool: 'records.append', result: { content: 'SYNTHETIC_PRIVATE_CONTENT' } });
  now = 3_600_000 - 1;
  assert.equal(store.purge({ contentHours: 1, auditDays: 1 }).runsExpired, 0);
  now++;
  assert.deepEqual(store.purge({ contentHours: 1, auditDays: 1 }), { runsExpired: 1, actionsExpired: 1, auditDeleted: 0, expiredRunIds: ['expired'] });
  const expired = store.byMessage('message-expired');
  assert.equal(expired.contentExpired, true);
  assert.equal(expired.status, 'completed');
  assert.equal(expired.createdAt, 0);
  assert.equal(expired.configHash, 'synthetic-config-hash');
  assert.deepEqual(expired.budget, { modelCalls: 2, toolCalls: 1, activeMs: 25 });
  for (const field of ['mail', 'reply', 'messages', 'instructionSnapshot', 'pending', 'approval', 'grants']) assert.equal(Object.hasOwn(expired, field), false);
  assert.equal(store.getAction('action-1').state, 'completed');
  assert.equal(Object.hasOwn(store.getAction('action-1'), 'result'), false);
  assert.deepEqual(store.purge({ contentHours: 1, auditDays: 1 }), { runsExpired: 0, actionsExpired: 0, auditDeleted: 0 });
  const db = await readFile(join(root, 'agent.sqlite'));
  assert.equal(db.includes(Buffer.from('SYNTHETIC_PRIVATE_CONTENT')), false);
  assert.equal((await lstat(join(root, 'agent.sqlite-wal'))).size, 0);
});

test('versioned projections provide bounded safe pages, counts, and targeted recovery queries', async (t) => {
  const root = await fixture(t);
  let tick = 10;
  const store = openStore(root, { identity: 'synthetic', clock: () => tick++ });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const first = { ...run('first', 1, 'queued'), sequence: 1, mail: { sender: 'one@example.test', body: 'SECRET' } };
  const second = { ...run('second', 2, 'awaiting_approval'), sequence: 2, mail: { sender: 'one@example.test', body: 'SECRET' }, approval: { id: 'approval-2', args: { text: 'SECRET' } } };
  store.saveRun(first);
  store.saveRun(second);
  store.saveAction({ key: 'action-2', runId: 'second', state: 'executing', effect: 'write', tool: 'fixture.write' });
  assert.deepEqual(store.summary().counts, { queued: 1, running: 0, awaiting_approval: 1, ready_to_send: 0, sending: 0, completed: 0, failed: 0, ignored: 0, uncertain: 0 });
  assert.equal(store.runPage({ limit: 1 }).items[0].id, 'first');
  assert.equal(store.runPage({ limit: 1, after: { sequence: first.sequence, id: first.id } }).items[0].id, 'second');
  assert.equal(store.runPage({ limit: 1 }).items[0].mail, undefined);
  assert.equal(store.findApproval('approval-2').id, 'second');
  assert.equal(store.approvalPage().items[0].requester, 'one@example.test');
  assert.equal(store.activeBatch({ limit: 1 }).items[0].id, 'first');
  assert.deepEqual(store.executingActionsBatch({ limit: 2 }).items.map(action => action.key), ['action-2']);
  assert.equal(store.findUncertainAction('second'), undefined);
  assert.equal(store.recoveryBatch().items.some(item => item.id === 'second'), false);
  first.status = 'completed';
  store.saveRun(first);
  assert.equal(store.summary().counts.queued, 0);
  assert.equal(store.summary().counts.completed, 1);
});

test('version zero backfill is atomic and rebuilds metadata projections once', async (t) => {
  const root = await fixture(t);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const db = new DatabaseSync(join(root, 'agent.sqlite'));
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY,message_key TEXT UNIQUE NOT NULL,conversation_key TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL,data TEXT NOT NULL);
    CREATE TABLE actions (key TEXT PRIMARY KEY,run_id TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE audit (seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,event TEXT NOT NULL,run_id TEXT,actor TEXT,target TEXT,details TEXT NOT NULL);
    INSERT INTO meta VALUES ('identity','synthetic');
    INSERT INTO runs VALUES ('legacy','message-legacy','conversation-legacy','queued',7,'{"id":"legacy","messageKey":"message-legacy","conversationKey":"conversation-legacy","status":"queued","createdAt":6,"sequence":2,"budget":{"modelCalls":0,"toolCalls":0,"activeMs":0},"mail":{"sender":"one@example.test","body":"PRIVATE"}}');`);
  db.close();
  const store = openStore(root, { identity: 'synthetic' });
  try {
    assert.equal(store.getMeta('schema_version'), '5');
    assert.equal(store.summary().counts.queued, 1);
    assert.deepEqual(store.runPage().items[0], { id: 'legacy', status: 'queued', updatedAt: 7, createdAt: 6, sequence: 2, budget: { modelCalls: 0, toolCalls: 0, activeMs: 0 }, responseKind: null, approvalId: null, contentExpired: false });
  } finally { store.close(); }
});

test('status and approval pages never parse retained run content and budget metadata is numeric only', async (t) => {
  const root = await fixture();
  const store = openStore(root, { identity: 'synthetic', clock: () => 9 });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.saveRun({ ...run('safe', 1, 'awaiting_approval'), sequence: 1,
    budget: { modelCalls: 2, toolCalls: 1, activeMs: 25, private: 'PRIVATE' },
    approval: { id: 'approval-safe', args: { intent: 'LOCAL_INTENT' } }, mail: { sender: 'one@example.test' } });
  const db = new DatabaseSync(join(root, 'agent.sqlite'));
  db.exec("DROP TRIGGER runs_projection_update; UPDATE runs SET data='not-json';");
  db.close();
  assert.deepEqual(store.runPage({ status: 'awaiting_approval' }).items[0].budget, { modelCalls: 2, toolCalls: 1, activeMs: 25 });
  assert.deepEqual(store.approvalPage({ limit: 1 }).items[0], { id: 'approval-safe', args: { intent: 'LOCAL_INTENT' }, runId: 'safe', requester: 'one@example.test' });
});

test('recovery selects indexed metadata before loading runs and tracks uncertain action transitions', async (t) => {
  const root = await fixture();
  const store = openStore(root, { identity: 'synthetic', clock: () => 9 });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  for (const [id, status, extra] of [['a', 'completed', {}], ['b', 'running', { activeOperation: {} }], ['c', 'completed', { activeOperation: {} }], ['d', 'completed', {}], ['e', 'uncertain', {}]]) {
    store.saveRun({ ...run(id, 1, status), sequence: 1, ...extra });
  }
  store.saveAction({ key: 'action-d', runId: 'd', state: 'uncertain' });
  store.saveAction({ key: 'action-e', runId: 'e', state: 'uncertain' });
  const db = new DatabaseSync(join(root, 'agent.sqlite'));
  db.exec("DROP TRIGGER runs_projection_update; UPDATE runs SET data='not-json' WHERE id IN ('a','e');");
  const plans = [
    ["SELECT id,sequence FROM run_projection WHERE status=? AND (sequence,id)>(?,?) ORDER BY sequence,id LIMIT ?", ['running', 0, '', 2], 'projection_status_sequence'],
    ["SELECT id,sequence FROM run_projection WHERE active_operation=1 AND (sequence,id)>(?,?) ORDER BY sequence,id LIMIT ?", [0, '', 2], 'projection_active_operation'],
    ["SELECT id,sequence FROM run_projection WHERE uncertain_actions>0 AND status<>'uncertain' AND (sequence,id)>(?,?) ORDER BY sequence,id LIMIT ?", [0, '', 2], 'projection_uncertain_recovery'],
    ["SELECT id FROM run_projection WHERE status=? AND (updated_at,id)>(?,?) ORDER BY updated_at,id LIMIT ?", ['queued', 0, '', 2], 'projection_status_page'],
    ["SELECT r.data,p.sequence,p.id FROM run_projection p INDEXED BY projection_active_sequence JOIN runs r ON r.id=p.id WHERE p.status IN ('queued','running','awaiting_approval','ready_to_send','sending') AND (p.sequence,p.id)>(?,?) ORDER BY p.sequence,p.id LIMIT ?", [0, '', 2], 'projection_active_sequence'],
    ["SELECT key,data FROM actions WHERE state='executing' AND key>? ORDER BY key LIMIT ?", ['', 2], 'actions_state_key'],
    ['SELECT seq FROM audit WHERE at<=? ORDER BY at,seq LIMIT 100', [9], 'audit_retention']
  ];
  for (const [sql, args, index] of plans) {
    const details = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail).join('\n');
    assert.match(details, new RegExp(index));
    assert.doesNotMatch(details, /SCAN runs|TEMP B-TREE/);
  }
  db.close();
  const first = store.recoveryBatch({ limit: 2 });
  assert.deepEqual(first.items.map(item => item.id), ['b', 'c']);
  assert.deepEqual(store.recoveryBatch({ limit: 2, after: first.nextCursor }).items.map(item => item.id), ['d']);
  assert.throws(() => store.transaction(() => { store.saveAction({ key: 'action-d', runId: 'd', state: 'completed' }); throw new Error('rollback'); }), /rollback/);
  assert.deepEqual(store.recoveryBatch().items.map(item => item.id), ['b', 'c', 'd']);
  store.saveAction({ key: 'action-d', runId: 'd', state: 'completed' });
  assert.deepEqual(store.recoveryBatch().items.map(item => item.id), ['b', 'c']);
});

test('status and approval cursors remain stable across updates and exclude invalid numeric budget values', async (t) => {
  const root = await fixture();
  let tick = 1;
  const store = openStore(root, { identity: 'synthetic', clock: () => tick++ });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const first = { ...run('first', 1, 'awaiting_approval'), sequence: 1, approval: { id: 'approval-first' } };
  const second = { ...run('second', 1, 'awaiting_approval'), sequence: 2, approval: { id: 'approval-second' },
    budget: { modelCalls: 'PRIVATE', toolCalls: -1, activeMs: 9007199254740992 } };
  store.saveRun(first);
  store.saveRun(second);
  const statusPage = store.runPage({ limit: 1 });
  const approvalPage = store.approvalPage({ limit: 1 });
  store.saveRun(first);
  assert.deepEqual(statusPage.nextCursor, { sequence: 1, id: 'first' });
  assert.deepEqual(store.runPage({ after: statusPage.nextCursor }).items.map(item => item.id), ['second']);
  assert.deepEqual(store.approvalPage({ after: approvalPage.nextCursor }).items.map(item => item.runId), ['second']);
  assert.deepEqual(store.runPage({ after: statusPage.nextCursor }).items[0].budget, {});
});

test('uncertain action counts stay exact across run saves, repeated updates, deletions, and terminal fences', async (t) => {
  const root = await fixture();
  const store = openStore(root, { identity: 'synthetic', clock: () => 9 });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const retained = { ...run('retained', 1), sequence: 1 };
  store.saveRun(retained);
  const first = { key: 'first', runId: retained.id, state: 'uncertain' };
  const second = { key: 'second', runId: retained.id, state: 'uncertain' };
  store.saveAction(first);
  store.saveAction(second);
  store.saveRun(retained);
  store.saveAction({ ...first, state: 'completed' });
  store.saveAction(second);
  assert.equal(store.recoveryBatch().items.length, 1);
  retained.status = 'uncertain';
  store.saveRun(retained);
  assert.equal(store.recoveryBatch().items.length, 0);
  retained.status = 'completed';
  store.saveRun(retained);
  assert.equal(store.recoveryBatch().items.length, 1);
  const db = new DatabaseSync(join(root, 'agent.sqlite'));
  assert.equal(db.prepare('SELECT uncertain_actions FROM run_projection WHERE id=?').get(retained.id).uncertain_actions, 1);
  db.prepare('DELETE FROM actions WHERE key=?').run(second.key);
  assert.equal(db.prepare('SELECT uncertain_actions FROM run_projection WHERE id=?').get(retained.id).uncertain_actions, 0);
  db.close();
  assert.equal(store.recoveryBatch().items.length, 0);
});

function downgradeProjectionToVersionOne(db) {
  downgradeProjectionToVersionTwo(db);
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'runs_projection_%' OR name LIKE 'actions_uncertainty_%')").all();
  for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
  for (const name of ['projection_active_operation', 'projection_uncertain_recovery', 'projection_status_page', 'projection_sequence', 'projection_active_sequence', 'actions_state_key']) db.exec(`DROP INDEX IF EXISTS ${name}`);
  for (const name of ['budget_present', 'model_calls', 'tool_calls', 'active_ms', 'active_operation', 'uncertain_actions']) db.exec(`ALTER TABLE run_projection DROP COLUMN ${name}`);
  db.exec("UPDATE meta SET value='1' WHERE key='schema_version';");
}

function downgradeProjectionToVersionTwo(db) {
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'runs_projection_%' OR name LIKE 'actions_result_%')").all();
  for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
  for (const name of ['projection_result_expiry', 'actions_results']) db.exec(`DROP INDEX IF EXISTS ${name}`);
  db.exec("ALTER TABLE run_projection DROP COLUMN result_actions; UPDATE meta SET value='2' WHERE key='schema_version';");
}

test('version one metadata upgrades atomically and preserves counters and recovery fences', async (t) => {
  const root = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  let store = openStore(root, { identity: 'synthetic' });
  store.saveRun({ ...run('legacy', 1, 'completed'), sequence: 3 });
  store.saveAction({ key: 'legacy-action', runId: 'legacy', state: 'uncertain' });
  store.close();
  const db = new DatabaseSync(join(root, 'agent.sqlite'));
  downgradeProjectionToVersionOne(db);
  db.close();
  store = openStore(root, { identity: 'synthetic' });
  try {
    assert.equal(store.getMeta('schema_version'), '5');
    assert.equal(store.summary().counts.completed, 1);
    assert.deepEqual(store.runPage().items[0].budget, { modelCalls: 2, toolCalls: 1, activeMs: 25 });
    assert.equal(store.recoveryBatch().items[0].id, 'legacy');
  } finally { store.close(); }
});

test('failed version zero, one, and two migrations roll back schema, counters, and version', async (t) => {
  for (const version of [0, 1, 2]) {
    const root = await fixture();
    t.after(async () => { await rm(root, { recursive: true, force: true }); });
    const store = openStore(root, { identity: 'synthetic' });
    store.saveRun(run('legacy', 1));
    store.saveAction({ key: 'legacy-action', runId: 'legacy', state: 'completed', result: 'PRIVATE' });
    store.close();
    let db = new DatabaseSync(join(root, 'agent.sqlite'));
    if (version === 2) downgradeProjectionToVersionTwo(db);
    else downgradeProjectionToVersionOne(db);
    if (version === 0) {
      for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()) db.exec(`DROP TRIGGER ${name}`);
      db.exec("DROP TABLE run_projection; DROP TABLE status_counts; DELETE FROM meta WHERE key='schema_version';");
    }
    if (version === 2) db.exec("CREATE TRIGGER fail_projection_migration BEFORE UPDATE ON run_projection BEGIN SELECT RAISE(ABORT,'synthetic migration failure'); END;");
    else db.exec("UPDATE runs SET data='malformed';");
    const before = db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
    const beforeCounts = version > 0 ? db.prepare('SELECT status,count FROM status_counts ORDER BY status').all() : null;
    db.close();
    assert.throws(() => openStore(root, { identity: 'synthetic' }), /malformed JSON|synthetic migration failure/);
    db = new DatabaseSync(join(root, 'agent.sqlite'));
    assert.deepEqual(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(), before);
    if (beforeCounts) assert.deepEqual(db.prepare('SELECT status,count FROM status_counts ORDER BY status').all(), beforeCounts);
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value, version > 0 ? String(version) : undefined);
    db.close();
    await assert.rejects(lstat(join(root, 'owner.lock')), { code: 'ENOENT' });
  }
});

test('retention expires a capped run batch and continues on the next maintenance pass', async (t) => {
  const root = await fixture(t);
  let now = 4_000_000;
  const store = openStore(root, { identity: 'synthetic', clock: () => now });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  for (let index = 0; index < 105; index++) store.saveRun(run(`batch-${String(index).padStart(3, '0')}`, 0));
  store.saveRun(run('queued-z', 0, 'queued'));
  now += 3_600_000;
  const retention = { contentHours: 1, auditDays: 1 };
  assert.equal(store.hasExpiredContent(retention), true);
  assert.equal(store.purge(retention).runsExpired, 100);
  assert.equal(store.hasExpiredContent(retention), true);
  assert.equal(store.summary().counts.completed, 105);
  assert.equal(store.purge(retention).runsExpired, 6);
  assert.equal(store.hasExpiredContent(retention), false);
  assert.equal(store.getRun('queued-z').status, 'failed');
  assert.equal(store.runPage({ limit: 500 }).items.filter(item => item.contentExpired).length, 106);
});

test('version two result metadata migrates and indexed retention skips permanent fences with no expired content', async (t) => {
  const root = await fixture();
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  let store = openStore(root, { identity: 'synthetic', clock: () => 3_600_000 });
  for (let index = 0; index < 20; index++) {
    const id = `fence-${index}`;
    store.saveRun({ ...run(id, 0), contentExpired: true });
    store.saveAction({ key: `action-${id}`, runId: id, state: 'completed' });
  }
  store.saveRun({ ...run('future', 3_600_000), contentExpired: true });
  store.saveAction({ key: 'future-action', runId: 'future', state: 'completed', result: 'PRIVATE' });
  store.close();
  let db = new DatabaseSync(join(root, 'agent.sqlite'));
  downgradeProjectionToVersionTwo(db);
  db.close();
  store = openStore(root, { identity: 'synthetic', clock: () => 3_600_000 });
  try {
    assert.equal(store.getMeta('schema_version'), '5');
    assert.equal(store.hasExpiredContent({ contentHours: 1, auditDays: 1 }), false);
    assert.deepEqual(store.reapBatch({ cutoff: 0 }), []);
    db = new DatabaseSync(join(root, 'agent.sqlite'));
    assert.equal(db.prepare("SELECT result_actions FROM run_projection WHERE id='future'").get().result_actions, 1);
    const plans = [
      ['SELECT id,created_at FROM run_projection WHERE content_expired=0 AND created_at<=? ORDER BY created_at,id LIMIT ?', [0,100], 'projection_expiry'],
      ['SELECT id,created_at FROM run_projection WHERE result_actions>0 AND created_at<=? ORDER BY created_at,id LIMIT ?', [0,100], 'projection_result_expiry'],
      ["SELECT data FROM actions INDEXED BY actions_results WHERE run_id IN (?,?) AND json_type(data,'$.result') IS NOT NULL ORDER BY key LIMIT ?", ['fence-0','future',100], 'actions_results']
    ];
    for (const [sql,args,index] of plans) {
      const details = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(row => row.detail).join('\n');
      assert.match(details, new RegExp(index));
      assert.doesNotMatch(details, /SCAN (?:runs|actions|p)\b/);
    }
    let reapSql;
    const originalPrepare = DatabaseSync.prototype.prepare;
    try {
      DatabaseSync.prototype.prepare = function (sql) {
        if (sql.startsWith('WITH candidates AS')) reapSql = sql;
        return originalPrepare.call(this, sql);
      };
      store.reapBatch({ cutoff: 0, limit: 100 });
    } finally { DatabaseSync.prototype.prepare = originalPrepare; }
    const details = db.prepare(`EXPLAIN QUERY PLAN ${reapSql}`).all(0,100,0,100,100).map(row => row.detail).join('\n');
    assert.match(details, /SEARCH run_projection USING COVERING INDEX projection_expiry/);
    assert.match(details, /SEARCH run_projection USING INDEX projection_result_expiry/);
    assert.match(details, /SEARCH r USING INDEX sqlite_autoindex_runs_1/);
    assert.doesNotMatch(details, /SCAN (?:run_projection|actions|r)\b/);
    assert.equal(reapSql.match(/LIMIT \?/g).length, 3); // Two capped inputs and one cap before loading content.
    db.exec("DROP TRIGGER runs_projection_update; UPDATE runs SET data='not-json' WHERE id LIKE 'fence-%';");
    db.close();
    assert.equal(store.hasExpiredContent({ contentHours: 1, auditDays: 1 }), false);
    assert.deepEqual(store.reapBatch({ cutoff: 0 }), []);
  } finally { store.close(); }
});

test('result counters are atomic and residual action content expires in capped batches', async (t) => {
  const root = await fixture();
  const store = openStore(root, { identity: 'synthetic', clock: () => 3_600_000 });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const retained = { ...run('retained', 0), contentExpired: true };
  store.saveRun(retained);
  for (let index = 0; index < 105; index++) store.saveAction({ key: `action-${String(index).padStart(3,'0')}`, runId: retained.id, state: 'completed', result: 'PRIVATE' });
  store.saveRun(retained);
  assert.throws(() => store.transaction(() => { store.saveAction({ key: 'action-000', runId: retained.id, state: 'completed' }); throw new Error('rollback'); }), /rollback/);
  assert.equal(store.purge({ contentHours: 1, auditDays: 1 }).actionsExpired, 100);
  assert.equal(store.hasExpiredContent({ contentHours: 1, auditDays: 1 }), true);
  assert.equal(store.purge({ contentHours: 1, auditDays: 1 }).actionsExpired, 5);
  assert.equal(store.hasExpiredContent({ contentHours: 1, auditDays: 1 }), false);
  store.saveAction({ key: 'nullable', runId: retained.id, state: 'completed', result: null });
  assert.equal(store.hasExpiredContent({ contentHours: 1, auditDays: 1 }), true);
  const db = new DatabaseSync(join(root, 'agent.sqlite'));
  db.exec("DELETE FROM actions WHERE key='nullable';");
  assert.equal(db.prepare('SELECT result_actions FROM run_projection WHERE id=?').get(retained.id).result_actions, 0);
  db.close();
  assert.equal(store.hasExpiredContent({ contentHours: 1, auditDays: 1 }), false);
});

test('targeted exact-boundary expiry clears content while preserving a sending fence', async (t) => {
  const root = await fixture(t);
  let now = 0;
  const store = openStore(root, { identity: 'synthetic', clock: () => now });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.saveRun(run('sending-expiry', 0, 'sending'));
  store.saveAction({ key: 'send-fence', runId: 'sending-expiry', state: 'uncertain', effect: 'write', result: { content: 'PRIVATE' } });
  assert.equal(store.expireRunById('sending-expiry', { contentHours: 1 }), false);
  now = 3_600_000;
  assert.deepEqual(store.expireRunById('sending-expiry', { contentHours: 1 }), { runExpired: true, actionsExpired: 1, expiredRunIds: ['sending-expiry'] });
  assert.equal(store.getRun('sending-expiry').status, 'uncertain');
  assert.deepEqual(store.getRun('sending-expiry').uncertainty, { kind: 'send' });
  assert.equal(Object.hasOwn(store.getAction('send-fence'), 'result'), false);
  assert.equal(store.hasExpiredContent({ contentHours: 1, auditDays: 1 }), false);
});

test('future schema versions fail without initializing or changing state', async (t) => {
  const root = await fixture(t);
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const db = new DatabaseSync(join(root, 'agent.sqlite'));
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('schema_version', '999');");
  db.close();
  const before = await readFile(join(root, 'agent.sqlite'));
  assert.throws(() => openStore(root, { identity: 'synthetic' }), /newer.*schema|schema.*newer/i);
  assert.deepEqual(await readFile(join(root, 'agent.sqlite')), before);
  await assert.rejects(lstat(join(root, 'owner.lock')), { code: 'ENOENT' });
});

test('expired queued/running/approval work fails while in-flight and uncertain sends remain fenced', async (t) => {
  const root = await fixture(t);
  let now = 0;
  const store = openStore(root, { identity: 'synthetic', clock: () => now });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  for (const status of ['queued', 'running', 'awaiting_approval', 'ready_to_send', 'sending', 'uncertain', 'ignored', 'failed']) {
    const saved = run(status, 0, status);
    if (status === 'uncertain') saved.uncertainty = { kind: 'tool', key: 'uncertain-action' };
    store.saveRun(saved);
  }
  store.saveAction({ key: 'uncertain-action', runId: 'uncertain', state: 'uncertain', effect: 'write', tool: 'records.append' });
  store.saveRun(run('fresh', 3_600_000));
  now = 3_600_000;
  store.purge({ contentHours: 1, auditDays: 1 });
  for (const status of ['queued', 'running', 'awaiting_approval', 'ready_to_send']) assert.equal(store.getRun(status).status, 'failed');
  assert.deepEqual(store.getRun('sending').uncertainty, { kind: 'send' });
  assert.equal(store.getRun('sending').status, 'uncertain');
  assert.deepEqual(store.getRun('uncertain').uncertainty, { kind: 'tool', key: 'uncertain-action' });
  assert.equal(store.getAction('uncertain-action').state, 'uncertain');
  assert.equal(store.getRun('fresh').contentExpired, undefined);
});

test('audit retention uses the injected clock and removes records at its cutoff', async (t) => {
  const root = await fixture(t);
  let now = 0;
  const store = openStore(root, { identity: 'synthetic', clock: () => now });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.audit('old', undefined, { decision: 'synthetic' });
  now = 86_400_000;
  store.audit('fresh', undefined, { decision: 'synthetic' });
  assert.equal(store.purge({ contentHours: 1, auditDays: 1 }).auditDeleted, 1);
  const inspect = new DatabaseSync(join(root, 'agent.sqlite'));
  try { assert.deepEqual(inspect.prepare('SELECT event FROM audit').all().map((row) => row.event), ['fresh']); }
  finally { inspect.close(); }
});

test('lock, database and SQLite sidecars reject symlinks before following targets', async (t) => {
  for (const name of ['owner.lock', 'owner.sqlite', 'owner.sqlite-journal', 'owner.sqlite-wal', 'owner.sqlite-shm', 'agent.sqlite', 'agent.sqlite-wal', 'agent.sqlite-shm']) {
    const root = await fixture(t);
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, 'synthetic-target');
    await writeFile(target, 'do not touch', { mode: 0o600 });
    await symlink(target, join(root, name));
    assert.throws(() => openStore(root, { identity: 'synthetic' }), /symlink/);
    assert.equal(await readFile(target, 'utf8'), 'do not touch');
  }
});

test('SQLite ownership rejects a second owner independently of PID metadata', async (t) => {
  const root = await fixture(t);
  const lock = new DatabaseSync(join(root, 'owner.sqlite'));
  await chmod(join(root,'owner.sqlite'),0o600);
  lock.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
  let unexpected;
  try {
    assert.throws(() => { unexpected = openStore(root, { identity: 'synthetic' }); }, /owned or locked/);
    await assert.rejects(lstat(join(root, 'owner.lock')), { code: 'ENOENT' });
  } finally {
    unexpected?.close();
    lock.exec('ROLLBACK');
    lock.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('stale or reused PID metadata is rewritten only after ownership is acquired', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'owner.lock'), JSON.stringify({ pid: process.pid, token: 'stale' }), { mode: 0o600 });
  const store = openStore(root, { identity: 'synthetic' });
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const owner = JSON.parse(await readFile(join(root, 'owner.lock'), 'utf8'));
  assert.equal(owner.pid, process.pid);
  assert.notEqual(owner.token, 'stale');
  assert.throws(() => openStore(root, { identity: 'synthetic' }), /owned or locked/);
  assert.equal(JSON.parse(await readFile(join(root, 'owner.lock'), 'utf8')).token, owner.token);
});

async function waitReady(child) {
  return new Promise((resolveReady, reject) => {
    let output = '';
    const timer = setTimeout(() => done(new Error('Synthetic owner did not become ready')), 5000);
    const onData = (chunk) => { output += chunk; if (output.includes('READY\n')) done(); };
    const onError = () => done(new Error('Synthetic owner failed'));
    function done(error) {
      clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.removeListener('error', onError);
      child.removeListener('exit', onError);
      if (error) reject(error); else resolveReady();
    }
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('exit', onError);
  });
}

test('independent process ownership survives contention and releases automatically after SIGKILL', async (t) => {
  const root = await fixture(t);
  const source = `
    import { openStore } from ${JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)};
    const store = openStore(process.argv[1], { identity: 'synthetic' });
    process.stdin.on('data', () => store.getMeta('synthetic-proof'));
    store.setMeta('synthetic-proof', 'durable');
    process.stdout.write('READY\\n');
    process.stdin.resume();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await rm(root, { recursive: true, force: true });
  });
  await waitReady(child);
  let unexpected;
  try { assert.throws(() => { unexpected = openStore(root, { identity: 'synthetic' }); }, /owned or locked/); }
  finally { unexpected?.close(); }
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const recovered = openStore(root, { identity: 'synthetic' });
  try { assert.equal(recovered.getMeta('synthetic-proof'), 'durable'); }
  finally { recovered.close(); }
});

test('ownership metadata cleanup failures still release the held SQLite lock', async (t) => {
  const root = await fixture(t);
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = openStore(root, { identity: 'synthetic' });
  const target = join(root, 'synthetic-untouched');
  await writeFile(target, 'do not touch');
  await rm(join(root, 'owner.lock'));
  await symlink(target, join(root, 'owner.lock'));
  assert.throws(() => store.close(), /symlink/);
  assert.equal(await readFile(target, 'utf8'), 'do not touch');
  await rm(join(root, 'owner.lock'));
  const resumed = openStore(root, { identity: 'synthetic' });
  resumed.close();
});
