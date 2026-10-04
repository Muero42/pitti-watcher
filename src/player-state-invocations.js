export const LEDGER_RETENTION_DAYS = 7;
export const LEDGER_RETENTION_LIMIT = 512;
export const LEDGER_START_SQL = `INSERT INTO player_state_invocations
  (id,started_at,scheduled_at,trigger_kind) VALUES(?1,?2,?3,?4)`;
export const LEDGER_FINISH_SQL = `UPDATE player_state_invocations SET
  finished_at=?1,run_id=?2,scope_index=?3,scope_offset=?4,state=?5,error_code=?6
  WHERE id=?7 AND state='open' AND finished_at IS NULL`;
export const LEDGER_RETENTION_SQL = `DELETE FROM player_state_invocations WHERE id IN
  (SELECT id FROM player_state_invocations WHERE started_at<?1 ORDER BY started_at,id LIMIT 512)`;

function diagnostic(code) {
  // Never format exceptions, controller values or SQL bindings.
  try { console.log(JSON.stringify({event:'player_state_ledger',code})); } catch (_) {}
}
async function shadow(code, action) {
  try { return await action(); } catch (_) { diagnostic(code); return null; }
}
function checked(result, exact = true) {
  if (result?.success !== true || (exact && result.meta?.changes !== 1)) {
    throw new Error('LEDGER_WRITE_UNCONFIRMED');
  }
  return result;
}

export async function recordPlayerStateInvocation(env, controller, kind, work) {
  const startedAt = Date.now();
  const context = {};
  const record = await shadow('LEDGER_START_FAILED', async () => {
    const id = crypto.randomUUID(); // Each platform retry is a distinct invocation.
    const scheduledAt = Number.isSafeInteger(controller.scheduledTime) ? controller.scheduledTime : null;
    checked(await env.DB.prepare(LEDGER_START_SQL).bind(id,startedAt,scheduledAt,kind).run());
    return id;
  });
  let state = 'ok';
  try {
    if (kind === 'daily_start') await shadow('LEDGER_RETENTION_FAILED', async () => checked(
      await env.DB.prepare(LEDGER_RETENTION_SQL).bind(startedAt-LEDGER_RETENTION_DAYS*86400000).run(),false
    ));
    return await work(context, startedAt);
  } catch (error) {
    state = 'fail';
    throw error; // Preserve the core failure, including its original identity.
  } finally {
    if (record) await shadow('LEDGER_FINISH_FAILED', async () => checked(
      await env.DB.prepare(LEDGER_FINISH_SQL).bind(Date.now(),context.run_id ?? null,
        context.scope_index ?? null,context.scope_offset ?? null,state,
        state === 'fail' ? 'PLAYER_STATE_WORK_FAILED' : null,record).run()
    ));
  }
}
