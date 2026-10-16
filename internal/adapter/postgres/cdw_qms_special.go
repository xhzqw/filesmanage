package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"

	"github.com/jackc/pgx/v5"
	"time"
)

const cdwSpecialColumns = `a.id,a.file_id,f.name,a.kind,a.template_version_id,
 a.policy_release_id,src.id,src.name,a.status,a.reason,a.proposed_by,
 COALESCE(a.verified_by,''),COALESCE(a.verification_statement,''),
 a.node_claims,COALESCE(a.reviewed_by,''),COALESCE(a.review_reason,'')`
const cdwSpecialJoins = ` FROM cdw_qms_special_authorities a
 JOIN files f ON f.id=a.file_id AND f.deleted_at IS NULL
 JOIN cdw_controlled_releases rel ON rel.id=a.policy_release_id
 JOIN files src ON src.id=rel.file_id AND src.deleted_at IS NULL `

func scanCDWSpecial(row rowScanner) (ports.CDWQMSSpecialAuthority, error) {
	var item ports.CDWQMSSpecialAuthority
	var claims []byte
	err := row.Scan(&item.ID, &item.FileID, &item.FileName, &item.Kind, &item.TemplateVersionID,
		&item.PolicyReleaseID, &item.PolicyFileID, &item.PolicyName, &item.Status, &item.Reason,
		&item.ProposedBy, &item.VerifiedBy, &item.VerificationStatement, &claims, &item.ReviewedBy, &item.ReviewReason)
	if err == nil && len(claims) > 0 {
		err = json.Unmarshal(claims, &item.NodeClaims)
	}
	if item.NodeClaims == nil {
		item.NodeClaims = []ports.CDWQMSSpecialNodeClaim{}
	}
	return item, err
}

