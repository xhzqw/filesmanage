package postgres

import (
	"context"
	"filesmanage/internal/ports"
)

func (r *Repository) CDWReadingEligible(ctx context.Context, targetID, actor string) ([]ports.CDWReadingPerson, error) {
	rows, err := r.Q.Query(ctx, `SELECT u.id,u.display_name
 FROM cdw_distribution_targets t
 JOIN users u ON u.department_id=t.department_id AND u.disabled_at IS NULL
 JOIN cdw_distribution_batches b ON b.id=t.batch_id AND b.state='dispatched'
 JOIN cdw_target_receipt_heads h ON h.target_id=t.id AND h.current_receipt_id IS NOT NULL
 WHERE t.id=$1 AND t.designated_receiver_id=$2 AND t.validity_state='active'
 ORDER BY u.display_name,u.id LIMIT 500`, targetID, actor)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CDWReadingPerson{}
	for rows.Next() {
		var p ports.CDWReadingPerson
		if err = rows.Scan(&p.ID, &p.DisplayName); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
