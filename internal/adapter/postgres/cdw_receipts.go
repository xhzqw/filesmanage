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

func (r *Repository) CDWReceiptTargets(ctx context.Context, actor string, limit int) ([]ports.CDWReceiptTarget, error) {
	rows, err := r.Q.Query(ctx, `SELECT t.id,t.batch_id,rel.file_id,rel.display_name_snapshot,
 rel.controlled_revision,t.department_id,t.designated_receiver_id,b.plan_digest_sha256,
 bi.artifact_sha256,CASE WHEN h.current_receipt_id IS NULL THEN 'awaiting' ELSE 'received' END,
 h.revision FROM cdw_distribution_targets t
 JOIN cdw_distribution_batches b ON b.id=t.batch_id
 JOIN cdw_distribution_batch_items bi ON bi.batch_id=b.id AND bi.ordinal=1
 JOIN cdw_controlled_releases rel ON rel.id=bi.release_id
 JOIN cdw_target_receipt_heads h ON h.target_id=t.id
 JOIN users u ON u.id=t.designated_receiver_id AND u.disabled_at IS NULL
 WHERE t.designated_receiver_id=$1 AND u.department_id=t.department_id
 AND b.state='dispatched' AND t.validity_state='active'
 ORDER BY b.dispatched_at DESC,t.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWReceiptTarget{}
	for rows.Next() {
		var v ports.CDWReceiptTarget
		if err = rows.Scan(&v.TargetID, &v.BatchID, &v.FileID, &v.FileName, &v.RevisionLabel,
			&v.DepartmentID, &v.ReceiverID, &v.ManifestSHA256, &v.ArtifactSHA256, &v.State,
			&v.Revision); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (r *Repository) CDWReceiptTargetFile(ctx context.Context, id string) (string, error) {
	var fileID string
	err := r.Q.QueryRow(ctx, `SELECT r.file_id FROM cdw_distribution_targets t
 JOIN cdw_distribution_batch_items i ON i.batch_id=t.batch_id AND i.ordinal=1
 JOIN cdw_controlled_releases r ON r.id=i.release_id WHERE t.id=$1`, id).Scan(&fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return fileID, err
}
func (r *Repository) CDWReceiptAcknowledge(ctx context.Context, targetID, actor string,
	expected int64, statement, receiptID, key string) (ports.CDWDepartmentReceipt, error) {
	var out ports.CDWDepartmentReceipt
	var batchID, departmentID, receiver, state, batchState, manifest, sha, fileID string
	var existing *string
	var revision int64
	err := r.Q.QueryRow(ctx, `SELECT t.batch_id,t.department_id,t.designated_receiver_id,
 t.validity_state,b.state,b.plan_digest_sha256,bi.artifact_sha256,rel.file_id,
 h.current_receipt_id,h.revision FROM cdw_distribution_targets t
 JOIN cdw_distribution_batches b ON b.id=t.batch_id
 JOIN cdw_distribution_batch_items bi ON bi.batch_id=b.id AND bi.ordinal=1
 JOIN cdw_controlled_releases rel ON rel.id=bi.release_id
 JOIN cdw_target_receipt_heads h ON h.target_id=t.id WHERE t.id=$1 FOR UPDATE OF t,h`, targetID).
		Scan(&batchID, &departmentID, &receiver, &state, &batchState, &manifest, &sha, &fileID, &existing, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if revision != expected || existing != nil {
		return out, domain.ErrVersionConflict
	}
	if batchState != "dispatched" || state != "active" {
		return out, domain.ErrConflict
	}
	if receiver != actor {
		return out, domain.ErrForbidden
	}
	var binding string
	err = r.Q.QueryRow(ctx, `SELECT b.id FROM cdw_business_role_bindings b
 JOIN users u ON u.id=b.user_id AND u.disabled_at IS NULL
 WHERE b.user_id=$1 AND b.role='department_receiver' AND b.department_id=$2
 AND b.file_id IS NULL AND b.revoked_at IS NULL AND b.valid_from<=now()
 AND (b.expires_at IS NULL OR b.expires_at>now()) AND u.department_id=$2
 LIMIT 1 FOR SHARE OF b,u`, actor, departmentID).Scan(&binding)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrForbidden
	}
	if err != nil {
		return out, err
	}
	var authorized bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_release_access_grants g
 WHERE g.source_target_id=$1 AND g.user_id=$2 AND g.revoked_at IS NULL
 AND (g.expires_at IS NULL OR g.expires_at>now()) AND 'preview'=ANY(g.actions))`,
		targetID, actor).Scan(&authorized)
	if err != nil {
		return out, err
	}
	if !authorized {
		return out, domain.ErrForbidden
	}
	snapshot := map[string]any{"role": "department_receiver", "bindingId": binding,
		"departmentId": departmentID, "targetId": targetID, "batchId": batchID,
		"manifestSha256": manifest, "artifactSha256": sha}
	roleJSON, e := json.Marshal(snapshot)
	if e != nil {
		return out, e
	}
	bodyJSON, e := json.Marshal(struct {
		TargetID  string `json:"targetId"`
		BatchID   string `json:"batchId"`
		Actor     string `json:"actor"`
		Manifest  string `json:"manifest"`
		Statement string `json:"statement"`
		Binding   string `json:"binding"`
	}{targetID, batchID, actor, manifest, statement, binding})
	if e != nil {
		return out, e
	}
	sum := sha256.Sum256(bodyJSON)
	evidence := hex.EncodeToString(sum[:])
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_department_receipts
 (id,target_id,actor_id,authority_binding_id,manifest_sha256,acknowledgement_text,
 actor_role_snapshot,request_id,evidence_sha256)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		receiptID, targetID, actor, binding, manifest, statement, string(roleJSON), key, evidence)
	if err != nil {
		return out, err
	}
	tag, err := r.Q.Exec(ctx, `INSERT INTO cdw_receipt_items
 (receipt_id,target_id,batch_id,batch_item_id,artifact_sha256)
 SELECT $1,req.target_id,req.batch_id,i.id,i.artifact_sha256
 FROM cdw_target_item_requirements req
 JOIN cdw_distribution_batch_items i ON i.id=req.batch_item_id
 WHERE req.target_id=$2 AND req.receipt_required`, receiptID, targetID)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrConflict
	}
	tag, err = r.Q.Exec(ctx, `UPDATE cdw_target_receipt_heads
 SET current_receipt_id=$2,revision=revision+1,changed_at=clock_timestamp()
 WHERE target_id=$1 AND revision=$3 AND current_receipt_id IS NULL`, targetID, receiptID, expected)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	var at time.Time
	err = r.Q.QueryRow(ctx, `SELECT signed_at FROM cdw_department_receipts WHERE id=$1`, receiptID).Scan(&at)
	if err != nil {
		return out, err
	}
	return ports.CDWDepartmentReceipt{ReceiptID: receiptID, TargetID: targetID, BatchID: batchID,
		FileID: fileID, ActorID: actor, State: "received", Revision: revision + 1,
		ManifestSHA256: manifest, EvidenceSHA256: evidence, SignedAt: at.UTC().Format(time.RFC3339Nano)}, nil
}
func (r *Repository) CDWReceiptEvent(ctx context.Context, actor, kind, key string,
	result ports.CDWDepartmentReceipt) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_domain_events
 (aggregate_kind,aggregate_id,event_kind,actor_id,request_id,details)
 VALUES('distribution_target',$1,$2,$3,$4,$5)`, result.TargetID, kind, actor, key, string(raw))
	if err != nil {
		return err
	}
	sum := sha256.Sum256([]byte("receipt|" + actor + "|" + kind + "|" + key + "|" + result.TargetID))
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'cdw.receipt.confirmed',$2)`, "cdw_evt_"+hex.EncodeToString(sum[:]), string(raw))
	return err
}
