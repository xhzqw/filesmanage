package application

import (
 "context"
 "errors"
 "filesmanage/internal/domain"
 "testing"
 "time"
)

func TestTrashPageFiltersAndPagination(t *testing.T){
 s,repo:=testService(t)
 ctx:=context.Background()
 base:=time.Date(2026,10,9,0,0,0,0,time.UTC)
 fileID,folderID:="file_a","folder_b"
 records:=[]domain.TrashEntry{
  {ID:"a",FileID:&fileID,OldName:"Assembly.step",DeletedBy:"u_admin",DeletedName:"系统管理员",DeletedAt:base},
  {ID:"b",FolderID:&folderID,OldName:"装配目录",DeletedBy:"u_admin",DeletedName:"系统管理员",DeletedAt:base.Add(time.Hour)},
  {ID:"c",FileID:&fileID,OldName:"drawing.pdf",DeletedBy:"u_user",DeletedName:"普通用户",DeletedAt:base.Add(2*time.Hour)},
  {ID:"d",FileID:&fileID,OldName:"assembly.stl",DeletedBy:"u_admin",DeletedName:"系统管理员",DeletedAt:base.Add(3*time.Hour)},
 }
 for _,item:=range records {
  if err:=repo.InsertTrashEntry(ctx,item);err!=nil{t.Fatal(err)}
 }
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 filtered,err:=s.PageTrash(ctx,admin,TrashFilters{Search:"assembly",Kind:"file",Sort:"recent",Offset:0,Limit:1})
 if err!=nil||len(filtered.Items)!=1||filtered.Items[0].ID!="d"||!filtered.HasMore{
  t.Fatalf("search/authorization failed: %+v, %v",filtered,err)
 }
 first,err:=s.PageTrash(ctx,admin,TrashFilters{Sort:"recent",Offset:0,Limit:2})
 if err!=nil||len(first.Items)!=2||first.Items[0].ID!="d"||first.Items[1].ID!="b"||!first.HasMore{
  t.Fatalf("page one failed: %+v, %v",first,err)
 }
 second,err:=s.PageTrash(ctx,admin,TrashFilters{Sort:"recent",Offset:2,Limit:2})
 if err!=nil||len(second.Items)!=1||second.Items[0].ID!="a"||second.HasMore{
  t.Fatalf("page two failed: %+v, %v",second,err)
 }
 named,err:=s.PageTrash(ctx,admin,TrashFilters{DeletedBy:"系统",Kind:"folder",Sort:"name",Offset:0,Limit:2})
 if err!=nil||len(named.Items)!=1||named.Items[0].ID!="b"{
  t.Fatalf("type/actor filter failed: %+v, %v",named,err)
 }
 recent,err:=s.PageTrash(ctx,admin,TrashFilters{From:base.Add(2*time.Hour),Offset:0,Limit:20})
 if err!=nil||len(recent.Items)!=1||recent.Items[0].ID!="d"{
  t.Fatalf("time filter failed: %+v, %v",recent,err)
 }
 member,err:=s.PageTrash(ctx,domain.User{ID:"u_user"},TrashFilters{Offset:0,Limit:10})
 if err!=nil||len(member.Items)!=1||member.Items[0].ID!="c"{
  t.Fatalf("cross-user leak: %+v, %v",member,err)
 }
 if _,err=s.PageTrash(ctx,admin,TrashFilters{Limit:101});!errors.Is(err,domain.ErrInvalidInput){
  t.Fatalf("limit must be bounded: %v",err)
 }
}

func TestRestoreToAnotherFolderWithNewName(t *testing.T){
 s,repo:=testService(t)
 ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 dest:=domain.Folder{ID:"folder_destination",Name:"目标目录",ParentID:stringPointer("folder_root"),OwnerID:admin.ID}
 repo.seedFolder(dest)
 now:=time.Now()
 fid:="file_restore"
 repo.files[fid]=domain.File{ID:fid,FolderID:"folder_market",Name:"assembly.step",DeletedAt:&now}
 fileTrash:=domain.TrashEntry{ID:"trash_file",FileID:&fid,OldParentID:stringPointer("folder_market"),OldName:"assembly.step",DeletedBy:admin.ID,DeletedAt:now}
 if err:=repo.InsertTrashEntry(ctx,fileTrash);err!=nil{t.Fatal(err)}
 if _,err:=s.RestoreFromTrash(ctx,admin,fileTrash.ID,RestoreRequest{DestinationFolderID:dest.ID,NewName:"assembly-restored.step"});err!=nil{t.Fatal(err)}
 file,err:=repo.FileByID(ctx,fid)
 if err!=nil||file.DeletedAt!=nil||file.FolderID!=dest.ID||file.Name!="assembly-restored.step"{
  t.Fatalf("file must be renamed and moved atomically: %+v, %v",file,err)
 }
 folderID:="folder_restore"
 repo.seedFolder(domain.Folder{ID:folderID,Name:"旧装配",ParentID:stringPointer("folder_market"),OwnerID:admin.ID,DeletedAt:&now})
 folderTrash:=domain.TrashEntry{ID:"trash_folder",FolderID:&folderID,OldParentID:stringPointer("folder_market"),OldName:"旧装配",DeletedBy:admin.ID,DeletedAt:now}
 if err:=repo.InsertTrashEntry(ctx,folderTrash);err!=nil{t.Fatal(err)}
 if _,err:=s.RestoreFromTrash(ctx,admin,folderTrash.ID,RestoreRequest{DestinationFolderID:dest.ID,NewName:"新装配"});err!=nil{t.Fatal(err)}
 folder,err:=repo.FolderByID(ctx,folderID)
 if err!=nil||folder.DeletedAt!=nil||folder.ParentID==nil||*folder.ParentID!=dest.ID||folder.Name!="新装配"{
  t.Fatalf("folder must be renamed and moved atomically: %+v, %v",folder,err)
 }
}

func stringPointer(value string)*string{return &value}
