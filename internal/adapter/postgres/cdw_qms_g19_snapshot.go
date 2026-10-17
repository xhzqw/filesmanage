package postgres

import "context"

// Must be invoked immediately after Begin, before first query. All parts of
// a multi-query exported audit see the same MVCC snapshot, while the audit
// request itself can still append its own audit event before commit.
func (r *Repository) CDWQMSAuditBeginSnapshot(ctx context.Context) error {
	_, err := r.Q.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
	return err
}
