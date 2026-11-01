import {Store,digest} from './core';

export type ReadinessState='ready'|'needs-input'|'blocked-by-dependency';
export type QuestionKind='requirement'|'dependency'|'security-scope';
export type PlanQuestion={id:string;question:string;kind:QuestionKind};
export type PlanDependency={ref:string;reason:string};
export type ReadinessAssessment={
  state:ReadinessState|'invalid';
  valid:boolean;
  source:'receipt'|'plan-text';
  reason:string|null;
  questions:PlanQuestion[];
  dependencies:PlanDependency[];
  risks:string[];
};
export type WorkerOutcome='pr-handoff'|'needs-input'|'blocked-dependency'|'failed'|'uncertain';
export type WorkerReceipt={outcome:WorkerOutcome;reason:string;questions:PlanQuestion[];dependencies:PlanDependency[]};

const states=new Set<ReadinessState>(['ready','needs-input','blocked-by-dependency']);
const kinds=new Set<QuestionKind>(['requirement','dependency','security-scope']);
const outcomes=new Set<WorkerOutcome>(['pr-handoff','needs-input','blocked-dependency','failed','uncertain']);
const text=(value:unknown,max:number)=>typeof value==='string'&&value.trim().length>0&&value.length<=max?value.trim():null;

function questions(value:unknown):PlanQuestion[]|null{
  if(!Array.isArray(value)||value.length>50)return null;
  const seen=new Set<string>();const result:PlanQuestion[]=[];
  for(const [index,item] of value.entries()){
    if(!item||typeof item!=='object')return null;
    const question=text((item as any).question,4000);if(!question)return null;
    const kind=(item as any).kind??'requirement';
    if(typeof kind!=='string'||!kinds.has(kind as QuestionKind))return null;
    const id=text((item as any).id,120)??`q${index+1}`;
    if(seen.has(id))return null;seen.add(id);
    result.push({id,question,kind:kind as QuestionKind});
  }
  return result;
}
function dependencies(value:unknown):PlanDependency[]|null{
  if(!Array.isArray(value)||value.length>50)return null;
  const seen=new Set<string>();const result:PlanDependency[]=[];
  for(const item of value){
    if(!item||typeof item!=='object')return null;
    const ref=text((item as any).ref,300);if(!ref||seen.has(ref))return null;seen.add(ref);
    const reason=text((item as any).reason,2000)??'Referenced dependency must be resolved';
    result.push({ref,reason});
  }
  return result;
}
function risks(value:unknown):string[]|null{
  if(value===undefined)return [];
  if(!Array.isArray(value)||value.length>50||value.some(x=>!text(x,2000)))return null;
  return value.map(x=>text(x,2000)!);
}

export function assessPlan(plan:string):ReadinessAssessment{
  const matches=[...plan.matchAll(/<!--\s*ADLC_PLAN_STATUS\s*(\{[\s\S]*?\})\s*-->/g)];
  if(!matches.length)return legacyAssessment(plan);
  const match=matches[matches.length-1];
  let parsed:any;
  try{parsed=JSON.parse(match[1]);}catch{return invalid('Plan readiness receipt is not valid JSON');}
  const questionsValue=questions(parsed?.questions??[]),dependenciesValue=dependencies(parsed?.dependencies??[]),risksValue=risks(parsed?.risks);
  if(parsed?.version!==1)return invalid('Unsupported plan readiness receipt version');
  if(typeof parsed?.readiness!=='string'||!states.has(parsed.readiness))return invalid('Plan readiness must be ready, needs-input or blocked-by-dependency');
  if(!questionsValue||!dependenciesValue||!risksValue)return invalid('Plan readiness receipt has malformed questions, dependencies or risks');
  if(parsed.readiness==='ready'&&(questionsValue.length||dependenciesValue.length))return invalid('Ready plan cannot carry blocking questions or dependencies');
  if(parsed.readiness==='needs-input'&&questionsValue.length===0)return invalid('needs-input plan requires at least one concrete question');
  if(parsed.readiness==='blocked-by-dependency'&&dependenciesValue.length===0)return invalid('blocked-by-dependency plan requires at least one dependency reference');
  return {state:parsed.readiness,valid:true,source:'receipt',reason:null,questions:questionsValue,dependencies:dependenciesValue,risks:risksValue};
}

function invalid(reason:string):ReadinessAssessment{
  return {state:'invalid',valid:false,source:'receipt',reason,questions:[],dependencies:[],risks:[]};
}

/** Legacy plans have no receipt. Questions are quoted, never invented, and the
 * plan stays non-actionable either way. */
