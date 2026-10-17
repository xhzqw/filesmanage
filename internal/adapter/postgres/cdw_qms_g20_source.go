package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWQMSEscalationPolicySourceFile(ctx context.Context, id string) (string, error) {
	var file string
	err := r.Q.QueryRow(ctx, `SELECT r.file_id FROM cdw_qms_escalation_policies p
 JOIN cdw_controlled_releases r ON r.id=p.policy_release_id WHERE p.id=$1`, id).Scan(&file)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return file, err
}
