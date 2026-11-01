import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {CheckpointManager} from './git.js';

test('real checkpoint preserves binary bytes and stays bound to its workspace',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-checkpoint-real-'));
  const workspace=path.join(root,'workspace');const outside=path.join(root,'outside');
  await fs.mkdir(workspace);await fs.mkdir(outside);
  try{
    const original=Buffer.from([0x4d,0x5a,0x00,0xff,0x80,0x41]);const file=path.join(workspace,'program.exe');
    await fs.writeFile(file,original);const manager=new CheckpointManager();
    await manager.captureFile(workspace,'binary','Real binary preservation','program.exe');
    const changed=Buffer.from([1,2,3]);await fs.writeFile(file,changed);
    const wrong=await manager.rollback(outside,'binary');assert.equal(wrong.success,false,'A checkpoint must refuse another workspace');
    assert.deepEqual(await fs.readFile(file),changed,'refusing a different workspace must not change the original file');
    const restored=await manager.rollback(workspace,'binary');assert.equal(restored.success,true);assert.deepEqual(await fs.readFile(file),original);
    await fs.writeFile(path.join(outside,'canary.txt'),'do not read via checkpoint');
    await assert.rejects(()=>manager.captureFile(workspace,'escape','outside','../outside/canary.txt'),/refusé|hors/i);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('rollback rejects a corrupted persisted snapshot before changing any workspace file',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-checkpoint-corrupt-'));
  const workspace=path.join(root,'workspace');await fs.mkdir(workspace);
  try{
    const first=path.join(workspace,'first.txt');const second=path.join(workspace,'second.txt');
    await fs.writeFile(first,'first original');await fs.writeFile(second,'second original');
    const manager=new CheckpointManager();let persisted='';
    manager.onChange=(records)=>{persisted=JSON.stringify(records);};
    await manager.captureFile(workspace,'corrupt','Integrity preflight','first.txt');
    await manager.captureFile(workspace,'corrupt','Integrity preflight','second.txt');
    await fs.writeFile(first,'first current');await fs.writeFile(second,'second current');

    const reloaded=new CheckpointManager();reloaded.load(JSON.parse(persisted));
    const record=reloaded.getCheckpoint('corrupt')!;
    record.files['second.txt']='tampered snapshot content';
    const result=await reloaded.rollback(workspace,'corrupt');

    assert.equal(result.success,false);
    assert.deepEqual(result.restoredFiles,[]);
    assert.match(result.errors.join('\n'),/corrompu|intégrité/i);
    assert.equal(await fs.readFile(first,'utf-8'),'first current','preflight must reject before restoring earlier entries');
    assert.equal(await fs.readFile(second,'utf-8'),'second current');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('rollback verifies binary snapshot bytes and refuses altered base64 payloads',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-checkpoint-binary-corrupt-'));
  const workspace=path.join(root,'workspace');await fs.mkdir(workspace);
  try{
    const file=path.join(workspace,'artifact.bin');const original=Buffer.from([0,255,1,128,42]);
    await fs.writeFile(file,original);const manager=new CheckpointManager();
    await manager.captureFile(workspace,'binary-integrity','Binary integrity','artifact.bin');
    const record=manager.getCheckpoint('binary-integrity')!;
    record.binaryFiles!['artifact.bin']=Buffer.from([0,255,1,128,43]).toString('base64');
    const changed=Buffer.from([9,8,7]);await fs.writeFile(file,changed);

    const result=await manager.rollback(workspace,'binary-integrity');
    assert.equal(result.success,false);
    assert.deepEqual(await fs.readFile(file),changed,'corrupt snapshot bytes must not be written');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('rollback restores original absence and remains compatible with legacy records without digests',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-checkpoint-absence-'));
  const workspace=path.join(root,'workspace');await fs.mkdir(workspace);
  try{
    const created=path.join(workspace,'created.txt');const unrelated=path.join(workspace,'untracked-after-capture.txt');const manager=new CheckpointManager();
    await manager.captureFile(workspace,'absence','Originally absent','created.txt');
    assert.equal(manager.getCheckpoint('absence')?.files['created.txt'],null);
    await fs.writeFile(created,'created during the task');
    await fs.writeFile(unrelated,'new file outside this checkpoint');
    const removed=await manager.rollback(workspace,'absence');
    assert.equal(removed.success,true);assert.deepEqual(removed.restoredFiles,['created.txt (supprimé)']);
    await assert.rejects(fs.lstat(created),{code:'ENOENT'});
    assert.equal(await fs.readFile(unrelated,'utf-8'),'new file outside this checkpoint','rollback must preserve files that this checkpoint never captured');
    assert.equal((await manager.rollback(workspace,'absence')).success,true,'already absent is a valid restored state');

    const legacyFile=path.join(workspace,'legacy.txt');await fs.writeFile(legacyFile,'legacy original');
    const legacy=new CheckpointManager();
    legacy.load([{id:'legacy',timestamp:1,description:'old record format',files:{'legacy.txt':'legacy original'}}]);
    await fs.writeFile(legacyFile,'legacy changed');
    const legacyRestore=await legacy.rollback(workspace,'legacy');
    assert.equal(legacyRestore.success,true);
    assert.equal(await fs.readFile(legacyFile,'utf-8'),'legacy original');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('rollback preflights destination types so a later directory conflict cannot leave earlier files restored',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-checkpoint-partial-'));
  const workspace=path.join(root,'workspace');await fs.mkdir(workspace);
  try{
    const first=path.join(workspace,'first.txt');const second=path.join(workspace,'second.txt');
    await fs.writeFile(first,'first original');await fs.writeFile(second,'second original');
    const manager=new CheckpointManager();
    await manager.captureFile(workspace,'preflight','Destination preflight','first.txt');
    await manager.captureFile(workspace,'preflight','Destination preflight','second.txt');
    await fs.writeFile(first,'first current');await fs.rm(second);await fs.mkdir(second);

    const result=await manager.rollback(workspace,'preflight');
    assert.equal(result.success,false);
    assert.deepEqual(result.restoredFiles,[]);
    assert.equal(await fs.readFile(first,'utf-8'),'first current');
    assert.equal((await fs.stat(second)).isDirectory(),true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('capture refuses to merge one checkpoint id across different workspaces',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-checkpoint-workspace-collision-'));
  const firstWorkspace=path.join(root,'first');const secondWorkspace=path.join(root,'second');
  await fs.mkdir(firstWorkspace);await fs.mkdir(secondWorkspace);
  try{
    const firstFile=path.join(firstWorkspace,'first.txt');const crossFile=path.join(secondWorkspace,'second-only.txt');
    await fs.writeFile(firstFile,'first workspace original');await fs.writeFile(crossFile,'second workspace original');
    const manager=new CheckpointManager();
    await manager.captureFile(firstWorkspace,'shared-id','Workspace-bound snapshot','first.txt');
    await assert.rejects(manager.captureFile(secondWorkspace,'shared-id','Workspace-bound snapshot','second-only.txt'),/autre workspace/i);
    assert.deepEqual(Object.keys(manager.getCheckpoint('shared-id')!.files),['first.txt']);
    await fs.writeFile(firstFile,'first workspace changed');
    const rollback=await manager.rollback(firstWorkspace,'shared-id');
    assert.equal(rollback.success,true);
    assert.equal(await fs.readFile(firstFile,'utf-8'),'first workspace original');
    assert.equal(await fs.readFile(crossFile,'utf-8'),'second workspace original');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('capture refuses a leaf symlink instead of snapshotting bytes rollback cannot restore',async(t)=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-checkpoint-symlink-'));
  const workspace=path.join(root,'workspace');await fs.mkdir(workspace);
  try{
    const target=path.join(workspace,'target.txt');const link=path.join(workspace,'alias.txt');
    await fs.writeFile(target,'target bytes');
    try{await fs.symlink(target,link,process.platform==='win32'?'file':undefined);}
    catch(error){
      const code=(error as NodeJS.ErrnoException).code;
      if(code==='EPERM'||code==='EACCES'||code==='ENOTSUP'||code==='ENOSYS'){t.skip(`Symlink creation is unavailable in this environment (${code}).`);return;}
      throw error;
    }
    const manager=new CheckpointManager();
    await assert.rejects(manager.captureFile(workspace,'symlink','Reject leaf symlink','alias.txt'),/fichier ordinaire|symbolique/i);
    assert.equal(manager.getCheckpoint('symlink'),undefined,'a rejected path must not leave an empty checkpoint behind');
    assert.equal(await fs.readFile(target,'utf-8'),'target bytes');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
