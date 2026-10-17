package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

const dhfTime = `to_char(%s AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"')`

func (r *Repository) DHFCreate(ctx context.Context, p ports.DHFProject, nodes []ports.DHFNode) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO dhf_projects(id,title,template_sha256,owner_id,reviewer_id) VALUES($1,$2,$3,$4,$5)`, p.ID, p.Title, p.TemplateSHA256, p.OwnerID, p.ReviewerID)
	if err != nil {
		return err
	}
	for _, node := range nodes {
		if node.Depth != 1 {
			continue
		}
		state := "locked"
		if node.StageNo == 1 {
			state = "open"
		}
		if _, err = r.Q.Exec(ctx, `INSERT INTO dhf_stages(project_id,stage_no,name,state) VALUES($1,$2,$3,$4)`, p.ID, node.StageNo, node.Title, state); err != nil {
			return err
		}
	}
	for _, node := range nodes {
		if node.Depth < 2 || node.IsGroup {
			continue
		}
		path, err := json.Marshal(node.ParentPath)
		if err != nil {
			return err
		}
		if _, err = r.Q.Exec(ctx, `INSERT INTO dhf_items(project_id,source_line,stage_no,parent_path,title) VALUES($1,$2,$3,$4,$5)`, p.ID, node.SourceLine, node.StageNo, path, node.Title); err != nil {
			return err
		}
	}
	return nil
}
func (r *Repository) DHFUserActive(ctx context.Context, id string) (bool, error) {
	var active bool
	err := r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND disabled_at IS NULL)`, id).Scan(&active)
	return active, err
}
func (r *Repository) DHFProjects(ctx context.Context, actor string) ([]ports.DHFProject, error) {
	rows, err := r.Q.Query(ctx, `SELECT p.id,p.title,p.owner_id,p.reviewer_id,p.template_sha256,p.revision,
 (SELECT count(*) FROM dhf_stages s WHERE s.project_id=p.id AND s.state='accepted'),
 `+fmt.Sprintf(dhfTime, "p.created_at")+` FROM dhf_projects p WHERE p.owner_id=$1 OR p.reviewer_id=$1 ORDER BY p.created_at DESC,p.id LIMIT 200`, actor)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.DHFProject{}
	for rows.Next() {
		var p ports.DHFProject
		if err = rows.Scan(&p.ID, &p.Title, &p.OwnerID, &p.ReviewerID, &p.TemplateSHA256, &p.Revision, &p.AcceptedStages, &p.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}
func (r *Repository) DHFProjectByID(ctx context.Context, id, actor string, lock bool) (ports.DHFProject, error) {
	var p ports.DHFProject
	sql := `SELECT id,title,owner_id,reviewer_id,template_sha256,revision,` +
		`(SELECT count(*) FROM dhf_stages s WHERE s.project_id=dhf_projects.id AND state='accepted'),` + fmt.Sprintf(dhfTime, "created_at") +
		` FROM dhf_projects WHERE id=$1 AND (owner_id=$2 OR reviewer_id=$2)`
	if lock {
		sql += ` FOR UPDATE`
	}
	err := r.Q.QueryRow(ctx, sql, id, actor).Scan(&p.ID, &p.Title, &p.OwnerID, &p.ReviewerID, &p.TemplateSHA256, &p.Revision, &p.AcceptedStages, &p.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return p, domain.ErrNotFound
	}
	return p, err
}
func (r *Repository) DHFDetail(ctx context.Context, id string) (ports.DHFDetail, error) {
	out := ports.DHFDetail{Stages: []ports.DHFStage{}, Items: []ports.DHFItem{}, Events: []ports.DHFEvent{}}
	rows, err := r.Q.Query(ctx, `SELECT stage_no,name,state,revision,COALESCE(accepted_by,''),
 COALESCE(`+fmt.Sprintf(dhfTime, "accepted_at")+`,''),COALESCE(baseline_sha256,'')
 FROM dhf_stages WHERE project_id=$1 ORDER BY stage_no`, id)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v ports.DHFStage
		if err = rows.Scan(&v.StageNo, &v.Name, &v.State, &v.Revision, &v.AcceptedBy, &v.AcceptedAt, &v.BaselineSHA256); err != nil {
			break
		}
		out.Stages = append(out.Stages, v)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = r.Q.Query(ctx, `SELECT source_line,stage_no,parent_path,title,state,applicability_reason,
 COALESCE(file_id,''),COALESCE(file_version_id,''),COALESCE(file_sha256,''),
 COALESCE(submitted_by,''),COALESCE(`+fmt.Sprintf(dhfTime, "submitted_at")+`,''),
 COALESCE(reviewed_by,''),COALESCE(`+fmt.Sprintf(dhfTime, "reviewed_at")+`,''),review_reason,revision
 FROM dhf_items WHERE project_id=$1 ORDER BY source_line`, id)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v ports.DHFItem
		var path []byte
		if err = rows.Scan(&v.SourceLine, &v.StageNo, &path, &v.Title, &v.State, &v.ApplicabilityReason,
			&v.FileID, &v.FileVersionID, &v.FileSHA256, &v.SubmittedBy, &v.SubmittedAt, &v.ReviewedBy, &v.ReviewedAt, &v.ReviewReason, &v.Revision); err != nil {
			break
		}
		if err = json.Unmarshal(path, &v.ParentPath); err != nil {
			break
		}
		out.Items = append(out.Items, v)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return out, err
	}
	rows, err = r.Q.Query(ctx, `SELECT id,COALESCE(stage_no,0),COALESCE(source_line,0),action,actor_id,event_sha256,previous_sha256,`+fmt.Sprintf(dhfTime, "occurred_at")+` FROM (SELECT * FROM dhf_events WHERE project_id=$1 ORDER BY id DESC LIMIT 200) e ORDER BY id DESC`, id)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var v ports.DHFEvent
		if err = rows.Scan(&v.ID, &v.StageNo, &v.SourceLine, &v.Action, &v.ActorID, &v.EventSHA256, &v.PreviousSHA256, &v.OccurredAt); err != nil {
			break
		}
		out.Events = append(out.Events, v)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	return out, err
}
func (r *Repository) DHFItemByLine(ctx context.Context, id string, line int) (ports.DHFItem, error) {
	var i ports.DHFItem
	var raw []byte
	err := r.Q.QueryRow(ctx, `SELECT source_line,stage_no,parent_path,title,state,applicability_reason,
 COALESCE(file_id,''),COALESCE(file_version_id,''),COALESCE(file_sha256,''),
 COALESCE(submitted_by,''),COALESCE(`+fmt.Sprintf(dhfTime, "submitted_at")+`,''),
 COALESCE(reviewed_by,''),COALESCE(`+fmt.Sprintf(dhfTime, "reviewed_at")+`,''),review_reason,revision
 FROM dhf_items WHERE project_id=$1 AND source_line=$2`, id, line).Scan(&i.SourceLine, &i.StageNo, &raw, &i.Title, &i.State, &i.ApplicabilityReason,
		&i.FileID, &i.FileVersionID, &i.FileSHA256, &i.SubmittedBy, &i.SubmittedAt, &i.ReviewedBy, &i.ReviewedAt, &i.ReviewReason, &i.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return i, domain.ErrNotFound
	}
	if err != nil {
		return i, err
	}
	err = json.Unmarshal(raw, &i.ParentPath)
	return i, err
}
func (r *Repository) DHFUpdateItem(ctx context.Context, id string, i ports.DHFItem, expected int64) error {
	var file, version, sha, submitter, reviewer any
	if i.FileID != "" {
		file, version, sha = i.FileID, i.FileVersionID, i.FileSHA256
	}
	if i.SubmittedBy != "" {
		submitter = i.SubmittedBy
	}
	if i.ReviewedBy != "" {
		reviewer = i.ReviewedBy
	}
	// Clock is always from server. Submitted/reviewed timestamps are set only on transitions.
	tag, err := r.Q.Exec(ctx, `UPDATE dhf_items SET state=$3,applicability_reason=$4,file_id=$5,file_version_id=$6,file_sha256=$7,
 submitted_by=$8,submitted_at=CASE WHEN $8::text IS NULL THEN NULL WHEN state NOT IN('submitted','accepted','returned') OR submitted_by IS DISTINCT FROM $8::text THEN clock_timestamp() ELSE submitted_at END,
 reviewed_by=$9,reviewed_at=CASE WHEN $9::text IS NULL THEN NULL ELSE clock_timestamp() END,review_reason=$10,revision=revision+1
 WHERE project_id=$1 AND source_line=$2 AND revision=$11`, id, i.SourceLine, i.State, i.ApplicabilityReason, file, version, sha, submitter, reviewer, i.ReviewReason, expected)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrVersionConflict
	}
	return nil
}
func (r *Repository) DHFFileVersion(ctx context.Context, file, version string) (string, error) {
	var sha string
	err := r.Q.QueryRow(ctx, `SELECT v.sha256 FROM file_versions v JOIN files f ON f.id=v.file_id AND f.deleted_at IS NULL WHERE v.file_id=$1 AND v.id=$2`, file, version).Scan(&sha)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", domain.ErrNotFound
	}
	return sha, err
}
func (r *Repository) DHFAcceptStage(ctx context.Context, id string, stage int, actor, digest string) error {
	var n int
	err := r.Q.QueryRow(ctx, `SELECT count(*) FROM dhf_items WHERE project_id=$1 AND stage_no=$2 AND state NOT IN('accepted','not_applicable')`, id, stage).Scan(&n)
	if err != nil {
		return err
	}
	if n != 0 {
		return domain.ErrConflict
	}
	tag, err := r.Q.Exec(ctx, `UPDATE dhf_stages SET state='accepted',revision=revision+1,accepted_by=$3,accepted_at=clock_timestamp(),baseline_sha256=$4 WHERE project_id=$1 AND stage_no=$2 AND state='open'`, id, stage, actor, digest)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrConflict
	}
	if stage < 9 {
		_, err = r.Q.Exec(ctx, `UPDATE dhf_stages SET state='open',revision=revision+1 WHERE project_id=$1 AND stage_no=$2 AND state='locked'`, id, stage+1)
	}
	return err
}
func (r *Repository) DHFClaim(ctx context.Context, actor, key, hash string) ([]byte, bool, error) {
	// Transaction-scoped lock serializes retries even across multiple Go servers.
	if _, err := r.Q.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, actor+":"+key); err != nil {
		return nil, false, err
	}
	var prior string
	var oldHash string
	err := r.Q.QueryRow(ctx, `SELECT request_sha256,response_json::text FROM dhf_operations WHERE actor_id=$1 AND request_key=$2`, actor, key).Scan(&oldHash, &prior)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if oldHash != hash {
		return nil, false, domain.ErrConflict
	}
	return []byte(prior), true, nil
}
func (r *Repository) DHFComplete(ctx context.Context, actor, key, hash string, response any) error {
	raw, err := json.Marshal(response)
	if err != nil {
		return err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO dhf_operations(actor_id,request_key,request_sha256,response_json) VALUES($1,$2,$3,$4)`, actor, key, hash, raw)
	return err
}
func (r *Repository) DHFAppendEvent(ctx context.Context, id string, stage, line int, action, actor string, value any) error {
	var prev string
	err := r.Q.QueryRow(ctx, `SELECT event_sha256 FROM dhf_events WHERE project_id=$1 ORDER BY id DESC LIMIT 1`, id).Scan(&prev)
	if errors.Is(err, pgx.ErrNoRows) {
		prev = "0000000000000000000000000000000000000000000000000000000000000000"
	} else if err != nil {
		return err
	}
	raw, err := json.Marshal(struct {
		Action string `json:"action"`
		Actor  string `json:"actor"`
		Stage  int    `json:"stage"`
		Line   int    `json:"line"`
		Value  any    `json:"value"`
	}{action, actor, stage, line, value})
	if err != nil {
		return err
	}
	digest := sha256.Sum256([]byte(prev + "\n" + string(raw)))
	_, err = r.Q.Exec(ctx, `INSERT INTO dhf_events(project_id,stage_no,source_line,action,actor_id,payload_text,previous_sha256,event_sha256)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, stage, line, action, actor, string(raw), prev, hex.EncodeToString(digest[:]))
	return err
}
func (r *Repository) DHFFileVersions(ctx context.Context, file string) ([]ports.DHFFileVersion, error) {
	rows, err := r.Q.Query(ctx, `SELECT v.id,v.seq,v.sha256 FROM file_versions v JOIN files f ON f.id=v.file_id AND f.deleted_at IS NULL WHERE v.file_id=$1 ORDER BY v.seq DESC LIMIT 200`, file)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.DHFFileVersion{}
	for rows.Next() {
		var v ports.DHFFileVersion
		if err = rows.Scan(&v.ID, &v.Seq, &v.SHA256); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

var _ ports.DHFStore = (*Repository)(nil)
