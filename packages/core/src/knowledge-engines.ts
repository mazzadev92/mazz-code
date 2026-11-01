import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ITool, ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@mazz/shared';
import { LegacyKnowledgeManager, resolvePython, type KnowledgeConfig, type KnowledgeContext } from './knowledge.js';
export { LegacyKnowledgeManager, resolvePython, type KnowledgeConfig, type KnowledgeContext };

type Envelope = {schema_version:string;request_id:string;status:'ok'|'no_evidence'|'awaiting_permission'|'error';data:any;warnings:string[];citations:unknown[];timings:{total_ms:number;[key:string]:unknown};[key:string]:unknown};
export interface RetrievalOptions { vaultPath?:string; allowedRoots?:string[]; deniedRoots?:string[]; signal?:AbortSignal; profile?:string; research?:boolean }
export interface EngineKnowledgeContext extends KnowledgeContext {
  methods:any[]; knowledge:any[]; verification?:any; cognitive_plan?:any; context_budget?:any; execution_path?:string; orchestration_mode?:string; intelligence_path?:string; selected_role?:string; task_ir?:any; can_execute_directly?:boolean; formatted_answer?:string; uie_result?:any; sourced_result?:any; engine_status:string; warnings:string[];
}
const OPS=['engine.health','engine.capabilities','uie.catalog','uie.open_source_stack','mcos.architecture','mcos.task_ir','mcos.task_ir_revise','mcos.automatibility','mcos.tabular_analyze','mcos.solution_search','mcos.skill_compile','mcos.experience_record','mcos.experience_match','mcos.checkpoint_save','mcos.checkpoint_resume','mcos.role_optimize','mcos.benchmark_lab','ic.profile_model','ic.budget_simulate','ic.memory_status','ic.compact_session','ic.page_get','ic.multipass','ic.ruler_benchmark','ic.multihop','ic.contradictions','ic.selective_erase','audit.retrieval_metrics','audit.scenarios_24','audit.benchmark_200','audit.live_2_gguf','audit.generate_12_deliverables','mks.build','mks.search','mks.concept','mks.relations','mks.prerequisites','mks.methods','mks.examples','mks.skills','mks.explain','mks.ingest','mks.memory5','mks.doctor','mks.benchmark','aengenium.audit_16_pillars','aengenium.gps_solve','aengenium.agent_control','aengenium.env_observe','aengenium.env_diff','aengenium.gguf_profiler','aengenium.resource_governor','aengenium.security_gate','aengenium.multimodal_inspect','aengenium.verify_completion','aengenium.ablation_benchmark','cognitive.compile','uie.execute','math.calculate','math.sympy','logic.z3','optimization.solve','nomad.transform','code.analyze','debug.diagnose','patch.preview','procedural.list','procedural.execute','procedural.compile','capability.profile','knowledge.search','knowledge.measure_tokens','knowledge.get_passage','knowledge.related_concepts','methods.find','skills.list','web.search','web.fetch','fusion.combine','discovery.propose_hypothesis','experiment.run_safe_test','memory.propose','memory.validate','memory.commit','memory.search','tasks.create','tasks.status','tasks.transition','research'];
const SCOPED_READ_OPERATIONS=new Set(['research','knowledge.search']);

/** Validate the versioned response contract shared by the Python, CLI and MCP engines. */
export function parseKnowledgeEnvelope(value:unknown):Envelope {
  let parsed:unknown=value;
  if(typeof value==='string') {
    try { parsed=JSON.parse(value); }
    catch { throw new Error('Réponse Bib1 : JSON invalide'); }
  }
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('Réponse Bib1 : enveloppe JSON objet requise');
  const result=parsed as Record<string,unknown>;
  if(result.schema_version!=='1.0')throw new Error('Réponse Bib1 : schema_version absent ou incompatible');
  if(typeof result.request_id!=='string'||!result.request_id.trim())throw new Error('Réponse Bib1 : request_id absent');
  if(result.status!=='ok'&&result.status!=='no_evidence'&&result.status!=='awaiting_permission'&&result.status!=='error')throw new Error('Réponse Bib1 : statut inconnu');
  if(!Object.prototype.hasOwnProperty.call(result,'data'))throw new Error('Réponse Bib1 : champ data absent');
  if(!Array.isArray(result.citations))throw new Error('Réponse Bib1 : citations doit être une liste');
  if(!Array.isArray(result.warnings)||!result.warnings.every(item=>typeof item==='string'))throw new Error('Réponse Bib1 : warnings doit être une liste de textes');
  if(!result.timings||typeof result.timings!=='object'||Array.isArray(result.timings))throw new Error('Réponse Bib1 : timings absent');
  const totalMs=(result.timings as Record<string,unknown>).total_ms;
  if(typeof totalMs!=='number'||!Number.isFinite(totalMs)||totalMs<0)throw new Error('Réponse Bib1 : timings.total_ms invalide');
  return result as Envelope;
}

