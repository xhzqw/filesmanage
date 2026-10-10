package application
import (
 "context"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "time"
)
func (r *memoryRepo) FileMetadataByID(_ context.Context,id string)(domain.FileMetadata,error){
 r.mu.Lock();defer r.mu.Unlock()
 m,ok:=r.fileMetadata[id];if !ok{return domain.FileMetadata{},ports.ErrRowMissing}
 return m,nil
}
func (r *memoryRepo) UpsertFileMetadata(_ context.Context,m domain.FileMetadata)error{
 r.mu.Lock();defer r.mu.Unlock()
 m.UpdatedAt=time.Now().UTC()
 r.fileMetadata[m.FileID]=m
 return nil
}
