package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
	"time"
)

var _ ports.DHFPilotGateHistoryStore = (*Repository)(nil)

// The Gate reviewer must still have an active account and project membership.
// An admin flag is never a substitute for the assigned Gate identity.
func (r *Repository) DHFPilotGateHistoryForSigner(ctx context.Context, submissionID, signerID, activeTrustKeySHA string) (ports.DHFPilotGateHistory, error) {
	var item ports.DHFPilotGateHistory
	if submissionID == "" || signerID == "" {
		return item, ports.ErrRowMissing
	}
	err := r.Q.QueryRow(ctx, `
SELECT s.id,s.project_id,s.stage_id
FROM dhf_pilot_submissions s
JOIN dhf_pilot_workbench_tasks gate
 ON gate.submission_id=s.id AND gate.review_key='__gate__'
 AND gate.reviewer_id=$2
JOIN dhf_pilot_members member ON member.project_id=s.project_id AND member.user_id=$2
JOIN users signer ON signer.id=$2 AND signer.disabled_at IS NULL
WHERE s.id=$1 AND s.submitted_by<>$2`, submissionID, signerID).
		Scan(&item.SubmissionID, &item.ProjectID, &item.StageID)
	if errors.Is(err, pgx.ErrNoRows) {
		return item, ports.ErrRowMissing
	}
	if err != nil {
		return item, err
	}

	err = r.Q.QueryRow(ctx, `
SELECT
 (SELECT count(*) FROM dhf_pilot_review_obligations o WHERE o.submission_id=$1),
 (SELECT count(*) FROM dhf_pilot_review_obligations o
  JOIN dhf_pilot_workbench_tasks t ON t.id=o.task_id
  JOIN dhf_pilot_review_decisions d ON d.task_id=t.id AND d.outcome='recommend_pass'
  JOIN dhf_pilot_review_attestations a ON a.task_id=t.id AND a.review_decision_id=d.id
   AND a.outcome='recommend_pass' AND a.signer_id=t.reviewer_id
  JOIN dhf_pilot_submissions s ON s.id=o.submission_id
  WHERE o.submission_id=$1 AND a.policy_sha=s.policy_sha AND a.manifest_sha=s.manifest_sha
   AND t.status='reviewed'),
 (SELECT count(*) FROM dhf_pilot_remediation_cases c
  LEFT JOIN dhf_pilot_remediation_verifications v ON v.case_id=c.id
  WHERE c.project_id=$2 AND c.stage_id=$3 AND v.id IS NULL)
`, submissionID, item.ProjectID, item.StageID).
		Scan(&item.TotalDuties, &item.SignedPassedDuties, &item.OpenRemediations)
	if err != nil {
		return item, err
	}

	record, err := r.DHFPilotExistingGateCandidate(ctx, submissionID)
	if err == nil {
		item.Candidate = &record
	} else if !errors.Is(err, ports.ErrRowMissing) {
		return item, err
	}
	// Historical V1 candidates have no registered credential; retain their
	// verifier and never synthesize a corporate authorization retroactively.
	if item.Candidate != nil && item.Candidate.SigningCredentialID == "" {
		item.CredentialStatus = "legacy_unbound"
		return item, nil
	}
	credentialID := ""
	if item.Candidate != nil {
		credentialID = item.Candidate.SigningCredentialID
	}
	if credentialID == "" && activeTrustKeySHA == "" {
		item.CredentialStatus = "trust_anchor_missing"
		return item, nil
	}
	var state string
	var keyExpiresAt time.Time
	// Current status describes whether this credential could sign NOW.
	// It is not used to rewrite whether an older signature verifies.
	err = r.Q.QueryRow(ctx, `
SELECT CASE
 WHEN latest.event_kind IN ('revoke','replace') THEN latest.event_kind
 WHEN transaction_timestamp()<c.valid_from THEN 'not_yet_valid'
 WHEN transaction_timestamp()>=c.expires_at THEN 'expired'
 ELSE COALESCE(latest.event_kind,'unactivated') END,c.expires_at
FROM dhf_pilot_signing_credentials c
LEFT JOIN LATERAL (
 SELECT event_kind FROM dhf_pilot_signing_credential_events e
 WHERE e.credential_id=c.id ORDER BY e.event_seq DESC LIMIT 1
) latest ON true
WHERE ($2<>'' AND c.id=$2 AND c.signer_id=$1)
   OR ($2='' AND c.signer_id=$1 AND c.key_sha=$3 AND c.purpose='dhf.pilot.gate.candidate')
ORDER BY CASE WHEN c.id=$2 THEN 0 ELSE 1 END,c.registered_at DESC LIMIT 1
`, signerID, credentialID, activeTrustKeySHA).Scan(&state, &keyExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		item.CredentialStatus = "unregistered"
		return item, nil
	}
	if err != nil {
		return item, err
	}
	item.CredentialStatus = state
	// The state timestamp is an ordinary database observation, not a TSA.
	item.CredentialExpiresAt = &keyExpiresAt
	return item, nil
}
