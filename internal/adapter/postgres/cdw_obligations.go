package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

func (r *Repository) CDWObligationFile(ctx context.Context, id string) (string, error) {
	var fileID string
	err := r.Q.QueryRow(ctx, `SELECT t.file_id FROM cdw_accountability_obligations o
 JOIN cdw_tasks t ON t.id=o.task_id WHERE o.id=$1`, id).Scan(&fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return fileID, err
}
func (r *Repository) CDWFulfillObligation(ctx context.Context, id, actor string, expected int64, statement, evidenceID string) (ports.CDWObligationFulfillment, error) {
	var out ports.CDWObligationFulfillment
	var parentID string
	// Lock parent before child and obligation, matching task lifecycle lock order.
	err := r.Q.QueryRow(ctx, `SELECT t.parent_id FROM cdw_accountability_obligations o
 JOIN cdw_tasks t ON t.id=o.task_id WHERE o.id=$1`, id).Scan(&parentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	var parentState, childState, fileID, rootID string
	err = r.Q.QueryRow(ctx, `SELECT state FROM cdw_tasks WHERE id=$1 FOR UPDATE`, parentID).Scan(&parentState)
	if err != nil {
		return out, err
	}
	var taskID string
	err = r.Q.QueryRow(ctx, `SELECT o.task_id FROM cdw_accountability_obligations o WHERE o.id=$1`, id).Scan(&taskID)
	if err != nil {
		return out, err
	}
	err = r.Q.QueryRow(ctx, `SELECT t.state,t.file_id,t.root_id FROM cdw_tasks t
 WHERE t.id=$1 AND t.parent_id=$2 FOR UPDATE`, taskID, parentID).Scan(&childState, &fileID, &rootID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrConflict
	}
	if err != nil {
		return out, err
	}
	var kind, state, assignmentID, responsible string
	var rev int64
	err = r.Q.QueryRow(ctx, `SELECT obligation_kind,state,assignment_id,responsible_user_id,revision
 FROM cdw_accountability_obligations WHERE id=$1 FOR UPDATE`, id).
		Scan(&kind, &state, &assignmentID, &responsible, &rev)
	if err != nil {
		return out, err
	}
	if state != "pending" || rev != expected {
		return out, domain.ErrVersionConflict
	}
	if responsible != actor {
		return out, domain.ErrForbidden
	}
	if kind != "manage" && kind != "integrate" && kind != "report" {
		return out, domain.ErrForbidden
	}
	var acceptedBy string
	err = r.Q.QueryRow(ctx, `SELECT a.accepted_by FROM cdw_task_assignments a
 JOIN users u ON u.id=a.accepted_by
 WHERE a.id=$1 AND a.task_id=$2 AND a.kind='primary'
 AND a.ended_at IS NULL AND a.accepted_at IS NOT NULL AND a.accepted_by=$3
 AND u.disabled_at IS NULL FOR SHARE OF a,u`, assignmentID, parentID, actor).Scan(&acceptedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, domain.ErrForbidden
	}
	if err != nil {
		return out, err
	}
	// "accepted_delivery" on its own is insufficient: require the real review
	// gate to be accepted and the persisted delivery to be the task's.
	var childReviewed bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_deliveries d JOIN cdw_review_gates g
 ON g.delivery_id=d.id JOIN cdw_delivery_freezes z ON z.id=d.freeze_id
 WHERE d.task_id=$1 AND g.state IN('accepted','substituted')
 AND z.state='committed' AND d.round_no=(SELECT round_no FROM cdw_tasks WHERE id=$1))`, taskID).Scan(&childReviewed)
	if err != nil {
		return out, err
	}
	if childState != "accepted_delivery" || !childReviewed {
		return out, domain.ErrConflict
	}
	var unfinished int
	err = r.Q.QueryRow(ctx, `WITH RECURSIVE descendants(id) AS
 (SELECT id FROM cdw_tasks WHERE parent_id=$1
 UNION ALL SELECT c.id FROM cdw_tasks c JOIN descendants d ON c.parent_id=d.id)
 SELECT COUNT(*) FROM cdw_tasks WHERE id IN(SELECT id FROM descendants)
 AND state NOT IN('accepted_delivery','closed')`, taskID).Scan(&unfinished)
	if err != nil {
		return out, err
	}
	if unfinished > 0 {
		return out, domain.ErrConflict
	}
	var managerDone, integrated bool
	err = r.Q.QueryRow(ctx, `SELECT
 EXISTS(SELECT 1 FROM cdw_accountability_obligations WHERE task_id=$1
 AND responsible_user_id=$2 AND assignment_id=$3 AND obligation_kind='manage' AND state='fulfilled'),
 EXISTS(SELECT 1 FROM cdw_accountability_obligations WHERE task_id=$1
 AND responsible_user_id=$2 AND assignment_id=$3 AND obligation_kind='integrate' AND state='fulfilled')`,
		taskID, actor, assignmentID).Scan(&managerDone, &integrated)
	if err != nil {
		return out, err
	}
	parentReviewed := false
	if kind != "manage" {
		err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_deliveries d
 JOIN cdw_review_gates g ON g.delivery_id=d.id
 JOIN cdw_delivery_freezes z ON z.id=d.freeze_id
 WHERE d.task_id=$1 AND d.round_no=(SELECT round_no FROM cdw_tasks WHERE id=$1)
 AND z.state='committed' AND g.state IN('accepted','substituted'))`, parentID).Scan(&parentReviewed)
		if err != nil {
			return out, err
		}
		if parentState != "accepted_delivery" || !parentReviewed || !managerDone {
			return out, domain.ErrConflict
		}
	}
	if kind == "report" && !integrated {
		return out, domain.ErrConflict
	}
	snapshot := map[string]any{"childTaskId": taskID, "parentTaskId": parentID, "rootTaskId": rootID,
		"fileId": fileID, "childState": childState, "childDeliveryAccepted": childReviewed,
		"parentState": parentState, "parentDeliveryAccepted": parentReviewed,
		"managementFulfilled": managerDone, "integrationFulfilled": integrated,
		"requiredDescendantsOpen": unfinished, "responsibleAssignmentId": assignmentID}
	raw, e := json.Marshal(struct {
		ObligationID string         `json:"obligationId"`
		Actor        string         `json:"actor"`
		Kind         string         `json:"kind"`
		Statement    string         `json:"statement"`
		Snapshot     map[string]any `json:"snapshot"`
	}{id, actor, kind, statement, snapshot})
	if e != nil {
		return out, e
	}
	sum := sha256.Sum256(raw)
	digest := hex.EncodeToString(sum[:])
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_accountability_obligations
 SET state='fulfilled',fulfilled_at=clock_timestamp(),revision=revision+1
 WHERE id=$1 AND state='pending' AND revision=$2`, id, expected)
	if err != nil {
		return out, err
	}
	if tag.RowsAffected() != 1 {
		return out, domain.ErrVersionConflict
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_obligation_fulfillments
 (id,obligation_id,task_id,actor_id,obligation_kind,statement,evidence_sha256,prerequisite_snapshot)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, evidenceID, id, taskID, actor, kind, statement, digest, string(mustJSON(snapshot)))
	if err != nil {
		return out, err
	}
	var when time.Time
	err = r.Q.QueryRow(ctx, `SELECT fulfilled_at FROM cdw_accountability_obligations WHERE id=$1`, id).Scan(&when)
	if err != nil {
		return out, err
	}
	return ports.CDWObligationFulfillment{ObligationID: id, TaskID: taskID, FileID: fileID, Kind: kind, State: "fulfilled",
		Revision: rev + 1, FulfilledBy: actor, EvidenceSHA256: digest, FulfilledAt: when.UTC().Format(time.RFC3339Nano)}, nil
}
func mustJSON(value any) []byte { raw, _ := json.Marshal(value); return raw }
func (r *Repository) CDWObligationEvent(ctx context.Context, actor, kind, key string, out ports.CDWObligationFulfillment) error {
	raw, e := json.Marshal(out)
	if e != nil {
		return e
	}
	_, e = r.Q.Exec(ctx, `INSERT INTO cdw_domain_events
 (aggregate_kind,aggregate_id,event_kind,actor_id,request_id,details)
 VALUES('obligation',$1,$2,$3,$4,$5)`, out.ObligationID, kind, actor, key, string(raw))
	if e != nil {
		return e
	}
	sum := sha256.Sum256([]byte("obligation|" + actor + "|" + kind + "|" + key + "|" + out.ObligationID))
	_, e = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'cdw.obligation.fulfilled',$2)`, "cdw_evt_"+hex.EncodeToString(sum[:]), string(raw))
	return e
}
