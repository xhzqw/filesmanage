package postgres
import("context";"filesmanage/internal/domain";"filesmanage/internal/ports";"errors";"github.com/jackc/pgx/v5")
const commentProjection=`SELECT c.id,c.file_id,c.version_seq,c.line_number,c.body,c.author_id,coalesce(u.display_name,''),c.created_at,c.resolved_at,coalesce(c.resolved_by,'')
 FROM file_review_comments c LEFT JOIN users u ON u.id=c.author_id`
func scanComment(row rowScanner)(domain.FileReviewComment,error){
 var c domain.FileReviewComment
 err:=row.Scan(&c.ID,&c.FileID,&c.VersionSeq,&c.LineNumber,&c.Body,&c.AuthorID,&c.AuthorName,&c.CreatedAt,&c.ResolvedAt,&c.ResolvedBy)
 return c,err
}
func(r *Repository) ReviewComments(ctx context.Context,fileID string,version int,before int64,limit int)([]domain.FileReviewComment,error){
 rows,err:=r.Q.Query(ctx,commentProjection+` WHERE c.file_id=$1 AND c.version_seq=$2 AND ($3::bigint=0 OR c.id<$3) ORDER BY c.id DESC LIMIT $4`,fileID,version,before,limit)
 if err!=nil{return nil,err};defer rows.Close()
 out:=make([]domain.FileReviewComment,0,limit)
 for rows.Next(){c,err:=scanComment(rows);if err!=nil{return nil,err};out=append(out,c)}
 return out,rows.Err()
}
func(r *Repository) ReviewCommentByID(ctx context.Context,id int64)(domain.FileReviewComment,error){
 c,err:=scanComment(r.Q.QueryRow(ctx,commentProjection+` WHERE c.id=$1`,id))
 if errors.Is(err,pgx.ErrNoRows){return c,ports.ErrRowMissing};return c,err
}
func(r *Repository) InsertReviewComment(ctx context.Context,c domain.FileReviewComment)(domain.FileReviewComment,error){
 var id int64
 err:=r.Q.QueryRow(ctx,`INSERT INTO file_review_comments(file_id,version_seq,line_number,body,author_id)
 VALUES($1,$2,$3,$4,$5) RETURNING id`,c.FileID,c.VersionSeq,c.LineNumber,c.Body,c.AuthorID).Scan(&id)
 if err!=nil{return c,err};return r.ReviewCommentByID(ctx,id)
}
func(r *Repository) ResolveReviewComment(ctx context.Context,id int64,actor string)(bool,error){
 tag,err:=r.Q.Exec(ctx,`UPDATE file_review_comments SET resolved_at=now(),resolved_by=$2 WHERE id=$1 AND resolved_at IS NULL`,id,actor)
 return tag.RowsAffected()==1,err
}
