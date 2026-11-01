import type {AgentEvent} from '@mazz/shared';
export interface SessionRecord {id:string;title:string;projectRoot:string;status:string;turns:Array<{id:string;taskId:string;prompt:string;finalText:string;events:AgentEvent[]}>}
export interface StreamOptions {sessionId?:string;mode?:'ask'|'plan'|'agent'|'review';providerId?:string;modelId?:string;signal?:AbortSignal}
export interface StreamMetadata {taskId:string;sessionId?:string;turnId?:string}
export class MazzClient {
  constructor(endpoint?:string);
  readonly endpoint:string;
  request(method:string,route:string,body?:object,signal?:AbortSignal):Promise<Response>;
  health():Promise<{status:string;version:string}>;
  createSession(projectRoot:string,title?:string):Promise<SessionRecord>;
  session(id:string):Promise<SessionRecord>;
  cancel(taskId:string):Promise<{cancelled?:boolean;success?:boolean}>;
  stream(goal:string,options?:StreamOptions):AsyncIterable<AgentEvent|StreamMetadata>;
}
