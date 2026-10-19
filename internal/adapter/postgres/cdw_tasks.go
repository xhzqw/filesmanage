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
)

// All CDW writes operate on Repository.Q bound to the UnitOfWork transaction.
// No method starts or commits its own transaction.
func (r *Repository) CDWClaimOperation(ctx context.Context, actor, operation, key, hash string) (json.RawMessage, bool, error) {
	tag, err := r.Q.Exec(ctx, `INSERT INTO cdw_operation_results(actor_id,operation,request_key,request_sha256,state)
 VALUES($1,$2,$3,$4,'running') ON CONFLICT DO NOTHING`, actor, operation, key, hash)
	if err != nil {
		return nil, false, err
	}
	if tag.RowsAffected() == 1 {
		return nil, false, nil
	}
	var storedHash, state string
	var response []byte
	err = r.Q.QueryRow(ctx, `SELECT request_sha256,state,response FROM cdw_operation_results
 WHERE actor_id=$1 AND operation=$2 AND request_key=$3 FOR UPDATE`, actor, operation, key).Scan(&storedHash, &state, &response)
	if err != nil {
		return nil, false, err
	}
	if storedHash != hash {
		return nil, false, ports.ErrCDWIdempotencyReuse
	}
	if state != "done" || len(response) == 0 {
		return nil, false, domain.ErrConflict
	}
	return json.RawMessage(response), true, nil
}

func (r *Repository) CDWCompleteOperation(ctx context.Context, actor, operation, key string, status int, result ports.CDWTaskResult) error {
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	tag, err := r.Q.Exec(ctx, `UPDATE cdw_operation_results SET state='done',http_status=$4,response=$5
 WHERE actor_id=$1 AND operation=$2 AND request_key=$3 AND state='running'`, actor, operation, key, status, string(raw))
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrConflict
	}
	return nil
}

// Check the intended assignee inside the transaction, locking current
// identity/appointment rows against disablement or revocation.
func (r *Repository) CDWActiveRecipients(ctx context.Context, target ports.CDWAssignmentTarget) ([]string, error) {
	switch target.Kind {
	case "user":
		var id string
		err := r.Q.QueryRow(ctx, `SELECT id FROM users WHERE id=$1 AND disabled_at IS NULL FOR SHARE`, target.ID).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, domain.ErrForbidden
		}
		if err != nil {
			return nil, err
		}
		return []string{id}, nil
	case "workgroup":
		rows, err := r.Q.Query(ctx, `SELECT b.user_id FROM cdw_workgroup_role_bindings b
    JOIN users u ON u.id=b.user_id
    WHERE b.group_id=$1 AND b.role IN ('leader','deputy')
      AND b.valid_from<=now() AND (b.expires_at IS NULL OR b.expires_at>now())
      AND b.revoked_at IS NULL AND u.disabled_at IS NULL
    ORDER BY b.user_id FOR SHARE OF b,u`, target.ID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		ids := []string{}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				return nil, err
			}
			ids = append(ids, id)
		}
		if err = rows.Err(); err != nil {
			return nil, err
		}
		if len(ids) == 0 {
			return nil, domain.ErrForbidden
		}
		return ids, nil
	default:
		return nil, domain.ErrInvalidInput
	}
}

func (r *Repository) CDWTaskScope(ctx context.Context, id string) (string, string, string, error) {
	var fileID, rootID, templateID string
	err := r.Q.QueryRow(ctx, `SELECT file_id,root_id,template_version_id FROM cdw_tasks WHERE id=$1 AND subject_kind='file'`, id).Scan(&fileID, &rootID, &templateID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", "", "", domain.ErrNotFound
	}
	return fileID, rootID, templateID, err
}

