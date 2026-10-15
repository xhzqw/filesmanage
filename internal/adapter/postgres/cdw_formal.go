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

// The binding is checked again while deciding, not just when a step is assigned.
// In particular, administrator status is never itself formal approval authority.
func (r *Repository) cdwFormalAuthority(ctx context.Context, actor, fileID string) (string, error) {
	var id string
	err := r.Q.QueryRow(ctx, `SELECT b.id FROM cdw_business_role_bindings b
 JOIN users u ON u.id=b.user_id WHERE b.user_id=$1 AND b.role='formal_approver'
 AND (b.file_id=$2 OR b.file_id IS NULL) AND b.department_id IS NULL
 AND b.valid_from<=now() AND (b.expires_at IS NULL OR b.expires_at>now())
 AND b.revoked_at IS NULL AND u.disabled_at IS NULL
 ORDER BY (b.file_id IS NOT NULL) DESC,b.id LIMIT 1 FOR SHARE OF b,u`, actor, fileID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrForbidden
	}
	return id, err
}

func (r *Repository) CDWPublishFormalTemplate(ctx context.Context, id, key string, steps []ports.CDWFormalStepDefinition, actor string) (string, error) {
	// A transaction-scoped advisory lock serializes version allocation for a key.
	if _, err := r.Q.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext($1))", key); err != nil {
		return "", err
	}
	var version int
	if err := r.Q.QueryRow(ctx, "SELECT COALESCE(MAX(version_no),0)+1 FROM cdw_workflow_template_versions WHERE template_key=$1", key).Scan(&version); err != nil {
		return "", err
	}
	graph, err := json.Marshal(map[string]any{"type": "formal_document", "steps": steps})
	if err != nil {
		return "", err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_workflow_template_versions
 (id,template_key,version_no,lifecycle,graph,role_policy,published_at,created_by)
 VALUES($1,$2,$3,'published',$4,'{"formalApproval":true}'::jsonb,now(),$5)`, id, key, version, graph, actor)
	return id, err
}
func (r *Repository) CDWGrantFormalApprover(ctx context.Context, id, userID, fileID, actor string) (string, error) {
	var existing string
	err := r.Q.QueryRow(ctx, `SELECT id FROM cdw_business_role_bindings
 WHERE user_id=$1 AND role='formal_approver' AND file_id=$2
 AND revoked_at IS NULL AND valid_from<=now()
 AND (expires_at IS NULL OR expires_at>now()) LIMIT 1 FOR UPDATE`, userID, fileID).Scan(&existing)
	if err == nil {
		return existing, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	tag, err := r.Q.Exec(ctx, `INSERT INTO cdw_business_role_bindings
 (id,user_id,role,file_id,granted_by) SELECT $1,u.id,'formal_approver',f.id,$4
 FROM users u CROSS JOIN files f WHERE u.id=$2 AND u.disabled_at IS NULL
 AND f.id=$3 AND f.deleted_at IS NULL`, id, userID, fileID, actor)
	if err != nil {
		return "", err
	}
	if tag.RowsAffected() != 1 {
		return "", domain.ErrInvalidInput
	}
	return id, nil
}
func (r *Repository) CDWFormalDeliveryFile(ctx context.Context, id string) (string, error) {
	var fileID string
	err := r.Q.QueryRow(ctx, `SELECT i.file_id FROM cdw_deliveries d JOIN cdw_delivery_items i
 ON i.delivery_id=d.id AND i.ordinal=1 WHERE d.id=$1`, id).Scan(&fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return fileID, err
}
func (r *Repository) CDWFormalApprovalFile(ctx context.Context, id string) (string, error) {
	var fileID string
	err := r.Q.QueryRow(ctx, `SELECT s.file_id FROM cdw_formal_approval_instances a
 JOIN cdw_approval_subjects s ON s.id=a.subject_id WHERE a.id=$1`, id).Scan(&fileID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return fileID, err
}

func (r *Repository) CDWStartFormalApproval(ctx context.Context, id, subjectID, deliveryID, templateID, actor, requestID string) (ports.CDWFormalApproval, error) {
	var result ports.CDWFormalApproval
	var fileID, blobID, hash, submittedBy string
	var size int64
	// This is a persisted, already-accepted ROOT task delivery; neither an
	// unacknowledged Office callback nor a subordinate gate can enter approval.
	err := r.Q.QueryRow(ctx, `SELECT i.file_id,i.blob_id,i.sha256,bl.size_bytes,d.submitted_by
 FROM cdw_deliveries d JOIN cdw_tasks t ON t.id=d.task_id
 JOIN cdw_review_gates g ON g.delivery_id=d.id
 JOIN cdw_delivery_items i ON i.delivery_id=d.id AND i.ordinal=1
 JOIN blobs bl ON bl.id=i.blob_id
 WHERE d.id=$1 AND t.id=t.root_id AND t.state='accepted_delivery'
 AND g.state IN('accepted','substituted') AND bl.state='ready' AND bl.sha256=i.sha256
 AND NOT EXISTS(SELECT 1 FROM cdw_tasks child WHERE child.root_id=t.id
 AND child.id<>t.id AND child.state NOT IN('accepted_delivery','closed'))`, deliveryID).Scan(&fileID, &blobID, &hash, &size, &submittedBy)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrConflict
	}
	if err != nil {
		return result, err
	}
	var lockedFile string
	if err = r.Q.QueryRow(ctx, "SELECT id FROM files WHERE id=$1 AND deleted_at IS NULL FOR UPDATE", fileID).Scan(&lockedFile); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return result, domain.ErrNotFound
		}
		return result, err
	}
	// A file-level lock also serializes two distinct idempotency keys for the
	// same delivery. Rejected submissions can be retried with a NEW instance.
	var duplicate bool
	err = r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM cdw_approval_subjects s
 JOIN cdw_formal_approval_instances a ON a.subject_id=s.id
 WHERE s.delivery_id=$1 AND (a.state='pending' OR EXISTS
 (SELECT 1 FROM cdw_approved_candidates ac WHERE ac.approval_instance_id=a.id)))`, deliveryID).Scan(&duplicate)
	if err != nil {
		return result, err
	}
	if duplicate {
		return result, domain.ErrConflict
	}
	var graph []byte
	err = r.Q.QueryRow(ctx, `SELECT graph FROM cdw_workflow_template_versions
 WHERE id=$1 AND lifecycle='published' AND graph->>'type'='formal_document'
 AND role_policy->>'formalApproval'='true'`, templateID).Scan(&graph)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrInvalidInput
	}
	if err != nil {
		return result, err
	}
	var template struct {
		Steps []ports.CDWFormalStepDefinition `json:"steps"`
	}
	if err = json.Unmarshal(graph, &template); err != nil {
		return result, domain.ErrInvalidInput
	}
	if len(template.Steps) < 1 || len(template.Steps) > 30 {
		return result, domain.ErrInvalidInput
	}
	// Fail closed if any designated approver lacks a current role on THIS file.
	// Distinct node keys permit parallel steps for the same principal.
	for _, step := range template.Steps {
		if step.Sequence < 1 || step.ApproverID == submittedBy {
			return result, domain.ErrForbidden
		}
		if _, err = r.cdwFormalAuthority(ctx, step.ApproverID, fileID); err != nil {
			return result, err
		}
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_approval_subjects
 (id,file_id,source_kind,delivery_id,blob_id,sha256,size_bytes,lineage_snapshot,frozen_by)
 VALUES($1,$2,'delivery',$3,$4,$5,$6,jsonb_build_object('deliveryId',$3::text,'blobId',$4::text,'requestId',$8::text),$7)`,
		subjectID, fileID, deliveryID, blobID, hash, size, actor, requestID)
	if err != nil {
		return result, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_formal_approval_instances
 (id,subject_id,template_version_id,state,requested_by) VALUES($1,$2,$3,'pending',$4)`, id, subjectID, templateID, actor)
	if err != nil {
		return result, err
	}
	minSeq := template.Steps[0].Sequence
	for _, step := range template.Steps {
		if step.Sequence < minSeq {
			minSeq = step.Sequence
		}
	}
	for _, step := range template.Steps {
		state := "waiting"
		if step.Sequence == minSeq {
			state = "ready"
		}
		tag, e := r.Q.Exec(ctx, `INSERT INTO cdw_formal_approval_steps
   (id,instance_id,node_key,sequence_no,approver_user_id,state,mandatory)
   VALUES($1,$2,$3,$4,$5,$6,true)`,
			"cdwstep_"+hashFormalID(id, step.NodeKey), id, step.NodeKey, step.Sequence, step.ApproverID, state)
		if e != nil {
			return result, e
		}
		if tag.RowsAffected() != 1 {
			return result, domain.ErrConflict
		}
	}
	return ports.CDWFormalApproval{ID: id, SubjectID: subjectID, DeliveryID: deliveryID, FileID: fileID,
		SHA256: hash, TemplateVersionID: templateID, State: "pending", Revision: 1, RequestedBy: actor}, nil
}
func hashFormalID(a, b string) string {
	h := sha256.Sum256([]byte(a + "|" + b))
	return hex.EncodeToString(h[:16])
}

