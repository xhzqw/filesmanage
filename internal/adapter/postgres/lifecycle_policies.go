package postgres
import(
 "context"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "github.com/jackc/pgx/v5"
)
func(r *Repository)FolderLifecyclePolicy(ctx context.Context,id string)(domain.LifecyclePolicy,error){
 var p domain.LifecyclePolicy
 e:=r.Q.QueryRow(ctx,"SELECT due_days,retention_days FROM folder_lifecycle_policies WHERE folder_id=$1",id).Scan(&p.DueDays,&p.RetentionDays)
 if errors.Is(e,pgx.ErrNoRows){return p,ports.ErrRowMissing};return p,e
}
func(r *Repository)DepartmentLifecyclePolicy(ctx context.Context,id string)(domain.LifecyclePolicy,error){
 var p domain.LifecyclePolicy
 e:=r.Q.QueryRow(ctx,"SELECT due_days,retention_days FROM department_lifecycle_policies WHERE department_id=$1",id).Scan(&p.DueDays,&p.RetentionDays)
 if errors.Is(e,pgx.ErrNoRows){return p,ports.ErrRowMissing};return p,e
}
func(r *Repository)PutFolderLifecyclePolicy(ctx context.Context,id string,p domain.LifecyclePolicy,by string)error{
 _,e:=r.Q.Exec(ctx,`INSERT INTO folder_lifecycle_policies(folder_id,due_days,retention_days,updated_by)
 VALUES($1,$2,$3,$4) ON CONFLICT(folder_id) DO UPDATE SET due_days=excluded.due_days,
 retention_days=excluded.retention_days,updated_by=excluded.updated_by,updated_at=now()`,id,p.DueDays,p.RetentionDays,by)
 return e
}
func(r *Repository)PutDepartmentLifecyclePolicy(ctx context.Context,id string,p domain.LifecyclePolicy,by string)error{
 _,e:=r.Q.Exec(ctx,`INSERT INTO department_lifecycle_policies(department_id,due_days,retention_days,updated_by)
 VALUES($1,$2,$3,$4) ON CONFLICT(department_id) DO UPDATE SET due_days=excluded.due_days,
 retention_days=excluded.retention_days,updated_by=excluded.updated_by,updated_at=now()`,id,p.DueDays,p.RetentionDays,by)
 return e
}
func(r *Repository)DeleteFolderLifecyclePolicy(ctx context.Context,id string)error{
 _,e:=r.Q.Exec(ctx,"DELETE FROM folder_lifecycle_policies WHERE folder_id=$1",id);return e
}
func(r *Repository)DeleteDepartmentLifecyclePolicy(ctx context.Context,id string)error{
 _,e:=r.Q.Exec(ctx,"DELETE FROM department_lifecycle_policies WHERE department_id=$1",id);return e
}
