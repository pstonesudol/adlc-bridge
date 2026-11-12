import type {Store} from './core';
import {effectiveSettings,type ProjectSettings} from './project-settings';

// Uncertain and reconciliation-blocked reservations always consume capacity.
// Completed planning dispatches release their slot even if manually proposed.
export const activePlanning="(EXISTS (SELECT 1 FROM planning_restores restore WHERE restore.job=d.job AND restore.state IN ('reserved','setup_consumed')) OR d.state IN ('dispatch_uncertain','needs_reconciliation') OR (d.state NOT IN ('awaiting_approval','planning_finished') AND j.state NOT IN ('awaiting_approval','approved','done')))";
export class PlanningCapacityReached extends Error{
 constructor(){super('Planning concurrency limit reached');this.name='PlanningCapacityReached';}
}
/** Call inside the transaction that reserves a new planning turn. Reusing an
 * already-settled owner replaces its own slot, not another job's reservation. */
export function assertPlanningCapacity(s:Store,c:ProjectSettings&{linear:{projectId:string}},reusedJob=''){
 const active=s.db.query(`SELECT count(*) AS n FROM planning_dispatch d JOIN jobs j ON j.id=d.job WHERE j.project=? AND d.job!=? AND ${activePlanning}`).get(c.linear.projectId,reusedJob) as {n:number};
 if(active.n>=effectiveSettings(c).maxPlanning)throw new PlanningCapacityReached();
}
