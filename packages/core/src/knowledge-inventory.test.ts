import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolExecutionContext } from '@mazz/shared';
import { KnowledgeManager } from './knowledge-engines.js';

const knowledgeDirectory=(home:string)=>path.join(home,'MAZZ_UNIVERSAL_KNOWLEDGE_STARTER','MAZZ_KNOWLEDGE');

async function prepare(home:string,vaults:string[],domains:Array<{vault:string;domain:string}> = []) {
  const root=knowledgeDirectory(home);
  await fs.mkdir(root,{recursive:true});
  await fs.writeFile(path.join(root,'VAULTS_MANIFEST.json'),JSON.stringify({schema_version:1,vaults,domains}),'utf8');
  return root;
}

async function inventory(home:string) {
  const manager=new KnowledgeManager(()=>({home,port:8095,python:'python'}));
  const tool=manager.tools().find(candidate=>candidate.definition.name==='knowledge.inventory');
  assert.ok(tool,'knowledge.inventory is registered by KnowledgeManager.tools()');
  return tool.execute({},{} as ToolExecutionContext);
}

test('knowledge.inventory counts only manifest vaults and returns exact file and byte totals',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-knowledge-inventory-'));
  try {
    const root=await prepare(home,['01_LANGUES','02_MATHS'],[
      {vault:'01_LANGUES',domain:'Francais'},
      {vault:'01_LANGUES',domain:'Anglais'},
      {vault:'02_MATHS',domain:'Algebre'}
    ]);
    const language=path.join(root,'01_LANGUES');
    await fs.mkdir(path.join(language,'nested'),{recursive:true});
    await fs.writeFile(path.join(language,'readme.txt'),Buffer.from('abc'));
    await fs.writeFile(path.join(language,'nested','notes.bin'),Buffer.from([0,1,2,3]));
    await fs.mkdir(path.join(root,'unlisted'),{recursive:true});
    await fs.writeFile(path.join(root,'unlisted','ignored.txt'),Buffer.alloc(100));

    const result=await inventory(home);
    assert.equal(result.success,true);
    const output=result.output as {exact:boolean;fileCount:number;totalBytes:string;canonicalManifestPath:string;canonicalKnowledgeRoot:string;vaults:Array<{name:string;domains:string[];canonicalRoot:string|null;exact:boolean;fileCount:number|null;totalBytes:string|null}>};
    assert.equal(output.exact,true);
    assert.equal(output.fileCount,2);
    assert.equal(output.totalBytes,'7');
    assert.equal(output.canonicalManifestPath,await fs.realpath(path.join(root,'VAULTS_MANIFEST.json')));
    assert.equal(output.canonicalKnowledgeRoot,await fs.realpath(root));
    assert.deepEqual(output.vaults.map(vault=>vault.name),['01_LANGUES','02_MATHS']);
    assert.deepEqual(output.vaults[0].domains,['Francais','Anglais']);
    assert.equal(output.vaults[0].canonicalRoot,await fs.realpath(language));
    assert.equal(output.vaults[0].fileCount,2);
    assert.equal(output.vaults[0].totalBytes,'7');
    assert.equal(output.vaults[1].fileCount,0);
    assert.equal(output.vaults[1].totalBytes,'0');
  } finally {
    await fs.rm(home,{recursive:true,force:true});
  }
});

test('knowledge.inventory reports an in-root junction and counts its physical files once',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-knowledge-links-'));
  try {
    const root=await prepare(home,['VAULT']);
    const vault=path.join(root,'VAULT');
    const payload=path.join(vault,'content');
    await fs.mkdir(payload,{recursive:true});
    await fs.writeFile(path.join(payload,'one.txt'),'12345');
    const linkType=process.platform==='win32'?'junction':'dir';
    await fs.symlink(payload,path.join(vault,'content-alias'),linkType);

    const result=await inventory(home);
    assert.equal(result.success,true);
    const output=result.output as {exact:boolean;fileCount:number|null;totalBytes:string|null;vaults:Array<{exact:boolean;fileCount:number|null;totalBytes:string|null;links:Array<{path:string;target:string|null;withinConfiguredRoot:boolean|null;action:string}>}>};
    const item=output.vaults[0];
    assert.equal(output.exact,true);
    assert.equal(output.fileCount,1);
    assert.equal(output.totalBytes,'5');
    assert.equal(item.exact,true);
    assert.equal(item.fileCount,1);
    assert.equal(item.totalBytes,'5');
    assert.equal(item.links.find(link=>link.path==='content-alias')?.withinConfiguredRoot,true);
    assert.equal(item.links.find(link=>link.path==='content-alias')?.action,'already_counted');
  } finally {
    await fs.rm(home,{recursive:true,force:true});
  }
});

test('knowledge.inventory reports and skips a link outside the configured knowledge root',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-knowledge-boundary-'));
  let outside:string|undefined;
  try {
    const root=await prepare(home,['VAULT']);
    const vault=path.join(root,'VAULT');
    outside=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-knowledge-external-'));
    await fs.mkdir(vault,{recursive:true});
    await fs.writeFile(path.join(outside,'secret.txt'),Buffer.alloc(4096));
    const linkType=process.platform==='win32'?'junction':'dir';
    await fs.symlink(outside,path.join(vault,'outside-alias'),linkType);

    const result=await inventory(home);
    assert.equal(result.success,true);
    const output=result.output as {exact:boolean;fileCount:number|null;totalBytes:string|null;vaults:Array<{exact:boolean;fileCount:number|null;totalBytes:string|null;links:Array<{path:string;target:string|null;withinConfiguredRoot:boolean|null;action:string}>;errors:Array<{path:string}>}>};
    const item=output.vaults[0];
    assert.equal(output.exact,false);
    assert.equal(output.fileCount,null);
    assert.equal(output.totalBytes,null);
    assert.equal(item.exact,false);
    assert.equal(item.fileCount,null);
    assert.equal(item.totalBytes,null);
    const escaped=item.links.find(link=>link.path==='outside-alias');
    assert.equal(escaped?.target,await fs.realpath(outside));
    assert.equal(escaped?.withinConfiguredRoot,false);
    assert.equal(escaped?.action,'skipped_outside');
    assert.ok(item.errors.some(error=>error.path==='outside-alias'));
  } finally {
    if(outside)await fs.rm(outside,{recursive:true,force:true});
    await fs.rm(home,{recursive:true,force:true});
  }
});

test('knowledge.inventory withholds exact totals when a declared vault cannot be traversed',async()=>{
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'mazz-knowledge-incomplete-'));
  try {
    const root=await prepare(home,['BROKEN']);
    await fs.writeFile(path.join(root,'BROKEN'),'this is not a vault directory');

    const result=await inventory(home);
    assert.equal(result.success,true);
    const output=result.output as {exact:boolean;fileCount:number|null;totalBytes:string|null;vaults:Array<{status:string;exact:boolean;fileCount:number|null;totalBytes:string|null;errors:Array<{path:string}>}>};
    assert.equal(output.exact,false);
    assert.equal(output.fileCount,null);
    assert.equal(output.totalBytes,null);
    assert.equal(output.vaults[0].status,'invalid_root');
    assert.equal(output.vaults[0].exact,false);
    assert.equal(output.vaults[0].fileCount,null);
    assert.equal(output.vaults[0].totalBytes,null);
    assert.equal(output.vaults[0].errors[0]?.path,'.');
  } finally {
    await fs.rm(home,{recursive:true,force:true});
  }
});
