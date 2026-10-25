package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/ports"

	"github.com/jackc/pgx/v5"
)

var _ ports.DHFConditionalProposalStore = (*Repository)(nil)

const dhfConditionalPolicyScope = `
FROM dhf_pilot_baselines b
JOIN dhf_pilot_projects p ON p.id=b.project_id AND p.state='active'
JOIN dhf_pilot_templates t ON t.id=b.template_id AND t.stage_id=b.stage_id
  AND t.status='published' AND t.approved_by IS NOT NULL AND t.approved_at IS NOT NULL
  AND t.policy_sha=encode(sha256(t.policy_body),'hex')
JOIN dhf_pilot_members m ON m.project_id=b.project_id AND m.user_id=$1 AND m.can_prepare
JOIN users actor ON actor.id=$1 AND actor.disabled_at IS NULL
 AND NOT actor.must_change_password
WHERE b.active `

func (r *Repository) dhfConditionalProjectOwners(ctx context.Context, projectID string) ([]ports.DHFConditionalOwner, error) {
	rows, err := r.Q.Query(ctx, `SELECT u.id,u.display_name FROM dhf_pilot_members m
 JOIN users u ON u.id=m.user_id
 WHERE m.project_id=$1 AND (m.can_prepare OR m.can_submit)
  AND u.disabled_at IS NULL AND NOT u.must_change_password
 ORDER BY u.display_name,u.id LIMIT 100`, projectID)
	if err != nil {
		return nil, err
	}
	out := []ports.DHFConditionalOwner{}
	for rows.Next() {
		var owner ports.DHFConditionalOwner
		if err = rows.Scan(&owner.ID, &owner.DisplayName); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, owner)
	}
	err = rows.Err()
	rows.Close()
	return out, err
}

