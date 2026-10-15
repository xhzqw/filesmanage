package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

const commentProjection = `SELECT c.id,c.file_id,c.version_seq,c.page_number,c.line_number,c.body,c.author_id,coalesce(u.display_name,''),
 c.created_at,c.resolved_at,coalesce(c.resolved_by,''),c.status,c.revision,coalesce(c.assignee_id,''),coalesce(assignee.display_name,''),
 c.resolution_note,c.resolved_version_seq,c.approval_note,c.approved_at,coalesce(resolver.display_name,'')
 FROM file_review_comments c LEFT JOIN users u ON u.id=c.author_id LEFT JOIN users assignee ON assignee.id=c.assignee_id
 LEFT JOIN users resolver ON resolver.id=c.resolved_by`

func scanComment(row rowScanner) (domain.FileReviewComment, error) {
	var c domain.FileReviewComment
	err := row.Scan(&c.ID, &c.FileID, &c.VersionSeq, &c.PageNumber, &c.LineNumber, &c.Body, &c.AuthorID, &c.AuthorName,
		&c.CreatedAt, &c.ResolvedAt, &c.ResolvedBy, &c.Status, &c.Revision, &c.AssigneeID, &c.AssigneeName,
		&c.ResolutionNote, &c.ResolvedVersionSeq, &c.ApprovalNote, &c.ApprovedAt, &c.ResolvedByName)
	c.CreatorID, c.CreatorName = c.AuthorID, c.AuthorName
	return c, err
}
func (r *Repository) ReviewComments(ctx context.Context, fileID string, version int, before int64, limit int) ([]domain.FileReviewComment, error) {
	rows, err := r.Q.Query(ctx, commentProjection+` WHERE c.file_id=$1 AND c.version_seq=$2 AND ($3::bigint=0 OR c.id<$3) ORDER BY c.id DESC LIMIT $4`, fileID, version, before, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.FileReviewComment, 0, limit)
	for rows.Next() {
		c, err := scanComment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
func (r *Repository) ReviewCommentsFiltered(ctx context.Context, fileID string, version int, before int64, limit int, actor, filter string) ([]domain.FileReviewComment, error) {
	rows, err := r.Q.Query(ctx, commentProjection+` WHERE c.file_id=$1 AND c.version_seq=$2
 AND ($3::bigint=0 OR c.id<$3)
 AND ($5='all' OR ($5='mine' AND c.assignee_id=$6 AND c.status IN ('assigned','rejected'))
  OR ($5='approval' AND c.author_id=$6 AND c.status='pending_approval')
  OR ($5='done' AND c.status IN ('approved','completed_self')))
 ORDER BY c.id DESC LIMIT $4`, fileID, version, before, limit, filter, actor)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.FileReviewComment, 0, limit)
	for rows.Next() {
		c, err := scanComment(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
func (r *Repository) ReviewCommentCounts(ctx context.Context, fileID string, version int, actor string) (domain.ReviewCommentCounts, error) {
	var c domain.ReviewCommentCounts
	err := r.Q.QueryRow(ctx, `SELECT count(*),
 count(*) FILTER (WHERE assignee_id=$3 AND status IN ('assigned','rejected')),
 count(*) FILTER (WHERE author_id=$3 AND status='pending_approval'),
 count(*) FILTER (WHERE status IN ('approved','completed_self'))
 FROM file_review_comments WHERE file_id=$1 AND version_seq=$2`, fileID, version, actor).
		Scan(&c.All, &c.Mine, &c.Approval, &c.Done)
	return c, err
}
func (r *Repository) ReviewCommentEvents(ctx context.Context, id int64) ([]domain.ReviewEvent, error) {
	rows, err := r.Q.Query(ctx, `SELECT e.id,e.actor_id,coalesce(actor.display_name,''),e.kind,e.status_before,e.status_after,
 coalesce(e.assignee_id,''),coalesce(assignee.display_name,''),coalesce(e.resolved_by,''),coalesce(resolver.display_name,''),
 e.resolution_note,e.resolved_version_seq,e.approval_note,e.created_at
 FROM file_review_events e
 LEFT JOIN users actor ON actor.id=e.actor_id
 LEFT JOIN users assignee ON assignee.id=e.assignee_id
 LEFT JOIN users resolver ON resolver.id=e.resolved_by
 WHERE e.review_id=$1 ORDER BY e.id ASC`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.ReviewEvent, 0)
	for rows.Next() {
		var e domain.ReviewEvent
		if err = rows.Scan(&e.ID, &e.ActorID, &e.ActorName, &e.Kind, &e.StatusBefore, &e.StatusAfter,
			&e.AssigneeID, &e.AssigneeName, &e.ResolvedBy, &e.ResolvedByName, &e.ResolutionNote, &e.ResolvedVersionSeq, &e.ApprovalNote, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
func (r *Repository) ReviewCommentByID(ctx context.Context, id int64) (domain.FileReviewComment, error) {
	c, err := scanComment(r.Q.QueryRow(ctx, commentProjection+` WHERE c.id=$1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return c, ports.ErrRowMissing
	}
	return c, err
}
func (r *Repository) InsertReviewComment(ctx context.Context, c domain.FileReviewComment) (domain.FileReviewComment, error) {
	var id int64
	err := r.Q.QueryRow(ctx, `INSERT INTO file_review_comments(file_id,version_seq,page_number,line_number,body,author_id,assignee_id,status)
 VALUES($1,$2,$3,$4,$5,$6,nullif($7,''),$8) RETURNING id`,
		c.FileID, c.VersionSeq, c.PageNumber, c.LineNumber, c.Body, c.AuthorID, c.AssigneeID, c.Status).Scan(&id)
	if err != nil {
		return c, err
	}
	return r.ReviewCommentByID(ctx, id)
}
func (r *Repository) ResolveReviewComment(ctx context.Context, id int64, actor string) (bool, error) {
	tag, err := r.Q.Exec(ctx, `UPDATE file_review_comments SET status='completed_self',resolved_at=now(),resolved_by=$2,revision=revision+1 WHERE id=$1 AND status='open'`, id, actor)
	return tag.RowsAffected() == 1, err
}

// revision CAS prevents simultaneous assignee submissions, approvals and reopens
// from silently overwriting one another.
func (r *Repository) UpdateReviewComment(ctx context.Context, c domain.FileReviewComment, expected int) (bool, error) {
	tag, err := r.Q.Exec(ctx, `UPDATE file_review_comments SET status=$2,assignee_id=nullif($3,''),resolution_note=$4,
 resolved_version_seq=$5,resolved_at=$6,resolved_by=nullif($7,''),approval_note=$8,approved_at=$9,revision=revision+1
 WHERE id=$1 AND revision=$10`, c.ID, c.Status, c.AssigneeID, c.ResolutionNote, c.ResolvedVersionSeq,
		c.ResolvedAt, c.ResolvedBy, c.ApprovalNote, c.ApprovedAt, expected)
	return tag.RowsAffected() == 1, err
}

func (r *Repository) RecordReviewTransition(ctx context.Context, c domain.FileReviewComment, previous domain.ReviewStatus, actor, kind, recipient string) error {
	var eventID int64
	note := c.ResolutionNote
	if kind == "approve" || kind == "reject" {
		note = c.ApprovalNote
	}
	err := r.Q.QueryRow(ctx, `INSERT INTO file_review_events(review_id,actor_id,kind,note,status_before,status_after,
 assignee_id,resolved_by,resolution_note,resolved_version_seq,approval_note)
 VALUES($1,$2,$3,$4,$5,$6,nullif($7,''),nullif($8,''),$9,$10,$11) RETURNING id`,
		c.ID, actor, kind, note, previous, c.Status, c.AssigneeID, c.ResolvedBy, c.ResolutionNote, c.ResolvedVersionSeq, c.ApprovalNote).Scan(&eventID)
	if err != nil {
		return err
	}
	if recipient != "" && recipient != actor {
		_, err = r.Q.Exec(ctx, `INSERT INTO file_review_notifications(event_id,recipient_id) VALUES($1,$2)`, eventID, recipient)
	}
	return err
}

func (r *Repository) ReviewNotifications(ctx context.Context, user string, limit int) ([]domain.ReviewNotification, int, error) {
	var unread int
	if err := r.Q.QueryRow(ctx, `SELECT count(*) FROM file_review_notifications WHERE recipient_id=$1 AND read_at IS NULL`, user).Scan(&unread); err != nil {
		return nil, 0, err
	}
	rows, err := r.Q.Query(ctx, `SELECT n.id,e.review_id,c.file_id,coalesce(f.name,''),e.kind,n.created_at,n.read_at IS NOT NULL
 FROM file_review_notifications n JOIN file_review_events e ON e.id=n.event_id
 JOIN file_review_comments c ON c.id=e.review_id JOIN files f ON f.id=c.file_id
 WHERE n.recipient_id=$1 ORDER BY n.id DESC LIMIT $2`, user, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]domain.ReviewNotification, 0)
	for rows.Next() {
		var n domain.ReviewNotification
		if err := rows.Scan(&n.ID, &n.ReviewID, &n.FileID, &n.FileName, &n.Kind, &n.CreatedAt, &n.Read); err != nil {
			return nil, 0, err
		}
		out = append(out, n)
	}
	return out, unread, rows.Err()
}

func (r *Repository) ReadReviewNotification(ctx context.Context, user string, id int64) (bool, error) {
	tag, err := r.Q.Exec(ctx, `UPDATE file_review_notifications SET read_at=now() WHERE id=$1 AND recipient_id=$2 AND read_at IS NULL`, id, user)
	return tag.RowsAffected() == 1, err
}
