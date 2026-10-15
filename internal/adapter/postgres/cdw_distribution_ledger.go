package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

func (r *Repository) CDWDistributionLedger(ctx context.Context, planID string) (ports.CDWDistributionLedger, error) {
	var out ports.CDWDistributionLedger
	out.Rows = []ports.CDWDistributionLedgerRow{}
	var state string
	err := r.Q.QueryRow(ctx, `SELECT id,plan_digest_sha256,state FROM cdw_distribution_batches
 WHERE plan_id=$1`, planID).Scan(&out.BatchID, &out.ManifestSHA256, &state)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if state != "dispatched" {
		return out, domain.ErrConflict
	}
	out.PlanID = planID
	rows, err := r.Q.Query(ctx, `SELECT t.id,t.department_id,d.name,t.designated_receiver_id,u.display_name,
 rec.id,rec.actor_id,signer.display_name,rec.signed_at,t.due_at,t.validity_state,
 COALESCE(reads.assigned,0),COALESCE(reads.confirmed,0)
 FROM cdw_distribution_targets t
 JOIN departments d ON d.id=t.department_id
 JOIN users u ON u.id=t.designated_receiver_id
 LEFT JOIN cdw_target_receipt_heads h ON h.target_id=t.id
 LEFT JOIN cdw_department_receipts rec ON rec.id=h.current_receipt_id
 LEFT JOIN users signer ON signer.id=rec.actor_id
 LEFT JOIN LATERAL (
  SELECT COUNT(*) FILTER(WHERE a.required) AS assigned,
  COUNT(*) FILTER(WHERE a.required AND a.state='confirmed') AS confirmed
  FROM cdw_reading_assignments a WHERE a.target_id=t.id
 ) reads ON true
 WHERE t.batch_id=$1 ORDER BY d.name,t.department_id`, out.BatchID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var row ports.CDWDistributionLedgerRow
		var signerAt, dueAt *time.Time
		var validity string
		if err = rows.Scan(&row.TargetID, &row.DepartmentID, &row.DepartmentName,
			&row.ReceiverID, &row.ReceiverName, &row.ReceiptID, &row.ActualSignerID,
			&row.ActualSignerName, &signerAt, &dueAt, &validity, &row.ReadingAssigned,
			&row.ReadingConfirmed); err != nil {
			return out, err
		}
		row.ReceiptStatus = "awaiting"
		if row.ReceiptID != nil {
			row.ReceiptStatus = "received"
			out.ReceiptCompleted++
		}
		if signerAt != nil {
			v := signerAt.UTC().Format(time.RFC3339Nano)
			row.SignedAt = &v
		}
		if dueAt != nil {
			v := dueAt.UTC().Format(time.RFC3339Nano)
			row.DueAt = &v
			row.Overdue = dueAt.Before(time.Now()) && row.ReceiptID == nil
		}
		switch {
		case row.ReadingAssigned == 0:
			row.ReadingStatus = "unassigned"
		case row.ReadingAssigned == row.ReadingConfirmed:
			row.ReadingStatus = "confirmed"
		case row.ReadingConfirmed > 0:
			row.ReadingStatus = "partial"
		default:
			row.ReadingStatus = "awaiting"
		}
		if validity != "active" {
			reason := "分发目标已撤销或替换"
			row.ExceptionReason = &reason
		}
		out.ReadingAssigned += row.ReadingAssigned
		out.ReadingConfirmed += row.ReadingConfirmed
		out.Rows = append(out.Rows, row)
	}
	return out, rows.Err()
}
