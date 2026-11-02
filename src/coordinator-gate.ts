import {Database} from 'bun:sqlite';
import {existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';

// Setup does not receive AO_SESSION_ID. Verify the native coordinator-only
// workspace convention against AO's read-only project/session registry instead.
// A role claimed in project environment or a branch name is never sufficient.
export function verifiedCoordinator(db:Database,project:string,source:string,cwd:string,dataRoot:string){
 if(!/^[\w-]+$/.test(project))return false;
 const p=db.query('SELECT path, config FROM projects WHERE id=? AND archived_at IS NULL').get(project) as any;
 if(!p||realpathSync(p.path)!==source)return false;
 const config=JSON.parse(p.config??'{}');
 const prefix=config.sessionPrefix||project.slice(0,12);
 if(typeof prefix!=='string'||! /^[\w-]+$/.test(prefix))return false;
 const expected=join(dataRoot,'worktrees',project,'orchestrator',prefix+'-orchestrator');
 if(!existsSync(expected))return false;
 if(realpathSync(expected)!==cwd||expected!==cwd)return false;
 const sessions=db.query("SELECT workspace_path FROM sessions WHERE project_id=? AND kind='orchestrator' AND is_terminated=0").all(project) as any[];
 return sessions.length===1&&(!sessions[0].workspace_path||realpathSync(sessions[0].workspace_path)===cwd);
}