/** External-root consent is retrieval-only; it cannot authorize writes to Bib1 state. */
export function scopedRetrievalRequest(request:Record<string,unknown>):Record<string,unknown> {
  const args=request.args&&typeof request.args==='object'&&!Array.isArray(request.args)?request.args as Record<string,unknown>:{};
  return {...request,args:{...args,execute_tools:false}};
}
function within(file:string,root:string):boolean {
  const rel=path.relative(root,file);return !rel || (!rel.startsWith('..'+path.sep) && rel!=='..' && !path.isAbsolute(rel));
}

type InventoryLink = {path:string;target:string|null;withinConfiguredRoot:boolean|null;kind:'directory'|'file'|'other'|'unknown';action:'followed'|'already_counted'|'skipped_outside'|'unresolved'|'ignored'};
type InventoryIssue = {path:string;message:string};
type VaultInventory = {name:string;domains:string[];root:string;canonicalRoot:string|null;exists:boolean;status:'ok'|'missing'|'blocked'|'invalid_root'|'partial';exact:boolean;fileCount:number|null;totalBytes:string|null;links:InventoryLink[];errors:InventoryIssue[]};

export interface RuntimeMcpToolSummary {
  name:string;
  description?:string;
  inputSchema?:{properties?:Record<string,unknown>;required?:string[]};
}

function wireNameForOperation(operation:string):string { return operation.replaceAll('.','_'); }

/** The Studio can execute only a unique dotted operation whose wire name is currently advertised by Bib1. */
export function requireAdvertisedOperation(operation:string,declaredOperations:readonly string[],runtimeWireNames:readonly string[]):string {
  if(!declaredOperations.includes(operation))throw new Error(`Opération Bib1 inconnue : ${operation}`);
  const wireName=wireNameForOperation(operation);
  if(declaredOperations.filter(candidate=>wireNameForOperation(candidate)===wireName).length!==1) {
    throw new Error(`Opération Bib1 ambiguë : plusieurs noms Studio correspondent à « ${wireName} »`);
  }
  const matches=runtimeWireNames.filter(name=>name===wireName).length;
  if(matches===0)throw new Error(`Opération Bib1 indisponible : le serveur MCP n’annonce pas « ${wireName} »`);
  if(matches!==1)throw new Error(`Opération Bib1 ambiguë : le serveur MCP annonce « ${wireName} » plusieurs fois`);
  return wireName;
}

/** Return only Studio operations with one unambiguous current MCP advertisement. */
export function advertisedOperations(declaredOperations:readonly string[],runtimeWireNames:readonly string[]):string[] {
  const actualCounts=new Map<string,number>();
  for(const name of runtimeWireNames)actualCounts.set(name,(actualCounts.get(name)||0)+1);
  const declaredCounts=new Map<string,number>();
  for(const operation of declaredOperations) {
    const wireName=wireNameForOperation(operation);
    declaredCounts.set(wireName,(declaredCounts.get(wireName)||0)+1);
  }
  return declaredOperations.filter(operation=>{
    const wireName=wireNameForOperation(operation);
    return declaredCounts.get(wireName)===1&&actualCounts.get(wireName)===1;
  });
}

/** Compare the app's dotted operation catalog to the actual MCP wire names. */
export function compareRuntimeToolNames(declaredOperations:readonly string[],runtimeTools:readonly Pick<RuntimeMcpToolSummary,'name'>[]) {
  const declaredWireNames=declaredOperations.map(operation=>operation.replaceAll('.','_'));
  const declared=new Set(declaredWireNames);
  const duplicateDeclaredNames=[...new Set(declaredWireNames.filter((name,index)=>declaredWireNames.indexOf(name)!==index))].sort();
  const actualNames=runtimeTools.map(tool=>tool.name);
  const actual=new Set(actualNames);
  const duplicates=[...new Set(actualNames.filter((name,index)=>actualNames.indexOf(name)!==index))].sort();
  return {
    exactMatch:declared.size===actual.size&&[...declared].every(name=>actual.has(name))&&duplicates.length===0&&duplicateDeclaredNames.length===0,
    declaredOperationCount:declaredOperations.length,
    runtimeToolCount:actualNames.length,
    duplicateDeclaredNames,
    missingFromRuntime:declaredWireNames.filter(name=>!actual.has(name)),
    undeclaredAtRuntime:actualNames.filter(name=>!declared.has(name)),
    duplicateRuntimeNames:duplicates,
    advertisedOperations:advertisedOperations(declaredOperations,actualNames),
  };
}

