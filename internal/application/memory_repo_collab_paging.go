package application

import (
 "context"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "sort"
 "time"
)

func collaborationAfter(created time.Time,id string,after ports.CollaborationCursor)bool{
 if after.ID=="" {return true}
 return created.Before(after.CreatedAt)||(created.Equal(after.CreatedAt)&&id<after.ID)
}
func (r *memoryRepo) PageSharesForSubject(ctx context.Context,userID string,groups []string,after ports.CollaborationCursor,limit int)([]domain.Share,error){
 all,err:=r.ListSharesForSubject(ctx,userID,groups);if err!=nil{return nil,err}
 return pageMemoryShares(all,after,limit,true),nil
}
func (r *memoryRepo) PageSharesCreatedBy(ctx context.Context,userID string,after ports.CollaborationCursor,limit int)([]domain.Share,error){
 all,err:=r.ListSharesCreatedBy(ctx,userID);if err!=nil{return nil,err}
 return pageMemoryShares(all,after,limit,false),nil
}
func pageMemoryShares(all []domain.Share,after ports.CollaborationCursor,limit int,activeOnly bool)[]domain.Share{
 out:=make([]domain.Share,0,len(all));now:=time.Now()
 for _,v:=range all{if activeOnly&&v.ExpiresAt!=nil&&!v.ExpiresAt.After(now){continue};if collaborationAfter(v.CreatedAt,v.ID,after){out=append(out,v)}}
 sort.Slice(out,func(i,j int)bool{if out[i].CreatedAt.Equal(out[j].CreatedAt){return out[i].ID>out[j].ID};return out[i].CreatedAt.After(out[j].CreatedAt)})
 if len(out)>limit{out=out[:limit]};return out
}
func (r *memoryRepo) PageFavorites(ctx context.Context,userID string,after ports.CollaborationCursor,limit int)([]domain.Favorite,error){
 all,err:=r.ListFavorites(ctx,userID);if err!=nil{return nil,err}
 out:=make([]domain.Favorite,0,len(all))
 for _,v:=range all{if collaborationAfter(v.CreatedAt,v.ID,after){out=append(out,v)}}
 sort.Slice(out,func(i,j int)bool{if out[i].CreatedAt.Equal(out[j].CreatedAt){return out[i].ID>out[j].ID};return out[i].CreatedAt.After(out[j].CreatedAt)})
 if len(out)>limit{out=out[:limit]};return out,nil
}
