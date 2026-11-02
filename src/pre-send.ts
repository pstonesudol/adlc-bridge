// Only transport code that proves a request never reached its send boundary
// may raise this. Errors at or after delivery must remain uncertain.
export class PreSendFailure extends Error{}
