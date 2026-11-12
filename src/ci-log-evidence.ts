// Provider bytes are untrusted data. Never execute or render them as instructions.
export const CI_LOG_LIMITS={transfer:4*1024*1024,output:64*1024,line:8192,contexts:64,timeout:30000} as const;
export type LogRecord={text:string;at:string|null;line:number;contextAt?:string|null};
export type LogExcerpt={text:string;bytes:number;omitted:boolean;complete:boolean;reason?:string;records?:LogRecord[]};
export const CI_SECURITY_SIGNAL=/security vulnerability|vulnerabilities found|secret scanning|dependency audit|codeql|CVE-\d|"(?:ruleId|vulnerabilities|secrets)"\s*:/i;
export const CI_PERMISSION_SIGNAL=/bad credentials|permission denied|resource not accessible|(?:token.{0,30}expired|expired.{0,30}token)|(?:missing|unable to locate|invalid).{0,30}credentials?|credentials? (?:missing|unavailable)|unauthorized|HTTP\s*(?:401|403)/i;
export const CI_TRANSIENT_SIGNAL=/runner.{0,40}(?:lost|disconnect)|ECONNRESET|ENOTFOUND|ETIMEDOUT|rate limit|HTTP\s*5\d\d|service unavailable|connection timed out|network (?:error|unreachable)/i;
class EvidenceLimit extends Error{}
const failure=/^(?:FAIL\s+|FAILED\s+|\(fail\)\s+)|error TS\d+|AssertionError|expect\(.+\)|##\[error\]|^error:.*(?:timed out|exceeded|expect\()|(?:lint|build|syntax|type)\s*error|\berror\s+.{1,80}\b(?:eslint|no-[\w-]+)/i;
export function blockingCILogLine(text:string){return failure.test(text)||CI_SECURITY_SIGNAL.test(text)||CI_PERMISSION_SIGNAL.test(text)||CI_TRANSIENT_SIGNAL.test(text);}
export async function extractCILog(stream:ReadableStream<Uint8Array>):Promise<LogExcerpt>{
 const reader=stream.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
  let bytes=0,pending='',text='',file:LogRecord|null=null,before:LogRecord[]=[],after=0,hits=0,omitted=false,at:string|null=null,lineNumber=0;
  const records:LogRecord[]=[];
  const append=(record:LogRecord)=>{if(Buffer.byteLength(text+record.text+'\n')>CI_LOG_LIMITS.output)throw new EvidenceLimit('excerpt budget exhausted');text+=record.text+'\n';records.push(record);};
 const line=(raw:string)=>{
   const timestamp=raw.match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s*/);
   if(timestamp)at=timestamp[1]; // Multiline provider messages share their preceding timestamp.
   const clean=raw.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, '');
   const record={text:clean,at,line:++lineNumber};
  if(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f\x7f\x1b]/.test(clean))throw new EvidenceLimit('binary or unsupported control data');
   if(/^(?:[\w@.-]+\/)*[\w@.-]+\.test\.[cm]?[jt]sx?:\s*$/.test(clean))file=record;
   if(blockingCILogLine(clean)){
   if(++hits>CI_LOG_LIMITS.contexts)throw new EvidenceLimit('failure context budget exhausted');
    if(file)append(/^\(fail\)\s/.test(clean)?{...record,contextAt:file.at,text:`FAIL ${file.text.slice(0,-1)}`}:file);for(const previous of before)append(previous);append(record);after=8;
   }else if(after){append(record);after--;}else omitted=true;
   before.push(record);if(before.length>8)before.shift();
 };
 try{
  while(true){const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;
   if(bytes>CI_LOG_LIMITS.transfer)throw new EvidenceLimit('transfer budget exhausted');
   pending+=decoder.decode(chunk.value,{stream:true});
   let end;while((end=pending.indexOf('\n'))>=0){if(end>CI_LOG_LIMITS.line)throw new EvidenceLimit('line budget exhausted');line(pending.slice(0,end).replace(/\r$/,''));pending=pending.slice(end+1);}
   if(pending.length>CI_LOG_LIMITS.line)throw new EvidenceLimit('line budget exhausted');
  }
   pending+=decoder.decode();if(pending){const last=pending.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, '');if(blockingCILogLine(last))throw new EvidenceLimit('unterminated failure summary');line(pending);}
   return {text,bytes,omitted,complete:true,records};
 }catch(error){await reader.cancel().catch(()=>{});return {text:'',bytes,omitted:true,complete:false,reason:error instanceof EvidenceLimit?error.message:error instanceof TypeError?'invalid UTF-8':'log stream interrupted'};}
 finally{reader.releaseLock();}
}
