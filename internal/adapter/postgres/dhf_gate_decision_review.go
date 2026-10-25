package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/ports"

	"github.com/jackc/pgx/v5"
)

var _ ports.DHFGateDecisionReviewStore = (*Repository)(nil)

// Scope is derived exclusively from the live, independently approved pilot
// delegation; not from the user's general role or a client-controlled project.
const dhfDecisionReviewScope = `
 FROM dhf_pilot_stage_gate_review_intents r
 JOIN dhf_pilot_submissions sub ON sub.id=r.submission_id
 JOIN dhf_pilot_projects project ON project.id=r.project_id AND project.state='active'
 JOIN dhf_pilot_baselines base ON base.project_id=r.project_id
   AND base.stage_id=r.stage_id AND base.active AND base.template_id=r.template_id
 JOIN dhf_pilot_templates tpl ON tpl.id=r.template_id
   AND tpl.status='published' AND tpl.policy_sha=r.policy_sha
 JOIN dhf_pilot_gate_decision_reviewer_grants g
  ON g.project_id=r.project_id AND g.stage_id=r.stage_id AND g.reviewer_id=$1
  AND g.trial_only AND g.approved_by<>$1 AND g.approved_by<>r.signer_id
  AND g.approved_by<>sub.submitted_by
  AND now()>=g.valid_from AND now()<g.expires_at
 JOIN users u ON u.id=$1 AND u.disabled_at IS NULL AND NOT u.must_change_password
 JOIN users approver ON approver.id=g.approved_by AND approver.disabled_at IS NULL
 JOIN dhf_pilot_members m ON m.project_id=r.project_id AND m.user_id=$1
 LEFT JOIN dhf_pilot_gate_decision_reviewer_revocations revoke ON revoke.grant_id=g.id
 WHERE r.state='awaiting_enterprise_authority' AND r.mode='strict'
  AND r.trial_only AND r.project_graph_sha IS NOT NULL
  AND r.signer_id<>$1 AND sub.submitted_by<>$1 AND revoke.id IS NULL
 `

func (r *Repository) DHFGateDecisionReviewInbox(ctx context.Context, actorID string) ([]ports.DHFGateDecisionReviewItem, error) {
	rows, err := r.Q.Query(ctx, `SELECT DISTINCT ON(r.id)
 r.id,r.submission_id,r.project_id,r.stage_id,r.signer_id,
 r.gate_candidate_id,r.candidate_payload_sha,r.project_graph_sha,g.id
`+dhfDecisionReviewScope+`
 ORDER BY r.id,g.expires_at DESC LIMIT 100`, actorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ports.DHFGateDecisionReviewItem{}
	for rows.Next() {
		var item ports.DHFGateDecisionReviewItem
		if err = rows.Scan(&item.ReviewID, &item.SubmissionID, &item.ProjectID, &item.StageID,
			&item.GateSignerID, &item.CandidateID, &item.CandidatePayloadSHA,
			&item.ProjectGraphSHA, &item.GrantID); err != nil {
			return nil, err
		}
		item.TrialOnly = true
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	// Separate query after rows.Close: the existing pgx connection may only
	// process one query at a time within the same serialized transaction.
	rows.Close()
	for idx := range items {
		opinion, e := r.DHFGateDecisionReviewOpinionByReview(ctx, items[idx].ReviewID)
		if e == nil {
			items[idx].Opinion = &opinion
		} else if !errors.Is(e, ports.ErrRowMissing) {
			return nil, e
		}
	}
	return items, nil
}
func (r *Repository) DHFGateDecisionReviewByID(ctx context.Context, reviewID, actorID string) (ports.DHFGateDecisionReviewItem, error) {
	var item ports.DHFGateDecisionReviewItem
	err := r.Q.QueryRow(ctx, `SELECT r.id,r.submission_id,r.project_id,r.stage_id,r.signer_id,
 r.gate_candidate_id,r.candidate_payload_sha,r.project_graph_sha,g.id
`+dhfDecisionReviewScope+` AND r.id=$2
 ORDER BY g.expires_at DESC LIMIT 1`, actorID, reviewID).
		Scan(&item.ReviewID, &item.SubmissionID, &item.ProjectID, &item.StageID,
			&item.GateSignerID, &item.CandidateID, &item.CandidatePayloadSHA,
			&item.ProjectGraphSHA, &item.GrantID)
	if errors.Is(err, pgx.ErrNoRows) {
		return item, ports.ErrRowMissing
	}
	if err != nil {
		return item, err
	}
	item.TrialOnly = true
	return item, nil
}
func (r *Repository) DHFGateDecisionReviewOpinionByReview(ctx context.Context, reviewID string) (ports.DHFGateDecisionReviewOpinion, error) {
	var x ports.DHFGateDecisionReviewOpinion
	err := r.Q.QueryRow(ctx, `SELECT id,review_id,grant_id,reviewer_id,opinion,reason,
 source_graph_sha,source_candidate_sha,idempotency_key,request_sha,trial_only
 FROM dhf_pilot_gate_decision_review_opinions WHERE review_id=$1`, reviewID).
		Scan(&x.ID, &x.ReviewID, &x.GrantID, &x.ReviewerID, &x.Opinion,
			&x.Reason, &x.SourceGraphSHA, &x.SourceCandidateSHA, &x.IdempotencyKey,
			&x.RequestSHA, &x.TrialOnly)
	if errors.Is(err, pgx.ErrNoRows) {
		return x, ports.ErrRowMissing
	}
	return x, err
}
func (r *Repository) DHFGateDecisionReviewPersistOpinion(ctx context.Context, x ports.DHFGateDecisionReviewOpinion) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO dhf_pilot_gate_decision_review_opinions
(id,review_id,grant_id,reviewer_id,opinion,reason,source_graph_sha,
 source_candidate_sha,idempotency_key,request_sha)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
		x.ID, x.ReviewID, x.GrantID, x.ReviewerID, x.Opinion, x.Reason,
		x.SourceGraphSHA, x.SourceCandidateSHA, x.IdempotencyKey, x.RequestSHA)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO audit_events(
 actor_id,event_type,target_kind,target_id,request_id,outcome,details)
VALUES($1,'dhf.pilot.gate.decision_review_recommended',
 'dhf_gate_decision_review',$2,$3,'recommendation_only',
 jsonb_build_object('reviewId',$4::text,'graphSha',$5::text,
 'opinion',$6::text,'formalAccepted',false))`,
		x.ReviewerID, x.ID, x.IdempotencyKey, x.ReviewID, x.SourceGraphSHA, x.Opinion)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
VALUES($1,'dhf.pilot.gate.decision_review_recommended',
 jsonb_build_object('opinionId',$2::text,'reviewId',$3::text,
 'trialOnly',true,'formalAccepted',false))`,
		"dhf-gate-decision-review:"+x.ID, x.ID, x.ReviewID)
	return err
}
