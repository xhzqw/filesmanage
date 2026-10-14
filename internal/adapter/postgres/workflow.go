package postgres

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

// ---------- approval policies ----------

func (r *Repository) ApprovalPolicyFor(ctx context.Context, folderID string) (domain.ApprovalPolicy, bool, error) {
	var p domain.ApprovalPolicy
	err := r.Q.QueryRow(ctx,
		"SELECT folder_id,approver_id,enabled,approver_chain FROM approval_policies WHERE folder_id=$1", folderID).
		Scan(&p.FolderID, &p.ApproverID, &p.Enabled, &p.ApproverChain)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.ApprovalPolicy{}, false, nil
		}
		return domain.ApprovalPolicy{}, false, err
	}
	return p, true, nil
}

func (r *Repository) UpsertApprovalPolicy(ctx context.Context, p domain.ApprovalPolicy) error {
	_, err := r.Q.Exec(ctx,
		`INSERT INTO approval_policies(id,folder_id,approver_id,enabled,approver_chain) VALUES($1,$2,$3,$4,$5)
		 ON CONFLICT (folder_id) DO UPDATE SET approver_id=EXCLUDED.approver_id,enabled=EXCLUDED.enabled,approver_chain=EXCLUDED.approver_chain`,
		newID("policy"), p.FolderID, p.ApproverID, p.Enabled, p.ApproverChain)
	if isForeignKeyViolation(err) {
		return domain.ErrInvalidInput
	}
	return err
}

func (r *Repository) ClearApprovalPolicy(ctx context.Context, folderID string) error {
	_, err := r.Q.Exec(ctx, "DELETE FROM approval_policies WHERE folder_id=$1", folderID)
	return err
}

// ---------- approvals ----------

const approvalSelect = "SELECT a.id,a.file_id,a.requester_id,a.approver_id,a.payload_blob_id,a.base_seq,a.action,a.rollback_target_seq,a.state,coalesce(a.reason,''),coalesce(a.decision_comment,''),a.created_at,a.decided_at,coalesce(nullif(a.file_name_snapshot,''),f.name,''),b.sha256,b.size_bytes,coalesce(rq.display_name,''),coalesce(ap.display_name,''),a.approver_chain,a.step_index FROM approvals a LEFT JOIN files f ON f.id=a.file_id LEFT JOIN blobs b ON b.id=a.payload_blob_id LEFT JOIN users rq ON rq.id=a.requester_id LEFT JOIN users ap ON ap.id=a.approver_id"

func scanApproval(row rowScanner) (domain.Approval, error) {
	var a domain.Approval
	err := row.Scan(&a.ID, &a.FileID, &a.RequesterID, &a.ApproverID, &a.PayloadBlobID, &a.BaseSeq, &a.Action,
		&a.RollbackTargetSeq, &a.State, &a.Reason, &a.DecisionComment, &a.CreatedAt, &a.DecidedAt,
		&a.FileName, &a.PayloadSha256, &a.PayloadSize, &a.RequesterName, &a.ApproverName, &a.ApproverChain, &a.StepIndex)
	return a, err
}

func (r *Repository) CreateApproval(ctx context.Context, a domain.Approval) error {
	_, err := r.Q.Exec(ctx,
		"INSERT INTO approvals(id,file_id,requester_id,approver_id,payload_blob_id,base_seq,action,rollback_target_seq,state,reason,approver_chain,step_index,file_name_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
		a.ID, a.FileID, a.RequesterID, a.ApproverID, a.PayloadBlobID, a.BaseSeq, a.Action, a.RollbackTargetSeq, a.State, a.Reason, a.ApproverChain, a.StepIndex, a.FileName)
	if isUniqueViolation(err) {
		return domain.ErrApprovalPending
	}
	return err
}

func (r *Repository) ApprovalByID(ctx context.Context, id string) (domain.Approval, error) {
	row := r.Q.QueryRow(ctx, approvalSelect+" WHERE a.id=$1", id)
	a, err := scanApproval(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Approval{}, ports.ErrRowMissing
		}
		return domain.Approval{}, err
	}
	return a, nil
}