// One file per task in this initial slice; manifest-based task creation remains
// disabled until the freeze/subset protocol is implemented.
func (r *Repository) CDWCreateRoot(ctx context.Context, cmd ports.CDWTaskCommand, actor string) (ports.CDWTaskResult, error) {
	if cmd.TemplateVersionID == "" {
		id := "cdw_template_single_file_v1"
		templateKey := "cdw-single-file-task"
		rolePolicy := `{"delegation":"accepted_assignee","formalApproval":false,"allowOverrideReview":false}`
		if cmd.AllowOverrideReview {
			id = "cdw_template_single_file_g6_override_v1"
			templateKey = "cdw-single-file-override-review"
			rolePolicy = `{"delegation":"accepted_assignee","formalApproval":false,"allowOverrideReview":true}`
		}
		_, err := r.Q.Exec(ctx, `INSERT INTO cdw_workflow_template_versions
		(id,template_key,version_no,lifecycle,graph,role_policy,published_at,created_by)
		VALUES($1,$3,1,'published',
		'{"type":"single_file","review":"direct_parent"}'::jsonb,
		$4::jsonb,now(),$2)
		ON CONFLICT DO NOTHING`, id, actor, templateKey, rolePolicy)
		if err != nil {
			return ports.CDWTaskResult{}, err
		}
		cmd.TemplateVersionID = id
	}
	tag, err := r.Q.Exec(ctx, `INSERT INTO cdw_tasks(id,root_id,template_version_id,title,subject_kind,file_id,state,created_by)
 SELECT $1,$1,id,$3,'file',$4,'assigned',$5
 FROM cdw_workflow_template_versions
 WHERE id=$2 AND lifecycle='published' AND role_policy->>'formalApproval' IS DISTINCT FROM 'true'`, cmd.TaskID, cmd.TemplateVersionID, cmd.Title, cmd.FileID, actor)
	if err != nil {
		return ports.CDWTaskResult{}, err
	}
	if tag.RowsAffected() != 1 {
		return ports.CDWTaskResult{}, domain.ErrInvalidInput
	}
	if err = r.cdwInsertAssignment(ctx, cmd, actor); err != nil {
		return ports.CDWTaskResult{}, err
	}
	return ports.CDWTaskResult{TaskID: cmd.TaskID, State: "assigned", Revision: 1, AssignmentID: cmd.AssignmentID}, nil
}

func (r *Repository) cdwInsertAssignment(ctx context.Context, cmd ports.CDWTaskCommand, actor string) error {
	var userID, groupID *string
	if cmd.Target.Kind == "user" {
		userID = &cmd.Target.ID
	} else {
		groupID = &cmd.Target.ID
	}
	_, err := r.Q.Exec(ctx, `INSERT INTO cdw_task_assignments
 (id,task_id,assigned_by,user_id,group_id,kind) VALUES($1,$2,$3,$4,$5,'primary')`,
		cmd.AssignmentID, cmd.TaskID, actor, userID, groupID)
	return err
}

func (r *Repository) CDWAccept(ctx context.Context, taskID, actor string, expected int64) (ports.CDWTaskResult, error) {
	var state, assignmentID string
	var rev int64
	err := r.Q.QueryRow(ctx, `SELECT state,revision FROM cdw_tasks WHERE id=$1 FOR UPDATE`, taskID).Scan(&state, &rev)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWTaskResult{}, domain.ErrNotFound
	}
	if err != nil {
		return ports.CDWTaskResult{}, err
	}
	if expected != rev || state != "assigned" {
		return ports.CDWTaskResult{}, domain.ErrVersionConflict
	}
	var who, group *string
	err = r.Q.QueryRow(ctx, `SELECT id,user_id,group_id FROM cdw_task_assignments
 WHERE task_id=$1 AND kind='primary' AND ended_at IS NULL AND accepted_at IS NULL FOR UPDATE`, taskID).
		Scan(&assignmentID, &who, &group)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWTaskResult{}, domain.ErrVersionConflict
	}
	if err != nil {
		return ports.CDWTaskResult{}, err
	}
	if who != nil {
		if *who != actor {
			return ports.CDWTaskResult{}, domain.ErrForbidden
		}
	} else if group != nil {
		eligible, e := r.CDWActiveRecipients(ctx, ports.CDWAssignmentTarget{Kind: "workgroup", ID: *group})
		if e != nil {
			return ports.CDWTaskResult{}, e
		}
		allowed := false
		for _, id := range eligible {
			if id == actor {
				allowed = true
				break
			}
		}
		if !allowed {
			return ports.CDWTaskResult{}, domain.ErrForbidden
		}
	} else {
		return ports.CDWTaskResult{}, domain.ErrForbidden
	}
	// The authenticated principal must still be active in the database.
	if _, e := r.CDWActiveRecipients(ctx, ports.CDWAssignmentTarget{Kind: "user", ID: actor}); e != nil {
		return ports.CDWTaskResult{}, e
	}
	if _, err = r.Q.Exec(ctx, `UPDATE cdw_task_assignments
 SET accepted_by=$2,accepted_at=now() WHERE id=$1`, assignmentID, actor); err != nil {
		return ports.CDWTaskResult{}, err
	}
	if _, err = r.Q.Exec(ctx, `UPDATE cdw_tasks SET state='accepted',revision=revision+1 WHERE id=$1`, taskID); err != nil {
		return ports.CDWTaskResult{}, err
	}
	return ports.CDWTaskResult{TaskID: taskID, State: "accepted", Revision: rev + 1, AcceptedBy: actor, AssignmentID: assignmentID}, nil
}

