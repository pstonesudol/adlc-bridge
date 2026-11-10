import {Store} from './core';

/** Persisted independently of review clearance; this is status, not authority. */
export function maintenanceStatus(s:Store,job:string):any{
 if(!s.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='branch_maintenance'").get())return null;
 const status=s.db.query('SELECT * FROM branch_maintenance WHERE job=?').get(job) as any;
 const schedule=s.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='maintenance_schedule'").get()?s.db.query('SELECT next_check,attempts,failures,reason FROM maintenance_schedule WHERE job=?').get(job):null;
 return status||schedule?{...status,schedule}:null;
}
