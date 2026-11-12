/** Offline provider inventory with explicit completeness; not production fallback. */
export function planningPRFixture(evidence:()=>any){
 return async(repo:string,branch:string)=>({repo,branch,complete:true as const,prs:(evidence().session.prs??[]).filter((p:any)=>p.state==='open').map((p:any)=>({number:p.number,url:p.url,repo,branch,head:'a'.repeat(40),base:repo,state:'open' as const}))});
}