function legacyAssessment(plan:string):ReadinessAssessment{
  const lines=plan.split('\n');const found:string[]=[];
  let inQuestions=false;
  for(const line of lines){
    const heading=line.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    if(heading){inQuestions=/(^|\b)(questions?|open questions|risks and questions|unresolved)\b/i.test(heading[1]);continue;}
    if(!inQuestions)continue;
    const bullet=line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/);
    if(!bullet)continue;
    const value=bullet[1].trim();
    if(/^(none|n\/a|no open questions|no blocking questions)\.?$/i.test(value))continue;
    if(value.length<=4000&&found.length<50)found.push(value);
  }
  if(found.length)return {
    state:'needs-input',valid:false,source:'plan-text',
    reason:'Legacy plan has no structured readiness receipt; questions were quoted from its plan text and require explicit resolution',
    questions:found.map((question,index)=>({id:`legacy-q${index+1}`,question,kind:'requirement' as QuestionKind})),
    dependencies:[],risks:[]
  };
  return {
    state:'invalid',valid:false,source:'plan-text',
    reason:'Structured plan readiness receipt is missing or malformed; standing approval requires explicit resolution',
    questions:[],dependencies:[],risks:[]
  };
}

export function assessWorkerReceipt(textValue:string):{valid:boolean;receipt:WorkerReceipt|null;reason:string|null}{
  const matches=[...textValue.matchAll(/<!--\s*ADLC_WORKER_STATUS\s*(\{[\s\S]*?\})\s*-->/g)];
  if(!matches.length)return {valid:false,receipt:null,reason:'No structured worker outcome receipt'};
  const match=matches[matches.length-1];
  let parsed:any;try{parsed=JSON.parse(match[1]);}catch{return {valid:false,receipt:null,reason:'Worker outcome receipt is not valid JSON'};}
  const questionsValue=questions(parsed?.questions??[]),dependenciesValue=dependencies(parsed?.dependencies??[]);
  if(parsed?.version!==1||typeof parsed?.outcome!=='string'||!outcomes.has(parsed.outcome))return {valid:false,receipt:null,reason:'Worker outcome receipt is malformed'};
  if(!questionsValue||!dependenciesValue)return {valid:false,receipt:null,reason:'Worker outcome receipt has malformed questions or dependencies'};
  if(parsed.outcome==='needs-input'&&questionsValue.length===0)return {valid:false,receipt:null,reason:'needs-input worker outcome requires a concrete question'};
  if(parsed.outcome==='blocked-dependency'&&dependenciesValue.length===0)return {valid:false,receipt:null,reason:'blocked-dependency worker outcome requires a dependency reference'};
  const reason=typeof parsed?.reason==='string'?parsed.reason.trim().slice(0,4000):'';
  return {valid:true,receipt:{outcome:parsed.outcome,reason,questions:questionsValue,dependencies:dependenciesValue},reason:null};
}

export function ensureReadinessStore(s:Store){
  s.db.exec(`CREATE TABLE IF NOT EXISTS plan_readiness (
    job TEXT PRIMARY KEY REFERENCES jobs(id),plan_hash TEXT NOT NULL,spec_hash TEXT NOT NULL,
    state TEXT NOT NULL,valid INTEGER NOT NULL,source TEXT NOT NULL,reason TEXT,
    questions TEXT NOT NULL,dependencies TEXT NOT NULL,risks TEXT NOT NULL,
    observed TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS plan_resolutions (
    job TEXT NOT NULL REFERENCES jobs(id),plan_hash TEXT NOT NULL,spec_hash TEXT NOT NULL,
    binding TEXT NOT NULL,source TEXT NOT NULL,actor TEXT NOT NULL,detail TEXT NOT NULL,
    state TEXT NOT NULL,at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(job,plan_hash,binding));`);
}
export function recordReadiness(s:Store,job:string,plan:string,planHash:string,specHash:string){
  ensureReadinessStore(s);const assessment=assessPlan(plan);
  s.db.query(`INSERT INTO plan_readiness(job,plan_hash,spec_hash,state,valid,source,reason,questions,dependencies,risks)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job) DO UPDATE SET plan_hash=excluded.plan_hash,
    spec_hash=excluded.spec_hash,state=excluded.state,valid=excluded.valid,source=excluded.source,
    reason=excluded.reason,questions=excluded.questions,dependencies=excluded.dependencies,
    risks=excluded.risks,observed=CURRENT_TIMESTAMP`)
    .run(job,planHash,specHash,assessment.state,Number(assessment.valid),assessment.source,assessment.reason,
      JSON.stringify(assessment.questions),JSON.stringify(assessment.dependencies),JSON.stringify(assessment.risks));
  return assessment;
}
export function readinessFor(s:Store,job:string):any{
  ensureReadinessStore(s);const row=s.db.query('SELECT * FROM plan_readiness WHERE job=?').get(job) as any;
  if(!row)return null;
  return {...row,valid:!!row.valid,questions:JSON.parse(row.questions),dependencies:JSON.parse(row.dependencies),risks:JSON.parse(row.risks)};
}
export function readinessBinding(s:Store,job:string):string|null{
  const row=readinessFor(s,job);if(!row)return null;
  return digest(JSON.stringify([row.plan_hash,row.spec_hash,row.state,row.questions,row.dependencies]));
}
/** A resolution is bound to the current plan readiness and, once present, the
 * worker's actual blocker. A new worker question therefore needs a new answer. */
