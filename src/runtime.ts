// Diagnostic only: no repository, credentials or agent are mounted or started.
export async function runtimeCheck(){
  const docker=Bun.which('docker');if(!docker)return {available:false,executionEnabled:false,reason:'Docker CLI missing'};
  const script='test "$(id -u)" = 65534 && test ! -e /var/run/docker.sock && test ! -e /Users && test ! -e /root/.ssh && ! touch /adlc-write-probe 2>/dev/null && touch /tmp/adlc-probe && ! ip route | grep -q default && echo ADLC_ISOLATION_PROBE_OK';
  const p=Bun.spawn([docker,'run','--rm','--pull=never','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','65534:65534','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=16m','alpine:latest','sh','-c',script],{stdout:'pipe',stderr:'pipe'});
  const [stdout,_stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);
  return {available:true,probePassed:code===0&&stdout.trim()==='ADLC_ISOLATION_PROBE_OK',executionEnabled:false,
    limitation:'Diagnostic container only; coding runs locally in Orchestrator, verification can run in Docker'};
}
