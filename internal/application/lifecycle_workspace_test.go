package application

import (
 "context"
 "errors"
 "filesmanage/internal/domain"
 "strings"
 "testing"
 "time"
)

func TestLifecycleLedgerACLAndRecipientIsolation(t *testing.T){
 s,repo:=testService(t);ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 viewer:=domain.User{ID:"u_user"}
 f1,e:=s.CommitUpload(ctx,admin,"folder_root","ledger-one.txt","text/plain","",strings.NewReader("one"));if e!=nil{t.Fatal(e)}
 f2,e:=s.CommitUpload(ctx,admin,"folder_root","ledger-two.txt","text/plain","",strings.NewReader("two"));if e!=nil{t.Fatal(e)}
 due:=time.Now().Add(2*24*time.Hour)
 for _,id:=range []string{f1.FileID,f2.FileID}{
  if _,e=s.SetFileLifecycle(ctx,admin,id,LifecycleDraft{Action:"publish",ExpectedVersionSeq:1,DueAt:&due});e!=nil{t.Fatal(e)}
 }
 first,e:=s.LifecycleLedger(ctx,admin,"","",1)
 if e!=nil||len(first.Items)!=1||first.NextCursor==""{t.Fatalf("first %+v %v",first,e)}
 second,e:=s.LifecycleLedger(ctx,admin,first.NextCursor,"",1)
 if e!=nil||len(second.Items)!=1||second.Items[0].FileID==first.Items[0].FileID{t.Fatalf("second %+v %v",second,e)}
 hidden,e:=s.LifecycleLedger(ctx,viewer,"","",20)
 if e!=nil{t.Fatal(e)}
 for _,item:=range hidden.Items{if item.FileID==f1.FileID||item.FileID==f2.FileID{t.Fatalf("leaked %s",item.FileID)}}
 repo.lifecycleNotifications=[]domain.LifecycleNotification{{ID:1,FileID:f1.FileID,Kind:"soon",DueAt:due,CreatedAt:time.Now()}}
 adminNotes,e:=s.LifecycleNotifications(ctx,admin)
 if e!=nil||len(adminNotes)!=1{t.Fatalf("admin %+v %v",adminNotes,e)}
 otherNotes,e:=s.LifecycleNotifications(ctx,viewer)
 if e!=nil||len(otherNotes)!=0{t.Fatalf("viewer leaked %+v %v",otherNotes,e)}
 if e=s.ReadLifecycleNotification(ctx,viewer,1);!errors.Is(e,domain.ErrNotFound){t.Fatalf("foreign read %v",e)}
 if e=s.ReadLifecycleNotification(ctx,admin,1);e!=nil{t.Fatal(e)}
}

func TestArchiveRetentionBlocksUndoDeleteAndFolderTrash(t *testing.T){
 s,_:=testService(t);ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 folder,e:=s.CreateFolder(ctx,admin,"folder_root","retention-spec");if e!=nil{t.Fatal(e)}
 uploaded,e:=s.CommitUpload(ctx,admin,folder.ID,"retained.txt","text/plain","",strings.NewReader("protected"))
 if e!=nil{t.Fatal(e)}
 if _,e=s.SetFileLifecycle(ctx,admin,uploaded.FileID,LifecycleDraft{Action:"publish",ExpectedVersionSeq:1});e!=nil{t.Fatal(e)}
 archived,e:=s.SetFileLifecycle(ctx,admin,uploaded.FileID,LifecycleDraft{Action:"archive",ExpectedVersionSeq:1,RetentionDays:30})
 if e!=nil||archived.RetentionUntil==nil{t.Fatalf("archive %+v %v",archived,e)}
 if _,e=s.SetFileLifecycle(ctx,admin,uploaded.FileID,LifecycleDraft{Action:"unarchive",ExpectedVersionSeq:1});!errors.Is(e,domain.ErrConflict){t.Fatalf("undo %v",e)}
 if _,e=s.DeleteFile(ctx,admin,uploaded.FileID);!errors.Is(e,domain.ErrConflict){t.Fatalf("delete %v",e)}
 if _,_,e=s.DeleteFolder(ctx,admin,folder.ID);!errors.Is(e,domain.ErrConflict){t.Fatalf("folder trash %v",e)}
 if _,e=s.SetFileLifecycle(ctx,admin,uploaded.FileID,LifecycleDraft{Action:"archive",ExpectedVersionSeq:1,RetentionDays:12});!errors.Is(e,domain.ErrInvalidInput){t.Fatalf("invalid period %v",e)}
}
