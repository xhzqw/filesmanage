package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWFormalClass(ctx context.Context, fileID string) (ports.CDWDocumentClassification, error) {
	v := ports.CDWDocumentClassification{FileID: fileID}
	var fromDB string
	err := r.Q.QueryRow(ctx, `SELECT COALESCE(p.approval_class,'pending'),
 cdw_formal_document_must_be_qms(f.id), COALESCE(p.classification_reason,''),
 COALESCE(p.classified_by,''), COALESCE(p.classification_role_binding_id,'')
 FROM files f LEFT JOIN cdw_document_profiles p ON p.file_id=f.id
 WHERE f.id=$1 AND f.deleted_at IS NULL`, fileID).
		Scan(&fromDB, &v.RequiresQMS, &v.Reason, &v.ClassifiedBy, &v.RoleBindingID)
	if errors.Is(err, pgx.ErrNoRows) {
		return v, domain.ErrNotFound
	}
	if err != nil {
		return v, err
	}
	v.ApprovalClass = fromDB
	if fromDB == "general" && v.RequiresQMS {
		v.ApprovalClass = "pending"
	}
	return v, nil
}

func (r *Repository) cdwFormalValidateClass(ctx context.Context, fileID, templateKey, policyBasisID string) error {
	classification, err := r.CDWFormalClass(ctx, fileID)
	if err != nil {
		return err
	}
	if classification.ApprovalClass == "pending" {
		return domain.ErrDocumentClassPending
	}
	qmsTemplate := cdwIsQMSFormalTemplate(templateKey)
	if classification.ApprovalClass == "qms" {
		if !qmsTemplate {
			return domain.ErrDocumentClassPending
		}
		active, err := r.cdwQMSPolicyEffective(ctx, policyBasisID)
		if err != nil {
			return err
		}
		if !active {
			return domain.ErrPolicyAuthorityPending
		}
	} else if qmsTemplate || policyBasisID != "" {
		return domain.ErrDocumentClassPending
	}
	return nil
}

func (r *Repository) CDWFormalClassify(ctx context.Context, fileID, category, reason, actor string) (ports.CDWDocumentClassification, error) {
	var locked string
	err := r.Q.QueryRow(ctx, "SELECT id FROM files WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", fileID).Scan(&locked)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWDocumentClassification{}, domain.ErrNotFound
	}
	if err != nil {
		return ports.CDWDocumentClassification{}, err
	}
	role, err := r.CDWControlRole(ctx, actor, "document_control", fileID)
	if err != nil {
		return ports.CDWDocumentClassification{}, err
	}
	current, err := r.CDWFormalClass(ctx, fileID)
	if err != nil {
		return current, err
	}
	if current.ApprovalClass != "pending" {
		return current, domain.ErrConflict
	}
	if category == "general" && current.RequiresQMS {
		return current, domain.ErrDocumentClassPending
	}
	tag, err := r.Q.Exec(ctx, `INSERT INTO cdw_document_profiles
 (file_id,document_type,managed,approval_class,classification_reason,classified_by,classified_at,classification_role_binding_id)
 VALUES($1,$2,false,$2,$3,$4,clock_timestamp(),$5)
 ON CONFLICT (file_id) DO UPDATE SET approval_class=EXCLUDED.approval_class,
 classification_reason=EXCLUDED.classification_reason,classified_by=EXCLUDED.classified_by,
 classified_at=EXCLUDED.classified_at,classification_role_binding_id=EXCLUDED.classification_role_binding_id,
 revision=cdw_document_profiles.revision+1
 WHERE cdw_document_profiles.approval_class='pending'`,
		fileID, category, reason, actor, role)
	if err != nil {
		return current, err
	}
	if tag.RowsAffected() != 1 {
		return current, domain.ErrConflict
	}
	return r.CDWFormalClass(ctx, fileID)
}
