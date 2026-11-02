// Harmless child process: only startup acknowledgement, no provider/poll work.
import {acknowledgePoll} from '../src/poll-process';
import {turnBarrier} from '../src/turn-submission';
const [config,cli,state]=process.argv.slice(2);
const finished=await acknowledgePoll(config,cli,state,undefined,turnBarrier(state).submit);
console.log(JSON.stringify({pollingEntered:true}));
finished();
