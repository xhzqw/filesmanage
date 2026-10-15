package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

func cdwBranchRow(row rowScanner) (ports.CDWBranch, error) {
	var b ports.CDWBranch
	var head *string
	err := row.Scan(&b.ID, &b.TaskID, &b.FileID, &b.BaseVersionID, &b.BaseSHA256, &b.State, &b.Revision, &head, &b.Epoch)
	if head != nil {
		b.HeadRevisionID = *head
	}
	return b, err
}
func (r *Repository) CDWCreateBranch(ctx context.Context, id, taskID, fileID, actor string) (ports.CDWBranch, error) {
	// Task and active assignment are checked in this same transaction.
	var state, taskFile, group string
	var acceptedBy string
	err := r.Q.QueryRow(ctx, `SELECT t.state,t.file_id,a.accepted_by,COALESCE(a.group_id,'')
 FROM cdw_tasks t JOIN cdw_task_assignments a ON a.task_id=t.id
 WHERE t.id=$1 AND a.kind='primary' AND a.ended_at IS NULL FOR UPDATE OF t,a`, taskID).Scan(&state, &taskFile, &acceptedBy, &group)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWBranch{}, domain.ErrNotFound
	}
	if err != nil {
		return ports.CDWBranch{}, err
	}
	if (state != "accepted" && state != "in_progress") || taskFile != fileID || acceptedBy != actor {
		return ports.CDWBranch{}, domain.ErrForbidden
	}
	if err = r.cdwVerifyBranchActor(ctx, actor, group); err != nil {
		return ports.CDWBranch{}, err
	}
	// Single-file pilot is single active branch per task/round. The locked
	// task row serializes competing branch creations from separate requests.
	var active bool
	if err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_work_branches WHERE task_id=$1 AND state IN ('open','fencing'))`, taskID).Scan(&active); err != nil {
		return ports.CDWBranch{}, err
	}
	if active {
		return ports.CDWBranch{}, domain.ErrConflict
	}
	var b ports.CDWBranch
	var head *string
	err = r.Q.QueryRow(ctx, `INSERT INTO cdw_work_branches(id,task_id,file_id,base_version_id,base_sha256,created_by,state)
 SELECT $1,$2,$3,v.id,v.sha256,$4,'open'
 FROM files f JOIN file_versions v ON v.file_id=f.id AND v.seq=f.current_version_seq
 WHERE f.id=$3 AND f.deleted_at IS NULL
 RETURNING id,task_id,file_id,base_version_id,base_sha256,state,revision,head_revision_id,edit_epoch`,
		id, taskID, fileID, actor).Scan(&b.ID, &b.TaskID, &b.FileID, &b.BaseVersionID, &b.BaseSHA256, &b.State, &b.Revision, &head, &b.Epoch)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWBranch{}, domain.ErrNotFound
	}
	if head != nil {
		b.HeadRevisionID = *head
	}
	return b, err
}
func (r *Repository) cdwVerifyBranchActor(ctx context.Context, actor, group string) error {
	var active bool
	if err := r.Q.QueryRow(ctx, `SELECT disabled_at IS NULL FROM users WHERE id=$1 FOR SHARE`, actor).Scan(&active); err != nil {
		return domain.ErrForbidden
	}
	if !active {
		return domain.ErrForbidden
	}
	if group != "" {
		eligible, err := r.CDWActiveRecipients(ctx, ports.CDWAssignmentTarget{Kind: "workgroup", ID: group})
		if err != nil {
			return err
		}
		for _, id := range eligible {
			if id == actor {
				return nil
			}
		}
		return domain.ErrForbidden
	}
	return nil
}
func (r *Repository) CDWBranchForActor(ctx context.Context, id, actor string) (ports.CDWBranch, error) {
	b, err := cdwBranchRow(r.Q.QueryRow(ctx, `SELECT b.id,b.task_id,b.file_id,b.base_version_id,b.base_sha256,b.state,b.revision,b.head_revision_id,b.edit_epoch
 FROM cdw_work_branches b JOIN cdw_task_assignments a ON a.task_id=b.task_id AND a.kind='primary' AND a.ended_at IS NULL
 WHERE b.id=$1 AND a.accepted_by=$2 AND a.accepted_at IS NOT NULL`, id, actor))
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWBranch{}, domain.ErrForbidden
	}
	if err != nil {
		return ports.CDWBranch{}, err
	}
	var group string
	err = r.Q.QueryRow(ctx, `SELECT COALESCE(a.group_id,'') FROM cdw_task_assignments a
 JOIN cdw_work_branches b ON b.task_id=a.task_id
 WHERE b.id=$1 AND a.kind='primary' AND a.ended_at IS NULL`, id).Scan(&group)
	if err != nil {
		return ports.CDWBranch{}, err
	}
	if err = r.cdwVerifyBranchActor(ctx, actor, group); err != nil {
		return ports.CDWBranch{}, err
	}
	return b, nil
}

// Only an accepted active primary assignee can see its task branches.
func (r *Repository) CDWTaskBranches(ctx context.Context, taskID, actor string) ([]ports.CDWBranch, error) {
	rows, err := r.Q.Query(ctx, `SELECT b.id,b.task_id,b.file_id,b.base_version_id,b.base_sha256,b.state,b.revision,b.head_revision_id,b.edit_epoch
 FROM cdw_work_branches b JOIN cdw_task_assignments a ON a.task_id=b.task_id
 WHERE b.task_id=$1 AND a.kind='primary' AND a.ended_at IS NULL AND a.accepted_at IS NOT NULL
 AND a.accepted_by=$2 ORDER BY b.created_at DESC,b.id DESC LIMIT 50`, taskID, actor)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []ports.CDWBranch{}
	for rows.Next() {
		var b ports.CDWBranch
		var head *string
		if err = rows.Scan(&b.ID, &b.TaskID, &b.FileID, &b.BaseVersionID, &b.BaseSHA256, &b.State, &b.Revision, &head, &b.Epoch); err != nil {
			return nil, err
		}
		if head != nil {
			b.HeadRevisionID = *head
		}
		result = append(result, b)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// Free the transaction connection before per-branch permission queries.
	rows.Close()
	for _, b := range result {
		if _, err = r.CDWBranchForActor(ctx, b.ID, actor); err != nil {
			return nil, err
		}
	}
	return result, nil
}
func scanCDWBranchSession(row rowScanner) (ports.CDWBranchSession, error) {
	var s ports.CDWBranchSession
	err := row.Scan(&s.ID, &s.BranchID, &s.DocumentKey, &s.OpenedBy, &s.Generation, &s.Epoch, &s.State, &s.ExpiresAt)
	return s, err
}
func (r *Repository) CDWOpenBranchSession(ctx context.Context, branchID, actor, sessionID, key string, expires time.Time) (ports.CDWBranchSession, error) {
	var state string
	var epoch int64
	err := r.Q.QueryRow(ctx, `SELECT state,edit_epoch FROM cdw_work_branches WHERE id=$1 FOR UPDATE`, branchID).Scan(&state, &epoch)
	if err != nil {
		return ports.CDWBranchSession{}, err
	}
	if state != "open" {
		return ports.CDWBranchSession{}, domain.ErrConflict
	}
	current, err := scanCDWBranchSession(r.Q.QueryRow(ctx, `SELECT id,branch_id,document_key,opened_by,generation,edit_epoch,state,expires_at
 FROM cdw_office_branch_sessions WHERE branch_id=$1 AND ended_at IS NULL FOR UPDATE`, branchID))
	if err == nil {
		if current.ExpiresAt.After(time.Now()) && current.State == "open" {
			if current.OpenedBy != actor {
				return ports.CDWBranchSession{}, domain.ErrLocked
			}
			return current, nil
		}
		// Expired/closed sessions cannot leave a still-pending force-save receipt.
		var pending bool
		if e := r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_office_save_requests
   WHERE session_id=$1 AND state IN ('requested','accepted','unknown'))`, current.ID).Scan(&pending); e != nil {
			return ports.CDWBranchSession{}, e
		}
		if pending {
			return ports.CDWBranchSession{}, domain.ErrConflict
		}
		if _, e := r.Q.Exec(ctx, `UPDATE cdw_office_branch_sessions
  SET ended_at=now(),state='closed' WHERE id=$1`, current.ID); e != nil {
			return ports.CDWBranchSession{}, e
		}
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWBranchSession{}, err
	}
	return scanCDWBranchSession(r.Q.QueryRow(ctx, `INSERT INTO cdw_office_branch_sessions
 (id,branch_id,document_key,mode,edit_epoch,state,opened_by,expires_at)
 VALUES($1,$2,$3,'exclusive',$4,'open',$5,$6)
 RETURNING id,branch_id,document_key,opened_by,generation,edit_epoch,state,expires_at`,
		sessionID, branchID, key, epoch, actor, expires))
}
func (r *Repository) CDWBranchSessionByKey(ctx context.Context, key string) (ports.CDWBranchSession, error) {
	s, err := scanCDWBranchSession(r.Q.QueryRow(ctx, `SELECT id,branch_id,document_key,opened_by,generation,edit_epoch,state,expires_at
 FROM cdw_office_branch_sessions WHERE document_key=$1`, key))
	if errors.Is(err, pgx.ErrNoRows) {
		return s, domain.ErrNotFound
	}
	return s, err
}
func (r *Repository) CDWBranchSessionByID(ctx context.Context, id string) (ports.CDWBranchSession, error) {
	session, err := scanCDWBranchSession(r.Q.QueryRow(ctx, `SELECT id,branch_id,document_key,opened_by,generation,edit_epoch,state,expires_at FROM cdw_office_branch_sessions WHERE id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return session, domain.ErrNotFound
	}
	return session, err
}

// Extend a live exclusive editor lease only for its actual owner while both
// branch state and edit epoch still agree. Expired/closed leases cannot revive.
func (r *Repository) CDWTouchBranchSession(ctx context.Context, branchID, sessionID, actor string, expires time.Time) (ports.CDWBranchSession, error) {
	session, err := scanCDWBranchSession(r.Q.QueryRow(ctx, `UPDATE cdw_office_branch_sessions s
 SET expires_at=GREATEST(s.expires_at,$4)
 FROM cdw_work_branches b
 WHERE b.id=s.branch_id AND s.id=$2 AND s.branch_id=$1 AND s.opened_by=$3
 AND s.state='open' AND s.ended_at IS NULL AND s.expires_at>now()
 AND b.state='open' AND b.edit_epoch=s.edit_epoch
 RETURNING s.id,s.branch_id,s.document_key,s.opened_by,s.generation,s.edit_epoch,s.state,s.expires_at`,
		branchID, sessionID, actor, expires))
	if errors.Is(err, pgx.ErrNoRows) {
		return session, domain.ErrVersionConflict
	}
	return session, err
}
func (r *Repository) CDWBranchSessionSource(ctx context.Context, key string) (ports.CDWBranchSource, error) {
	var source ports.CDWBranchSource
	err := r.Q.QueryRow(ctx, `SELECT bl.storage_key,f.name,bl.size_bytes
 FROM cdw_office_branch_sessions s JOIN cdw_work_branches b ON b.id=s.branch_id
 JOIN files f ON f.id=b.file_id
 JOIN file_versions v ON v.id=b.base_version_id
 JOIN blobs base ON base.id=v.blob_id
 LEFT JOIN cdw_work_branch_revisions br ON br.id=b.head_revision_id
 JOIN blobs bl ON bl.id=COALESCE(br.blob_id,base.id)
 WHERE s.document_key=$1 AND s.ended_at IS NULL AND s.expires_at>now()
   AND s.state='open' AND b.state='open' AND f.deleted_at IS NULL
   AND bl.state='ready'`, key).Scan(&source.StorageKey, &source.Name, &source.SizeBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return source, domain.ErrForbidden
	}
	return source, err
}
func (r *Repository) CDWBeginBranchSave(ctx context.Context, branchID, sessionID, actor, requestID string) (ports.CDWBranchSave, error) {
	var epoch int64
	var state string
	if err := r.Q.QueryRow(ctx, `SELECT state,edit_epoch FROM cdw_work_branches WHERE id=$1 FOR UPDATE`, branchID).Scan(&state, &epoch); err != nil {
		return ports.CDWBranchSave{}, err
	}
	if state != "open" {
		return ports.CDWBranchSave{}, domain.ErrConflict
	}
	var session ports.CDWBranchSession
	session, err := scanCDWBranchSession(r.Q.QueryRow(ctx, `SELECT id,branch_id,document_key,opened_by,generation,edit_epoch,state,expires_at
 FROM cdw_office_branch_sessions WHERE id=$1 AND branch_id=$2 AND ended_at IS NULL FOR UPDATE`, sessionID, branchID))
	if err != nil {
		return ports.CDWBranchSave{}, domain.ErrNotFound
	}
	if session.OpenedBy != actor || session.State != "open" || !session.ExpiresAt.After(time.Now()) || session.Epoch != epoch {
		return ports.CDWBranchSave{}, domain.ErrConflict
	}
	// Replays of the same save key always return the same request, including
	// 'unknown' (retryable), rather than generating a competing barrier.
	if existing, e := r.CDWReadBranchSave(ctx, branchID, requestID, actor); e == nil {
		if existing.SessionID != sessionID || existing.Generation != session.Generation || existing.Epoch != epoch {
			return ports.CDWBranchSave{}, domain.ErrConflict
		}
		return existing, nil
	} else if !errors.Is(e, domain.ErrNotFound) {
		return ports.CDWBranchSave{}, e
	}
	var active bool
	if err = r.Q.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM cdw_office_save_requests
 WHERE branch_id=$1 AND state IN('requested','accepted','unknown'))`, branchID).Scan(&active); err != nil {
		return ports.CDWBranchSave{}, err
	}
	if active {
		return ports.CDWBranchSave{}, domain.ErrConflict
	}
	result := ports.CDWBranchSave{ID: requestID, BranchID: branchID, SessionID: sessionID, State: "requested", Generation: session.Generation, Epoch: epoch}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_office_save_requests(id,session_id,branch_id,requested_by,requested_generation,requested_epoch,state)
 VALUES($1,$2,$3,$4,$5,$6,'requested')`, requestID, sessionID, branchID, actor, session.Generation, epoch)
	return result, err
}
func (r *Repository) CDWCompleteOperationRaw(ctx context.Context, actor, operation, key string, status int, response json.RawMessage) error {
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_operation_results SET state='done',http_status=$4,response=$5
 WHERE actor_id=$1 AND operation=$2 AND request_key=$3 AND state='running'`, actor, operation, key, status, string(response))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrConflict
	}
	return nil
}
func (r *Repository) CDWBranchEvent(ctx context.Context, actor, kind, branchID, requestID string, details map[string]any) error {
	if requestID == "" {
		return domain.ErrInvalidInput
	}
	raw, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_domain_events(aggregate_kind,aggregate_id,event_kind,actor_id,request_id,details)
 VALUES('branch',$1,$2,$3,$4,$5)`, branchID, kind, actor, requestID, string(raw))
	if err != nil {
		return err
	}
	event := sha256.Sum256([]byte(actor + "|" + branchID + "|" + kind + "|" + requestID))
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload) VALUES($1,'cdw.branch.changed',$2)`,
		"cdw_evt_"+hex.EncodeToString(event[:]), string(raw))
	return err
}
func (r *Repository) CDWMarkBranchSaveUnknown(ctx context.Context, id string) error {
	_, err := r.Q.Exec(ctx, `UPDATE cdw_office_save_requests SET state='unknown'
 WHERE id=$1 AND state='requested'`, id)
	return err
}
func (r *Repository) CDWReadBranchSave(ctx context.Context, branchID, requestID, actor string) (ports.CDWBranchSave, error) {
	var result ports.CDWBranchSave
	var rev *string
	err := r.Q.QueryRow(ctx, `SELECT req.id,req.branch_id,req.session_id,req.state,req.persisted_revision_id,
 req.requested_generation,req.requested_epoch,COALESCE(br.sha256,'')
 FROM cdw_office_save_requests req
 JOIN cdw_office_branch_sessions ses ON ses.id=req.session_id
 LEFT JOIN cdw_work_branch_revisions br ON br.id=req.persisted_revision_id
 WHERE req.id=$1 AND req.branch_id=$2 AND req.requested_by=$3 AND ses.opened_by=$3`, requestID, branchID, actor).
		Scan(&result.ID, &result.BranchID, &result.SessionID, &result.State, &rev, &result.Generation, &result.Epoch, &result.SHA256)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrNotFound
	}
	if rev != nil {
		result.RevisionID = *rev
	}
	return result, err
}

