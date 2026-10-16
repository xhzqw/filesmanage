package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

const cdwQMSAppointmentColumns = `id,file_id,user_id,node_key,policy_release_id,
 evidence_release_id,expires_at,status,proposed_by,COALESCE(verified_by,''),reason`

func cdwScanAppointment(row rowScanner) (ports.CDWQMSAppointment, error) {
	var a ports.CDWQMSAppointment
	var expires time.Time
	err := row.Scan(&a.ID, &a.FileID, &a.UserID, &a.NodeKey, &a.PolicyReleaseID,
		&a.EvidenceReleaseID, &expires, &a.Status, &a.ProposedBy, &a.VerifiedBy, &a.Reason)
	a.ExpiresAt = expires.UTC().Format(time.RFC3339)
	return a, err
}

func (r *Repository) cdwCurrentQMSAppointment(ctx context.Context, fileID, userID, nodeKey, policyID string) (string, error) {
	var id string
	err := r.Q.QueryRow(ctx, `SELECT a.id FROM cdw_qms_appointments a
 WHERE a.file_id=$1 AND a.user_id=$2 AND a.node_key=$3 AND a.policy_release_id=$4
 AND cdw_qms_appointment_current($1,$2,$3,$4)
 AND a.status='verified' AND a.valid_from<=clock_timestamp() AND a.expires_at>clock_timestamp()
 AND cdw_qms_policy_release_effective(a.evidence_release_id)
 ORDER BY a.expires_at DESC,a.id DESC LIMIT 1 FOR SHARE OF a`, fileID, userID, nodeKey, policyID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrQMSAppointmentPending
	}
	return id, err
}

func (r *Repository) CDWQMSProposeAppointment(ctx context.Context, id, fileID, userID, nodeKey, policyID, evidenceID, actor string, expiresAt time.Time, reason string) (ports.CDWQMSAppointment, error) {
	if actor == userID || !expiresAt.After(time.Now().Add(time.Minute)) {
		return ports.CDWQMSAppointment{}, domain.ErrInvalidInput
	}
	cl, err := r.CDWFormalClass(ctx, fileID)
	if err != nil {
		return ports.CDWQMSAppointment{}, err
	}
	if cl.ApprovalClass != "qms" {
		return ports.CDWQMSAppointment{}, domain.ErrDocumentClassPending
	}
	for _, candidate := range []string{policyID, evidenceID} {
		active, e := r.cdwQMSPolicyEffective(ctx, candidate)
		if e != nil {
			return ports.CDWQMSAppointment{}, e
		}
		if !active {
			return ports.CDWQMSAppointment{}, domain.ErrPolicyAuthorityPending
		}
	}
	var personFound bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND disabled_at IS NULL)`, userID).Scan(&personFound)
	if err != nil {
		return ports.CDWQMSAppointment{}, err
	}
	if !personFound {
		return ports.CDWQMSAppointment{}, domain.ErrForbidden
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_qms_appointments
 (id,file_id,user_id,node_key,policy_release_id,evidence_release_id,expires_at,proposed_by,reason)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, id, fileID, userID, nodeKey, policyID, evidenceID, expiresAt, actor, reason)
	if err != nil {
		return ports.CDWQMSAppointment{}, err
	}
	return cdwScanAppointment(r.Q.QueryRow(ctx, `SELECT `+cdwQMSAppointmentColumns+` FROM cdw_qms_appointments WHERE id=$1`, id))
}

func (r *Repository) CDWQMSAppointmentFile(ctx context.Context, id string) (string, error) {
	var fileID string
	err := r.Q.QueryRow(ctx, "SELECT file_id FROM cdw_qms_appointments WHERE id=$1", id).Scan(&fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return fileID, err
}

func (r *Repository) CDWQMSVerifyAppointment(ctx context.Context, id, actor, statement string) (ports.CDWQMSAppointment, error) {
	var fileID, userID, proposer, policyID, evidenceID, status string
	var expiresAt time.Time
	err := r.Q.QueryRow(ctx, `SELECT file_id,user_id,proposed_by,policy_release_id,
 evidence_release_id,status,expires_at FROM cdw_qms_appointments WHERE id=$1 FOR UPDATE`, id).
		Scan(&fileID, &userID, &proposer, &policyID, &evidenceID, &status, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWQMSAppointment{}, domain.ErrNotFound
	}
	if err != nil {
		return ports.CDWQMSAppointment{}, err
	}
	if status != "pending" {
		return ports.CDWQMSAppointment{}, domain.ErrConflict
	}
	if actor == userID || actor == proposer {
		return ports.CDWQMSAppointment{}, domain.ErrForbidden
	}
	if !expiresAt.After(time.Now()) {
		return ports.CDWQMSAppointment{}, domain.ErrQMSAppointmentPending
	}
	role, err := r.CDWControlRole(ctx, actor, "document_control", fileID)
	if err != nil {
		return ports.CDWQMSAppointment{}, err
	}
	for _, releaseID := range []string{policyID, evidenceID} {
		active, e := r.cdwQMSPolicyEffective(ctx, releaseID)
		if e != nil {
			return ports.CDWQMSAppointment{}, e
		}
		if !active {
			return ports.CDWQMSAppointment{}, domain.ErrPolicyAuthorityPending
		}
	}
	_, err = r.Q.Exec(ctx, `UPDATE cdw_qms_appointments SET status='verified',
 verified_by=$2,verified_at=clock_timestamp(),verifier_binding_id=$3,verification_reason=$4
 WHERE id=$1 AND status='pending'`, id, actor, role, statement)
	if err != nil {
		return ports.CDWQMSAppointment{}, err
	}
	return cdwScanAppointment(r.Q.QueryRow(ctx, `SELECT `+cdwQMSAppointmentColumns+` FROM cdw_qms_appointments WHERE id=$1`, id))
}

func (r *Repository) CDWQMSListAppointments(ctx context.Context, fileID string) ([]ports.CDWQMSAppointment, error) {
	rows, err := r.Q.Query(ctx, `SELECT `+cdwQMSAppointmentColumns+
		` FROM cdw_qms_appointments WHERE file_id=$1 ORDER BY proposed_at DESC,id DESC LIMIT 100`, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSAppointment{}
	for rows.Next() {
		a, e := cdwScanAppointment(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
