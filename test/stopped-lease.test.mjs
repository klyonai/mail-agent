import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,chmod,lstat,symlink,writeFile,link} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,acquireStoppedLease} from '../src/store.mjs';

test('stopped maintenance lease excludes the daemon without opening or migrating its database',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ma-stopped-lease-'));
  const store=openStore(root,{identity:'synthetic'});
  t.after(()=>rm(root,{recursive:true,force:true}));
  assert.throws(()=>acquireStoppedLease(root),/owned or locked/);
  store.close();
  const before=await readFile(join(root,'agent.sqlite'));
  const release=acquireStoppedLease(root);
  try{
    assert.throws(()=>openStore(root,{identity:'synthetic'}),/owned or locked/);
    assert.deepEqual(await readFile(join(root,'agent.sqlite')),before);
  }finally{release();}
  const reopened=openStore(root,{identity:'synthetic'});reopened.close();
});

test('maintenance refuses linked or permissive ownership files without repairing or writing them',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ma-stopped-owner-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const outside=join(root,'external.sqlite');
  await writeFile(outside,'synthetic unrelated file',{mode:0o600});
  await link(outside,join(root,'owner.sqlite'));
  assert.throws(()=>acquireStoppedLease(root),/private/);
  assert.equal(await readFile(outside,'utf8'),'synthetic unrelated file');
  await rm(join(root,'owner.sqlite'));
  const store=openStore(root,{identity:'synthetic'});store.close();
  const ownerDatabase=join(root,'owner.sqlite');
  await chmod(ownerDatabase,0o644);
  const before=await readFile(ownerDatabase);
  assert.throws(()=>acquireStoppedLease(root),/private/);
  assert.equal((await lstat(ownerDatabase)).mode&0o777,0o644);
  assert.deepEqual(await readFile(ownerDatabase),before);
  await chmod(ownerDatabase,0o600);
  const ownerLock=join(root,'owner.lock');
  await link(outside,ownerLock);
  assert.throws(()=>acquireStoppedLease(root),/private/);
  assert.equal(await readFile(outside,'utf8'),'synthetic unrelated file');
});

test('maintenance rejects absent, symlinked or permissive state roots without repairing them',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ma-stopped-invalid-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  assert.throws(()=>acquireStoppedLease(join(root,'missing')));
  await assert.rejects(lstat(join(root,'missing')),{code:'ENOENT'});
  await chmod(root,0o755);
  assert.throws(()=>acquireStoppedLease(root),/private/);
  assert.equal((await lstat(root)).mode&0o777,0o755);
  await chmod(root,0o700);
  const link=join(root,'link');await symlink(root,link);
  assert.throws(()=>acquireStoppedLease(link),/private/);
  const badOwner=join(root,'owner.lock');await writeFile(badOwner,'unchanged');
  await rm(badOwner);await symlink(link,badOwner);
  assert.throws(()=>acquireStoppedLease(root),/symlink/);
});
