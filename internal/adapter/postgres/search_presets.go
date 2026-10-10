package postgres

import(
 "context"
 "filesmanage/internal/domain"
 "github.com/jackc/pgx/v5"
)

// Reads are always scoped to the session principal, not a request user ID.
func(r *Repository) ListSearchPresets(ctx context.Context,userID string)([]domain.SearchPreset,error){
 rows,err:=r.Q.Query(ctx,`SELECT name,fields,created_at FROM search_presets WHERE user_id=$1 ORDER BY updated_at DESC,name LIMIT 12`,userID)
 if err!=nil{return nil,err};defer rows.Close()
 result:=make([]domain.SearchPreset,0)
 for rows.Next(){var p domain.SearchPreset;if err=rows.Scan(&p.Name,&p.Fields,&p.CreatedAt);err!=nil{return nil,err};result=append(result,p)}
 return result,rows.Err()
}
func(r *Repository) UpsertSearchPreset(ctx context.Context,userID string,p domain.SearchPreset)(bool,error){
 // Called inside the service transaction. Serialize concurrent writes for
 // this principal; otherwise two devices could exceed the 12-preset cap.
 _,err:=r.Q.Exec(ctx,`SELECT pg_advisory_xact_lock(hashtextextended($1,129))`,userID)
 if err!=nil{return false,err}
 var count int
 err=r.Q.QueryRow(ctx,`SELECT COUNT(*) FROM search_presets WHERE user_id=$1 AND name<>$2`,userID,p.Name).Scan(&count)
 if err!=nil{return false,err}
 if count>=12{return false,nil}
 _,err=r.Q.Exec(ctx,`INSERT INTO search_presets(user_id,name,fields) VALUES($1,$2,$3)
 ON CONFLICT(user_id,name) DO UPDATE SET fields=EXCLUDED.fields,updated_at=now()`,userID,p.Name,p.Fields)
 return err==nil,err
}
func(r *Repository) DeleteSearchPreset(ctx context.Context,userID,name string)(bool,error){
 tag,err:=r.Q.Exec(ctx,`DELETE FROM search_presets WHERE user_id=$1 AND name=$2`,userID,name)
 return tag.RowsAffected()>0,err
}
var _=pgx.ErrNoRows
