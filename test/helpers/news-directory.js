export async function seedNewsDirectory(db,at,players,{accepted=true,complete=true}={}){
  const run=await db.prepare(`INSERT INTO watcher_runs(run_type,started_at,finished_at,ok,item_count)
    VALUES('player_state:scheduled',?,?,?,?) RETURNING id`).bind(at-1000,accepted?at:null,accepted?1:0,players.length).first();
  await db.prepare(`INSERT INTO player_state_sweeps(run_id,source_etag,total_entries,next_index,seen_count,started_at,revalidated_at)
    VALUES(?,'{}',5,?,?,?,?)`).bind(run.id,complete?5:4,players.length,at-1000,complete?at:null).run();
  for(const scope of ['QB','RB','WR','TE','K']){
    const entries=players.filter(p=>(p.position||'WR')===scope).map(p=>[p.player_id,{full_name:p.full_name,position:scope}]);
    await db.prepare(`INSERT INTO player_state_scope_frames VALUES(?,?,?,'fixture-etag',?,?)`).bind(run.id,scope,at,entries.length,JSON.stringify(entries)).run();
  }
  return run.id;
}