/** Read-only inventory of the physical vault directories declared by Bib1. */
async function inventoryKnowledge(home:string) {
  const configuredRoot=await fs.realpath(home);
  const manifestPath=path.join(home,'MAZZ_UNIVERSAL_KNOWLEDGE_STARTER','MAZZ_KNOWLEDGE','VAULTS_MANIFEST.json');
  const canonicalManifestPath=await fs.realpath(manifestPath);
  if(!within(canonicalManifestPath,configuredRoot))throw new Error('Le manifeste des vaults sort du knowledge.home configuré');
  const manifest=JSON.parse(await fs.readFile(canonicalManifestPath,'utf8')) as {vaults?:unknown;domains?:unknown};
  if(!Array.isArray(manifest.vaults)||!manifest.vaults.every((name):name is string=>typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name))) {
    throw new Error('Le manifeste VAULTS_MANIFEST.json doit déclarer une liste de noms de vaults valides');
  }
  if(new Set(manifest.vaults).size!==manifest.vaults.length)throw new Error('Le manifeste VAULTS_MANIFEST.json contient des vaults en double');
  const domainsByVault=new Map<string,string[]>();
  if(Array.isArray(manifest.domains))for(const item of manifest.domains) {
    if(!item||typeof item!=='object')continue;
    const row=item as {vault?:unknown;domain?:unknown};
    if(typeof row.vault==='string'&&typeof row.domain==='string') {
      const domains=domainsByVault.get(row.vault)||[];
      if(!domains.includes(row.domain))domains.push(row.domain);
      domainsByVault.set(row.vault,domains);
    }
  }

  const knowledgeRoot=path.join(home,'MAZZ_UNIVERSAL_KNOWLEDGE_STARTER','MAZZ_KNOWLEDGE');
  const canonicalKnowledgeRoot=await fs.realpath(knowledgeRoot);
  if(!within(canonicalKnowledgeRoot,configuredRoot))throw new Error('La racine MAZZ_KNOWLEDGE sort du knowledge.home configuré');

  const inventories:VaultInventory[]=[];
  for(const name of manifest.vaults) {
    const root=path.join(knowledgeRoot,name);
    const result:VaultInventory={name,domains:domainsByVault.get(name)||[],root,canonicalRoot:null,exists:false,status:'partial',exact:false,fileCount:null,totalBytes:null,links:[],errors:[]};
    let rootStat;
    try { rootStat=await fs.lstat(root); }
    catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT') {
        result.exists=false;result.status='missing';result.exact=true;result.fileCount=0;result.totalBytes='0';inventories.push(result);continue;
      }
      result.errors.push({path:'.',message:`Impossible de lire la racine: ${(error as Error).message}`});inventories.push(result);continue;
    }
    result.exists=true;
    try { result.canonicalRoot=await fs.realpath(root); }
    catch(error) { result.errors.push({path:'.',message:`Impossible de résoudre la racine: ${(error as Error).message}`});inventories.push(result);continue; }
    const rootInside=within(result.canonicalRoot,configuredRoot);
    if(rootStat.isSymbolicLink())result.links.push({path:'.',target:result.canonicalRoot,withinConfiguredRoot:rootInside,kind:'directory',action:rootInside?'followed':'skipped_outside'});
    if(!rootInside) {
      result.status='blocked';result.errors.push({path:'.',message:'Racine ignorée : sa cible sort du knowledge.home configuré'});inventories.push(result);continue;
    }
    let resolvedRootStat;
    try { resolvedRootStat=await fs.stat(result.canonicalRoot,{bigint:true}); }
    catch(error) { result.errors.push({path:'.',message:`Impossible de lire la racine canonique: ${(error as Error).message}`});inventories.push(result);continue; }
    if(rootStat.isSymbolicLink()&&result.links[0])result.links[0].kind=resolvedRootStat.isDirectory()?'directory':resolvedRootStat.isFile()?'file':'other';
    if(!resolvedRootStat.isDirectory()) {
      result.status='invalid_root';result.errors.push({path:'.',message:'La racine déclarée n’est pas un dossier'});inventories.push(result);continue;
    }

    const visitedDirectories=new Set<string>();
    const visitedFiles=new Set<string>();
    let totalBytes=0n;
    const issue=(relativePath:string,error:unknown)=>result.errors.push({path:relativePath,message:(error as Error).message||String(error)});
    const identity=(stat:{dev:bigint;ino:bigint},fallback:string)=>stat.ino!==0n?`${stat.dev}:${stat.ino}`:fallback;
    const addFile=async(absolutePath:string,relativePath:string)=>{
      try {
        const canonical=await fs.realpath(absolutePath);
        if(!within(canonical,configuredRoot))throw new Error('Fichier ignoré : sa cible sort du knowledge.home configuré');
        const stat=await fs.stat(canonical,{bigint:true});
        if(!stat.isFile())return;
        const key=identity(stat,canonical);
        if(visitedFiles.has(key))return;
        visitedFiles.add(key);totalBytes+=stat.size;
      } catch(error) { issue(relativePath,error); }
    };
    const walk=async(absoluteDirectory:string,logicalPrefix:string):Promise<boolean>=>{
      let canonicalDirectory:string;
      try {
        canonicalDirectory=await fs.realpath(absoluteDirectory);
        if(!within(canonicalDirectory,configuredRoot))throw new Error('Dossier ignoré : sa cible sort du knowledge.home configuré');
      } catch(error) { issue(logicalPrefix||'.',error);return false; }
      let directoryStat;
      try { directoryStat=await fs.stat(canonicalDirectory,{bigint:true}); }
      catch(error) { issue(logicalPrefix||'.',error);return false; }
      if(!directoryStat.isDirectory()) { issue(logicalPrefix||'.',new Error('La cible du lien n’est pas un dossier'));return false; }
      const directoryKey=identity(directoryStat,canonicalDirectory);
      if(visitedDirectories.has(directoryKey))return false;
      visitedDirectories.add(directoryKey);
      let entries;
      try { entries=await fs.readdir(canonicalDirectory,{withFileTypes:true}); }
      catch(error) { issue(logicalPrefix||'.',error);return true; }
      entries.sort((a,b)=>a.name.localeCompare(b.name));
      for(const entry of entries) {
        const absolutePath=path.join(canonicalDirectory,entry.name);
        const relativePath=logicalPrefix?`${logicalPrefix}/${entry.name}`:entry.name;
        let stat;
        try { stat=await fs.lstat(absolutePath,{bigint:true}); }
        catch(error) { issue(relativePath,error);continue; }
        if(stat.isSymbolicLink()) {
          let target:string;
          try { target=await fs.realpath(absolutePath); }
          catch(error) {
            result.links.push({path:relativePath,target:null,withinConfiguredRoot:null,kind:'unknown',action:'unresolved'});issue(relativePath,error);continue;
          }
          const allowed=within(target,configuredRoot);
          if(!allowed) {
            result.links.push({path:relativePath,target,withinConfiguredRoot:false,kind:'unknown',action:'skipped_outside'});
            issue(relativePath,new Error('Lien ignoré : sa cible sort du knowledge.home configuré'));continue;
          }
          let targetStat;
          try { targetStat=await fs.stat(target,{bigint:true}); }
          catch(error) { result.links.push({path:relativePath,target,withinConfiguredRoot:true,kind:'unknown',action:'unresolved'});issue(relativePath,error);continue; }
          if(targetStat.isDirectory()) {
            const link:InventoryLink={path:relativePath,target,withinConfiguredRoot:true,kind:'directory',action:'followed'};
            result.links.push(link);
            if(!await walk(target,relativePath))link.action='already_counted';
          } else if(targetStat.isFile()) {
            result.links.push({path:relativePath,target,withinConfiguredRoot:true,kind:'file',action:'followed'});await addFile(target,relativePath);
          } else result.links.push({path:relativePath,target,withinConfiguredRoot:true,kind:'other',action:'ignored'});
          continue;
        }
        if(stat.isDirectory())await walk(absolutePath,relativePath);
        else if(stat.isFile())await addFile(absolutePath,relativePath);
      }
      return true;
    };
    await walk(result.canonicalRoot,'');
    result.exact=result.errors.length===0;
    result.status=result.exact?'ok':'partial';
    if(result.exact) {
      result.fileCount=visitedFiles.size;
      result.totalBytes=totalBytes.toString();
    }
    inventories.push(result);
  }

  const exact=inventories.every(vault=>vault.exact);
  return {
    manifestPath,canonicalManifestPath,knowledgeRoot,canonicalKnowledgeRoot,vaultCount:inventories.length,exact,
    fileCount:exact?inventories.reduce((sum,vault)=>sum+(vault.fileCount||0),0):null,
    totalBytes:exact?inventories.reduce((sum,vault)=>sum+BigInt(vault.totalBytes||'0'),0n).toString():null,
    vaults:inventories
  };
}