func (r *Repository) ListApprovalsForApprover(ctx context.Context, approverID string) ([]domain.Approval, error) {
	rows, err := r.Q.Query(ctx,
		approvalSelect+" WHERE a.approver_id=$1 AND a.state='pending' ORDER BY a.created_at DESC LIMIT 200", approverID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Approval, 0)
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Admin oversight lists pending decisions without widening ordinary user scopes.
func (r *Repository) ListPendingApprovalsForAdmin(ctx context.Context) ([]domain.Approval, error) {
	rows, err := r.Q.Query(ctx, approvalSelect+" WHERE a.state='pending' ORDER BY a.created_at DESC LIMIT 200")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Approval, 0)
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (r *Repository) ListApprovalsByRequester(ctx context.Context, requesterID string) ([]domain.Approval, error) {
	rows, err := r.Q.Query(ctx,
		approvalSelect+" WHERE a.requester_id=$1 ORDER BY a.created_at DESC LIMIT 200", requesterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Approval, 0)
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// Keyset cursor is the last approval ID of the preceding page. The immutable
// (created_at,id) ordering prevents concurrent inserts from shifting pages.
func (r *Repository) ListApprovalPage(ctx context.Context, scope, userID, cursor string, limit int) ([]domain.Approval, error) {
	var where string
	switch scope {
	case "inbox":
		where = "a.approver_id=$1 AND a.state='pending'"
	case "mine":
		where = "a.requester_id=$1"
	case "all_pending":
		// Keep the first bind parameter typed even for this admin-only scope.
		where = "a.state='pending' AND $1::text <> ''"
	default:
		return nil, domain.ErrInvalidInput
	}
	rows, err := r.Q.Query(ctx, approvalSelect+" WHERE "+where+
		" AND ($2::text='' OR (a.created_at,a.id)<(SELECT created_at,id FROM approvals WHERE id=$2))"+
		" ORDER BY a.created_at DESC,a.id DESC LIMIT $3", userID, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Approval, 0)
	for rows.Next() {
		a, err := scanApproval(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (r *Repository) CountPendingApprovals(ctx context.Context, userID string) (int, error) {
	var count int
	err := r.Q.QueryRow(ctx,"SELECT count(*) FROM approvals WHERE approver_id=$1 AND state='pending'",userID).Scan(&count)
	return count,err
}

func (r *Repository) PendingApprovalForFile(ctx context.Context, fileID string) (domain.Approval, bool, error) {
	row := r.Q.QueryRow(ctx, approvalSelect+" WHERE a.file_id=$1 AND a.state='pending'", fileID)
	a, err := scanApproval(row)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.Approval{}, false, nil
		}
		return domain.Approval{}, false, err
	}
	return a, true, nil
}

// DecideApproval transitions a pending approval to its terminal state. The
// state predicate makes the update itself the concurrency gate: only one
// concurrent decider can move a row out of pending.
func (r *Repository) DecideApproval(ctx context.Context, id, state, comment string) (bool, error) {
	tag, err := r.Q.Exec(ctx,
		"UPDATE approvals SET state=$2,decision_comment=$3,decided_at=now() WHERE id=$1 AND state='pending'", id, state, comment)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// Optimistic single-step advance; another approver or cancellation cannot win
// the same step. The caller commits this update with its audit event.
func (r *Repository) AdvanceApproval(ctx context.Context, id string, step int, nextID string) (bool, error) {
	tag, err := r.Q.Exec(ctx, "UPDATE approvals SET step_index=$2+1,approver_id=$3 WHERE id=$1 AND state='pending' AND step_index=$2 AND approver_id=approver_chain[$2+1]", id, step, nextID)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ---------- edit locks ----------

func (r *Repository) LockByFileID(ctx context.Context, fileID string) (domain.EditLock, error) {
	var l domain.EditLock
	var ownerName *string
	err := r.Q.QueryRow(ctx,
		"SELECT l.file_id,l.owner_id,l.token_hash,l.base_seq,l.expires_at,l.generation,coalesce(u.display_name,'') FROM edit_locks l LEFT JOIN users u ON u.id=l.owner_id WHERE l.file_id=$1", fileID).
		Scan(&l.FileID, &l.OwnerID, &l.TokenHash, &l.BaseSeq, &l.ExpiresAt, &l.Generation, &ownerName)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return domain.EditLock{}, ports.ErrRowMissing
		}
		return domain.EditLock{}, err
	}
	if ownerName != nil {
		l.OwnerName = *ownerName
	}
	return l, nil
}

func (r *Repository) InsertLock(ctx context.Context, l domain.EditLock) error {
	_, err := r.Q.Exec(ctx,
		"INSERT INTO edit_locks(file_id,owner_id,token_hash,base_seq,expires_at,generation) VALUES($1,$2,$3,$4,$5,$6)",
		l.FileID, l.OwnerID, l.TokenHash, l.BaseSeq, l.ExpiresAt, l.Generation)
	if isUniqueViolation(err) {
		return domain.ErrLocked
	}
	return err
}

func (r *Repository) RenewLock(ctx context.Context, fileID, tokenHash string, expires time.Time, generation int64) (bool, error) {
	tag, err := r.Q.Exec(ctx,
		"UPDATE edit_locks SET expires_at=$3 WHERE file_id=$1 AND token_hash=$2 AND generation=$4 AND expires_at>now()",
		fileID, tokenHash, expires, generation)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (r *Repository) ReleaseLock(ctx context.Context, fileID, tokenHash string) (bool, error) {
	tag, err := r.Q.Exec(ctx,
		"DELETE FROM edit_locks WHERE file_id=$1 AND token_hash=$2", fileID, tokenHash)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

// ForceReleaseLock removes any lock and returns it for the audit record.
func (r *Repository) ForceReleaseLock(ctx context.Context, fileID string) (domain.EditLock, error) {
	var l domain.EditLock
	err := r.Q.QueryRow(ctx,
		"DELETE FROM edit_locks WHERE file_id=$1 RETURNING file_id,owner_id,token_hash,base_seq,expires_at,generation", fileID).
		Scan(&l.FileID, &l.OwnerID, &l.TokenHash, &l.BaseSeq, &l.ExpiresAt, &l.Generation)
	if errors.Is(err, pgx.ErrNoRows) {
		// Nothing to release: an idempotent no-op. A concurrent releaser may
		// have taken the row already; the caller's InsertLock is the real gate.
		return domain.EditLock{}, nil
	}
	if err != nil {
		return domain.EditLock{}, err
	}
	return l, nil
}

// LockFileRow takes the file row lock so concurrent lock mutations serialise
// inside the caller's transaction (SPEC §7.2).
func (r *Repository) LockFileRow(ctx context.Context, fileID string) error {
	var locked string
	err := r.Q.QueryRow(ctx, "SELECT id FROM files WHERE id=$1 FOR UPDATE", fileID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrRowMissing
	}
	return err
}

// newID generates opaque identifiers without importing upper layers.
func newID(prefix string) string {
	raw := make([]byte, 12)
	if _, err := rand.Read(raw); err != nil {
		panic(err)
	}
	return prefix + "_" + hex.EncodeToString(raw)
}

var _ = ports.ErrRowMissing
