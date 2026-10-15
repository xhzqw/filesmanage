package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWDistributionGrantScopeRole(ctx context.Context, id, userID, fileID, actor string) (string, error) {
	// Independently granting a role is deliberate and audited, never implicit
	// in plan authorship or an administrator session.
	if _, err := r.Q.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))",
		"cdw:scope_approver:"+userID+":"+fileID); err != nil {
		return "", err
	}
	var existing string
	err := r.Q.QueryRow(ctx, `SELECT id FROM cdw_business_role_bindings
 WHERE user_id=$1 AND file_id=$2 AND role='scope_approver' AND revoked_at IS NULL
 AND valid_from<=now() AND (expires_at IS NULL OR expires_at>now())
 LIMIT 1 FOR UPDATE`, userID, fileID).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	tag, err := r.Q.Exec(ctx, `INSERT INTO cdw_business_role_bindings
 (id,user_id,role,file_id,granted_by)
 SELECT $1,u.id,'scope_approver',f.id,$4 FROM users u CROSS JOIN files f
 WHERE u.id=$2 AND u.disabled_at IS NULL AND f.id=$3 AND f.deleted_at IS NULL`,
		id, userID, fileID, actor)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() != 1 {
		return "", domain.ErrInvalidInput
	}
	return id, nil
}
func (r *Repository) CDWDistributionScopeApprove(ctx context.Context, evidenceID, id, actor string,
	expected int64, digest string) (ports.CDWDistributionPlan, error) {
	var out ports.CDWDistributionPlan
	var state, storedDigest, createdBy, fileID, releaseID, fileName string
	var rev int64
	err := r.Q.QueryRow(ctx, `SELECT p.state,p.revision,p.digest_sha256,p.created_by,
 r.file_id,r.id,r.display_name_snapshot FROM cdw_distribution_plans p
 JOIN cdw_distribution_plan_items i ON i.plan_id=p.id AND i.ordinal=1
 JOIN cdw_controlled_releases r ON r.id=i.release_id
 WHERE p.id=$1 FOR UPDATE OF p`, id).
		Scan(&state, &rev, &storedDigest, &createdBy, &fileID, &releaseID, &fileName)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if rev != expected || state != "frozen" {
		return out, domain.ErrVersionConflict
	}
	if digest != storedDigest {
		return out, domain.ErrConflict
	}
	if createdBy == actor {
		return out, domain.ErrForbidden
	}
	binding, err := r.CDWControlRole(ctx, actor, "scope_approver", fileID)
	if err != nil {
		return out, err
	}
	var sourceReady bool
	if err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_controlled_releases r
 JOIN cdw_release_artifact_verifications v ON v.release_id=r.id
 JOIN cdw_release_artifacts a ON a.id=v.verified_artifact_id
 WHERE r.id=$1 AND r.state='ready' AND a.purpose='distribution'
 AND a.sha256=v.source_sha256)`, releaseID).Scan(&sourceReady); err != nil {
		return out, err
	}
	if !sourceReady {
		return out, domain.ErrConflict
	}
	snapshot, err := json.Marshal(map[string]any{
		"bindingId": binding, "actorId": actor, "role": "scope_approver", "frozenPlanSHA256": digest,
		"releaseId": releaseID, "fileId": fileID,
	})
	if err != nil {
		return out, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_distribution_scope_approvals
 (id,plan_id,plan_digest_sha256,approved_by,authority_binding_id,approver_role_snapshot)
 VALUES($1,$2,$3,$4,$5,$6)`, evidenceID, id, digest, actor, binding, string(snapshot))
	if err != nil {
		return out, err
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_distribution_plans
 SET state='approved',revision=revision+1 WHERE id=$1 AND state='frozen' AND revision=$2`, id, expected)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	return ports.CDWDistributionPlan{ID: id, ReleaseID: releaseID, FileID: fileID, FileName: fileName,
		State: "approved", Revision: rev + 1, DigestSHA256: digest}, nil
}

func (r *Repository) CDWDistributionScopeInbox(ctx context.Context, actor string, limit int) ([]ports.CDWDistributionPlan, error) {
	rows, err := r.Q.Query(ctx, `SELECT p.id,i.release_id,r.file_id,r.display_name_snapshot,
 p.state,p.revision,p.digest_sha256,
 (SELECT COUNT(*) FROM cdw_distribution_plan_targets t WHERE t.plan_id=p.id)
 FROM cdw_distribution_plans p
 JOIN cdw_distribution_plan_items i ON i.plan_id=p.id AND i.ordinal=1
 JOIN cdw_controlled_releases r ON r.id=i.release_id
 WHERE p.state='frozen' AND p.created_by<>$1 AND EXISTS(
 SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
 WHERE b.user_id=$1 AND b.role='scope_approver' AND
 (b.file_id=r.file_id OR b.file_id IS NULL) AND b.department_id IS NULL
 AND b.revoked_at IS NULL AND b.valid_from<=now() AND
 (b.expires_at IS NULL OR b.expires_at>now()) AND u.disabled_at IS NULL)
 ORDER BY p.frozen_at DESC,p.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWDistributionPlan{}
	for rows.Next() {
		var v ports.CDWDistributionPlan
		if err = rows.Scan(&v.ID, &v.ReleaseID, &v.FileID, &v.FileName,
			&v.State, &v.Revision, &v.DigestSHA256, &v.DepartmentCount); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
