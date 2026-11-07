function timestamp(value:unknown){const n=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(n)?n:0;}
function order(c:any){return [Math.max(timestamp(c.completed_at),timestamp(c.started_at)),timestamp(c.started_at),Number.isSafeInteger(c.id)&&c.id>0?c.id:0];}
function compare(a:any,b:any,timed:boolean){const x=order(a),y=order(b);for(let i=timed?0:2;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];return 0;}

// A suite/run identifies an instance, not a logical check. Keep heads and apps
// separate and use provider chronology, never response order or a success bias.
// Unorderable ties remain ambiguous so callers still fail closed.
export function latestWorkflowChecks<T extends {name:string}>(checks:T[]):T[]{
 const groups=new Map<string,T[]>();
 for(const c of checks){
  const raw=c as any,key=JSON.stringify([raw.head_sha,raw.app?.slug??raw.app?.id,raw.name]);
  const group=groups.get(key)??[];group.push(c);groups.set(key,group);
 }
 return [...groups].sort(([a],[b])=>a.localeCompare(b)).flatMap(([,group])=>{
  const timed=group.every(c=>order(c)[0]>0);
  // Queued checks may have neither timestamp yet. In that case compare the
  // whole group by provider ID, rather than letting an older timestamp win.
  if(!timed&&!group.every(c=>order(c)[2]>0))return group;
  const sorted=[...group].sort((a,b)=>compare(b,a,timed));
  return sorted.filter(c=>compare(c,sorted[0],timed)===0);
 });
}

export function checkState(c:{status:string;conclusion:string|null}){
 if(c.status!=='completed')return 'pending';
 if(c.conclusion==='success')return 'success';
 if(['failure','timed_out','action_required','startup_failure'].includes(c.conclusion??''))return 'failure';
 // Cancellation, skipped/neutral and unknown conclusions cannot establish a pass.
 return 'pending';
}
