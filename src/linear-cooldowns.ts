import type {Store} from './core';
import {createHash} from 'node:crypto';

const fingerprint=(token:string)=>createHash('sha256').update('adlc-linear-api-key\0'+token).digest('hex');
export class LinearCooldown extends Error {
  constructor(public nextEligible:number){super(`Linear quota cooldown; next eligible ${new Date(nextEligible).toISOString()}`);}
}
// Unlike a throttle response, admission rejection proves this operation was not sent.
export class LinearPreSendCooldown extends LinearCooldown {}
type Budget={remaining:number|null;limit:number|null;reset:number|null};
export type QuotaEvidence={requests:Budget;endpointRequests:Budget;complexity:Budget;endpointComplexity:Budget;retryAfter:number|null};
const numeric=(s:string|null)=>s!==null&&s.trim()!==''&&Number.isFinite(Number(s))&&Number(s)>=0?Number(s):null;
function reset(s:string|null){const n=numeric(s);if(n===null)return null;const ms=n<1e12?n*1000:n;return Number.isSafeInteger(ms)&&ms<=8640000000000000?ms:null;}
export function quotaEvidence(headers:Headers,now:number):QuotaEvidence {
  const budget=(name:string):Budget=>({remaining:numeric(headers.get(`x-ratelimit-${name}-remaining`)),limit:numeric(headers.get(`x-ratelimit-${name}-limit`)),reset:reset(headers.get(`x-ratelimit-${name}-reset`))});
  const raw=headers.get('retry-after'),seconds=numeric(raw),date=raw===null?NaN:Date.parse(raw);
  const retry=seconds!==null?now+seconds*1000:Number.isFinite(date)?date:null;
  return {requests:budget('requests'),endpointRequests:budget('endpoint-requests'),complexity:budget('complexity'),endpointComplexity:budget('endpoint-complexity'),retryAfter:retry!==null&&Number.isSafeInteger(retry)&&retry<=8640000000000000?retry:null};
}
export const isLinearThrottle=(status:number,body:any)=>status===429||Array.isArray(body?.errors)&&body.errors.some((e:any)=>[e?.extensions?.code,e?.extensions?.type].includes('RATELIMITED'));