/** Persistent, model-independent MCP client. Documents never become executable instructions. */
export class KnowledgeManager extends LegacyKnowledgeManager {
  private engine?:Client;
  private opening?:Promise<Client>;
  private engineConfig='';
  private capabilitiesCache?:Record<string,unknown>;
  private engineError='';
  private operationEnum?:string[];
  constructor(private readonly getConfig:()=>KnowledgeConfig) { super(getConfig); }

  override status() { return {...super.status(),enginesRunning:!!this.engine,capabilities:this.capabilitiesCache,error:this.engineError || undefined}; }

  private async connect():Promise<Client> {
    const cfg=this.getConfig();const signature=JSON.stringify(cfg);
    if(this.engine && signature===this.engineConfig)return this.engine;
    if(this.opening)return this.opening;
    this.opening=(async()=>{
      if(this.engine)await this.engine.close();
      const transport=new StdioClientTransport({command:resolvePython(cfg.python),args:['-m','mazz_knowledge.engines','mcp'],cwd:cfg.home,
        env:{...(process.env as Record<string,string>),PYTHONIOENCODING:'utf-8'},stderr:'pipe'});
      const client=new Client({name:'mazz-studio-knowledge',version:'1.0.0'});
      let timer:ReturnType<typeof setTimeout>|undefined;
      try {
        await Promise.race([client.connect(transport),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Connexion Bib1 dépassée (15 s)')),15000);})]);
        this.engine=client;this.engineConfig=signature;this.engineError='';
        client.onclose=()=>{if(this.engine===client)this.engine=undefined;};
        return client;
      } catch(error) { await transport.close().catch(()=>{});this.engineError=String(error);throw error; }
      finally {if(timer)clearTimeout(timer);}
    })();
    try{return await this.opening;}finally{this.opening=undefined;}
  }

  async runtimeToolCatalog(signal?:AbortSignal) {
    const client=await this.connect();
    const tools:RuntimeMcpToolSummary[]=[];
    const cursors=new Set<string>();
    let cursor:string|undefined;
    do {
      const page=await client.listTools(cursor?{cursor}:undefined,{timeout:45000,signal});
      tools.push(...page.tools);
      cursor=page.nextCursor;
      if(cursor) {
        if(cursors.has(cursor))throw new Error('Le serveur MCP a renvoyé un curseur de pagination répété.');
        cursors.add(cursor);
        if(cursors.size>100)throw new Error('Le catalogue MCP dépasse 100 pages.');
      }
    } while(cursor);

    const comparison=compareRuntimeToolNames(OPS,tools);
    // Keep the next model request's schema aligned to the complete live listTools reply.
    // The call boundary below independently rechecks this list before every invocation.
    if(this.operationEnum)this.operationEnum.splice(0,this.operationEnum.length,...comparison.advertisedOperations);
    return {
      inspectedAt:new Date().toISOString(),
      server:client.getServerVersion()??null,
      ...comparison,
      // Keep the model-facing result compact: the 89 Bib1 descriptions repeat
      // the same wrapper and consume more tokens than the audit can use. Exact
      // comparison and counts are computed from the complete MCP response;
      // the caller still gets every actual wire name plus all drift details.
      tools:tools.map(tool=>tool.name),
    };
  }

  async call(operation:string,request:Record<string,unknown>,options:RetrievalOptions={}):Promise<Envelope> {
    if(!OPS.includes(operation))throw new Error('Opération Bib1 inconnue');
    if(options.vaultPath)return this.scopedCall(operation,request,options);
    // Never dispatch from the static catalog alone: the connected server is authoritative.
    const catalog=await this.runtimeToolCatalog(options.signal);
    const wireName=requireAdvertisedOperation(operation,OPS,catalog.tools);
    const client=await this.connect();
    const requestTimeout=operation==='research'?90000:operation==='knowledge.search'?35000:60000;
    const response=await client.callTool({name:wireName,arguments:{request}},undefined,{timeout:requestTimeout,maxTotalTimeout:120000,signal:options.signal}) as {isError?:boolean;content?:Array<{type:string;text?:string}>;structuredContent?:unknown};
    const text=(response.content||[]).filter(x=>x.type==='text').map(x=>x.text || '').join('\n');
    if(response.isError)throw new Error(text.slice(0,500));
    const result=parseKnowledgeEnvelope(response.structuredContent!==undefined?response.structuredContent:text);
    if(operation==='engine.capabilities'||operation==='engine.health')this.capabilitiesCache=result.data;
    return result;
  }

  private async scopedCall(operation:string,request:Record<string,unknown>,options:RetrievalOptions):Promise<Envelope> {
    if(!SCOPED_READ_OPERATIONS.has(operation))throw new Error(`Opération « ${operation} » refusée : un accès à un vault externe autorise uniquement la recherche en lecture seule.`);
    const cfg=this.getConfig();
    const selected=await fs.realpath(options.vaultPath!);
    const permitted=await Promise.all([cfg.home,...(options.allowedRoots || [])].map(p=>fs.realpath(p).catch(()=>path.resolve(p))));
    const denied=await Promise.all((options.deniedRoots || []).map(p=>fs.realpath(p).catch(()=>path.resolve(p))));
    if(!permitted.some(p=>within(selected,p)) || denied.some(p=>within(selected,p)))throw new Error('Accès au vault non autorisé par le Studio');
    if(!(await fs.stat(selected)).isDirectory())throw new Error('Le vault doit être un dossier');
    return new Promise<Envelope>((resolve,reject)=>{
      const child=spawn(resolvePython(cfg.python),['-m','mazz_knowledge.engines.studio_bridge'],{cwd:cfg.home,windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}});
      let output='';let error='';let settled=false;
      const finish=(err?:Error,result?:Envelope)=>{if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);err?reject(err):resolve(result!);};
      const abort=()=>{child.kill();finish(new Error('Recherche Bib1 interrompue'));};
      const timer=setTimeout(()=>{child.kill();finish(new Error('Indexation/recherche du vault dépassée (60 s)'));},60000);
      options.signal?.addEventListener('abort',abort,{once:true});
      child.stdout.on('data',(d:Buffer)=>{output+=d.toString('utf-8');if(output.length>1_000_000){child.kill();finish(new Error('Réponse Bib1 trop volumineuse'));}});
      child.stderr.on('data',(d:Buffer)=>{error=(error+d.toString('utf-8')).slice(-1000);});
      child.on('error',err=>finish(err));child.on('exit',code=>{try{if(code!==0)throw new Error(error || 'Processus Bib1 en échec');finish(undefined,JSON.parse(output));}catch(err){finish(err as Error);}});
      child.stdin.on('error',err=>finish(err));
      const scopedRequest=operation==='research'?scopedRetrievalRequest(request):request;
      child.stdin.end(JSON.stringify({operation,request:scopedRequest,allowed_roots:[selected],vault_path:selected}));
      if(options.signal?.aborted)abort();
    });
  }

