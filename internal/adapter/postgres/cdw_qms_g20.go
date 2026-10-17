package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

func (r *Repository) CDWQMSEscalationSourceFile(ctx context.Context, release string) (string, error) {
	var file string
	err := r.Q.QueryRow(ctx, "SELECT file_id FROM cdw_controlled_releases WHERE id=$1", release).Scan(&file)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return file, err
}
func (r *Repository) CDWQMSEscalationContextFile(ctx context.Context, id, kind string) (string, error) {
	var file string
	var err error
	switch kind {
	case "policy":
		err = r.Q.QueryRow(ctx, "SELECT target_file_id FROM cdw_qms_escalation_policies WHERE id=$1", id).Scan(&file)
	case "case":
		err = r.Q.QueryRow(ctx, "SELECT target_file_id FROM cdw_qms_escalation_cases WHERE id=$1", id).Scan(&file)
	default:
		return "", domain.ErrInvalidInput
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return file, err
}
func (r *Repository) CDWQMSEscalationPropose(ctx context.Context, id string, p ports.CDWQMSEscalationPolicy) (ports.CDWQMSEscalationPolicy, error) {
	var out ports.CDWQMSEscalationPolicy
	var proposed time.Time
	err := r.Q.QueryRow(ctx, `INSERT INTO cdw_qms_escalation_policies
 (id,target_file_id,policy_release_id,clause_ref,delay_minutes,escalation_owner_id,reason,proposed_by)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)
 RETURNING id,target_file_id,policy_release_id,clause_ref,delay_minutes,escalation_owner_id,
 reason,proposed_by,status,proposed_at`,
		id, p.TargetFileID, p.PolicyReleaseID, p.ClauseRef, p.DelayMinutes, p.OwnerID, p.Reason, p.ProposedBy).
		Scan(&out.ID, &out.TargetFileID, &out.PolicyReleaseID, &out.ClauseRef, &out.DelayMinutes,
			&out.OwnerID, &out.Reason, &out.ProposedBy, &out.Status, &proposed)
	if err != nil {
		return out, err
	}
	out.ProposedAt = proposed.UTC().Format(time.RFC3339Nano)
	return out, nil
}
func (r *Repository) CDWQMSEscalationVerify(ctx context.Context, id, actor, reason string) (ports.CDWQMSEscalationPolicy, error) {
	var out ports.CDWQMSEscalationPolicy
	var proposed, verified time.Time
	err := r.Q.QueryRow(ctx, `UPDATE cdw_qms_escalation_policies SET status='verified',
 verified_by=$2,verified_at=clock_timestamp(),verification_reason=$3
 WHERE id=$1 AND status='pending'
 RETURNING id,target_file_id,policy_release_id,clause_ref,delay_minutes,escalation_owner_id,
 reason,proposed_by,status,verified_by,proposed_at,verified_at`,
		id, actor, reason).Scan(&out.ID, &out.TargetFileID, &out.PolicyReleaseID,
		&out.ClauseRef, &out.DelayMinutes, &out.OwnerID, &out.Reason,
		&out.ProposedBy, &out.Status, &out.VerifiedBy, &proposed, &verified)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	out.ProposedAt = proposed.UTC().Format(time.RFC3339Nano)
	v := verified.UTC().Format(time.RFC3339Nano)
	out.VerifiedAt = &v
	return out, nil
}
func (r *Repository) CDWQMSEscalationPolicies(ctx context.Context, actor string, limit int) ([]ports.CDWQMSEscalationPolicy, error) {
	rows, err := r.Q.Query(ctx, `SELECT p.id,p.target_file_id,p.policy_release_id,p.clause_ref,p.delay_minutes,
 p.escalation_owner_id,p.reason,p.proposed_by,p.status,COALESCE(p.verified_by,''),
 p.proposed_at,p.verified_at
 FROM cdw_qms_escalation_policies p
 WHERE EXISTS(SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
 WHERE b.user_id=$1 AND b.role='document_control' AND (b.file_id=p.target_file_id OR b.file_id IS NULL)
 AND b.department_id IS NULL AND b.revoked_at IS NULL AND u.disabled_at IS NULL
 AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))
 ORDER BY p.proposed_at DESC,p.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSEscalationPolicy{}
	for rows.Next() {
		var p ports.CDWQMSEscalationPolicy
		var proposed time.Time
		var verified *time.Time
		if err = rows.Scan(&p.ID, &p.TargetFileID, &p.PolicyReleaseID, &p.ClauseRef,
			&p.DelayMinutes, &p.OwnerID, &p.Reason, &p.ProposedBy, &p.Status,
			&p.VerifiedBy, &proposed, &verified); err != nil {
			return nil, err
		}
		p.ProposedAt = proposed.UTC().Format(time.RFC3339Nano)
		if verified != nil {
			v := verified.UTC().Format(time.RFC3339Nano)
			p.VerifiedAt = &v
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
func (r *Repository) CDWQMSEscalationOpen(ctx context.Context, id, noticeID, policyID, actor, reason string) (ports.CDWQMSEscalationCase, error) {
	var out ports.CDWQMSEscalationCase
	var at time.Time
	err := r.Q.QueryRow(ctx, `INSERT INTO cdw_qms_escalation_cases
 (id,notice_id,policy_id,target_file_id,escalated_to,escalated_by,reason)
 SELECT $1,$2,p.id,p.target_file_id,p.escalation_owner_id,$4,$5
 FROM cdw_qms_escalation_policies p WHERE p.id=$3
 RETURNING id,notice_id,policy_id,target_file_id,escalated_to,escalated_by,reason,escalated_at`,
		id, noticeID, policyID, actor, reason).Scan(&out.ID, &out.NoticeID, &out.PolicyID,
		&out.TargetFileID, &out.OwnerID, &out.EscalatedBy, &out.Reason, &at)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	out.EscalatedAt = at.UTC().Format(time.RFC3339Nano)
	return out, nil
}
func (r *Repository) CDWQMSEscalationResolve(ctx context.Context, id, caseID, actor, reason string) (ports.CDWQMSEscalationResolution, error) {
	var out ports.CDWQMSEscalationResolution
	var at time.Time
	err := r.Q.QueryRow(ctx, `INSERT INTO cdw_qms_escalation_resolutions
 (id,case_id,resolved_by,resolution) VALUES($1,$2,$3,$4)
 RETURNING id,case_id,resolved_by,resolution,resolved_at`, id, caseID, actor, reason).
		Scan(&out.ID, &out.CaseID, &out.ResolvedBy, &out.Resolution, &at)
	if err != nil {
		return out, err
	}
	out.ResolvedAt = at.UTC().Format(time.RFC3339Nano)
	return out, nil
}
func (r *Repository) CDWQMSEscalationCases(ctx context.Context, actor string, limit int) ([]ports.CDWQMSEscalationCase, error) {
	rows, err := r.Q.Query(ctx, `SELECT c.id,c.notice_id,c.policy_id,c.target_file_id,c.escalated_to,
 c.escalated_by,c.reason,c.escalated_at,COALESCE(res.resolution,''),
 COALESCE(res.resolved_by,''),res.resolved_at
 FROM cdw_qms_escalation_cases c
 LEFT JOIN cdw_qms_escalation_resolutions res ON res.case_id=c.id
 WHERE c.escalated_to=$1 OR EXISTS(SELECT 1 FROM cdw_business_role_bindings b
 JOIN users u ON u.id=b.user_id WHERE b.user_id=$1 AND b.role='document_control'
 AND (b.file_id=c.target_file_id OR b.file_id IS NULL) AND b.department_id IS NULL
 AND b.revoked_at IS NULL AND u.disabled_at IS NULL
 AND b.valid_from<=clock_timestamp() AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp()))
 ORDER BY c.escalated_at DESC,c.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSEscalationCase{}
	for rows.Next() {
		var c ports.CDWQMSEscalationCase
		var at time.Time
		var finished *time.Time
		if err = rows.Scan(&c.ID, &c.NoticeID, &c.PolicyID, &c.TargetFileID, &c.OwnerID,
			&c.EscalatedBy, &c.Reason, &at, &c.Resolution, &c.ResolvedBy, &finished); err != nil {
			return nil, err
		}
		c.EscalatedAt = at.UTC().Format(time.RFC3339Nano)
		if finished != nil {
			v := finished.UTC().Format(time.RFC3339Nano)
			c.ResolvedAt = &v
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
