// Offline policy decision aid only. No runtime imports, network or database.
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

export const policy=JSON.parse(readFileSync(new URL('../config/write-budget-policy-v1.json',import.meta.url),'utf8'));
const classes=['market','playerState','unknown','bookkeeping','retry'];
function count(value,label) {
  if(!Number.isSafeInteger(value)||value<0)throw new Error(`INVALID_COUNT:${label}`);
  return value;
}
export function validatePolicy(candidate=policy) {
  if(candidate.status!=='POLICY_CANDIDATE'||candidate.active!==false||candidate.accountPlan!=='UNKNOWN' ||
    candidate.ceilingBasis!=='HYPOTHETICAL_FREE_PLANNING_ONLY'||candidate.window!=='UTC_DAY' ||
    candidate.independentReserveBorrowable!==false||candidate.recursiveRetryAllowed!==false ||
    candidate.outboxReady!==false||candidate.externalAlertingReady!==false ||
    JSON.stringify(candidate.retryPurposes)!==JSON.stringify(['retry','completion']))throw new Error('POLICY_SAFETY_INVARIANT');
  const sum=[...classes,'independentReserve'].reduce((n,k)=>n+count(candidate.envelopes[k],k),0);
  if(!Number.isSafeInteger(sum)||sum!==count(candidate.globalPlanningCeiling,'globalPlanningCeiling'))throw new Error('POLICY_SUM_MISMATCH');
  return sum;
}

function plainObject(value) {
  return value!==null && typeof value==='object' && Object.getPrototypeOf(value)===Object.prototype;
}
export function simulate(usage,options={}) {
  const allowed=['candidate','retryPurpose','recursiveRetry','independentReserveUse','totalWrites'];
  if(!plainObject(options) || Reflect.ownKeys(options).some(k=>!allowed.includes(k)) ||
    Object.values(options).some(v=>v===undefined))throw new Error('INVALID_SIMULATION_OPTIONS');
  if(Object.hasOwn(options,'recursiveRetry')&&typeof options.recursiveRetry!=='boolean')throw new Error('INVALID_RECURSIVE_RETRY');
  if(Object.hasOwn(options,'retryPurpose')&&typeof options.retryPurpose!=='string')throw new Error('INVALID_RETRY_PURPOSE');
  if(Object.hasOwn(options,'totalWrites'))count(options.totalWrites,'totalWrites');
  const {candidate=policy,retryPurpose=null,recursiveRetry=false,independentReserveUse=0}=options;
  validatePolicy(candidate);
  if(!plainObject(usage) || Reflect.ownKeys(usage).some(k=>!classes.includes(k)) ||
    classes.some(k=>!Object.hasOwn(usage,k)))throw new Error('INVALID_ACCOUNTING_CLASS');
  const errors=[];
  const writes=Object.fromEntries(classes.map(k=>[k,count(usage[k],k)]));
  for(const k of classes)if(writes[k]>candidate.envelopes[k])errors.push(`${k.toUpperCase()}_CEILING_EXCEEDED`);
  if(writes.retry>0&&!candidate.retryPurposes.includes(retryPurpose))errors.push('RETRY_PURPOSE_FORBIDDEN');
  if(recursiveRetry)errors.push('RECURSIVE_RETRY_FORBIDDEN');
  if(count(independentReserveUse,'independentReserveUse')!==0)errors.push('INDEPENDENT_RESERVE_NOT_BORROWABLE');
  const accounted=classes.reduce((n,k)=>n+writes[k],0);
  count(accounted,'accountedWrites');
  const reported=Object.hasOwn(options,'totalWrites')?options.totalWrites:accounted;
  if(reported!==accounted)errors.push('TOTAL_ACCOUNTING_MISMATCH');
  if(reported>candidate.globalPlanningCeiling)errors.push('GLOBAL_CEILING_EXCEEDED');
  if(reported>candidate.globalPlanningCeiling-candidate.envelopes.independentReserve)errors.push('INDEPENDENT_RESERVE_ENCROACHED');
  return {fits:errors.length===0,errors,accountedWrites:accounted,
    unusedRetry:candidate.envelopes.retry-writes.retry,
    independentReserve:candidate.envelopes.independentReserve,accountPlan:candidate.accountPlan};
}

export const observedDays=[
  {day:'2026-10-05',market:63911,playerState:1953,unknown:1169,events:10830},
  {day:'2026-10-06',market:59771,playerState:1481,unknown:629,events:9991},
  {day:'2026-10-07',market:61576,playerState:1894,unknown:1203,events:10439}
];
export function runScenarios() {
  const bookkeeping=2529+512; // Added control plus maximum future retention; ledger already observed.
  return {
    policySum:validatePolicy(),accountPlan:policy.accountPlan,
    days:observedDays.map(({day,events,...lanes})=>{
      const total=lanes.market+lanes.playerState+lanes.unknown+bookkeeping+events*3;
      return {day,result:simulate({...lanes,bookkeeping,retry:0}),
        outboxScenario:{fits:false,accountedWrites:total,
          errors:['OUTBOX_NOT_READY','OUTBOX_HAS_NO_POLICY_ENVELOPE',
            ...(total>policy.globalPlanningCeiling?['GLOBAL_CEILING_EXCEEDED']:[])]},
        outboxIncrement:events*3};
    }),
    conservativeBounds:simulate({market:65080,playerState:3122,unknown:1203,bookkeeping,retry:0})
  };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)console.log(JSON.stringify(runScenarios(),null,2));
