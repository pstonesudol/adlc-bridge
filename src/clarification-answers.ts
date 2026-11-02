/** Independent DEV-18 adapter. No persistence, publication, resolution or dispatch.
 * A complete candidate is NOT a semantic resolution or an authorization. */
export type ClarificationQuestion={id:string;question:string;kind:'requirement'|'dependency'|'security-scope'};
export type ClarificationContext={issue:string;job:string;binding:string;reference:string;noticeId:string;publishedAt:string;questions:ClarificationQuestion[]};
export type HumanComment={id:string;issue:string;body:string;createdAt:string;editedAt:string|null;user:{id:string;app:boolean}|null;botActor:unknown};
export type AnswerCandidate={comment:string;actor:string;question:string;text:string};
export type AnswerResult={state:'ignored'|'partial'|'candidate';reason:string;answers:AnswerCandidate[];remaining:string[]};
export interface AnswerEvidence {
 // Must return the current outstanding request, not a cached historical notice.
 current(issue:string,job:string):Promise<ClarificationContext|null>;
 authorizedHumanIds():Promise<readonly string[]>;
 // Durable consumption belongs to the host, after semantic validation.
 consumed(comment:string):Promise<boolean>;
}
const timestamp=(s:string)=>Number.isFinite(Date.parse(s));
function parseAnswers(c:ClarificationContext,comment:HumanComment):AnswerResult {
 const remaining=c.questions.map(q=>q.id);
 const ignore=(reason:string):AnswerResult=>({state:'ignored',reason,answers:[],remaining});
 if(!c.questions.length||new Set(remaining).size!==remaining.length||remaining.some(id=>!id||/[\r\n:]/.test(id)))return ignore('Invalid outstanding questions');
 if(comment.issue!==c.issue||comment.id===c.noticeId)return ignore('Not a reply to this issue');
 if(!timestamp(c.publishedAt)||!timestamp(comment.createdAt)||Date.parse(comment.createdAt)<=Date.parse(c.publishedAt))return ignore('Reply predates request');
 if(comment.editedAt!==null)return ignore('Edited reply requires review or a new comment');
 const body=comment.body.trim();
 if(!body||body.length>4000)return ignore('Empty or oversized reply');
 // Reject rather than strip quotations: quoted material must not answer a question.
 if(/^\s*>/m.test(body)||body.includes('```')||body.includes('~~~')||/<!--|-->/.test(body))return ignore('Quoted or embedded content requires review');
 let lines=body.split(/\r?\n/);
 if(lines[0].startsWith('Clarification ')){
  if(lines.shift()!==`Clarification ${c.reference}`)return ignore('Stale or foreign reference');
 }else if(/\bClarification\b/i.test(body))return ignore('Ambiguous reference');
 lines=lines.map(x=>x.trim()).filter(Boolean);
 const answers:AnswerCandidate[]=[];
 for(const line of lines){
  const m=line.match(/^([^:]+):\s*(.+)$/);
  if(!m||!remaining.includes(m[1])){
   // Ordinary prose is unambiguous structurally only for one question.
   if(c.questions.length===1&&lines.length===1&&!/^\s*[^:]+:/.test(line)){
    answers.push({comment:comment.id,actor:comment.user!.id,question:remaining[0],text:line});break;
   }
   return ignore('Use question IDs for multiple or ambiguous answers');
  }
  if(answers.some(x=>x.question===m[1]))return ignore('Repeated question ID');
  answers.push({comment:comment.id,actor:comment.user!.id,question:m[1],text:m[2].trim()});
 }
 if(!answers.length)return ignore('No answer supplied');
 const pending=remaining.filter(id=>!answers.some(a=>a.question===id));
 return {state:pending.length?'partial':'candidate',reason:'Untrusted answer candidates require semantic and scope validation',answers,remaining:pending};
}
export async function inspectHumanAnswer(e:AnswerEvidence,expected:ClarificationContext,comment:HumanComment):Promise<AnswerResult>{
 const ignored=(reason:string):AnswerResult=>({state:'ignored',reason,answers:[],remaining:expected.questions.map(q=>q.id)});
 const users=await e.authorizedHumanIds();
 if(!comment.user||comment.user.app!==false||comment.botActor!==null||!users.includes(comment.user.id))return ignored('Not a configured human');
 if(await e.consumed(comment.id))return ignored('Already consumed');
 const current=await e.current(expected.issue,expected.job);
 if(!current||JSON.stringify(current)!==JSON.stringify(expected))return ignored('Request changed or resolved');
 return parseAnswers(current,comment);
}
