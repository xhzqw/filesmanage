package postgres
import("context";"filesmanage/internal/domain";"time")
func(r *Repository)LifecycleStatistics(ctx context.Context,now time.Time)(domain.LifecycleStatistics,error){
 var v domain.LifecycleStatistics
 e:=r.Q.QueryRow(ctx,`SELECT
 count(*) FILTER(WHERE l.state='released'),
 count(*) FILTER(WHERE l.state='archived'),
 count(*) FILTER(WHERE l.due_at>$1 AND l.due_at<=$1+interval '30 days'),
 count(*) FILTER(WHERE l.due_at<=$1),
 count(*) FILTER(WHERE l.retention_until>$1)
 FROM file_lifecycle l JOIN files f ON f.id=l.file_id WHERE f.deleted_at IS NULL`,now).
 Scan(&v.Released,&v.Archived,&v.DueSoon,&v.Overdue,&v.Retained)
 return v,e
}
