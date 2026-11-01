/** Consumer SDK for the actual local MAZZ API. No simulated transport. */
export class MazzClient {
  constructor(endpoint='http://127.0.0.1:3333') {
    const url=new URL(endpoint);
    if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw new Error('An explicit loopback HTTP origin is required');
    this.endpoint=url.origin;
  }
  async request(method,route,body,signal) {
    if(!route.startsWith('/api/')||route.startsWith('//'))throw new Error('Only /api/ routes are supported');
    const response=await fetch(this.endpoint+route,{method,redirect:'error',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal});
    if(!response.ok)throw new Error(`MAZZ HTTP ${response.status}: ${await response.text()}`);
    return response;
  }
  async health(){return(await this.request('GET','/api/health')).json();}
  async createSession(projectRoot,title='SDK session'){return(await(await this.request('POST','/api/sessions',{projectRoot,title,providerId:'llama-local',modelId:'local',mode:'ask'})).json()).session;}
  async session(id){return(await(await this.request('GET','/api/sessions/'+encodeURIComponent(id))).json()).session;}
  async cancel(taskId){return(await this.request('POST','/api/agent/cancel',{taskId})).json();}
  async *stream(goal,{sessionId,mode='ask',providerId='llama-local',modelId='local',signal}={}){
    const response=await this.request('POST','/api/agent/run',{goal,sessionId,mode,selection:{providerId,modelId,executionMode:'local_strict'}},signal);
    if(!response.body)throw new Error('Missing SSE body');
    const reader=response.body.getReader();const decoder=new TextDecoder();let pending='';
    try{for(;;){const{value,done}=await reader.read();pending+=decoder.decode(value,{stream:!done});let end;
      while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end).trimEnd();pending=pending.slice(end+1);if(!line.startsWith('data: '))continue;const payload=line.slice(6).trim();if(payload==='[DONE]')return;yield JSON.parse(payload);}
      if(done)break;
    }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
}
