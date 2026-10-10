package application

import (
	"context"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
)

// snapshotTrashPath is called inside the same transaction as soft delete.
// Missing parents and cycles are failures: silently persisting a partial
// snapshot would allow us to mistake a changed destination for the original.
func snapshotTrashPath(ctx context.Context, repo ports.Repository, parentID string) ([]domain.TrashPathPart, error) {
	if parentID=="" { return nil,domain.ErrParentMissing }
	result:=make([]domain.TrashPathPart,0,8)
	seen:=make(map[string]bool)
	for parentID!="" {
		if seen[parentID]||len(result)>=64 { return nil,domain.ErrInvalidInput }
		seen[parentID]=true
		folder,err:=repo.FolderByID(ctx,parentID)
		if err!=nil { return nil,domain.ErrParentMissing }
		result=append(result,domain.TrashPathPart{ID:folder.ID,Name:folder.Name})
		if folder.ParentID==nil {break}
		parentID=*folder.ParentID
	}
	for i,j:=0,len(result)-1;i<j;i,j=i+1,j-1 {result[i],result[j]=result[j],result[i]}
	return result,nil
}

func sameTrashPath(a,b []domain.TrashPathPart)bool{
	if len(a)==0 || len(b)==0 || len(a)!=len(b){return false}
	for i:=range a { if a[i]!=b[i]{return false} }
	return true
}
