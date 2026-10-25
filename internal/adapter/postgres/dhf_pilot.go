package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain/dhf"
	"filesmanage/internal/ports"

	"github.com/jackc/pgx/v5"
)

// Compile-time guarantee: a transaction-bound Repository supports DHF
// snapshot reads. The methods reject pool-only invocations.
var _ ports.DHFPilotSnapshotStore = (*Repository)(nil)

func (r *Repository) DHFPilotBeginSnapshot(ctx context.Context) error {
	if _, ok := r.Q.(pgx.Tx); !ok {
		return errors.New("DHF snapshot requires a transaction")
	}
	// First operation on a freshly begun tx. READ ONLY prevents a supposedly
	// passive preflight from mutating business state; REPEATABLE READ guarantees
	// that policy, attempts, roles, files and dependency projections share one
	// database snapshot rather than a series of READ COMMITTED snapshots.
	_, err := r.Q.Exec(ctx, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
	return err
}

func (r *Repository) DHFPilotAttemptForActor(ctx context.Context, attemptID, actorID string) (ports.DHFPilotAttemptRecord, error) {
	var out ports.DHFPilotAttemptRecord
	var stageState string
	if attemptID == "" || actorID == "" {
		return out, ports.ErrRowMissing
	}
	err := r.Q.QueryRow(ctx,
		"SELECT a.project_id,a.stage_id,a.id,a.template_id,"+
		" t.policy_body,t.policy_sha,t.status,(t.approved_by IS NOT NULL AND t.approved_at IS NOT NULL),"+
		" a.manifest_body,a.manifest_sha,a.state,p.state,b.active,m.can_prepare,m.can_submit"+
		" FROM dhf_pilot_attempts a"+
		" JOIN dhf_pilot_projects p ON p.id=a.project_id"+
		" JOIN dhf_pilot_baselines b ON b.project_id=a.project_id AND b.stage_id=a.stage_id AND b.template_id=a.template_id"+
		" JOIN dhf_pilot_templates t ON t.id=a.template_id AND t.stage_id=a.stage_id"+
		" JOIN dhf_pilot_members m ON m.project_id=a.project_id AND m.user_id=$2"+
		" JOIN users u ON u.id=m.user_id AND u.disabled_at IS NULL"+
		" WHERE a.id=$1", attemptID, actorID).Scan(
		&out.ProjectID,&out.StageID,&out.AttemptID,&out.TemplateVersionID,
		&out.PolicyBody,&out.PolicyHash,&out.PolicyStatus,&out.TemplateApproved,
		&out.ManifestBody,&out.ManifestHash,&stageState,&out.ProjectState,&out.BaselineActive,
		&out.CanPrepare,&out.CanSubmit,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.DHFPilotAttemptRecord{}, ports.ErrRowMissing
	}
	out.State = dhf.StageState(stageState)
	return out, err
}

// Only an exact stage within the same DHF project can serve as a predecessor.
// Absence means no accepted stage, NOT "no dependency".
func (r *Repository) DHFPilotPredecessor(ctx context.Context, projectID, stageID string) (dhf.StageState, error) {
	var state string
	err := r.Q.QueryRow(ctx,
		"SELECT state FROM dhf_pilot_stage_positions WHERE project_id=$1 AND stage_id=$2",
		projectID, stageID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return dhf.Preparing, nil
	}
	return dhf.StageState(state), err
}
