-- News-only ordered candidate scans. No backfill or non-News row changes.
CREATE INDEX IF NOT EXISTS idx_news_evidence_retention
  ON evidence_events(first_seen_at,id)
  WHERE fundamental_or_market='news' AND event_type='NEWS_REPORT';
CREATE INDEX IF NOT EXISTS idx_news_runs_retention
  ON watcher_runs(finished_at,id)
  WHERE run_type='news:scheduled' AND finished_at IS NOT NULL;