func (r *Repository) CDWDecideFormalApproval(ctx context.Context, id, actor, decisionID string, expected int64, decision, reason, candidateID string) (ports.CDWFormalApproval, error) {
	var result ports.CDWFormalApproval
	var state, subjectID, templateID, fileID, hash, requester string
	var rev int64
	err := r.Q.QueryRow(ctx, `SELECT a.state,a.subject_id,a.template_version_id,s.file_id,s.sha256,a.requested_by,a.revision
 FROM cdw_formal_approval_instances a JOIN cdw_approval_subjects s ON s.id=a.subject_id
 WHERE a.id=$1 FOR UPDATE OF a`, id).Scan(&state, &subjectID, &templateID, &fileID, &hash, &requester, &rev)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrNotFound
	}
	if err != nil {
		return result, err
	}
	if expected != rev || state != "pending" {
		return result, domain.ErrVersionConflict
	}
	if actor == requester {
		return result, domain.ErrForbidden
	}
	binding, err := r.cdwFormalAuthority(ctx, actor, fileID)
	if err != nil {
		return result, err
	}
	var stepID string
	err = r.Q.QueryRow(ctx, `SELECT id FROM cdw_formal_approval_steps
 WHERE instance_id=$1 AND approver_user_id=$2 AND state='ready'
 ORDER BY sequence_no,node_key LIMIT 1 FOR UPDATE`, id, actor).Scan(&stepID)
	if errors.Is(err, pgx.ErrNoRows) {
		return result, domain.ErrForbidden
	}
	if err != nil {
		return result, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_formal_approval_decisions
 (id,step_id,actor_id,decision,reason,subject_sha256,actor_authority_snapshot)
 VALUES($1,$2,$3,$4,$5,$6,jsonb_build_object('role','formal_approver',
 'bindingId',$7::text,'actorId',$3::text,'approvedSubjectId',$8::text))`,
		decisionID, stepID, actor, decision, reason, hash, binding, subjectID)
	if err != nil {
		return result, err
	}
	stateStep := "approved"
	if decision == "reject" {
		stateStep = "rejected"
	}
	_, err = r.Q.Exec(ctx, `UPDATE cdw_formal_approval_steps
 SET state=$2,revision=revision+1 WHERE id=$1 AND state='ready'`, stepID, stateStep)
	if err != nil {
		return result, err
	}
	candidate := ""
	if decision == "reject" {
		state = "rejected"
		_, err = r.Q.Exec(ctx, `UPDATE cdw_formal_approval_steps SET state='skipped',revision=revision+1
   WHERE instance_id=$1 AND state IN('ready','waiting')`, id)
		if err != nil {
			return result, err
		}
	} else {
		var ready int
		if err = r.Q.QueryRow(ctx, `SELECT COUNT(*) FROM cdw_formal_approval_steps
   WHERE instance_id=$1 AND state='ready'`, id).Scan(&ready); err != nil {
			return result, err
		}
		if ready == 0 {
			var next *int
			if err = r.Q.QueryRow(ctx, `SELECT MIN(sequence_no) FROM cdw_formal_approval_steps
   WHERE instance_id=$1 AND state='waiting'`, id).Scan(&next); err != nil {
				return result, err
			}
			if next != nil {
				_, err = r.Q.Exec(ctx, `UPDATE cdw_formal_approval_steps SET state='ready',revision=revision+1
     WHERE instance_id=$1 AND sequence_no=$2 AND state='waiting'`, id, *next)
				if err != nil {
					return result, err
				}
			} else {
				state = "approved"
				candidate = candidateID
				_, err = r.Q.Exec(ctx, `INSERT INTO cdw_approved_candidates
    (id,subject_id,file_id,approval_instance_id,content_sha256)
    VALUES($1,$2,$3,$4,$5)`, candidate, subjectID, fileID, id, hash)
				if err != nil {
					return result, err
				}
			}
		}
	}
	_, err = r.Q.Exec(ctx, `UPDATE cdw_formal_approval_instances
 SET state=$2,revision=revision+1,completed_at=CASE WHEN $2='pending' THEN NULL ELSE now() END
 WHERE id=$1 AND revision=$3 AND state='pending'`, id, state, expected)
	if err != nil {
		return result, err
	}
	return ports.CDWFormalApproval{ID: id, SubjectID: subjectID, FileID: fileID, SHA256: hash, TemplateVersionID: templateID,
		State: state, Revision: rev + 1, CandidateID: candidate, RequestedBy: requester}, nil
}

func (r *Repository) CDWFormalReady(ctx context.Context, limit int) ([]ports.CDWFormalReadyDelivery, error) {
	rows, err := r.Q.Query(ctx, `SELECT d.id,t.id,f.id,f.name,i.sha256 FROM cdw_deliveries d
 JOIN cdw_tasks t ON t.id=d.task_id AND t.root_id=t.id
 JOIN cdw_review_gates g ON g.delivery_id=d.id
 JOIN cdw_delivery_items i ON i.delivery_id=d.id AND i.ordinal=1
 JOIN files f ON f.id=i.file_id
 JOIN blobs b ON b.id=i.blob_id
 WHERE t.state='accepted_delivery' AND g.state IN('accepted','substituted')
 AND f.deleted_at IS NULL AND b.state='ready' AND b.sha256=i.sha256
 AND NOT EXISTS(SELECT 1 FROM cdw_tasks child WHERE child.root_id=t.id
 AND child.id<>t.id AND child.state NOT IN('accepted_delivery','closed'))
 AND NOT EXISTS(SELECT 1 FROM cdw_approval_subjects s
 JOIN cdw_formal_approval_instances a ON a.subject_id=s.id
 WHERE s.delivery_id=d.id AND (a.state='pending' OR EXISTS
 (SELECT 1 FROM cdw_approved_candidates c WHERE c.approval_instance_id=a.id)))
 ORDER BY d.submitted_at DESC,d.id DESC LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []ports.CDWFormalReadyDelivery{}
	for rows.Next() {
		var d ports.CDWFormalReadyDelivery
		if e := rows.Scan(&d.DeliveryID, &d.TaskID, &d.FileID, &d.FileName, &d.SHA256); e != nil {
			return nil, e
		}
		result = append(result, d)
	}
	return result, rows.Err()
}

