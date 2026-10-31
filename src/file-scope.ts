// Scope strings are repository-relative globs, never shell arguments.
export function safePath(path:string){return !!path&&!path.startsWith('/')&&!/[\\\x00-\x1f]/.test(path)&&!path.split('/').some(p=>p==='..'||p==='.'||!p);}
function protectedPath(path:string){return path.split('/').some(p=>p.toLowerCase()==='.git'||p.toLowerCase().startsWith('.env')||['agents.md','.codex','.agents','.opencode'].includes(p.toLowerCase()));}
function matches(path:string,pattern:string){
 let regex='^';
 for(let i=0;i<pattern.length;i++){
  const c=pattern[i];
  if(c==='*'&&pattern[i+1]==='*'){if(pattern[i+2]==='/'){regex+='(?:.*/)?';i+=2;}else{regex+='.*';i++;}}
  else if(c==='*')regex+='[^/]*';
  else regex+=c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 }
 return new RegExp(regex+'$').test(path);
}
export function validScopes(scopes:string[]){return Array.isArray(scopes)&&scopes.length>0&&scopes.some(p=>!p.startsWith('!'))&&scopes.every(p=>typeof p==='string'&&safePath(p.startsWith('!')?p.slice(1):p));}
export function scopeAllows(path:string,scopes:string[]){return safePath(path)&&!protectedPath(path)&&validScopes(scopes)&&scopes.some(s=>!s.startsWith('!')&&matches(path,s))&&!scopes.some(s=>s.startsWith('!')&&matches(path,s.slice(1)));}