func (r *Repository) CDWDelegate(ctx context.Context, parentID, actor string, expected int64, cmd ports.CDWTaskCommand, obligationIDs [3]string) (ports.CDWTaskResult, error) {
	var rootID string
	err := r.Q.QueryRow(ctx, `SELECT root_id FROM cdw_tasks WHERE id=$1`, parentID).Scan(&rootID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWTaskResult{}, domain.ErrNotFound
	}
	if err != nil {
		return ports.CDWTaskResult{}, err
	}
	// Root first, then the parent. A newly inserted child only references this
	// fixed root; no operation rewires an existing parent.
	if _, err = r.Q.Exec(ctx, `SELECT id FROM cdw_tasks WHERE id=$1 FOR UPDATE`, rootID); err != nil {
		return ports.CDWTaskResult{}, err
	}
	var state, fileID, templateID string
	var rev int64
	err = r.Q.QueryRow(ctx, `SELECT state,file_id,template_version_id,revision
 FROM cdw_tasks WHERE id=$1 FOR UPDATE`, parentID).Scan(&state, &fileID, &templateID, &rev)
	if err != nil {
		return ports.CDWTaskResult{}, err
	}
	if expected != rev || (state != "accepted" && state != "in_progress") {
		return ports.CDWTaskResult{}, domain.ErrVersionConflict
	}
	var assignmentID, acceptedBy string
	var groupID *string
	err = r.Q.QueryRow(ctx, `SELECT id,accepted_by,group_id FROM cdw_task_assignments
 WHERE task_id=$1 AND kind='primary' AND ended_at IS NULL AND accepted_by=$2 AND accepted_at IS NOT NULL FOR UPDATE`, parentID, actor).
		Scan(&assignmentID, &acceptedBy, &groupID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.CDWTaskResult{}, domain.ErrForbidden
	}
	if err != nil {
		return ports.CDWTaskResult{}, err
	}
	if groupID != nil {
		eligible, e := r.CDWActiveRecipients(ctx, ports.CDWAssignmentTarget{Kind: "workgroup", ID: *groupID})
		if e != nil {
			return ports.CDWTaskResult{}, e
		}
		allowed := false
		for _, id := range eligible {
			if id == actor {
				allowed = true
				break
			}
		}
		if !allowed {
			return ports.CDWTaskResult{}, domain.ErrForbidden
		}
	}
	if fileID != cmd.FileID || templateID != cmd.TemplateVersionID || rootID != cmd.RootID {
		return ports.CDWTaskResult{}, domain.ErrInvalidInput
	}
	tag, err := r.Q.Exec(ctx, `INSERT INTO cdw_tasks
 (id,root_id,parent_id,template_version_id,title,subject_kind,file_id,state,created_by)
 VALUES($1,$2,$3,$4,$5,'file',$6,'assigned',$7)`, cmd.TaskID, rootID, parentID, templateID, cmd.Title, fileID, actor)
	if err != nil {
		return ports.CDWTaskResult{}, err
	}
	if tag.RowsAffected() != 1 {
		return ports.CDWTaskResult{}, domain.ErrConflict
	}
	if err = r.cdwInsertAssignment(ctx, cmd, actor); err != nil {
		return ports.CDWTaskResult{}, err
	}
	for i, kind := range []string{"manage", "integrate", "report"} {
		if _, err = r.Q.Exec(ctx, `INSERT INTO cdw_accountability_obligations
   (id,task_id,responsible_user_id,assignment_id,obligation_kind,state)
   VALUES($1,$2,$3,$4,$5,'pending')`, obligationIDs[i], cmd.TaskID, actor, assignmentID, kind); err != nil {
			return ports.CDWTaskResult{}, err
		}
	}
	if _, err = r.Q.Exec(ctx, `UPDATE cdw_tasks SET revision=revision+1 WHERE id=$1`, parentID); err != nil {
		return ports.CDWTaskResult{}, err
	}
	return ports.CDWTaskResult{TaskID: cmd.TaskID, ParentTaskID: parentID, ParentRevision: rev + 1, State: "assigned", Revision: 1, AssignmentID: cmd.AssignmentID, RemainingObligations: obligationIDs[:]}, nil
}

