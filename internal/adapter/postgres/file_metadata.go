package postgres
import (
 "context"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "github.com/jackc/pgx/v5"
)
func (r *Repository) FileMetadataByID(ctx context.Context,id string)(domain.FileMetadata,error){
 var m domain.FileMetadata
 err:=r.Q.QueryRow(ctx,`SELECT file_id,category,description,tags,updated_by,updated_at FROM file_metadata WHERE file_id=$1`,id).Scan(&m.FileID,&m.Category,&m.Description,&m.Tags,&m.UpdatedBy,&m.UpdatedAt)
 if errors.Is(err,pgx.ErrNoRows){return domain.FileMetadata{},ports.ErrRowMissing}
 return m,err
}
func (r *Repository) UpsertFileMetadata(ctx context.Context,m domain.FileMetadata)error{
 _,err:=r.Q.Exec(ctx,`INSERT INTO file_metadata(file_id,category,description,tags,updated_by)
 VALUES($1,$2,$3,$4,$5)
 ON CONFLICT(file_id) DO UPDATE SET category=EXCLUDED.category,
 description=EXCLUDED.description,tags=EXCLUDED.tags,updated_by=EXCLUDED.updated_by,updated_at=now()`,
 m.FileID,m.Category,m.Description,m.Tags,m.UpdatedBy)
 return err
}