func (r *Repository) DHFConditionalPoliciesForActor(ctx context.Context, actorID string) ([]ports.DHFConditionalPolicySource, error) {
	rows, err := r.Q.Query(ctx, `SELECT b.project_id,b.stage_id,b.template_id,t.policy_sha,t.policy_body`+
		dhfConditionalPolicyScope+` ORDER BY b.project_id,b.stage_id LIMIT 90`, actorID)
	if err != nil {
		return nil, err
	}
	sources := []ports.DHFConditionalPolicySource{}
	for rows.Next() {
		var x ports.DHFConditionalPolicySource
		if err = rows.Scan(&x.ProjectID, &x.StageID, &x.TemplateID, &x.PolicySHA, &x.PolicyBody); err != nil {
			rows.Close()
			return nil, err
		}
		sources = append(sources, x)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	// Every stage in one project uses the same verified DAG and owner list.
	// Cache within this serializable read transaction to bound DB roundtrips.
	graphByProject := map[string][]ports.DHFStageGateGraphNode{}
	ownersByProject := map[string][]ports.DHFConditionalOwner{}
	for i := range sources {
		projectID := sources[i].ProjectID
		if _, exists := graphByProject[projectID]; !exists {
			graphByProject[projectID], err = r.DHFStageGateProjectGraph(ctx, projectID)
			if err != nil {
				return nil, err
			}
			ownersByProject[projectID], err = r.dhfConditionalProjectOwners(ctx, projectID)
			if err != nil {
				return nil, err
			}
		}
		sources[i].Graph = graphByProject[projectID]
		sources[i].Owners = ownersByProject[projectID]
	}
	return sources, nil
}
func (r *Repository) DHFConditionalPolicyForActor(ctx context.Context, projectID, stageID, actorID string) (ports.DHFConditionalPolicySource, error) {
	var x ports.DHFConditionalPolicySource
	err := r.Q.QueryRow(ctx, `SELECT b.project_id,b.stage_id,b.template_id,t.policy_sha,t.policy_body`+
		dhfConditionalPolicyScope+` AND b.project_id=$2 AND b.stage_id=$3`, actorID, projectID, stageID).
		Scan(&x.ProjectID, &x.StageID, &x.TemplateID, &x.PolicySHA, &x.PolicyBody)
	if errors.Is(err, pgx.ErrNoRows) {
		return x, ports.ErrRowMissing
	}
	if err != nil {
		return x, err
	}
	x.Graph, err = r.DHFStageGateProjectGraph(ctx, projectID)
	if err != nil {
		return x, err
	}
	x.Owners, err = r.dhfConditionalProjectOwners(ctx, projectID)
	return x, err
}
func scanDHFConditionalProposal(row rowScanner) (ports.DHFConditionalProposal, error) {
	var x ports.DHFConditionalProposal
	var raw []byte
	var withdrawn *string
	err := row.Scan(&x.ID, &x.ProjectID, &x.StageID, &x.TemplateID, &x.PolicySHA, &x.ProposedBy,
		&x.DependencyID, &x.PredecessorStage, &x.GuardedAction, &x.GraphSHA, &raw,
		&x.Reason, &x.ExpiresAt, &x.IdempotencyKey, &x.RequestSHA, &x.Status, &withdrawn)
	if err != nil {
		return x, err
	}
	if err = json.Unmarshal(raw, &x.Obligations); err != nil {
		return x, err
	}
	if withdrawn != nil {
		x.WithdrawalReason = *withdrawn
	}
	x.TrialOnly = true
	return x, nil
}

const dhfConditionalFields = `SELECT p.id,p.project_id,p.stage_id,p.template_id,p.policy_sha,
p.proposed_by,p.dependency_id,p.predecessor_stage,p.guarded_action,p.graph_sha,
p.obligations,p.reason,p.expires_at,p.idempotency_key,p.request_sha,
dhf_pilot_conditional_proposal_status(
 p.expires_at,w.happened_at,transaction_timestamp()),w.reason
FROM dhf_pilot_conditional_remediation_proposals p
LEFT JOIN dhf_pilot_conditional_proposal_withdrawals w ON w.proposal_id=p.id `

func (r *Repository) DHFConditionalProposalByScope(ctx context.Context, projectID, stageID, templateID, edgeID string) (ports.DHFConditionalProposal, error) {
	x, err := scanDHFConditionalProposal(r.Q.QueryRow(ctx, dhfConditionalFields+
		`WHERE p.project_id=$1 AND p.stage_id=$2 AND p.template_id=$3 AND p.dependency_id=$4`,
		projectID, stageID, templateID, edgeID))
	if errors.Is(err, pgx.ErrNoRows) {
		return x, ports.ErrRowMissing
	}
	return x, err
}
func (r *Repository) DHFConditionalProposalsForActor(ctx context.Context, actorID string) ([]ports.DHFConditionalProposal, error) {
	rows, err := r.Q.Query(ctx, dhfConditionalFields+`
 JOIN dhf_pilot_members member ON member.project_id=p.project_id
 AND member.user_id=$1 AND member.can_prepare
 JOIN users actor ON actor.id=$1 AND actor.disabled_at IS NULL
 WHERE p.proposed_by=$1
 ORDER BY p.created_at DESC LIMIT 100`, actorID)
	if err != nil {
		return nil, err
	}
	items := []ports.DHFConditionalProposal{}
	for rows.Next() {
		x, e := scanDHFConditionalProposal(rows)
		if e != nil {
			rows.Close()
			return nil, e
		}
		items = append(items, x)
	}
	err = rows.Err()
	rows.Close()
	return items, err
}
func (r *Repository) DHFConditionalProposalByID(ctx context.Context, proposalID, actorID string) (ports.DHFConditionalProposal, error) {
	x, err := scanDHFConditionalProposal(r.Q.QueryRow(ctx, dhfConditionalFields+
		` JOIN dhf_pilot_members member ON member.project_id=p.project_id
 AND member.user_id=$2 AND member.can_prepare
 JOIN users u ON u.id=$2 AND u.disabled_at IS NULL
 WHERE p.id=$1 AND p.proposed_by=$2`, proposalID, actorID))
	if errors.Is(err, pgx.ErrNoRows) {
		return x, ports.ErrRowMissing
	}
	return x, err
}
func (r *Repository) DHFConditionalPersist(ctx context.Context, x ports.DHFConditionalProposal) error {
	raw, err := json.Marshal(x.Obligations)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO dhf_pilot_conditional_remediation_proposals
(id,project_id,stage_id,template_id,policy_sha,proposed_by,dependency_id,
 predecessor_stage,guarded_action,graph_snapshot,graph_sha,obligations,reason,
 expires_at,idempotency_key,request_sha)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'[]'::jsonb,repeat('0',64),
 $10::jsonb,$11,$12,$13,$14)`,
		x.ID, x.ProjectID, x.StageID, x.TemplateID, x.PolicySHA, x.ProposedBy,
		x.DependencyID, x.PredecessorStage, x.GuardedAction, string(raw), x.Reason,
		x.ExpiresAt, x.IdempotencyKey, x.RequestSHA)
	if err != nil {
		return err
	}
	err = r.Q.QueryRow(ctx, `SELECT graph_sha FROM dhf_pilot_conditional_remediation_proposals
 WHERE id=$1`, x.ID).Scan(&x.GraphSHA)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO audit_events(
 actor_id,event_type,target_kind,target_id,request_id,outcome,details)
VALUES($1,'dhf.pilot.conditional_proposal_filed','dhf_conditional_proposal',
 $2,$3,'awaiting_enterprise_authority',
 jsonb_build_object('graphSha',$4::text,'projectId',$5::text,
 'stageId',$6::text,'formalAccepted',false))`,
		x.ProposedBy, x.ID, x.IdempotencyKey, x.GraphSHA, x.ProjectID, x.StageID)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'dhf.pilot.conditional_proposal_filed',
 jsonb_build_object('proposalId',$2::text,'graphSha',$3::text,
 'trialOnly',true,'formalAccepted',false))`,
		"dhf-conditional-proposal:"+x.ID, x.ID, x.GraphSHA)
	return err
}
func (r *Repository) DHFConditionalWithdraw(ctx context.Context, x ports.DHFConditionalWithdrawal) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO dhf_pilot_conditional_proposal_withdrawals
 (id,proposal_id,actor_id,reason) VALUES($1,$2,$3,$4)`,
		x.ID, x.ProposalID, x.ActorID, x.Reason)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO audit_events(actor_id,event_type,target_kind,
 target_id,request_id,outcome,details)
 VALUES($1,'dhf.pilot.conditional_proposal_withdrawn',
 'dhf_conditional_proposal',$2,$3,'withdrawn',
 jsonb_build_object('withdrawalId',$3::text,'formalAccepted',false))`,
		x.ActorID, x.ProposalID, x.ID)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'dhf.pilot.conditional_proposal_withdrawn',
 jsonb_build_object('proposalId',$2::text,'trialOnly',true,'formalAccepted',false))`,
		"dhf-conditional-withdraw:"+x.ID, x.ProposalID)
	return err
}