const cdwFormalApprovalSelect = `SELECT a.id,s.id,COALESCE(s.delivery_id,''),s.file_id,s.sha256,a.template_version_id,
 a.state,a.revision,COALESCE(c.id,''),a.requested_by,f.name
 FROM cdw_formal_approval_instances a JOIN cdw_approval_subjects s ON s.id=a.subject_id
 JOIN files f ON f.id=s.file_id
 LEFT JOIN cdw_approved_candidates c ON c.approval_instance_id=a.id`

func scanFormalApproval(row rowScanner) (ports.CDWFormalApproval, error) {
	var a ports.CDWFormalApproval
	err := row.Scan(&a.ID, &a.SubjectID, &a.DeliveryID, &a.FileID, &a.SHA256, &a.TemplateVersionID,
		&a.State, &a.Revision, &a.CandidateID, &a.RequestedBy, &a.FileName)
	return a, err
}
func (r *Repository) CDWFormalInbox(ctx context.Context, actor string, limit int) ([]ports.CDWFormalApproval, error) {
	rows, err := r.Q.Query(ctx, cdwFormalApprovalSelect+`
 WHERE a.state='pending' AND EXISTS (
 SELECT 1 FROM cdw_formal_approval_steps step
 JOIN cdw_business_role_bindings b ON b.user_id=step.approver_user_id
 JOIN users u ON u.id=b.user_id
 WHERE step.instance_id=a.id AND step.state='ready' AND step.approver_user_id=$1
 AND b.role='formal_approver' AND (b.file_id=s.file_id OR b.file_id IS NULL)
 AND b.department_id IS NULL AND b.revoked_at IS NULL AND b.valid_from<=now()
 AND (b.expires_at IS NULL OR b.expires_at>now()) AND u.disabled_at IS NULL)
 ORDER BY a.requested_at DESC,a.id DESC LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	list := []ports.CDWFormalApproval{}
	for rows.Next() {
		var a ports.CDWFormalApproval
		if err = rows.Scan(&a.ID, &a.SubjectID, &a.DeliveryID, &a.FileID, &a.SHA256, &a.TemplateVersionID,
			&a.State, &a.Revision, &a.CandidateID, &a.RequestedBy, &a.FileName); err != nil {
			return nil, err
		}
		list = append(list, a)
	}
	return list, rows.Err()
}
func (r *Repository) CDWFormalCanRead(ctx context.Context, id, actor string) (bool, error) {
	var allowed bool
	err := r.Q.QueryRow(ctx, `SELECT EXISTS(
 SELECT 1 FROM cdw_formal_approval_instances a
 JOIN cdw_approval_subjects s ON s.id=a.subject_id
 WHERE a.id=$1 AND (a.requested_by=$2 OR EXISTS(
 SELECT 1 FROM cdw_formal_approval_steps st WHERE st.instance_id=a.id AND st.approver_user_id=$2)
 OR EXISTS(SELECT 1 FROM cdw_business_role_bindings b WHERE b.user_id=$2 AND b.role='document_control'
 AND (b.file_id=s.file_id OR b.file_id IS NULL) AND b.revoked_at IS NULL
 AND b.valid_from<=now() AND (b.expires_at IS NULL OR b.expires_at>now()))))`, id, actor).Scan(&allowed)
	return allowed, err
}
func (r *Repository) CDWFormalDetail(ctx context.Context, id string) (ports.CDWFormalDetail, error) {
	var result ports.CDWFormalDetail
	a, err := scanFormalApproval(r.Q.QueryRow(ctx, cdwFormalApprovalSelect+" WHERE a.id=$1", id))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return result, domain.ErrNotFound
		}
		return result, err
	}
	result.Approval = a
	result.Steps = []ports.CDWFormalStep{}
	result.Decisions = []ports.CDWFormalDecision{}
	rows, err := r.Q.Query(ctx, `SELECT id,node_key,sequence_no,approver_user_id,state,revision
 FROM cdw_formal_approval_steps WHERE instance_id=$1 ORDER BY sequence_no,node_key`, id)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var step ports.CDWFormalStep
		if err = rows.Scan(&step.ID, &step.NodeKey, &step.Sequence, &step.ApproverID, &step.State, &step.Revision); err != nil {
			rows.Close()
			return result, err
		}
		result.Steps = append(result.Steps, step)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return result, err
	}
	decisions, err := r.Q.Query(ctx, `SELECT d.step_id,d.actor_id,d.decision,d.reason,d.decided_at
 FROM cdw_formal_approval_decisions d JOIN cdw_formal_approval_steps st ON st.id=d.step_id
 WHERE st.instance_id=$1 ORDER BY d.decided_at,d.id`, id)
	if err != nil {
		return result, err
	}
	defer decisions.Close()
	for decisions.Next() {
		var d ports.CDWFormalDecision
		var when time.Time
		if err = decisions.Scan(&d.StepID, &d.ActorID, &d.Decision, &d.Reason, &when); err != nil {
			return result, err
		}
		d.DecidedAt = when.UTC().Format(time.RFC3339Nano)
		result.Decisions = append(result.Decisions, d)
	}
	return result, decisions.Err()
}
func (r *Repository) CDWFormalBlobSource(ctx context.Context, id string) (ports.CDWBranchSource, error) {
	var src ports.CDWBranchSource
	err := r.Q.QueryRow(ctx, `SELECT b.storage_key,f.name,b.size_bytes FROM cdw_formal_approval_instances a
 JOIN cdw_approval_subjects s ON s.id=a.subject_id JOIN blobs b ON b.id=s.blob_id
 JOIN files f ON f.id=s.file_id WHERE a.id=$1 AND b.state='ready' AND b.sha256=s.sha256`, id).
		Scan(&src.StorageKey, &src.Name, &src.SizeBytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return src, domain.ErrNotFound
	}
	return src, err
}
func (r *Repository) CDWFormalEvent(ctx context.Context, actor, kind, id, requestID string, details map[string]any) error {
	payload, err := json.Marshal(details)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_domain_events
 (aggregate_kind,aggregate_id,event_kind,actor_id,request_id,details)
 VALUES('formal_approval',$1,$2,$3,$4,$5)`, id, kind, actor, requestID, string(payload))
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte("formal|" + actor + "|" + kind + "|" + id + "|" + requestID))
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'cdw.formal.changed',$2)`, "cdw_evt_"+hex.EncodeToString(digest[:]), string(payload))
	return err
}