// Inbox ownership is derived from the live assignment or obligation; nothing
// in cdw_tasks acts as a second "current assignee" source of truth.
func (r *Repository) CDWInbox(ctx context.Context, actor string, limit int) ([]ports.CDWInboxItem, error) {
	rows, err := r.Q.Query(ctx, `SELECT kind,task_id,title,file_id,state,revision,assignment_id,obligation_id,obligation_kind
 FROM (
  SELECT 'task'::text AS kind,t.id AS task_id,t.title,t.file_id,t.state,t.revision,
    a.id AS assignment_id,NULL::text AS obligation_id,NULL::text AS obligation_kind,t.created_at AS time_key
  FROM cdw_task_assignments a JOIN cdw_tasks t ON t.id=a.task_id
  WHERE a.kind='primary' AND a.ended_at IS NULL AND t.state NOT IN ('closed','cancelled')
    AND (a.user_id=$1 OR (a.group_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM cdw_workgroup_role_bindings b
      WHERE b.group_id=a.group_id AND b.user_id=$1 AND b.role IN ('leader','deputy')
       AND b.revoked_at IS NULL AND b.valid_from<=now()
       AND (b.expires_at IS NULL OR b.expires_at>now()))))
  UNION ALL
  SELECT 'obligation',t.id,t.title,t.file_id,o.state,o.revision,NULL::text,o.id,o.obligation_kind,t.created_at
  FROM cdw_accountability_obligations o JOIN cdw_tasks t ON t.id=o.task_id
  WHERE o.responsible_user_id=$1 AND o.state='pending'
 ) items ORDER BY time_key DESC,task_id,kind LIMIT $2`, actor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ports.CDWInboxItem{}
	for rows.Next() {
		var item ports.CDWInboxItem
		var assignment, obligation, kind *string
		if err = rows.Scan(&item.Kind, &item.TaskID, &item.Title, &item.FileID, &item.State, &item.Revision, &assignment, &obligation, &kind); err != nil {
			return nil, err
		}
		if assignment != nil {
			item.AssignmentID = *assignment
		}
		if obligation != nil {
			item.ObligationID = *obligation
		}
		if kind != nil {
			item.ObligationKind = *kind
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// An author-scoped, stable keyset of actual CDW tasks, including completed,
// cancelled and delegated tasks. Never join in another author's assignments.
func (r *Repository) CDWInitiated(ctx context.Context, actor string, limit int, cursor string) ([]ports.CDWInitiatedItem, error) {
	rows, err := r.Q.Query(ctx, `SELECT t.id,t.root_id,COALESCE(t.parent_id,''),t.title,t.file_id,t.state,
 t.revision,t.created_at,COALESCE(u.display_name,w.name,'')
 FROM cdw_tasks t
 LEFT JOIN cdw_tasks anchor ON anchor.id=$3 AND anchor.created_by=$1
 LEFT JOIN cdw_task_assignments a ON a.task_id=t.id AND a.kind='primary' AND a.ended_at IS NULL
 LEFT JOIN users u ON u.id=a.user_id
 LEFT JOIN workgroups w ON w.id=a.group_id
 WHERE t.created_by=$1 AND ($3='' OR (anchor.id IS NOT NULL AND
 (t.created_at,t.id)<(anchor.created_at,anchor.id)))
 ORDER BY t.created_at DESC,t.id DESC LIMIT $2`, actor, limit, cursor)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []ports.CDWInitiatedItem{}
	for rows.Next() {
		var item ports.CDWInitiatedItem
		if err = rows.Scan(&item.TaskID, &item.RootID, &item.ParentID, &item.Title, &item.FileID,
			&item.State, &item.Revision, &item.CreatedAt, &item.AssigneeName); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *Repository) CDWEvent(ctx context.Context, actor, eventType, taskID, requestID string, result ports.CDWTaskResult) error {
	if len(requestID) == 0 {
		return domain.ErrInvalidInput
	}
	raw, err := json.Marshal(result)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO cdw_domain_events(aggregate_kind,aggregate_id,event_kind,actor_id,request_id,details)
 VALUES('task',$1,$2,$3,$4,$5)`, taskID, eventType, actor, requestID, raw)
	if err != nil {
		return err
	}
	// Durable outbox is atomically queued, never interpreted as the audit log.
	identity := sha256.Sum256([]byte(actor + "|" + eventType + "|" + taskID + "|" + requestID))
	_, err = r.Q.Exec(ctx, `INSERT INTO outbox_jobs(id,kind,payload)
 VALUES($1,'cdw.task.changed',$2)`, "cdw_evt_"+hex.EncodeToString(identity[:]), raw)
	return err
}
