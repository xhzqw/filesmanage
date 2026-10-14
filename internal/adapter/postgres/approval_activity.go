package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

func (r *Repository) RecordApprovalEvent(ctx context.Context, e domain.ApprovalEvent, recipients []string) error {
	var eventID int64
	err := r.Q.QueryRow(ctx, `INSERT INTO approval_events(approval_id,actor_id,kind,step_index,comment)
 VALUES($1,$2,$3,$4,$5) RETURNING id`, e.ApprovalID, e.ActorID, e.Kind, e.StepIndex, e.Comment).Scan(&eventID)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, id := range recipients {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		_, err = r.Q.Exec(ctx, `INSERT INTO approval_notifications(event_id,approval_id,recipient_id)
   VALUES($1,$2,$3)`, eventID, e.ApprovalID, id)
		if err != nil {
			return err
		}
	}
	return nil
}
func (r *Repository) ListApprovalEvents(ctx context.Context, approvalID string) ([]domain.ApprovalEvent, error) {
	rows, err := r.Q.Query(ctx, `SELECT e.id,e.approval_id,e.actor_id,coalesce(u.display_name,''),e.kind,e.step_index,e.comment,e.created_at
 FROM approval_events e LEFT JOIN users u ON u.id=e.actor_id
 WHERE e.approval_id=$1 ORDER BY e.id LIMIT 200`, approvalID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]domain.ApprovalEvent, 0)
	for rows.Next() {
		var e domain.ApprovalEvent
		if err = rows.Scan(&e.ID, &e.ApprovalID, &e.ActorID, &e.ActorName, &e.Kind, &e.StepIndex, &e.Comment, &e.CreatedAt); err != nil {
			return nil, err
		}
		result = append(result, e)
	}
	return result, rows.Err()
}
func (r *Repository) ListApprovalNotifications(ctx context.Context, userID string) ([]domain.ApprovalNotification, error) {
	rows, err := r.Q.Query(ctx, `SELECT n.id,n.approval_id,coalesce(nullif(a.file_name_snapshot,''),f.name,''),e.kind,e.step_index,n.created_at,n.read_at IS NOT NULL
 FROM approval_notifications n JOIN approval_events e ON e.id=n.event_id
 JOIN approvals a ON a.id=n.approval_id LEFT JOIN files f ON f.id=a.file_id
 WHERE n.recipient_id=$1 ORDER BY n.id DESC LIMIT 100`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.ApprovalNotification, 0)
	for rows.Next() {
		var n domain.ApprovalNotification
		if err = rows.Scan(&n.ID, &n.ApprovalID, &n.FileName, &n.Kind, &n.StepIndex, &n.CreatedAt, &n.Read); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}
func (r *Repository) ListApprovalNotificationPage(ctx context.Context, userID string, before int64, limit int) ([]domain.ApprovalNotification,error) {
	rows,err:=r.Q.Query(ctx,`SELECT n.id,n.approval_id,coalesce(nullif(a.file_name_snapshot,''),f.name,''),e.kind,e.step_index,n.created_at,n.read_at IS NOT NULL
 FROM approval_notifications n JOIN approval_events e ON e.id=n.event_id
 JOIN approvals a ON a.id=n.approval_id LEFT JOIN files f ON f.id=a.file_id
 WHERE n.recipient_id=$1 AND ($2::bigint=0 OR n.id<$2) ORDER BY n.id DESC LIMIT $3`,userID,before,limit)
	if err!=nil{return nil,err}
	defer rows.Close()
	out:=make([]domain.ApprovalNotification,0)
	for rows.Next(){
		var n domain.ApprovalNotification
		if err=rows.Scan(&n.ID,&n.ApprovalID,&n.FileName,&n.Kind,&n.StepIndex,&n.CreatedAt,&n.Read);err!=nil{return nil,err}
		out=append(out,n)
	}
	return out,rows.Err()
}

func (r *Repository) CountUnreadApprovalNotifications(ctx context.Context,userID string)(int,error){
	var count int
	err:=r.Q.QueryRow(ctx,"SELECT count(*) FROM approval_notifications WHERE recipient_id=$1 AND read_at IS NULL",userID).Scan(&count)
	return count,err
}

func (r *Repository) ReadApprovalNotification(ctx context.Context, userID string, id int64) (bool, error) {
	tag, err := r.Q.Exec(ctx, "UPDATE approval_notifications SET read_at=coalesce(read_at,now()) WHERE id=$1 AND recipient_id=$2", id, userID)
	return tag.RowsAffected() > 0, err
}

var _ = errors.Is
var _ = pgx.ErrNoRows
var _ = ports.ErrRowMissing
