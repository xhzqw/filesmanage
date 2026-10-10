package application
import("context";"errors";"filesmanage/internal/domain";"filesmanage/internal/ports";"strings";"unicode/utf8")
func blankFileMetadata(fileID string)domain.FileMetadata{return domain.FileMetadata{FileID:fileID,Tags:[]string{}}}
func(s *Service) FileMetadata(ctx context.Context,u domain.User,id string)(domain.FileMetadata,error){
 tx,err:=s.uow.Begin(ctx);if err!=nil{return domain.FileMetadata{},err};defer tx.Rollback(ctx)
 if _,err=s.visibleFile(ctx,tx,u,id,domain.ActionPreview);err!=nil{return domain.FileMetadata{},err}
 m,err:=tx.FileMetadataByID(ctx,id);if errors.Is(err,ports.ErrRowMissing){return blankFileMetadata(id),nil};return m,err
}
func normalizeFileMetadata(m domain.FileMetadata)(domain.FileMetadata,error){
 m.Category=strings.TrimSpace(m.Category);m.Description=strings.TrimSpace(m.Description)
 if !utf8.ValidString(m.Category)||!utf8.ValidString(m.Description)||utf8.RuneCountInString(m.Category)>80||utf8.RuneCountInString(m.Description)>2000||len(m.Tags)>20{return m,domain.ErrInvalidInput}
 tags:=make([]string,0,len(m.Tags));seen:=map[string]bool{}
 for _,tag:=range m.Tags{tag=strings.TrimSpace(tag);if tag==""||utf8.RuneCountInString(tag)>40||!utf8.ValidString(tag){return m,domain.ErrInvalidInput};key:=strings.ToLower(tag);if !seen[key]{seen[key]=true;tags=append(tags,tag)}}
 m.Tags=tags;return m,nil
}
func(s *Service) SetFileMetadata(ctx context.Context,u domain.User,id string,draft domain.FileMetadata)(domain.FileMetadata,error){
 var err error;draft,err=normalizeFileMetadata(draft);if err!=nil{return domain.FileMetadata{},err}
 tx,err:=s.uow.Begin(ctx);if err!=nil{return domain.FileMetadata{},err};defer tx.Rollback(ctx)
 if _,err=s.visibleFile(ctx,tx,u,id,domain.ActionModify);err!=nil{return domain.FileMetadata{},err}
 before,err:=tx.FileMetadataByID(ctx,id);if errors.Is(err,ports.ErrRowMissing){before=blankFileMetadata(id)}else if err!=nil{return domain.FileMetadata{},err}
 draft.FileID=id;draft.UpdatedBy=u.ID
 if err=tx.UpsertFileMetadata(ctx,draft);err!=nil{return domain.FileMetadata{},err}
 if err=auditRequired(ctx,tx,u,"file.metadata_update","file",id,"success",map[string]any{
  "before":map[string]any{"category":before.Category,"description":before.Description,"tags":before.Tags},
  "after":map[string]any{"category":draft.Category,"description":draft.Description,"tags":draft.Tags},
 });err!=nil{return domain.FileMetadata{},err}
 if err=tx.Commit(ctx);err!=nil{return domain.FileMetadata{},err}
 s.bumpACLEpoch();return s.FileMetadata(ctx,u,id)
}
