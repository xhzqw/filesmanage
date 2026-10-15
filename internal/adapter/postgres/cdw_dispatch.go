package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

// Snapshot dispatch occurs atomically after independent scope approval and
// release issue. Item/target keys are allocated once per idempotency request.
func (r *Repository) CDWDistributionDispatch(ctx context.Context, batchID, planID, actor string,
	expected int64, digest string, itemIDs, targetIDs, grantIDs []string) (ports.CDWDistributionBatch, error) {
	var out ports.CDWDistributionBatch
	var state, sourceDigest, releaseID, releaseState, fileID string
	var rev int64
	err := r.Q.QueryRow(ctx, `SELECT p.state,p.revision,p.digest_sha256,pi.release_id,
 rel.state,rel.file_id FROM cdw_distribution_plans p
 JOIN cdw_distribution_plan_items pi ON pi.plan_id=p.id AND pi.ordinal=1
 JOIN cdw_controlled_releases rel ON rel.id=pi.release_id
 WHERE p.id=$1 FOR UPDATE OF p`, planID).
		Scan(&state, &rev, &sourceDigest, &releaseID, &releaseState, &fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if rev != expected || state != "approved" {
		return out, domain.ErrVersionConflict
	}
	if sourceDigest != digest || releaseState != "issued_pending" {
		return out, domain.ErrConflict
	}
	if _, err = r.CDWControlRole(ctx, actor, "document_control", fileID); err != nil {
		return out, err
	}
	var approved bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_distribution_scope_approvals
 WHERE plan_id=$1 AND plan_digest_sha256=$2)`, planID, digest).Scan(&approved)
	if err != nil {
		return out, err
	}
	if !approved {
		return out, domain.ErrConflict
	}
	var itemCount int
	err = r.Q.QueryRow(ctx, `SELECT count(*) FROM cdw_distribution_plan_items WHERE plan_id=$1`, planID).Scan(&itemCount)
	if err != nil {
		return out, err
	}
	var targetCount int
	err = r.Q.QueryRow(ctx, `SELECT count(*) FROM cdw_distribution_plan_targets WHERE plan_id=$1`, planID).Scan(&targetCount)
	if err != nil {
		return out, err
	}
	if itemCount != len(itemIDs) || targetCount != len(targetIDs) || len(grantIDs) != targetCount*itemCount || targetCount == 0 || itemCount != 1 {
		return out, domain.ErrConflict
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_distribution_batches
 (id,plan_id,plan_digest_sha256,state) VALUES($1,$2,$3,'draft')`, batchID, planID, digest)
	if err != nil {
		return out, err
	}
	items, err := r.Q.Query(ctx, `SELECT ordinal,release_id,artifact_id,artifact_sha256,required
 FROM cdw_distribution_plan_items WHERE plan_id=$1 ORDER BY ordinal`, planID)
	if err != nil {
		return out, err
	}
	type row struct {
		ordinal                    int
		releaseID, artifactID, sha string
		required                   bool
	}
	sourceItems := []row{}
	for items.Next() {
		var i row
		if err = items.Scan(&i.ordinal, &i.releaseID, &i.artifactID, &i.sha, &i.required); err != nil {
			items.Close()
			return out, err
		}
		sourceItems = append(sourceItems, i)
	}
	err = items.Err()
	items.Close()
	if err != nil {
		return out, err
	}
	for i, item := range sourceItems {
		_, err = r.Q.Exec(ctx, `INSERT INTO cdw_distribution_batch_items
 (id,batch_id,plan_id,ordinal,release_id,artifact_id,artifact_sha256,required)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, itemIDs[i], batchID, planID, item.ordinal,
			item.releaseID, item.artifactID, item.sha, item.required)
		if err != nil {
			return out, err
		}
	}
	rows, err := r.Q.Query(ctx, `SELECT department_id,designated_receiver_id
 FROM cdw_distribution_plan_targets WHERE plan_id=$1 ORDER BY department_id`, planID)
	if err != nil {
		return out, err
	}
	type target struct{ dept, receiver string }
	receivers := []target{}
	for rows.Next() {
		var t target
		if err = rows.Scan(&t.dept, &t.receiver); err != nil {
			rows.Close()
			return out, err
		}
		receivers = append(receivers, t)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return out, err
	}
	for i, target := range receivers {
		_, err = r.Q.Exec(ctx, `INSERT INTO cdw_distribution_targets
 (id,batch_id,plan_id,department_id,designated_receiver_id)
 VALUES($1,$2,$3,$4,$5)`, targetIDs[i], batchID, planID, target.dept, target.receiver)
		if err != nil {
			return out, err
		}
		_, err = r.Q.Exec(ctx, `INSERT INTO cdw_target_receipt_heads(target_id) VALUES($1)`, targetIDs[i])
		if err != nil {
			return out, err
		}
		for _, item := range sourceItems {
			_, err = r.Q.Exec(ctx, `INSERT INTO cdw_target_item_requirements
 (target_id,batch_id,plan_id,department_id,batch_item_id,item_ordinal,
 receipt_required,reading_required,implementation_required)
 SELECT $1,$2,$3,$4,$5,$6,p.receipt_required,p.reading_required,p.implementation_required
 FROM cdw_distribution_plan_target_requirements p
 WHERE p.plan_id=$3 AND p.department_id=$4 AND p.item_ordinal=$6`,
				targetIDs[i], batchID, planID, target.dept, itemIDs[item.ordinal-1], item.ordinal)
			if err != nil {
				return out, err
			}
			_, err = r.Q.Exec(ctx, `INSERT INTO cdw_release_access_grants
   (id,release_id,artifact_id,batch_item_id,user_id,actions,source_target_id,granted_by)
   VALUES($1,$2,$3,$4,$5,ARRAY['preview','download','print']::text[],$6,$7)`,
				grantIDs[i*len(sourceItems)+item.ordinal-1], item.releaseID, item.artifactID,
				itemIDs[item.ordinal-1], target.receiver, targetIDs[i], actor)
			if err != nil {
				return out, err
			}
		}
	}
	_, err = r.Q.Exec(ctx, `UPDATE cdw_distribution_batches SET state='dispatched',
 dispatched_by=$2,dispatched_at=clock_timestamp(),revision=revision+1
 WHERE id=$1 AND state='draft'`, batchID, actor)
	if err != nil {
		return out, err
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_distribution_plans SET state='dispatched',revision=revision+1
 WHERE id=$1 AND state='approved' AND revision=$2`, planID, expected)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	return ports.CDWDistributionBatch{ID: batchID, PlanID: planID, ReleaseID: releaseID, FileID: fileID,
		State: "dispatched", Revision: 2, DigestSHA256: digest, DepartmentCount: len(receivers)}, nil
}