  override async context(query:string,k=3,budget=2800,options:RetrievalOptions={}):Promise<EngineKnowledgeContext|null> {
    if(!this.available())return null;
    const linked = /cha[iî]ne|r[eé]f[eé]rences|reli[eé]|linked|chain/i.test(query);
    // Keep ordinary retrieval on Bib1's bounded FTS/BM25 path. The richer
    // research pipeline is reserved for explicit reference-chain requests or
    // an explicit caller opt-in (the Studio /fast deterministic lane); it may
    // perform several passes and should not sit behind a 20 s search.
    const useResearch=linked || options.research===true;
    const operation=useResearch?'research':'knowledge.search';
    const request=useResearch
      ? {task:query.slice(0,2000),model_profile:options.profile || 'tiny-0.6b',mode:'offline_strict',
          source_policy:{include_imports:true,include_external:true,minimum_overlap:0.2},args:{execute_tools:true}}
      : {task:query.slice(0,2000),mode:'offline_strict',
          source_policy:{include_imports:true,include_external:true,minimum_overlap:0.2},args:{k:Math.max(3,k)}};
    const result=await this.call(operation,request,options);
    if(result.status==='error'||result.status==='awaiting_permission')throw new Error((result.warnings || []).join('; ') || result.status);
    const data=result.data || {};
    const knowledge=(Array.isArray(data)?data:(data.knowledge || [])).slice(0,useResearch ? 8 : Math.max(3,k));
    const citations=knowledge.map((h:any,i:number)=>({label:`[${i+1}]`,id:h.id,title:h.title,path:h.path,absolute_path:h.absolute_path || h.path,line:h.line,heading:h.heading,status:h.status,body:h.body,sources:h.sources}));
    const methods=(data.methods || []).slice(0,2);
    // Bound every injected fragment and preserve the lookup key in its citation.
    const cap=Math.min(3600,Math.max(300,budget));
    const headers=knowledge.map((h:any,i:number)=>`[${i+1}] ${h.title} (${h.status || h.trust})\nSource: ${h.absolute_path || h.path}:${h.line}`);
    const excerptBudget=Math.max(0,Math.floor((cap-headers.reduce((n:number,h:string)=>n+h.length+4,0))/Math.max(1,knowledge.length)));
    const blocks=knowledge.map((h:any,i:number)=>{
      const body=String(h.body || '');
      const terms=[...query.matchAll(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu)].map(m=>m[0].toLowerCase());
      const code=/\b[A-Z][A-Z0-9_]*(?:-[A-Z0-9]+)+\b/.exec(body);
      let anchor=code?.index ?? -1;
      if(anchor<0){const positions=terms.map(t=>body.toLowerCase().indexOf(t)).filter(n=>n>=0);anchor=positions.length?Math.min(...positions):0;}
      const start=Math.max(0,Math.min(body.length-excerptBudget,anchor-Math.floor(excerptBudget/3)));
      const excerpt=body.slice(start,start+excerptBudget);
      h.excerpt_start=start;h.excerpt_end=start+excerpt.length;
      return `[${i+1}] ${h.title} (${h.status || h.trust})\n${excerpt}\nSource: ${h.absolute_path || h.path}:${h.line}`;
    });
    blocks.push(...methods.map((m:any)=>`Méthode ${m.id}: ${m.text}`));
    if(data.uie_result?.verified && data.uie_result?.output!==undefined){
      blocks.unshift(`Résultat UIE vérifié (${data.uie_result.engine}, chemin=${data.execution_path || 'fast_path'}): ${JSON.stringify(data.uie_result.output)}`);
    }
    if(data.verification?.status==='verified' && data.verification?.payload?.result?.data!==undefined){
      blocks.push(`Vérification déterministe (${data.verification.payload.tool}, statut=verified): ${JSON.stringify(data.verification.payload.result.data)}`);
    }
    const text=blocks.join('\n\n').slice(0,cap);
    return {query,context:text,characters:text.length,citations,knowledge,methods,verification:data.verification,cognitive_plan:data.cognitive_plan,context_budget:data.context_budget,execution_path:data.execution_path,orchestration_mode:data.orchestration_mode || data.cognitive_plan?.orchestration_mode,intelligence_path:data.intelligence_path || data.cognitive_plan?.intelligence_path,selected_role:data.selected_role || data.cognitive_plan?.selected_role,task_ir:data.task_ir || data.cognitive_plan?.task_ir,can_execute_directly:Boolean(data.cognitive_plan?.can_execute_directly),formatted_answer:data.cognitive_plan?.formatted_answer,uie_result:data.uie_result,sourced_result:data.sourced_result,engine_status:result.status,warnings:result.warnings || []};
  }