// The branch row is locked first: freeze and callback cannot cross or publish
// a revision after delivery; session generation/epoch and request are checked
// again AFTER external download, while in this transaction.
func (r *Repository) CDWCommitBranchCallback(ctx context.Context, key string, status int, userdata, eventHash, blobID string, size int64, sha string, epoch int64, revisionID string) (bool, error) {
	var branchID string
	err := r.Q.QueryRow(ctx, `SELECT branch_id FROM cdw_office_branch_sessions WHERE document_key=$1`, key).Scan(&branchID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, domain.ErrForbidden
	}
	if err != nil {
		return false, err
	}
	var branchState, head string
	var branchEpoch int64
	err = r.Q.QueryRow(ctx, `SELECT state,COALESCE(head_revision_id,''),edit_epoch FROM cdw_work_branches WHERE id=$1 FOR UPDATE`, branchID).Scan(&branchState, &head, &branchEpoch)
	if err != nil {
		return false, err
	}
	if branchState != "open" || branchEpoch != epoch {
		return false, domain.ErrVersionConflict
	}
	var sess ports.CDWBranchSession
	sess, err = scanCDWBranchSession(r.Q.QueryRow(ctx, `SELECT id,branch_id,document_key,opened_by,generation,edit_epoch,state,expires_at
 FROM cdw_office_branch_sessions WHERE document_key=$1 AND ended_at IS NULL FOR UPDATE`, key))
	if err != nil {
		return false, domain.ErrVersionConflict
	}
	if sess.Epoch != branchEpoch || sess.State != "open" || !sess.ExpiresAt.After(time.Now()) {
		return false, domain.ErrVersionConflict
	}
	var exists bool
	if err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_office_callback_events
 WHERE session_id=$1 AND event_hash=$2)`, sess.ID, eventHash).Scan(&exists); err != nil {
		return false, err
	}
	if exists {
		return false, nil
	}
	if status != 2 && status != 6 {
		return false, domain.ErrInvalidInput
	}
	var requestID *string
	if userdata != "" {
		var g, e int64
		var requestState string
		err = r.Q.QueryRow(ctx, `SELECT id,requested_generation,requested_epoch,state
   FROM cdw_office_save_requests WHERE id=$1 AND session_id=$2 FOR UPDATE`, userdata, sess.ID).
			Scan(&requestID, &g, &e, &requestState)
		if err != nil || g != sess.Generation || e != branchEpoch || !(requestState == "requested" || requestState == "accepted" || requestState == "unknown") {
			return false, domain.ErrVersionConflict
		}
	}
	var ordinal int
	err = r.Q.QueryRow(ctx, `SELECT COALESCE(MAX(ordinal),0)+1 FROM cdw_work_branch_revisions WHERE branch_id=$1`, branchID).Scan(&ordinal)
	if err != nil {
		return false, err
	}
	var parent *string
	if head != "" {
		parent = &head
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_work_branch_revisions
 (id,branch_id,ordinal,parent_revision_id,blob_id,sha256,size_bytes,save_epoch)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, revisionID, branchID, ordinal, parent, blobID, sha, size, branchEpoch)
	if err != nil {
		return false, err
	}
	if _, err = r.Q.Exec(ctx, `UPDATE cdw_work_branches SET head_revision_id=$2,revision=revision+1 WHERE id=$1`, branchID, revisionID); err != nil {
		return false, err
	}
	if requestID != nil {
		if _, err = r.Q.Exec(ctx, `UPDATE cdw_office_save_requests
 SET state='persisted',persisted_revision_id=$2,completed_at=now() WHERE id=$1`, *requestID, revisionID); err != nil {
			return false, err
		}
	}
	callbackID := sha256.Sum256([]byte(sess.ID + "|" + eventHash))
	if _, err = r.Q.Exec(ctx, `INSERT INTO cdw_office_callback_events
 (id,session_id,event_hash,request_id,callback_status,outcome)
 VALUES($1,$2,$3,$4,$5,'persisted')`, "cdwcb_"+hex.EncodeToString(callbackID[:]), sess.ID, eventHash, requestID, status); err != nil {
		return false, err
	}
	if status == 2 {
		if _, err = r.Q.Exec(ctx, `UPDATE cdw_office_branch_sessions SET state='closed',ended_at=now()
    WHERE id=$1`, sess.ID); err != nil {
			return false, err
		}
	}
	return true, nil
}
func (r *Repository) CDWFreezeBranchDelivery(ctx context.Context, branchID, actor, requestID, revisionID, deliveryID string, expected int64, freezeID, gateID, idempotency string) (ports.CDWBranchFreeze, error) {
	var result ports.CDWBranchFreeze
	b, err := cdwBranchRow(r.Q.QueryRow(ctx, `SELECT id,task_id,file_id,base_version_id,base_sha256,state,revision,head_revision_id,edit_epoch
 FROM cdw_work_branches WHERE id=$1 FOR UPDATE`, branchID))
	if err != nil {
		return result, domain.ErrNotFound
	}
	if b.Revision != expected || b.State != "open" || b.HeadRevisionID != revisionID {
		return result, domain.ErrVersionConflict
	}
	var requestState string
	var requestEpoch int64
	err = r.Q.QueryRow(ctx, `SELECT state,requested_epoch FROM cdw_office_save_requests
 WHERE id=$1 AND branch_id=$2 AND persisted_revision_id=$3 FOR UPDATE`, requestID, branchID, revisionID).Scan(&requestState, &requestEpoch)
	if err != nil || requestState != "persisted" || requestEpoch != b.Epoch {
		return result, domain.ErrConflict
	}
	var pending bool
	if err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_office_save_requests
 WHERE branch_id=$1 AND state IN('requested','accepted','unknown'))`, branchID).Scan(&pending); err != nil {
		return result, err
	}
	if pending {
		return result, domain.ErrConflict
	}
	var blobID, sha, taskState, reviewer string
	var round int
	err = r.Q.QueryRow(ctx, `SELECT br.blob_id,br.sha256,t.state,t.round_no,
 CASE WHEN t.parent_id IS NULL THEN t.created_by ELSE (SELECT a.accepted_by
 FROM cdw_task_assignments a WHERE a.task_id=t.parent_id AND a.kind='primary' AND a.ended_at IS NULL LIMIT 1) END
 FROM cdw_work_branches b JOIN cdw_work_branch_revisions br ON br.id=b.head_revision_id
 JOIN cdw_tasks t ON t.id=b.task_id
 WHERE b.id=$1`, branchID).Scan(&blobID, &sha, &taskState, &round, &reviewer)
	if err != nil {
		return result, err
	}
	if reviewer == "" || !(taskState == "accepted" || taskState == "in_progress") {
		return result, domain.ErrConflict
	}
	var assignee string
	err = r.Q.QueryRow(ctx, `SELECT accepted_by FROM cdw_task_assignments WHERE task_id=$1 AND kind='primary' AND ended_at IS NULL FOR UPDATE`, b.TaskID).Scan(&assignee)
	if err != nil || assignee != actor {
		return result, domain.ErrForbidden
	}
	if err = r.cdwVerifyBranchActor(ctx, actor, ""); err != nil {
		return result, err
	}
	hash := sha256.Sum256([]byte("cdw-delivery-v1|" + b.TaskID + "|" + branchID + "|" + revisionID + "|" + sha))
	digest := hex.EncodeToString(hash[:])
	if _, err = r.Q.Exec(ctx, `INSERT INTO cdw_delivery_freezes
 (id,task_id,round_no,state,fenced_epoch,started_by,completed_at)
 VALUES($1,$2,$3,'committed',$4,$5,now())`, freezeID, b.TaskID, round, b.Epoch, actor); err != nil {
		return result, err
	}
	if _, err = r.Q.Exec(ctx, `INSERT INTO cdw_deliveries(id,task_id,freeze_id,round_no,manifest_sha256,submitted_by)
 VALUES($1,$2,$3,$4,$5,$6)`, deliveryID, b.TaskID, freezeID, round, digest, actor); err != nil {
		return result, err
	}
	if _, err = r.Q.Exec(ctx, `INSERT INTO cdw_delivery_items(delivery_id,ordinal,file_id,branch_id,branch_revision_id,blob_id,sha256)
 VALUES($1,1,$2,$3,$4,$5,$6)`, deliveryID, b.FileID, branchID, revisionID, blobID, sha); err != nil {
		return result, err
	}
	if _, err = r.Q.Exec(ctx, `INSERT INTO cdw_review_gates(id,delivery_id,node_key,round_no,responsible_user_id,substitutable,state)
 VALUES($1,$2,'direct_parent',$3,$4,false,'awaiting')`, gateID, deliveryID, round, reviewer); err != nil {
		return result, err
	}
	if _, err = r.Q.Exec(ctx, `UPDATE cdw_office_branch_sessions SET state='closed',ended_at=now() WHERE branch_id=$1 AND ended_at IS NULL`, branchID); err != nil {
		return result, err
	}
	if _, err = r.Q.Exec(ctx, `UPDATE cdw_work_branches SET state='frozen',edit_epoch=edit_epoch+1,revision=revision+1 WHERE id=$1`, branchID); err != nil {
		return result, err
	}
	if _, err = r.Q.Exec(ctx, `UPDATE cdw_tasks SET state='submitted',revision=revision+1 WHERE id=$1`, b.TaskID); err != nil {
		return result, err
	}
	result = ports.CDWBranchFreeze{DeliveryID: deliveryID, BranchID: branchID, TaskID: b.TaskID, RevisionID: revisionID, SHA256: sha, ReviewGateID: gateID, Revision: b.Revision + 1}

	return result, nil
}