// All tables live in the shared state database, never a project-local cache.
export class LinearCooldowns {
  constructor(public s:Store,public now=Date.now,public pause:(ms:number)=>Promise<unknown>=Bun.sleep){}
  private credential(token:string){if(!token)throw Error('ADLC_LINEAR_TOKEN required');return fingerprint(token);}
  private scope(credential:string){const row=this.s.db.query('SELECT viewer FROM linear_quota_credentials WHERE credential=?').get(credential) as any;return row?.viewer?'viewer:'+row.viewer:'credential:'+credential;}
  private ensure(scope:string){this.s.db.query('INSERT OR IGNORE INTO linear_quota_state(scope) VALUES (?)').run(scope);}
  verified(token:string){return this.scope(this.credential(token)).startsWith('viewer:');}
  verify(token:string,viewer:unknown){
    if(typeof viewer!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i).test(viewer))return;
    const credential=this.credential(token),scope='viewer:'+viewer.toLowerCase();
    this.s.db.transaction(()=>{
      const oldScope=this.scope(credential);
      this.ensure(scope);
      // Transfer local cooldowns when verification becomes available; never shorten
      // an account hold, including one written by a different key or process.
      const old=this.s.db.query('SELECT * FROM linear_quota_state WHERE scope=?').get(oldScope) as any;
      if(old&&oldScope.startsWith('credential:')){
        this.s.db.query('UPDATE linear_quota_state SET until_ms=MAX(until_ms,?),next_request=MAX(next_request,?),failures=MAX(failures,?) WHERE scope=?').run(old.until_ms,old.next_request,old.failures,scope);
        this.s.db.query('UPDATE linear_quota_state SET last_throttle=?,throttle_kind=? WHERE scope=? AND (last_throttle IS NULL OR last_throttle<?)').run(old.last_throttle,old.throttle_kind,scope,old.last_throttle);
      }
      this.s.db.query('INSERT INTO linear_quota_credentials VALUES (?,?) ON CONFLICT(credential) DO UPDATE SET viewer=excluded.viewer').run(credential,viewer.toLowerCase());
    }).immediate();
  }
  async admit(token:string,project?:string){
    const credential=this.credential(token),at=this.now();
    const slot=this.s.db.transaction(()=>{
      const scope=this.scope(credential);this.ensure(scope);
      if(project)this.s.db.query("INSERT INTO linear_quota_projects VALUES (?,?,'polling',?) ON CONFLICT(project) DO UPDATE SET credential=excluded.credential,intake_state=excluded.intake_state,observed=excluded.observed").run(project,credential,at);
      const row=this.s.db.query('SELECT * FROM linear_quota_state WHERE scope=?').get(scope) as any;
      if(row.until_ms>at){if(project)this.s.db.query("UPDATE linear_quota_projects SET intake_state='cooldown' WHERE project=?").run(project);return {until:row.until_ms,wait:0};}
      // Durable staggered admission prevents a restart herd, including across keys.
      const slot=Math.max(at,row.next_request);
      this.s.db.query('UPDATE linear_quota_state SET next_request=? WHERE scope=?').run(slot+250,scope);
      return {until:0,wait:slot-at};
    }).immediate();
    if(slot.until)throw new LinearPreSendCooldown(slot.until);
    if(slot.wait>0)await this.pause(slot.wait);
    const row=this.s.db.query('SELECT until_ms FROM linear_quota_state WHERE scope=?').get(this.scope(credential)) as any;
    if(row?.until_ms>this.now())throw new LinearPreSendCooldown(row.until_ms);
  }
  observe(token:string,status:number,headers:Headers,body:any){
    if(status>=200&&status<300&&!body?.errors)this.verify(token,body?.data?.viewer?.id);
    const credential=this.credential(token),at=this.now(),evidence=quotaEvidence(headers,at),throttled=isLinearThrottle(status,body);
    return this.s.db.transaction(()=>{
      const scope=this.scope(credential);this.ensure(scope);
      const row=this.s.db.query('SELECT * FROM linear_quota_state WHERE scope=?').get(scope) as any;
      const budgets=[evidence.requests,evidence.endpointRequests,evidence.complexity,evidence.endpointComplexity];
      const exhausted=budgets.filter(b=>b.remaining===0);
      let until=0;
      if(throttled||exhausted.length){
        // Complexity can be insufficient for this operation without reaching zero.
        // When no exhausted dimension identifies the limit, conservatively honor
        // every supplied reset rather than assuming a positive balance is usable.
        const applicable=throttled?(exhausted.length?budgets.filter(b=>b.remaining===null||b.remaining===0):budgets):exhausted;
        const resets=applicable.map(b=>b.reset).filter((n):n is number=>n!==null&&n>at);
        if(evidence.retryAfter!==null&&evidence.retryAfter>at)resets.push(evidence.retryAfter);
        until=resets.length?Math.max(...resets):at+Math.min(900000,60000*2**Math.min(row.failures,4));
      }
      this.s.db.query('UPDATE linear_quota_state SET until_ms=MAX(until_ms,?),evidence=?,observed=?,failures=? WHERE scope=?').run(until,JSON.stringify(evidence),at,until?Math.min(row.failures+1,5):0,scope);
      if(throttled)this.s.db.query('UPDATE linear_quota_state SET last_throttle=?,throttle_kind=? WHERE scope=?').run(at,status===429?'HTTP 429':'GraphQL RATELIMITED',scope);
      return Math.max(row.until_ms,until);
    }).immediate();
  }
  state(project:string,state:string){this.s.db.query('UPDATE linear_quota_projects SET intake_state=?,observed=? WHERE project=?').run(state,this.now(),project);}
}

export function linearQuotaStatus(s:Store,project:string,now=Date.now()){
  const unknown={project,identityVerification:'unknown',crossKeySharing:'unverified',intakeState:'unknown',lastThrottle:null,availableRequestBudget:null,requestBudgetEvidence:'unknown',reset:null,resetEvidence:'unknown',nextEligiblePoll:null,evidence:'unknown'};
  if(!s.db.query("SELECT name FROM sqlite_master WHERE name='linear_quota_projects'").get())return unknown;
  const p=s.db.query('SELECT * FROM linear_quota_projects WHERE project=?').get(project) as any;
  if(!p)return unknown;
  const c=s.db.query('SELECT viewer FROM linear_quota_credentials WHERE credential=?').get(p.credential) as any;
  const row=s.db.query('SELECT * FROM linear_quota_state WHERE scope=?').get(c?.viewer?'viewer:'+c.viewer:'credential:'+p.credential) as any;
  const e=row?.evidence?JSON.parse(row.evidence):null;
  return {...unknown,identityVerification:c?.viewer?'verified':'unknown',crossKeySharing:c?.viewer?'verified':'unverified',intakeState:row?.until_ms>now?'cooldown':p.intake_state==='cooldown'?'eligible':p.intake_state,lastThrottle:row?.last_throttle?{at:row.last_throttle,kind:row.throttle_kind}:null,availableRequestBudget:e?.requests.remaining??null,requestBudgetEvidence:e?.requests.remaining==null?'unknown':'observed',reset:e?.requests.reset??null,resetEvidence:e?.requests.reset==null?'unknown':'observed',nextEligiblePoll:row?Math.max(now,row.until_ms,row.next_request):null,evidence:e??'unknown',observed:row?.observed??null};
}
