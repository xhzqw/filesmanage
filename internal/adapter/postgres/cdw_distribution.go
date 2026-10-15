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
)

func (r *Repository) CDWDistributionReleaseFile(ctx context.Context, releaseID string) (string, error) {
	return r.CDWControlFile(ctx, releaseID)
}
func (r *Repository) CDWDistributionPlanFile(ctx context.Context, planID string) (string, error) {
	var fileID string
	err := r.Q.QueryRow(ctx, `SELECT r.file_id FROM cdw_distribution_plans p
 JOIN cdw_distribution_plan_items i ON i.plan_id=p.id AND i.ordinal=1
 JOIN cdw_controlled_releases r ON r.id=i.release_id WHERE p.id=$1`, planID).Scan(&fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return fileID, err
}
func (r *Repository) CDWDistributionCreate(ctx context.Context, planID, releaseID, actor string,
	targets []ports.CDWDistributionTargetInput) (ports.CDWDistributionPlan, error) {
	var result ports.CDWDistributionPlan
	var fileID, name, state, sha, artifactID string
	err := r.Q.QueryRow(ctx, `SELECT r.file_id,r.display_name_snapshot,r.state,a.sha256,a.id
 FROM cdw_controlled_releases r
 JOIN cdw_release_artifacts a ON a.release_id=r.id AND a.purpose='distribution'
 JOIN cdw_release_artifact_verifications v ON v.release_id=r.id
 AND v.verified_artifact_id=a.id AND v.source_sha256=a.sha256
 WHERE r.id=$1 AND a.format='docx' FOR UPDATE OF r`, releaseID).
		Scan(&fileID, &name, &state, &sha, &artifactID)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrConflict
	}
	if err != nil {
		return result, err
	}
	if state != "ready" {
		return result, domain.ErrConflict
	}
	if _, err = r.CDWControlRole(ctx, actor, "document_control", fileID); err != nil {
		return result, err
	}
	var exists bool
	if err = r.Q.QueryRow(ctx, `SELECT EXISTS(
 SELECT 1 FROM cdw_distribution_plan_items i JOIN cdw_distribution_plans p ON p.id=i.plan_id
 WHERE i.release_id=$1 AND p.state<>'cancelled')`, releaseID).Scan(&exists); err != nil {
		return result, err
	}
	if exists {
		return result, domain.ErrConflict
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_distribution_plans(id,state,created_by)
 VALUES($1,'draft',$2)`, planID, actor)
	if err != nil {
		return result, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_distribution_plan_items
 (plan_id,ordinal,release_id,artifact_id,artifact_sha256,required)
 VALUES($1,1,$2,$3,$4,true)`, planID, releaseID, artifactID, sha)
	if err != nil {
		return result, err
	}
	for _, target := range targets {
		var found string
		err = r.Q.QueryRow(ctx, `SELECT u.id FROM users u
 JOIN departments d ON d.id=u.department_id
 WHERE u.id=$1 AND d.id=$2 AND u.disabled_at IS NULL FOR SHARE OF u,d`,
			target.ReceiverID, target.DepartmentID).Scan(&found)
		if errors.Is(err, pgx.ErrNoRows) {
			return result, domain.ErrForbidden
		}
		if err != nil {
			return result, err
		}
		_, err = r.Q.Exec(ctx, `INSERT INTO cdw_distribution_plan_targets
 (plan_id,department_id,designated_receiver_id,channel,paper_quantity)
 VALUES($1,$2,$3,'electronic',0)`, planID, target.DepartmentID, found)
		if err != nil {
			return result, err
		}
		_, err = r.Q.Exec(ctx, `INSERT INTO cdw_distribution_plan_target_requirements
 (plan_id,department_id,item_ordinal,receipt_required,reading_required,implementation_required)
 VALUES($1,$2,1,true,true,false)`, planID, target.DepartmentID)
		if err != nil {
			return result, err
		}
	}
	return ports.CDWDistributionPlan{ID: planID, ReleaseID: releaseID, FileID: fileID, FileName: name,
		State: "draft", Revision: 1, DepartmentCount: len(targets)}, nil
}
func (r *Repository) CDWDistributionSnapshot(ctx context.Context, id string) (ports.CDWDistributionScopeSnapshot, error) {
	var out ports.CDWDistributionScopeSnapshot
	out.PlanID = id
	err := r.Q.QueryRow(ctx, `SELECT p.state,p.revision,r.file_id FROM cdw_distribution_plans p
 JOIN cdw_distribution_plan_items i ON i.plan_id=p.id AND i.ordinal=1
 JOIN cdw_controlled_releases r ON r.id=i.release_id
 WHERE p.id=$1 FOR UPDATE OF p`, id).Scan(&out.State, &out.Revision, &out.FileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	items, err := r.Q.Query(ctx, `SELECT ordinal,release_id,artifact_id,artifact_sha256,required
 FROM cdw_distribution_plan_items WHERE plan_id=$1 ORDER BY ordinal`, id)
	if err != nil {
		return out, err
	}
	for items.Next() {
		var i ports.CDWDistributionItemSnapshot
		if err = items.Scan(&i.Ordinal, &i.ReleaseID, &i.ArtifactID, &i.SHA256, &i.Required); err != nil {
			items.Close()
			return out, err
		}
		out.Items = append(out.Items, i)
	}
	err = items.Err()
	items.Close()
	if err != nil {
		return out, err
	}
	rows, err := r.Q.Query(ctx, `SELECT t.department_id,t.designated_receiver_id,t.channel,t.paper_quantity,
 req.receipt_required,req.reading_required,req.implementation_required
 FROM cdw_distribution_plan_targets t JOIN cdw_distribution_plan_target_requirements req
 ON req.plan_id=t.plan_id AND req.department_id=t.department_id AND req.item_ordinal=1
 WHERE t.plan_id=$1 ORDER BY t.department_id`, id)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var target ports.CDWDistributionTargetSnapshot
		if err = rows.Scan(&target.DepartmentID, &target.ReceiverID, &target.Channel, &target.PaperQuantity,
			&target.ReceiptRequired, &target.ReadingRequired, &target.ImplementationRequired); err != nil {
			rows.Close()
			return out, err
		}
		out.Targets = append(out.Targets, target)
	}
	err = rows.Err()
	rows.Close()
	return out, err
}
func (r *Repository) CDWDistributionFreeze(ctx context.Context, id, actor string, expected int64, digest string) (ports.CDWDistributionPlan, error) {
	var out ports.CDWDistributionPlan
	var state, releaseID, fileID, fileName string
	var rev int64
	err := r.Q.QueryRow(ctx, `SELECT p.state,p.revision,r.id,r.file_id,r.display_name_snapshot
 FROM cdw_distribution_plans p JOIN cdw_distribution_plan_items i
 ON i.plan_id=p.id AND i.ordinal=1 JOIN cdw_controlled_releases r ON r.id=i.release_id
 WHERE p.id=$1 FOR UPDATE OF p`, id).Scan(&state, &rev, &releaseID, &fileID, &fileName)
	if err != nil {
		return out, err
	}
	if state != "draft" || rev != expected {
		return out, domain.ErrVersionConflict
	}
	if _, err = r.CDWControlRole(ctx, actor, "document_control", fileID); err != nil {
		return out, err
	}
	var readiness bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_controlled_releases r
 JOIN cdw_release_artifact_verifications v ON v.release_id=r.id
 WHERE r.id=$1 AND r.state='ready')`, releaseID).Scan(&readiness)
	if err != nil {
		return out, err
	}
	if !readiness {
		return out, domain.ErrConflict
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_distribution_plans SET state='frozen',
 digest_sha256=$2,frozen_at=clock_timestamp(),revision=revision+1
 WHERE id=$1 AND state='draft' AND revision=$3`, id, digest, expected)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	return ports.CDWDistributionPlan{ID: id, ReleaseID: releaseID, FileID: fileID, FileName: fileName,
		State: "frozen", Revision: expected + 1, DigestSHA256: digest}, nil
}
func (r *Repository) CDWDistributionRead(ctx context.Context, id string) (ports.CDWDistributionPlan, error) {
	var out ports.CDWDistributionPlan
	var digest *string
	err := r.Q.QueryRow(ctx, `SELECT p.id,i.release_id,r.file_id,r.display_name_snapshot,
 p.state,p.revision,p.digest_sha256,(SELECT COUNT(*) FROM cdw_distribution_plan_targets t WHERE t.plan_id=p.id)
 FROM cdw_distribution_plans p JOIN cdw_distribution_plan_items i ON i.plan_id=p.id AND i.ordinal=1
 JOIN cdw_controlled_releases r ON r.id=i.release_id WHERE p.id=$1`, id).
		Scan(&out.ID, &out.ReleaseID, &out.FileID, &out.FileName, &out.State, &out.Revision, &digest, &out.DepartmentCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if digest != nil {
		out.DigestSHA256 = *digest
	}
	rows, err := r.Q.Query(ctx, `SELECT department_id,designated_receiver_id
 FROM cdw_distribution_plan_targets WHERE plan_id=$1 ORDER BY department_id`, id)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	out.Targets = []ports.CDWDistributionTargetInput{}
	for rows.Next() {
		var target ports.CDWDistributionTargetInput
		if err = rows.Scan(&target.DepartmentID, &target.ReceiverID); err != nil {
			return out, err
		}
		out.Targets = append(out.Targets, target)
	}
	return out, rows.Err()
}
func (r *Repository) CDWDistributionForRelease(ctx context.Context, releaseID string) (ports.CDWDistributionPlan, error) {
	var id string
	err := r.Q.QueryRow(ctx, `SELECT p.id FROM cdw_distribution_plan_items i
 JOIN cdw_distribution_plans p ON p.id=i.plan_id
 WHERE i.release_id=$1 AND p.state<>'cancelled'
 ORDER BY p.created_at DESC LIMIT 1`, releaseID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWDistributionPlan{}, domain.ErrNotFound
	}
	if err != nil {
		return ports.CDWDistributionPlan{}, err
	}
	return r.CDWDistributionRead(ctx, id)
}
func (r *Repository) CDWDistributionEvent(ctx context.Context, actor, kind, id, key string, result any) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_domain_events
 (aggregate_kind,aggregate_id,event_kind,actor_id,request_id,details)
 VALUES('distribution_plan',$1,$2,$3,$4,$5)`, id, kind, actor, key, string(raw))
	if err != nil {
		return err
	}
	sum := sha256.Sum256([]byte("distribution-plan|" + actor + "|" + kind + "|" + id + "|" + key))
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'cdw.distribution.changed',$2)`, "cdw_evt_"+hex.EncodeToString(sum[:]), string(raw))
	return err
}
