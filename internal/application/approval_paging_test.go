package application

import (
 "context"
 "errors"
 "filesmanage/internal/domain"
 "fmt"
 "strings"
 "testing"
 "time"
)

func TestApprovalPagesBeyondLegacyCaps(t *testing.T){
 svc,repo:=testService(t)
 ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 regular:=domain.User{ID:"u_user"}
 base:=time.Date(2026,10,13,1,0,0,0,time.UTC)
 repo.mu.Lock()
 for i:=0;i<235;i++{
  id:=fmt.Sprintf("appr_%04d",i)
  repo.approvals=append(repo.approvals,domain.Approval{
   ID:id,FileID:"file",RequesterID:regular.ID,ApproverID:admin.ID,
   State:domain.ApprovalPending,FileName:fmt.Sprintf("original_%04d.pdf",i),
   CreatedAt:base.Add(time.Duration(i/2)*time.Second),
  })
 }
 for i:=0;i<137;i++{
  repo.approvalNotifications=append(repo.approvalNotifications,domain.ApprovalNotification{
   ID:int64(i+1),ApprovalID:fmt.Sprintf("appr_%04d",i),
   Read:i%4==0,CreatedAt:base.Add(time.Duration(i)*time.Second),
  })
  repo.approvalNotificationOwners=append(repo.approvalNotificationOwners,admin.ID)
 }
 repo.mu.Unlock()
 if _,err:=svc.ListApprovalsPage(ctx,regular,"all_pending","",30);!errors.Is(err,domain.ErrForbidden){t.Fatalf("admin scope leaked: %v",err)}
 for _,scope:=range []string{"inbox","all_pending"}{
  cursor:="";seen:=map[string]bool{}
  for pageNo:=0;pageNo<12;pageNo++{
   page,err:=svc.ListApprovalsPage(ctx,admin,scope,cursor,30)
   if err!=nil{t.Fatal(err)}
   if page.PendingCount!=235{t.Fatalf("inaccurate pending count: %d",page.PendingCount)}
   for _,a:=range page.Items{
    if seen[a.ID]{t.Fatalf("duplicate across pages: %s",a.ID)}
    seen[a.ID]=true
   }
   if !page.HasMore{break}
   if page.NextCursor==""{t.Fatal("missing cursor")}
   cursor=page.NextCursor
  }
  if len(seen)!=235{t.Fatalf("%s dropped rows: %d",scope,len(seen))}
 }
 before:=int64(0);seen:=map[int64]bool{}
 for i:=0;i<10;i++{
  page,err:=svc.ApprovalNotificationsPage(ctx,admin,before,20)
  if err!=nil{t.Fatal(err)}
  if page.UnreadCount!=102{t.Fatalf("unread count should include older notifications: %d",page.UnreadCount)}
  for _,n:=range page.Items{
   if seen[n.ID]{t.Fatalf("duplicate notification %d",n.ID)}
   seen[n.ID]=true
  }
  if !page.HasMore{break}
  before=page.NextCursor
 }
 if len(seen)!=137{t.Fatalf("notifications truncated: %d",len(seen))}
 if err:=svc.ReadApprovalNotification(ctx,admin,137);err!=nil{t.Fatal(err)}
 afterRead,err:=svc.ApprovalNotificationsPage(ctx,admin,0,1)
 if err!=nil||afterRead.UnreadCount!=101{
  t.Fatalf("unread count did not update after marking an older notification read: %+v %v",afterRead,err)
 }
 if _,err:=svc.ApprovalNotificationsPage(ctx,admin,0,101);!errors.Is(err,domain.ErrInvalidInput){t.Fatalf("limit not validated: %v",err)}
}

func TestApprovalSnapshotNameSurvivesRename(t *testing.T){
	s,repo:=testService(t)
	ctx:=context.Background()
	admin:=domain.User{ID:"u_admin",IsAdmin:true}
	requester:=domain.User{ID:"u_user"}
	repo.seedGrant(domain.ACL{ID:"snapshot-edit",FolderID:"folder_root",SubjectKind:"user",SubjectID:requester.ID,Actions:[]domain.Action{domain.ActionList,domain.ActionModify}})
	file,err:=s.CommitUpload(ctx,admin,"folder_root","at-submission.txt","text/plain","",strings.NewReader("original"))
	if err!=nil{t.Fatal(err)}
	if err=s.SetApprovalPolicy(ctx,admin,"folder_root",admin.ID,true);err!=nil{t.Fatal(err)}
	submission,err:=s.Save(ctx,requester,file.FileID,[]byte("updated"),1,"","review")
	if err!=nil||submission.Approval==nil{t.Fatalf("pending: %+v %v",submission,err)}
	_,err=s.RenameFile(ctx,admin,file.FileID,"renamed-after-request.txt")
	if err!=nil{t.Fatal(err)}
	detail,err:=s.ApprovalDetail(ctx,admin,submission.Approval.ID)
	if err!=nil||detail.FileName!="at-submission.txt"{t.Fatalf("submission snapshot lost: %+v %v",detail,err)}
	page,err:=s.ApprovalNotificationsPage(ctx,admin,0,10)
	if err!=nil||len(page.Items)!=1||page.Items[0].FileName!="at-submission.txt"{
		t.Fatalf("notification snapshot lost: %+v %v",page,err)
	}
}
