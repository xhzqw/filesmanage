package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) CDWPaperTargetFile(ctx context.Context, targetID string) (string, error) {
	var id string
	err := r.Q.QueryRow(ctx, `SELECT rel.file_id FROM cdw_distribution_targets t
 JOIN cdw_distribution_batch_items bi ON bi.batch_id=t.batch_id AND bi.ordinal=1
 JOIN cdw_controlled_releases rel ON rel.id=bi.release_id WHERE t.id=$1`, targetID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return id, err
}
func (r *Repository) CDWPaperCopyFile(ctx context.Context, copyID string) (string, error) {
	var id string
	err := r.Q.QueryRow(ctx, `SELECT rel.file_id FROM cdw_controlled_copies c
 JOIN cdw_controlled_releases rel ON rel.id=c.release_id WHERE c.id=$1`, copyID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return id, err
}
func (r *Repository) CDWPaperLedger(ctx context.Context, targetID string) (ports.CDWPaperLedger, error) {
	out := ports.CDWPaperLedger{TargetID: targetID, Copies: []ports.CDWPaperCopy{}}
	err := r.Q.QueryRow(ctx, `SELECT rel.file_id,t.batch_id,t.revision,pt.channel,pt.paper_quantity,COALESCE(l.id,'')
 FROM cdw_distribution_targets t
 JOIN cdw_distribution_plan_targets pt ON pt.plan_id=t.plan_id AND pt.department_id=t.department_id
 JOIN cdw_distribution_batch_items bi ON bi.batch_id=t.batch_id AND bi.ordinal=1
 JOIN cdw_controlled_releases rel ON rel.id=bi.release_id
 LEFT JOIN cdw_copy_issue_lots l ON l.target_id=t.id AND l.batch_item_id=bi.id
 WHERE t.id=$1`, targetID).Scan(&out.FileID, &out.BatchID, &out.TargetRevision, &out.Channel, &out.PaperQuantity, &out.LotID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if out.LotID == "" {
		return out, nil
	}
	rows, err := r.Q.Query(ctx, `SELECT c.id,c.copy_no,c.holder_id,h.state,h.revision,
 h.current_event_id,e.actor_id,e.reason
 FROM cdw_controlled_copies c JOIN cdw_controlled_copy_heads h ON h.copy_id=c.id
 LEFT JOIN cdw_withdrawal_events e ON e.id=h.current_event_id
 WHERE c.lot_id=$1 ORDER BY c.copy_no,c.id`, out.LotID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var copy ports.CDWPaperCopy
		if err = rows.Scan(&copy.ID, &copy.CopyNo, &copy.HolderID, &copy.State, &copy.Revision,
			&copy.LastEventID, &copy.LastActorID, &copy.LastReason); err != nil {
			return out, err
		}
		out.Copies = append(out.Copies, copy)
		out.Issued++
		switch copy.State {
		case "issued":
			out.Outstanding++
		case "collected":
			out.Collected++
		case "destroyed":
			out.Destroyed++
		case "lost":
			out.Lost++
			out.Outstanding++
		case "waived":
			out.Waived++
		}
	}
	return out, rows.Err()
}
func (r *Repository) CDWPaperIssue(ctx context.Context, targetID, lotID, actor string, expected int64,
	copyIDs, copyNumbers []string) (ports.CDWPaperLedger, error) {
	var out ports.CDWPaperLedger
	var batchID, itemID, releaseID, fileID, targetState, batchState, channel string
	var receiptID *string
	var paperQty int
	var revision int64
	err := r.Q.QueryRow(ctx, `SELECT t.batch_id,bi.id,bi.release_id,rel.file_id,
 t.validity_state,b.state,pt.channel,pt.paper_quantity,h.current_receipt_id,t.revision
 FROM cdw_distribution_targets t
 JOIN cdw_distribution_batches b ON b.id=t.batch_id
 JOIN cdw_distribution_batch_items bi ON bi.batch_id=t.batch_id AND bi.ordinal=1
 JOIN cdw_controlled_releases rel ON rel.id=bi.release_id
 JOIN cdw_distribution_plan_targets pt ON pt.plan_id=t.plan_id AND pt.department_id=t.department_id
 JOIN cdw_target_receipt_heads h ON h.target_id=t.id
 WHERE t.id=$1 FOR UPDATE OF t`, targetID).
		Scan(&batchID, &itemID, &releaseID, &fileID, &targetState, &batchState,
			&channel, &paperQty, &receiptID, &revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if revision != expected {
		return out, domain.ErrVersionConflict
	}
	if batchState != "dispatched" || targetState != "active" || receiptID == nil ||
		(channel != "paper" && channel != "mixed") || paperQty != len(copyIDs) ||
		len(copyIDs) != len(copyNumbers) {
		return out, domain.ErrConflict
	}
	if _, err = r.CDWControlRole(ctx, actor, "document_control", fileID); err != nil {
		return out, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_copy_issue_lots
 (id,target_id,batch_item_id,release_id,issued_qty,state)
 VALUES($1,$2,$3,$4,$5,'draft')`, lotID, targetID, itemID, releaseID, paperQty)
	if isUniqueViolation(err) {
		return out, domain.ErrConflict
	}
	if err != nil {
		return out, err
	}
	var receiverID string
	err = r.Q.QueryRow(ctx, `SELECT designated_receiver_id FROM cdw_distribution_targets WHERE id=$1`, targetID).Scan(&receiverID)
	if err != nil {
		return out, err
	}
	for i, id := range copyIDs {
		_, err = r.Q.Exec(ctx, `INSERT INTO cdw_controlled_copies(id,lot_id,release_id,copy_no,holder_id)
  VALUES($1,$2,$3,$4,$5)`, id, lotID, releaseID, copyNumbers[i], receiverID)
		if isUniqueViolation(err) {
			return out, domain.ErrConflict
		}
		if err != nil {
			return out, err
		}
		_, err = r.Q.Exec(ctx, `INSERT INTO cdw_controlled_copy_heads(copy_id,state) VALUES($1,'issued')`, id)
		if err != nil {
			return out, err
		}
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_copy_issue_lots SET state='frozen'
 WHERE id=$1 AND state='draft'`, lotID)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrConflict
	}
	tag, err = r.Q.Exec(ctx, `UPDATE cdw_distribution_targets SET revision=revision+1
 WHERE id=$1 AND revision=$2`, targetID, revision)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	return r.CDWPaperLedger(ctx, targetID)
}
func (r *Repository) CDWPaperTransition(ctx context.Context, copyID, eventID, actor string,
	expected int64, kind, reason string) (ports.CDWPaperTransition, error) {
	var out ports.CDWPaperTransition
	var state, fileID, lotState string
	var rev int64
	err := r.Q.QueryRow(ctx, `SELECT h.state,h.revision,rel.file_id,l.state
 FROM cdw_controlled_copy_heads h
 JOIN cdw_controlled_copies c ON c.id=h.copy_id
 JOIN cdw_copy_issue_lots l ON l.id=c.lot_id
 JOIN cdw_controlled_releases rel ON rel.id=c.release_id
 WHERE h.copy_id=$1 FOR UPDATE OF h`, copyID).
		Scan(&state, &rev, &fileID, &lotState)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	if rev != expected {
		return out, domain.ErrVersionConflict
	}
	if lotState != "frozen" || !((state == "issued" && (kind == "collected" || kind == "lost")) ||
		(state == "collected" && kind == "destroyed")) {
		return out, domain.ErrConflict
	}
	if _, err = r.CDWControlRole(ctx, actor, "document_control", fileID); err != nil {
		return out, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_withdrawal_events(id,copy_id,actor_id,kind,reason)
 VALUES($1,$2,$3,$4,$5)`, eventID, copyID, actor, kind, reason)
	if err != nil {
		return out, err
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_controlled_copy_heads
 SET state=$3,revision=revision+1,current_event_id=$4,changed_at=clock_timestamp()
 WHERE copy_id=$1 AND revision=$2`, copyID, expected, kind, eventID)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	return ports.CDWPaperTransition{CopyID: copyID, EventID: eventID, Kind: kind,
		State: kind, Revision: expected + 1, ActorID: actor, Reason: reason}, nil
}
