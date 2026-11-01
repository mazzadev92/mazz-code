import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import test from 'node:test';
import type { ToolExecutionContext } from '@mazz/shared';
import { KnowledgeManager, parseKnowledgeEnvelope, scopedRetrievalRequest } from './knowledge-engines.js';

function envelope(overrides:Record<string,unknown>={}) {
  return {
    schema_version:'1.0',request_id:'req-1',status:'ok',data:{items:[]},citations:[],warnings:[],timings:{total_ms:1.25},
    ...overrides,
  };
}

test('Bib1 response parser accepts the documented v1 envelope and MCP structured content',()=>{
  const expected=envelope();
  assert.deepEqual(parseKnowledgeEnvelope(JSON.stringify(expected)),expected);
  assert.deepEqual(parseKnowledgeEnvelope(expected),expected);
});

test('Bib1 response parser rejects malformed JSON and incomplete or invalid response contracts',()=>{
  assert.throws(()=>parseKnowledgeEnvelope('{broken'),/JSON invalide/);
  assert.throws(()=>parseKnowledgeEnvelope([]),/enveloppe JSON objet/);
  assert.throws(()=>parseKnowledgeEnvelope(envelope({schema_version:'2.0'})),/schema_version/);
  assert.throws(()=>parseKnowledgeEnvelope(envelope({request_id:''})),/request_id/);
  assert.throws(()=>parseKnowledgeEnvelope(envelope({status:'partial'})),/statut inconnu/);
  const noData=envelope();delete (noData as Record<string,unknown>).data;
  assert.throws(()=>parseKnowledgeEnvelope(noData),/data absent/);
  assert.throws(()=>parseKnowledgeEnvelope(envelope({citations:{}})),/citations/);
  assert.throws(()=>parseKnowledgeEnvelope(envelope({warnings:['ok',1]})),/warnings/);
  assert.throws(()=>parseKnowledgeEnvelope(envelope({timings:{total_ms:Infinity}})),/total_ms/);
});

test('scoped research cannot execute tools with possible persistent side effects',()=>{
  const request=scopedRetrievalRequest({task:'cherche seulement',args:{execute_tools:true,limit:3},mode:'offline_strict'});
  assert.deepEqual(request,{task:'cherche seulement',args:{execute_tools:false,limit:3},mode:'offline_strict'});
});

test('explicit research opt-in selects the Bib1 research pipeline without changing keyword routing',async()=>{
  const manager=new KnowledgeManager(()=>({home:process.cwd(),port:8098,python:process.execPath}));
  (manager as any).available=()=>true;
  const calls:Array<{operation:string;request:any}>=[];
  (manager as any).call=async(operation:string,request:any)=>{
    calls.push({operation,request});
    const passages=[{id:'mazz.pilot.fractions',path:'fractions.md',title:'Addition de fractions exactes',line:26,body:'Additionner a/b et c/d.',status:'verified',absolute_path:'D:\\Bib1\\fractions.md'}];
    const data=operation==='research'
      ? {knowledge:passages,methods:[],
          cognitive_plan:{intent:'exact_rational_calculation',can_execute_directly:true,formatted_answer:'Résultat vérifié (07.math_engine (rational_add)) : **29/36**'},
          uie_result:{engine:'07.math_engine (rational_add)',verified:true,output:{value:'29/36'}},
          execution_path:'fast_path',orchestration_mode:'FAST'}
      : passages;
    return {schema_version:'1.0',request_id:'req-fast',status:'ok',data,warnings:[],citations:[],timings:{total_ms:1}};
  };
  const fast=await manager.context('Calcule 5/12 + 7/18',3,2800,{research:true});
  assert.equal(calls[0]!.operation,'research');
  assert.equal(calls[0]!.request.args.execute_tools,true);
  assert.equal(fast?.formatted_answer,'Résultat vérifié (07.math_engine (rational_add)) : **29/36**');
  assert.equal(fast?.can_execute_directly,true);
  assert.equal(fast?.execution_path,'fast_path');
  const plain=await manager.context('Calcule 5/12 + 7/18',3,2800);
  assert.equal(calls[1]!.operation,'knowledge.search');
  assert.equal(plain?.formatted_answer,undefined);
  assert.equal(plain?.can_execute_directly,false);
  manager.stop();
});

test('external vault authorization does not grant Bib1 mutation operations or start the MCP process',async()=>{
  const root=await mkdtemp(path.join(tmpdir(),'mazz-bib1-scope-'));
  try {
    const manager=new KnowledgeManager(()=>({home:root,port:8098,python:process.execPath}));
    await assert.rejects(
      manager.call('memory.commit',{task:'must remain unavailable',args:{id:'hypothesis-1'}},{vaultPath:root}),
      /accès à un vault externe autorise uniquement la recherche en lecture seule/i,
    );
    assert.equal(manager.status().enginesRunning,false);
    manager.stop();
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('the configured Bib1 label resolves to its configured root without an external path prompt',async()=>{
  const temp=await mkdtemp(path.join(tmpdir(),'mazz-bib1-alias-'));
  const root=path.join(temp,'Bib1');
  try {
    await mkdir(root);
    const manager=new KnowledgeManager(()=>({home:root,port:8098,python:process.execPath}));
    let observedVaultPath:string|undefined;
    let accessPrompts=0;
    manager.context=async(query,_k,_budget,options)=>{
      observedVaultPath=options?.vaultPath;
      return {query,context:'CRC-32 reference excerpt',characters:25,citations:[],knowledge:[],methods:[],warnings:[]} as unknown as Awaited<ReturnType<typeof manager.context>>;
    };
    const context={
      workspaceRoot:path.join(root,'workspace'),allowedRoots:[],deniedRoots:[],
      requestPathAccess:async()=>{accessPrompts++;return false;},
    } as unknown as ToolExecutionContext;
    for(const vaultLabel of ['Bib1',root]) {
      const result=await manager.tools()[0]!.execute({query:'CRC-32 ISO-HDLC',vault_path:vaultLabel},context);
      assert.equal(result.success,true);
      assert.equal(observedVaultPath,undefined,'the configured vault stays on the default Bib1 retrieval path');
    }
    assert.equal(accessPrompts,0);
    manager.stop();
  } finally { await rm(temp,{recursive:true,force:true}); }
});
