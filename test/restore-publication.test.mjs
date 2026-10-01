import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,lstat,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,acquireStoppedLease} from '../src/store.mjs';

test('a sibling restore reservation blocks startup before a missing state root can be initialized',async t=>{
  const parent=await mkdtemp(join(tmpdir(),'ma-publication-'));
  t.after(()=>rm(parent,{recursive:true,force:true}));
  const target=join(parent,'restored');
  await writeFile(join(parent,'.restored.restore-incomplete'),'reserved',{mode:0o600});
  assert.throws(()=>openStore(target,{identity:'synthetic'}),/restore publication is incomplete/i);
  await assert.rejects(lstat(target),{code:'ENOENT'});
});

test('an inner restore marker blocks application access while permitting stopped maintenance ownership',async t=>{
  const root=await mkdtemp(join(tmpdir(),'ma-publication-inner-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'.restore-incomplete'),'reserved',{mode:0o600});
  assert.throws(()=>openStore(root,{identity:'synthetic'}),/restore publication is incomplete/i);
  await assert.rejects(lstat(join(root,'agent.sqlite')),{code:'ENOENT'});
  await assert.rejects(lstat(join(root,'owner.sqlite')),{code:'ENOENT'});
  const release=acquireStoppedLease(root);release();
});

test('a dangling reservation symlink also blocks startup without following or removing it',async t=>{
  const parent=await mkdtemp(join(tmpdir(),'ma-publication-link-'));
  t.after(()=>rm(parent,{recursive:true,force:true}));
  const target=join(parent,'restored');
  const reservation=join(parent,'.restored.restore-incomplete');
  await symlink(join(parent,'absent'),reservation);
  assert.throws(()=>openStore(target,{identity:'synthetic'}),/restore publication is incomplete/i);
  assert.equal((await lstat(reservation)).isSymbolicLink(),true);
  await assert.rejects(lstat(target),{code:'ENOENT'});
});