func (r *Repository) CDWQMSSpecialPropose(ctx context.Context, id, fileID, kind, templateID, policyID, actor, reason string, claims []ports.CDWQMSSpecialNodeClaim) (ports.CDWQMSSpecialAuthority, error) {
	var eligible bool
	err := r.Q.QueryRow(ctx, `SELECT COALESCE(cdw_qms_special_kind($1)=$2,false)
 AND cdw_qms_special_policy_qualified($2,$4)
 AND EXISTS(SELECT 1 FROM cdw_workflow_template_versions tv
 JOIN cdw_controlled_releases rel ON rel.id=$4 AND rel.file_id<>$1
 WHERE tv.id=$3 AND tv.lifecycle='published'
 AND lower(tv.template_key) ~ '^(cdw_)?qms_'
 AND tv.authority_basis_release_id=$4)`, fileID, kind, templateID, policyID).Scan(&eligible)
	if err != nil {
		return ports.CDWQMSSpecialAuthority{}, err
	}
	if !eligible {
		return ports.CDWQMSSpecialAuthority{}, domain.ErrPolicyAuthorityPending
	}
	var duplicate bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_qms_special_authorities
 WHERE file_id=$1 AND template_version_id=$2 AND status IN('pending','verified'))`, fileID, templateID).Scan(&duplicate)
	if err != nil {
		return ports.CDWQMSSpecialAuthority{}, err
	}
	if duplicate {
		return ports.CDWQMSSpecialAuthority{}, domain.ErrConflict
	}
	encoded, err := json.Marshal(claims)
	if err != nil {
		return ports.CDWQMSSpecialAuthority{}, domain.ErrInvalidInput
	}
	var exact bool
	if err = r.Q.QueryRow(ctx, `SELECT cdw_qms_special_node_claims_match($1,$2::jsonb)`, templateID, string(encoded)).Scan(&exact); err != nil {
		return ports.CDWQMSSpecialAuthority{}, err
	}
	if !exact {
		return ports.CDWQMSSpecialAuthority{}, domain.ErrInvalidInput
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_qms_special_authorities
 (id,file_id,kind,template_version_id,policy_release_id,reason,proposed_by,node_claims)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, id, fileID, kind, templateID, policyID, reason, actor, string(encoded))
	if err != nil {
		return ports.CDWQMSSpecialAuthority{}, err
	}
	return scanCDWSpecial(r.Q.QueryRow(ctx, `SELECT `+cdwSpecialColumns+cdwSpecialJoins+` WHERE a.id=$1`, id))
}

func (r *Repository) CDWQMSSpecialFile(ctx context.Context, id string) (string, string, error) {
	var subject, source string
	err := r.Q.QueryRow(ctx, `SELECT a.file_id,rel.file_id FROM cdw_qms_special_authorities a
 JOIN cdw_controlled_releases rel ON rel.id=a.policy_release_id
 WHERE a.id=$1`, id).Scan(&subject, &source)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", domain.ErrNotFound
	}
	return subject, source, err
}

func (r *Repository) CDWQMSSpecialReview(ctx context.Context, id, actor, statement, action string) (ports.CDWQMSSpecialAuthority, error) {
	var fileID, proposer, status string
	err := r.Q.QueryRow(ctx, `SELECT file_id,proposed_by,status FROM cdw_qms_special_authorities
 WHERE id=$1 FOR UPDATE`, id).Scan(&fileID, &proposer, &status)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWQMSSpecialAuthority{}, domain.ErrNotFound
	}
	if err != nil {
		return ports.CDWQMSSpecialAuthority{}, err
	}
	if actor == proposer {
		return ports.CDWQMSSpecialAuthority{}, domain.ErrForbidden
	}
	role, err := r.CDWControlRole(ctx, actor, "document_control", fileID)
	if err != nil {
		return ports.CDWQMSSpecialAuthority{}, err
	}
	if action == "revoke" {
		if status != "verified" {
			return ports.CDWQMSSpecialAuthority{}, domain.ErrConflict
		}
		_, err = r.Q.Exec(ctx, `UPDATE cdw_qms_special_authorities SET status='revoked',
 revoked_by=$2,revoked_at=clock_timestamp(),revocation_reason=$3
 WHERE id=$1 AND status='verified'`, id, actor, statement)
	} else if action == "verify" {
		if status != "pending" {
			return ports.CDWQMSSpecialAuthority{}, domain.ErrConflict
		}
		_, err = r.Q.Exec(ctx, `UPDATE cdw_qms_special_authorities SET status='verified',
 verified_by=$2,verified_at=clock_timestamp(),verifier_binding_id=$3,
 verification_statement=$4 WHERE id=$1 AND status='pending'`, id, actor, role, statement)
	} else if action == "return" || action == "reject" {
		if status != "pending" {
			return ports.CDWQMSSpecialAuthority{}, domain.ErrConflict
		}
		state := "returned"
		if action == "reject" {
			state = "rejected"
		}
		_, err = r.Q.Exec(ctx, `UPDATE cdw_qms_special_authorities SET status=$2,
 reviewed_by=$3,reviewed_at=clock_timestamp(),review_reason=$4
 WHERE id=$1 AND status='pending'`, id, state, actor, statement)
	} else {
		return ports.CDWQMSSpecialAuthority{}, domain.ErrInvalidInput
	}
	if err != nil {
		return ports.CDWQMSSpecialAuthority{}, err
	}
	return scanCDWSpecial(r.Q.QueryRow(ctx, `SELECT `+cdwSpecialColumns+cdwSpecialJoins+` WHERE a.id=$1`, id))
}

func (r *Repository) CDWQMSSpecialAlerts(ctx context.Context, actor string, limit int) ([]ports.CDWQMSSpecialAlert, error) {
	rows, err := r.Q.Query(ctx, `SELECT n.id,n.authority_id,a.file_id,a.kind,n.event_kind,n.created_at,n.read_at
 FROM cdw_qms_special_alerts n JOIN cdw_qms_special_authorities a ON a.id=n.authority_id
 WHERE n.recipient_id=$1 ORDER BY n.created_at DESC,n.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSSpecialAlert{}
	for rows.Next() {
		var a ports.CDWQMSSpecialAlert
		var at time.Time
		var seen *time.Time
		if err = rows.Scan(&a.ID, &a.AuthorityID, &a.FileID, &a.Kind, &a.EventKind, &at, &seen); err != nil {
			return nil, err
		}
		a.CreatedAt = at.UTC().Format(time.RFC3339Nano)
		if seen != nil {
			v := seen.UTC().Format(time.RFC3339Nano)
			a.ReadAt = &v
		}
		out = append(out, a)
	}
	return out, rows.Err()
}
func (r *Repository) CDWQMSSpecialReadAlert(ctx context.Context, id, actor string) (bool, error) {
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_qms_special_alerts SET read_at=clock_timestamp()
 WHERE id=$1 AND recipient_id=$2 AND read_at IS NULL`, id, actor)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() == 1, nil
}

func (r *Repository) CDWQMSSpecialList(ctx context.Context, actor string, limit int) ([]ports.CDWQMSSpecialAuthority, error) {
	rows, err := r.Q.Query(ctx, `SELECT `+cdwSpecialColumns+cdwSpecialJoins+`
 WHERE a.proposed_by=$1 OR EXISTS(
  SELECT 1 FROM cdw_business_role_bindings b JOIN users u ON u.id=b.user_id
  WHERE b.user_id=$1 AND b.role='document_control'
  AND (b.file_id=a.file_id OR b.file_id IS NULL)
  AND b.department_id IS NULL AND b.revoked_at IS NULL AND u.disabled_at IS NULL
  AND b.valid_from<=clock_timestamp()
  AND (b.expires_at IS NULL OR b.expires_at>clock_timestamp())
 )
 ORDER BY a.proposed_at DESC,a.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWQMSSpecialAuthority{}
	for rows.Next() {
		item, e := scanCDWSpecial(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
