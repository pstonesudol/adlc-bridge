from pathlib import Path
import os,subprocess,base64,hmac,hashlib,re,time,json,urllib.request,signal,shlex,secrets
root=Path.home()/'Library/Application Support/ADLC Bridge'
manifest=json.loads((root/'orchestrator-runtime.json').read_text())
exe=Path(manifest['executable'])
assert hashlib.sha256(exe.read_bytes()).hexdigest()==manifest['sha256'],'Hotfix binary changed'
data=Path.home()/'.ao/data'
data.mkdir(parents=True,exist_ok=True)
keypath=data/'browser-runtime.key'
if not keypath.exists():
 with keypath.open('x') as f:f.write(base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip('=')+'\n')
 keypath.chmod(0o600)
raw=keypath.read_text()
records=raw.split('\n')[:-1] if '\n' in raw else [raw]
record=next(x.strip() for x in records if re.fullmatch(r'[A-Za-z0-9_-]{43}',x.strip()))
key=base64.urlsafe_b64decode(record+'=')
assert len(key)==32
token=base64.urlsafe_b64encode(hmac.new(key,b'ao-browser-runtime-token-v1',hashlib.sha256).digest()).decode().rstrip('=')
resources=Path('/Applications/Agent Orchestrator.app/Contents/Resources')
runid=manifest['appRunId']
env={**os.environ,'PATH':str(Path.home()/'.local/bin')+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin','AO_DATA_DIR':str(data),'AO_RUN_FILE':str(Path.home()/'.ao/running.json'),'AO_PORT':'3001','AO_APP_RUN_ID':runid,'AO_OWNER':'persistent','AO_BROWSER_RUNTIME_TOKEN_STDIN':'1','AO_ACP_RUNTIME_DIR':str(resources/'acp-runtime'),'AO_WAKE_HELPER':str(resources/'wake-helper/ao-wake'),'AO_CLOUDFLARED_PATH':str(resources/'cloudflared/cloudflared'),'AO_TMUX_BINARY':str(resources/'tmux/bin/tmux'),'AO_TMUX_SOCKET_NAME':'ao'}
p=subprocess.Popen([str(exe),'daemon'],cwd=str(Path.home()/'.ao'),env=env,stdin=subprocess.PIPE)
def stop(*_):
 p.terminate()
signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
p.stdin.write((token+'\n').encode());p.stdin.close();del token,key
for attempt in range(100):
 if p.poll() is not None: raise SystemExit(p.returncode)
 try:
  with urllib.request.urlopen('http://127.0.0.1:3001/readyz',timeout=1) as r: ready=json.load(r)
  if ready.get('pid')==p.pid:break
 except Exception:pass
 time.sleep(.2)
else:
 p.terminate();raise SystemExit('Hotfix readiness timeout')
for name,value in {'AO_APP_RUN_ID':runid,'AO_DAEMON_COMMAND':shlex.quote(str(exe))+' daemon','AO_KEEP_DAEMON':'1'}.items():
 subprocess.run(['/bin/launchctl','setenv',name,value],check=True)
print('Patched daemon ready for desktop attachment',flush=True)
raise SystemExit(p.wait())
