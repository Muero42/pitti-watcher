import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {policy,validatePolicy,simulate,runScenarios} from '../tools/write-budget-policy-simulation.mjs';
const empty=()=>({market:0,playerState:0,unknown:0,bookkeeping:0,retry:0});

test('candidate envelopes total exactly hypothetical 100k and preserve safety classifications',()=>{
  assert.equal(validatePolicy(),100000);
  assert.deepEqual(policy.envelopes,{market:72000,playerState:4000,unknown:3000,bookkeeping:4000,retry:5000,independentReserve:12000});
  assert.equal(policy.accountPlan,'UNKNOWN');assert.equal(policy.active,false);
  assert.throws(()=>validatePolicy({...policy,accountPlan:'FREE'}),/SAFETY/);
  assert.throws(()=>validatePolicy({...policy,envelopes:{...policy.envelopes,market:72001}}),/SUM/);
});

test('all observed days and conservative per-lane bounds fit without borrowing retry or reserve',()=>{
  const report=runScenarios();assert.equal(report.days.length,3);
  assert.deepEqual(report.days.map(d=>d.result.accountedWrites),[70074,64922,67714]);
  for(const row of [...report.days.map(d=>d.result),report.conservativeBounds]){
    assert.equal(row.fits,true);assert.equal(row.unusedRetry,5000);assert.equal(row.independentReserve,12000);
  }
  assert.ok(65080<policy.envelopes.market);assert.ok(3122<policy.envelopes.playerState);
  assert.ok(3041<policy.envelopes.bookkeeping);
});

for(const [key,limit] of Object.entries(policy.envelopes).filter(([key])=>key!=='independentReserve'))
  test(`${key} cannot use another class's spare capacity`,()=>{
    const usage={...empty(),[key]:limit+1};const result=simulate(usage,{retryPurpose:'retry'});
    assert.equal(result.fits,false);assert.ok(result.errors.includes(`${key.toUpperCase()}_CEILING_EXCEEDED`));
  });

test('bounded retry/completion allowed, new work and recursive retry rejected',()=>{
  for(const retryPurpose of ['retry','completion'])assert.equal(simulate({...empty(),retry:5000},{retryPurpose}).fits,true);
  assert.equal(simulate({...empty(),retry:1},{retryPurpose:'new_market_start'}).fits,false);
  assert.equal(simulate({...empty(),retry:1},{retryPurpose:'new_player_state_start'}).fits,false);
  assert.equal(simulate({...empty(),retry:1}).fits,false);
  assert.equal(simulate({...empty(),retry:1},{retryPurpose:'retry',recursiveRetry:true}).fits,false);
});

test('normal capacity never borrows independent reserve, even when total remains below ceiling',()=>{
  const result=simulate(empty(),{independentReserveUse:1});assert.equal(result.fits,false);
  assert.ok(result.errors.includes('INDEPENDENT_RESERVE_NOT_BORROWABLE'));
  assert.equal(simulate({...empty(),market:72001}).fits,false);
  assert.throws(()=>simulate({...empty(),independentReserve:12000}),/INVALID_ACCOUNTING_CLASS/);
});

test('global excess and unaccounted usage fail closed without invented rest budget',()=>{
  const result=simulate(empty(),{totalWrites:100001});assert.equal(result.fits,false);
  assert.ok(result.errors.includes('GLOBAL_CEILING_EXCEEDED'));
  assert.ok(result.errors.includes('TOTAL_ACCOUNTING_MISMATCH'));
  assert.equal(simulate(empty(),{totalWrites:88001}).fits,false);
  for(const value of [null,undefined,NaN,-1,1.5,'10',Infinity])assert.throws(()=>simulate({...empty(),market:value}),/INVALID_COUNT/);
});

test('October 5 outbox scenario violates policy eligibility and global planning model',()=>{
  const first=runScenarios().days[0];assert.equal(first.outboxIncrement,32490);
  assert.equal(first.outboxScenario.accountedWrites,102564);assert.equal(first.outboxScenario.fits,false);
  assert.ok(first.outboxScenario.errors.includes('GLOBAL_CEILING_EXCEEDED'));
  assert.equal(policy.outboxReady,false);assert.equal(policy.externalAlertingReady,false);
});

test('no runtime source imports or reads policy artifacts',()=>{
  for(const name of readdirSync(new URL('../src/',import.meta.url)).filter(n=>/\.(js|mjs)$/.test(n))){
    const source=readFileSync(new URL('../src/'+name,import.meta.url),'utf8');
    assert.doesNotMatch(source,/write-budget-policy-v1|write-budget-policy-simulation/,name);
  }
});

test('malformed options cannot silently default to a passing simulation',()=>{
  for(const options of [null,false,true,0,1,'bad',[],new Date(),
    {independentReserve:12000},{unexpected:0},{recursiveRetry:undefined},
    Object.create({independentReserveUse:12000})]) {
    assert.throws(()=>simulate(empty(),options),/INVALID_SIMULATION_OPTIONS/);
  }
  for(const value of [null,0,1,'false',NaN])
    assert.throws(()=>simulate(empty(),{recursiveRetry:value}),/INVALID_RECURSIVE_RETRY/);
  for(const value of [null,1,false,[]])
    assert.throws(()=>simulate(empty(),{retryPurpose:value}),/INVALID_RETRY_PURPOSE/);
  for(const value of [null,NaN,Infinity,-1,'0',1.5]){
    assert.throws(()=>simulate(empty(),{totalWrites:value}),/INVALID_COUNT/);
    assert.throws(()=>simulate(empty(),{independentReserveUse:value}),/INVALID_COUNT/);
  }
  assert.equal(simulate(empty()).fits,true,'omitted total is a derived offline scenario');
  assert.equal(simulate(empty(),{totalWrites:0,recursiveRetry:false}).fits,true);
});

test('missing or inherited accounting classes cannot supply invented zero usage',()=>{
  for(const usage of [null,undefined,[],new Date(),{},Object.create(empty())])
    assert.throws(()=>simulate(usage),/INVALID_ACCOUNTING_CLASS/);
  for(const key of Object.keys(empty())){
    const usage=empty();delete usage[key];
    assert.throws(()=>simulate(usage),/INVALID_ACCOUNTING_CLASS/);
  }
});
