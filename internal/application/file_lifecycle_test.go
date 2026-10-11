package application

import (
 "context"
 "errors"
 "filesmanage/internal/domain"
 "strings"
 "testing"
 "time"
)

func TestFileLifecyclePublishArchiveAndReadOnly(t *testing.T){
 s,_:=testService(t)
 ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 other:=domain.User{ID:"u_user"}
 upload,err:=s.CommitUpload(ctx,admin,"folder_root","lifecycle-test.txt","text/plain","",strings.NewReader("draft"))
 if err!=nil{t.Fatal(err)}
 before,err:=s.FileLifecycle(ctx,admin,upload.FileID)
 if err!=nil||before.State!="draft"||!before.CanManage{t.Fatalf("initial lifecycle %+v %v",before,err)}
 if _,err=s.SetFileLifecycle(ctx,admin,upload.FileID,LifecycleDraft{Action:"publish",ExpectedVersionSeq:2});!errors.Is(err,domain.ErrVersionConflict){t.Fatalf("stale publish %v",err)}
 if _,err=s.SetFileLifecycle(ctx,other,upload.FileID,LifecycleDraft{Action:"publish",ExpectedVersionSeq:1});err==nil{t.Fatal("unauthorized publish")}
 token,_,err:=s.AcquireLock(ctx,admin,upload.FileID,1)
 if err!=nil{t.Fatal(err)}
 if _,err=s.SetFileLifecycle(ctx,admin,upload.FileID,LifecycleDraft{Action:"publish",ExpectedVersionSeq:1});!errors.Is(err,domain.ErrLocked){t.Fatalf("published during lock %v",err)}
 if err=s.ReleaseLock(ctx,admin,upload.FileID,token);err!=nil{t.Fatal(err)}
 due:=time.Now().Add(72*time.Hour).UTC()
 published,err:=s.SetFileLifecycle(ctx,admin,upload.FileID,LifecycleDraft{Action:"publish",ExpectedVersionSeq:1,DueAt:&due,Note:"issued"})
 if err!=nil||published.State!="released"||published.PublishedSeq!=1||published.DueStatus!="soon"{t.Fatalf("published %+v %v",published,err)}
 archived,err:=s.SetFileLifecycle(ctx,admin,upload.FileID,LifecycleDraft{Action:"archive",ExpectedVersionSeq:1})
 if err!=nil||archived.State!="archived"{t.Fatalf("archive %+v %v",archived,err)}
 if _,err=s.RenameFile(ctx,admin,upload.FileID,"renamed.txt");!errors.Is(err,domain.ErrConflict){t.Fatalf("archived rename %v",err)}
 if _,_,err=s.AcquireLock(ctx,admin,upload.FileID,1);!errors.Is(err,domain.ErrConflict){t.Fatalf("archived lock %v",err)}
 if _,err=s.DeleteFile(ctx,admin,upload.FileID);!errors.Is(err,domain.ErrConflict){t.Fatalf("archived delete %v",err)}
 if _,err=s.SetFileLifecycle(ctx,admin,upload.FileID,LifecycleDraft{Action:"publish",ExpectedVersionSeq:1});!errors.Is(err,domain.ErrConflict){t.Fatalf("archived publish %v",err)}
 reopened,err:=s.SetFileLifecycle(ctx,admin,upload.FileID,LifecycleDraft{Action:"unarchive",ExpectedVersionSeq:1})
 if err!=nil||reopened.State!="released"{t.Fatalf("unarchive %+v %v",reopened,err)}
 if _,err=s.RenameFile(ctx,admin,upload.FileID,"renamed.txt");err!=nil{t.Fatal(err)}
}
func TestArchiveRequiresLatestVersionPublished(t *testing.T){
 s,_:=testService(t);ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 upload,err:=s.CommitUpload(ctx,admin,"folder_root","revised.txt","text/plain","",strings.NewReader("one"))
 if err!=nil{t.Fatal(err)}
 if _,err=s.SetFileLifecycle(ctx,admin,upload.FileID,LifecycleDraft{Action:"publish",ExpectedVersionSeq:1});err!=nil{t.Fatal(err)}
 token,_,err:=s.AcquireLock(ctx,admin,upload.FileID,1);if err!=nil{t.Fatal(err)}
 if _,err=s.Save(ctx,admin,upload.FileID,[]byte("two"),1,token,"");err!=nil{t.Fatal(err)}
 if _,err=s.SetFileLifecycle(ctx,admin,upload.FileID,LifecycleDraft{Action:"archive",ExpectedVersionSeq:2});!errors.Is(err,domain.ErrVersionConflict){
  t.Fatalf("archived unpublished edit %v",err)
 }
 if _,err=s.SetFileLifecycle(ctx,admin,upload.FileID,LifecycleDraft{Action:"publish",ExpectedVersionSeq:2});err!=nil{t.Fatal(err)}
 if _,err=s.SetFileLifecycle(ctx,admin,upload.FileID,LifecycleDraft{Action:"archive",ExpectedVersionSeq:2});err!=nil{t.Fatal(err)}
}

func TestLifecycleDueStatus(t *testing.T){
 now:=time.Date(2026,10,11,12,0,0,0,time.UTC)
 if lifecycleDueStatus(nil,now)!="none"{t.Fatal("nil due")}
 soon:=now.Add(2*time.Hour);if lifecycleDueStatus(&soon,now)!="soon"{t.Fatal("soon")}
 past:=now.Add(-time.Minute);if lifecycleDueStatus(&past,now)!="overdue"{t.Fatal("overdue")}
 future:=now.Add(40*24*time.Hour);if lifecycleDueStatus(&future,now)!="scheduled"{t.Fatal("scheduled")}
}
