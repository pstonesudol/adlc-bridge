import {digest} from './core';
export type Requirements={title:string;requirements:{id:string;text:string}[];constraints:string[];outOfScope:string[]};
export type TicketDraft={key:string;title:string;description:string;requirementIds:string[];acceptanceCriteria:string[];verification:string[];dependsOn:string[]};
export type FeatureDraft={summary:string;assumptions:string[];questions:string[];tickets:TicketDraft[]};
function text(x:any,max=20000):string{if(typeof x!=='string'||!x.trim()||x.length>max)throw Error('Nonempty bounded text required');return x.trim();}
function list(x:any,max=50):string[]{if(!Array.isArray(x)||x.length>max)throw Error('Bounded text list required');return x.map(v=>text(v));}
function keys(x:any,names:string[]){if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!names.includes(k)))throw Error('Unknown or invalid planning fields');}
export function parseRequirements(raw:string,title='Feature plan'):Requirements{
 if(!raw.trim()||raw.length>60000)throw Error('Requirements must contain 1–60000 characters');
 if(!raw.trim().startsWith('{'))return {title:text(title,160),requirements:[{id:'R1',text:raw.trim()}],constraints:[],outOfScope:[]};
 const r=JSON.parse(raw);keys(r,['title','requirements','constraints','outOfScope']);
 if(!Array.isArray(r.requirements)||!r.requirements.length||r.requirements.length>60)throw Error('Between one and sixty requirements required');
 const result={title:text(r.title,160),requirements:r.requirements.map((v:any)=>{keys(v,['id','text']);const id=text(v.id,40);if(!/^[A-Za-z0-9_-]+$/.test(id))throw Error('Invalid requirement ID');return {id,text:text(v.text)};}),constraints:list(r.constraints??[]),outOfScope:list(r.outOfScope??[])};
 if(new Set(result.requirements.map((v:any)=>v.id)).size!==result.requirements.length)throw Error('Duplicate requirement IDs');return result;
}
export function validateDraft(value:any,r:Requirements,maxTickets=25):FeatureDraft{
 keys(value,['summary','assumptions','questions','tickets']);
 if(!Array.isArray(value.tickets)||!value.tickets.length||value.tickets.length>maxTickets)throw Error('Ticket count outside configured limit');
 const tickets=value.tickets.map((t:any)=>{
  keys(t,['key','title','description','requirementIds','acceptanceCriteria','verification','dependsOn']);
  const key=text(t.key,30);if(!/^[A-Z][A-Z0-9_-]*$/.test(key))throw Error('Invalid ticket key');
  const ticket={key,title:text(t.title,200),description:text(t.description),requirementIds:list(t.requirementIds),acceptanceCriteria:list(t.acceptanceCriteria),verification:list(t.verification),dependsOn:list(t.dependsOn)};
  if(!ticket.requirementIds.length||!ticket.acceptanceCriteria.length||!ticket.verification.length)throw Error('Every ticket needs requirement references, acceptance criteria and verification');
  if(ticket.requirementIds.some(id=>!r.requirements.some(v=>v.id===id)))throw Error('Unknown requirement reference');return ticket;
 });
 const ids=new Set(tickets.map(t=>t.key));if(ids.size!==tickets.length)throw Error('Duplicate ticket key');
 const visiting=new Set<string>(),visited=new Set<string>();
 const visit=(key:string)=>{if(visiting.has(key))throw Error('Cyclic ticket dependencies');if(visited.has(key))return;visiting.add(key);const t=tickets.find(t=>t.key===key)!;for(const dep of t.dependsOn){if(!ids.has(dep)||dep===key)throw Error('Invalid dependency');visit(dep);}visiting.delete(key);visited.add(key);};
 tickets.forEach(t=>visit(t.key));
 if(r.requirements.some(req=>!tickets.some(t=>t.requirementIds.includes(req.id))))throw Error('Uncovered requirement');
 return {summary:text(value.summary),assumptions:list(value.assumptions),questions:list(value.questions),tickets};
}
export function extractResult(text:string,marker:string){
 const at=text.indexOf(marker);if(at<0||text.indexOf(marker,at+marker.length)>=0)throw Error('Missing or ambiguous feature result marker');
 let body=text.slice(at+marker.length).trim();if(body.startsWith('```json')){if(!body.endsWith('```'))throw Error('Incomplete JSON result');body=body.slice(7,-3).trim();}
 if(body.length>120000)throw Error('Feature result too large');return JSON.parse(body);
}
export function validateReview(x:any,requirements:Requirements){keys(x,['summary','recommendations','questions']);return {summary:text(x.summary),recommendations:list(x.recommendations),questions:list(x.questions)};}
export function batchHash(requirements:Requirements,target:unknown,draft:FeatureDraft){return digest(JSON.stringify([requirements,target,draft]));}
export function ticketDescription(t:TicketDraft,plan:string,requirements:Requirements){return `${t.description}\n\n## Acceptance criteria\n${t.acceptanceCriteria.map(s=>'- '+s).join('\n')}\n\n## Verification\n${t.verification.map(s=>'- '+s).join('\n')}\n\n## Requirements\n${t.requirementIds.map(id=>`${id}: ${requirements.requirements.find(r=>r.id===id)!.text}`).join('\n')}\n\nDepends on: ${t.dependsOn.join(', ')||'none'}\n\nADLC feature ${plan}, ticket ${t.key}. Planning data only; created in Backlog without agent-ready. No implementation, merge or deployment is authorized by this description.`;}