  override async loadTool():Promise<ITool|null> { return this.available()?this.tools()[0]:null; }

  tools():ITool[] {
    const manager=this;
    const operationEnum=[...OPS];
    this.operationEnum=operationEnum;
    const definition:ToolDefinition={name:'knowledge.search',description:'Recherche Bib1 et ses sources. vault_path est optionnel : omets-le pour le Bib1 configuré; renseigne-le seulement pour un autre dossier explicitement autorisé.',category:'memory',requiresPermission:false,
      parameters:{type:'object',properties:{query:{type:'string'},vault_path:{type:'string'}},required:['query']}};
    const search:ITool={definition,async execute(params,context){
      const start=Date.now();
      try {
        const requestedVaultPath=typeof params.vault_path==='string'?params.vault_path.trim():'';
        const configuredHome=path.resolve(manager.getConfig().home);
        // Small local models often echo the configured library label from the
        // prompt (for example "Bib1") as a path. Resolve that exact label to
        // the configured home; arbitrary relative or external paths still go
        // through the normal access request.
        const configuredLabel=path.basename(configuredHome);
        const namesConfiguredHome=requestedVaultPath && (
          (path.isAbsolute(requestedVaultPath) && path.resolve(requestedVaultPath).toLocaleLowerCase()===configuredHome.toLocaleLowerCase())
          || (!path.isAbsolute(requestedVaultPath)
            && path.normalize(requestedVaultPath).replace(/[\\/]+$/u,'').toLocaleLowerCase()===configuredLabel.toLocaleLowerCase())
        );
        const vaultPath=namesConfiguredHome?undefined:requestedVaultPath || undefined;
        const roots=[context.workspaceRoot,...(context.allowedRoots || [])];
        if(vaultPath && !roots.some(root=>within(path.resolve(vaultPath),path.resolve(root))) && !within(path.resolve(vaultPath),path.resolve(manager.getConfig().home))) {
          if(!context.requestPathAccess || !await context.requestPathAccess(vaultPath,'knowledge.search'))throw new Error('Accès au vault refusé');
          roots.push(vaultPath);
        }
        const output=await manager.context(String(params.query || ''),3,2800,{vaultPath,allowedRoots:roots,deniedRoots:context.deniedRoots,signal:context.signal});
        return {success:!!output,output,durationMs:Date.now()-start};
      }catch(error){return {success:false,output:null,error:(error as Error).message,durationMs:Date.now()-start};}
    }};
    const engine:ITool={definition:{name:'knowledge.engine',description:'Appelle un moteur MAZZ annoncé par le catalogue MCP Bib1 courant : méthodes, outils vérifiés, expériences, mémoire ou tâches. Si un nom a disparu du serveur, la requête est refusée explicitement. Réseau désactivé.',category:'mcp',requiresPermission:true,
      parameters:{type:'object',properties:{operation:{type:'string',enum:operationEnum},task:{type:'string'},args:{type:'object',properties:{}}},required:['operation']}},
      async execute(params,context):Promise<ToolExecutionResult>{const start=Date.now();try{const output=await manager.call(String(params.operation),{task:String(params.task || ''),args:params.args || {},mode:'offline_strict'}, {signal:context.signal});return {success:output.status==='ok',output,durationMs:Date.now()-start};}catch(error){return {success:false,output:null,error:(error as Error).message,durationMs:Date.now()-start};}}};
    const inventory:ITool={definition:{name:'knowledge.inventory',description:'Inventorie en lecture seule les vaults déclarés dans VAULTS_MANIFEST.json : racines canoniques, sous-domaines, liens symboliques/jonctions, nombre de fichiers et octets physiques. Les liens sortant du knowledge.home configuré sont ignorés et toute erreur de parcours invalide les totaux exacts.',category:'memory',requiresPermission:false,
      parameters:{type:'object',properties:{}}},
      async execute(_params,context):Promise<ToolExecutionResult>{const start=Date.now();try{const output=await inventoryKnowledge(manager.getConfig().home);return {success:true,output,durationMs:Date.now()-start};}catch(error){return {success:false,output:null,error:(error as Error).message,durationMs:Date.now()-start};}}};
    const engines:ITool={definition:{name:'knowledge.engines',description:'Liste les outils MCP réellement exposés par Bib1 et compare leurs noms wire aux opérations déclarées par MAZZ Studio.',category:'mcp',requiresPermission:false,
      parameters:{type:'object',properties:{}}},
      async execute(_params,context):Promise<ToolExecutionResult>{const start=Date.now();try{const output=await manager.runtimeToolCatalog(context.signal);return {success:true,output,durationMs:Date.now()-start};}catch(error){return {success:false,output:null,error:(error as Error).message,durationMs:Date.now()-start};}}};
    return [search,engine,inventory,engines];
  }

  override stop():void { const current=this.engine;this.engine=undefined;void current?.close().catch(()=>{});super.stop(); }
}

/** An explicit slash command, or an explicitly quoted vault path in the request. */
export function parseVaultQuery(goal:string):{query:string;vaultPath?:string;explicit:boolean} {
  const explicit=/^\/vault-search(?:\s|$)/i.test(goal);
  let query=explicit?goal.replace(/^\/vault-search\s*/i,''):goal;
  const match=explicit?/^(?:--vault\s+)?["']([A-Za-z]:[\\/][^"']+)["']\s*/.exec(query):/\b(?:vault|dossier|biblioth[eè]que)\s*(?:dans|:|situ[ée]+ dans)?\s*["']([A-Za-z]:[\\/][^"']+)["']/i.exec(query);
  if(match)query=query.replace(match[0],'').trim();
  return {query:query || 'Rechercher les connaissances disponibles',vaultPath:match?.[1],explicit};
}
