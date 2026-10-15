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
 c.resolution_note,c.resolved_version_seq,c.approval_note,c.approved_at
 FROM file_review_comments c LEFT JOIN users u ON u.id=c.author_id LEFT JOIN users assignee ON assignee.id=c.assignee_id`

func scanComment(row rowScanner) (domain.FileReviewComment, error) {
	var c domain.FileReviewComment
	err := row.Scan(&c.ID, &c.FileID, &c.VersionSeq, &c.PageNumber, &c.LineNumber, &c.Body, &c.AuthorID, &c.AuthorName,
		&c.CreatedAt, &c.ResolvedAt, &c.ResolvedBy, &c.Status, &c.Revision, &c.AssigneeID, &c.AssigneeName,
		&c.ResolutionNote, &c.ResolvedVersionSeq, &c.ApprovalNote, &c.ApprovedAt)
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

func (r *Repository) RecordReviewTransition(ctx context.Context, id int64, actor, kind, note, recipient string) error {
	var eventID int64
	err := r.Q.QueryRow(ctx, `INSERT INTO file_review_events(review_id,actor_id,kind,note) VALUES($1,$2,$3,$4) RETURNING id`, id, actor, kind, note).Scan(&eventID)
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
