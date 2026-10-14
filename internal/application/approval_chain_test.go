package application

import (
 "context"
 "errors"
 "filesmanage/internal/domain"
 "strings"
 "testing"
)

func TestSequentialApprovalChainSnapshot(t *testing.T){
 s,repo:=testService(t);ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 requester:=domain.User{ID:"u_user"}
 // Give the requester edit rights, but not approval powers.
 repo.seedGrant(domain.ACL{ID:"chain-mod",FolderID:"folder_root",SubjectKind:"user",SubjectID:requester.ID,
  Actions:[]domain.Action{domain.ActionList,domain.ActionModify}})
 id,err:=s.CommitUpload(ctx,admin,"folder_root","chain.txt","text/plain","",strings.NewReader("first"))
 if err!=nil{t.Fatal(err)}
 if err=s.SetApprovalChainPolicy(ctx,admin,"folder_root",[]string{"u_admin","u_user","u_admin"},true);!errors.Is(err,domain.ErrInvalidInput){t.Fatalf("duplicate approver accepted: %v",err)}
 if err=s.SetApprovalChainPolicy(ctx,requester,"folder_root",[]string{requester.ID},true);!errors.Is(err,domain.ErrForbidden){t.Fatalf("nonadmin policy edit: %v",err)}
 if err=s.SetApprovalChainPolicy(ctx,admin,"folder_root",[]string{"u_admin",requester.ID},true);err!=nil{t.Fatal(err)}
 outcome,err:=s.Save(ctx,requester,id.FileID,[]byte("second"),1,"","")
 if err!=nil||outcome.Approval==nil{t.Fatalf("request %+v %v",outcome,err)}
 req:=outcome.Approval
 if len(req.ApproverChain)!=2||req.StepIndex!=0{t.Fatalf("snapshot invalid %+v",req)}
 // Changing policy does not alter this pending request.
 if err=s.SetApprovalChainPolicy(ctx,admin,"folder_root",[]string{requester.ID},true);err!=nil{t.Fatal(err)}
 result,err:=s.Approve(ctx,admin,req.ID,"一级通过")
 if err!=nil||result.VersionSeq!=0{t.Fatalf("first step should not commit: %+v %v",result,err)}
 _,versions,err:=s.FileMeta(ctx,admin,id.FileID)
 if err!=nil||len(versions)!=1{t.Fatalf("premature commit: %v, %d versions",err,len(versions))}
 if won,err:=repo.AdvanceApproval(ctx,req.ID,0,admin.ID);err!=nil||won{t.Fatalf("old step advanced twice: %v %v",won,err)}
 advanced,err:=repo.ApprovalByID(ctx,req.ID)
 if err!=nil||advanced.StepIndex!=1||advanced.ApproverID!=requester.ID||len(advanced.ApproverChain)!=2{t.Fatalf("bad step %+v %v",advanced,err)}
 if _,err=s.Approve(ctx,requester,req.ID,"末级通过");err!=nil{t.Fatal(err)}
 _,versions,err=s.FileMeta(ctx,admin,id.FileID)
 if err!=nil||len(versions)!=2{t.Fatalf("last step failed: %v %d",err,len(versions))}
 if _,err=s.Approve(ctx,requester,req.ID,"重复终审");!errors.Is(err,domain.ErrVersionConflict){t.Fatalf("double-commit: %v",err)}
}
func TestApprovalChainCancellationAfterFirstStep(t *testing.T){
 s,repo:=testService(t);ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 requester:=domain.User{ID:"u_user"}
 repo.seedGrant(domain.ACL{ID:"chain-mod2",FolderID:"folder_root",SubjectKind:"user",SubjectID:requester.ID,Actions:[]domain.Action{domain.ActionList,domain.ActionModify}})
 uploaded,err:=s.CommitUpload(ctx,admin,"folder_root","cancel-chain.txt","text/plain","",strings.NewReader("base"))
 if err!=nil{t.Fatal(err)}
 if err=s.SetApprovalChainPolicy(ctx,admin,"folder_root",[]string{admin.ID,requester.ID},true);err!=nil{t.Fatal(err)}
 pending,err:=s.Save(ctx,requester,uploaded.FileID,[]byte("draft"),1,"","")
 if err!=nil{t.Fatal(err)}
 if _,err=s.Approve(ctx,admin,pending.Approval.ID,"ok");err!=nil{t.Fatal(err)}
 if err=s.CancelApproval(ctx,requester,pending.Approval.ID);err!=nil{t.Fatal(err)}
 if _,err=s.Approve(ctx,requester,pending.Approval.ID,"approve after cancel");!errors.Is(err,domain.ErrVersionConflict){t.Fatalf("cancelled request approved: %v",err)}
 _,versions,err:=s.FileMeta(ctx,admin,uploaded.FileID)
 if err!=nil||len(versions)!=1{t.Fatalf("cancel changed current version %v %d",err,len(versions))}
}