export function resolutionBinding(s:Store,job:string):string|null{
  const base=readinessBinding(s,job);if(!base)return null;
  let outcome:any=null;
  if(s.db.query("SELECT name FROM sqlite_master WHERE name='worker_outcomes'").get()){
    outcome=s.db.query('SELECT plan_hash,outcome,questions,dependencies FROM worker_outcomes WHERE job=?').get(job);
  }
  return digest(JSON.stringify([base,outcome?.plan_hash??null,outcome?.outcome??null,outcome?.questions??null,outcome?.dependencies??null]));
}
export function currentResolution(s:Store,job:string,planHash:string,specHash:string,binding:string):any{
  ensureReadinessStore(s);
  return s.db.query("SELECT * FROM plan_resolutions WHERE job=? AND plan_hash=? AND spec_hash=? AND binding=? AND state='active'").get(job,planHash,specHash,binding);
}
export function activeResolution(s:Store,job:string):any{
  ensureReadinessStore(s);const j=s.get(job),binding=resolutionBinding(s,job);
  return binding&&currentResolution(s,job,j.plan_hash,digest(j.spec),binding);
}
export function recordResolution(s:Store,job:string,source:string,actor:string,detail:string){
  ensureReadinessStore(s);
  if(!['human-answer','dependency-satisfied','human-acknowledgement'].includes(source))throw Error('Human answer or dependency evidence required');
  if(!actor.trim()||!detail.trim()||actor.length>200||detail.length>4000)throw Error('Named human and explicit bounded resolution detail required');
  const j=s.get(job);if(!j.plan)throw Error('Captured plan required');
  const binding=resolutionBinding(s,job);if(!binding)throw Error('Current plan readiness evidence required');
  return s.db.transaction(()=>{
    const current=s.get(job);
    if(current.plan_hash!==j.plan_hash||current.spec!==j.spec)throw Error('Plan or requirements changed during resolution');
    s.db.query(`INSERT INTO plan_resolutions(job,plan_hash,spec_hash,binding,source,actor,detail,state)
      VALUES (?,?,?,?,?,?,?,'active') ON CONFLICT(job,plan_hash,binding) DO UPDATE SET
      source=excluded.source,actor=excluded.actor,detail=excluded.detail,state='active',at=CURRENT_TIMESTAMP`)
      .run(job,j.plan_hash,digest(j.spec),binding,source,actor.trim(),detail.trim());
    s.event(job,'plan_readiness_resolved',JSON.stringify({planHash:j.plan_hash,binding,source,actor:actor.trim()}));
    return {job,planHash:j.plan_hash,binding,source,actor:actor.trim()};
  }).immediate();
}

export const PLAN_STATUS_INSTRUCTION=[
  'End the plan with exactly one machine-readable readiness receipt on its own line:',
  '<!-- ADLC_PLAN_STATUS {"version":1,"readiness":"ready|needs-input|blocked-by-dependency","questions":[{"id":"q1","question":"...","kind":"requirement|dependency|security-scope"}],"dependencies":[{"ref":"ISSUE-OR-REF","reason":"..."}],"risks":["..."]} -->',
  'Use ready only when no requirement, dependency or security/scope decision is unresolved; ordinary non-blocking risks belong in risks and do not block. Use needs-input for missing decisions or approved wording and blocked-by-dependency for named external dependencies. Never fabricate an answer to make the plan ready.'
].join('\n');
export const WORKER_STATUS_INSTRUCTION=[
  'Before your final response, emit exactly one machine-readable outcome receipt on its own line:',
  '<!-- ADLC_WORKER_STATUS {"version":1,"outcome":"pr-handoff|needs-input|blocked-dependency|failed|uncertain","reason":"...","questions":[{"id":"q1","question":"...","kind":"requirement|dependency|security-scope"}],"dependencies":[{"ref":"ISSUE-OR-REF","reason":"..."}]} -->',
  'Use pr-handoff only after opening or updating exactly one PR. If you must stop for a human decision or an unmet dependency, report needs-input or blocked-dependency with the exact question or reference. Never invent answers and never claim a PR that does not exist.'
].join('\n');
