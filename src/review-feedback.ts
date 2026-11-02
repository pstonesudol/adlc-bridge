import {Store} from './core';

// Durable provenance for inline review feedback that was already handed to the
// existing worker. It prevents the same carried-forward thread from being sent
// again on every poll/push while a thread stays unresolved, and keeps the
// original thread/comment identity available for operator inspection.
const TABLE=`CREATE TABLE IF NOT EXISTS review_feedback(
 job TEXT NOT NULL,thread_id TEXT NOT NULL,comments_hash TEXT NOT NULL,path TEXT,
 head TEXT NOT NULL,attempt INTEGER,state TEXT NOT NULL DEFAULT 'dispatched',
 updated TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(job,thread_id,comments_hash));`;

export function ensureReviewFeedback(db:any){db.exec(TABLE);}

export function feedbackKey(threadId:string,commentsHash:string){return `${threadId}\u0000${commentsHash}`;}

export function feedbackIdentity(f:any):{threadId:string;commentsHash:string}|undefined{
 if(!f||f.source!=='github-review'||typeof f.threadId!=='string'||!f.threadId||typeof f.commentsHash!=='string'||!/^[a-f0-9]{64}$/.test(f.commentsHash))return;
 return {threadId:f.threadId,commentsHash:f.commentsHash};
}

export function dispatchedFeedback(s:Store,job:string){
 ensureReviewFeedback(s.db);
 const rows=s.db.query('SELECT thread_id,comments_hash,path,head,attempt,state FROM review_feedback WHERE job=?').all(job) as any[];
 return new Map(rows.map(r=>[feedbackKey(r.thread_id,r.comments_hash),r]));
}

// The caller wraps reservation and this claim in one immediate transaction.
// Nested transactions use savepoints; a conflict rolls back the entire attempt,
// including budget consumption. Never silently accept an overlapping batch.
export function recordDispatchedFeedback(s:Store,job:string,head:string,attempt:number,findings:any[]){
 if(!Number.isSafeInteger(attempt)||attempt<1)return 0;
 const rows=(Array.isArray(findings)?findings:[]).map(f=>({f,id:feedbackIdentity(f)})).filter(x=>x.id) as any[];
 if(!rows.length)return 0;
 return s.db.transaction(()=>{
  ensureReviewFeedback(s.db);
  let recorded=0;
  for(const {f,id} of rows){
   const path=typeof f.path==='string'?f.path:null;
   if(s.db.query('SELECT 1 FROM review_feedback WHERE job=? AND thread_id=? AND comments_hash=?').get(job,id.threadId,id.commentsHash))throw Error('Review feedback already claimed; reconcile before retry');
   const inserted=s.db.query(`INSERT INTO review_feedback(job,thread_id,comments_hash,path,head,attempt,state)
    VALUES (?,?,?,?,?,?,'dispatched')`).run(job,id.threadId,id.commentsHash,path,head,attempt);
   recorded+=inserted.changes?1:0;
  }
  return recorded;
 }).immediate();
}
