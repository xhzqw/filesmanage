package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

func (r *Repository) CDWQMSEscalationRevoke(ctx context.Context, id, actor, reason string) (ports.CDWQMSEscalationPolicy, error) {
	var out ports.CDWQMSEscalationPolicy
	var proposed, verified time.Time
	err := r.Q.QueryRow(ctx, `UPDATE cdw_qms_escalation_policies SET status='revoked',
 revoked_by=$2,revoked_at=clock_timestamp(),revocation_reason=$3
 WHERE id=$1 AND status='verified'
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
