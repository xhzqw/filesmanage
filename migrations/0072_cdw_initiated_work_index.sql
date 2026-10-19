-- Author work tracking: order by actor and immutable creation key for
-- stable cursor pagination without scanning unrelated employees' tasks.
CREATE INDEX cdw_tasks_initiated_by_actor
 ON cdw_tasks(created_by,created_at DESC,id DESC);
