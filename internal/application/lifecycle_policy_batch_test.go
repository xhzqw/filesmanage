package application
import(
 "context"
 "errors"
 "filesmanage/internal/domain"
 "strings"
 "testing"
 "time"
)
func TestLifecyclePoliciesInheritedAndArchiveMinimum(t *testing.T){
 s,repo:=testService(t);ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true};user:=domain.User{ID:"u_user"}
 if e:=s.SetLifecyclePolicy(ctx,user,"folder","folder_root",&domain.LifecyclePolicy{DueDays:30});!errors.Is(e,domain.ErrForbidden){t.Fatalf("unauthorized %v",e)}
 pol:=domain.LifecyclePolicy{DueDays:90,RetentionDays:90}
 if e:=s.SetLifecyclePolicy(ctx,admin,"folder","folder_root",&pol);e!=nil{t.Fatal(e)}
 inherited,e:=s.LifecyclePolicy(ctx,admin,"folder","folder_market")
 if e!=nil||inherited.SourceID!="folder_root"||inherited.DueDays!=90{t.Fatalf("inherit %+v %v",inherited,e)}
 uploaded,e:=s.CommitUpload(ctx,admin,"folder_market","managed.txt","text/plain","",strings.NewReader("managed"));if e!=nil{t.Fatal(e)}
 published,e:=s.SetFileLifecycle(ctx,admin,uploaded.FileID,LifecycleDraft{Action:"publish",ExpectedVersionSeq:1})
 if e!=nil||published.DueAt==nil||published.DueStatus!="scheduled"{t.Fatalf("due policy %+v %v",published,e)}
 archived,e:=s.SetFileLifecycle(ctx,admin,uploaded.FileID,LifecycleDraft{Action:"archive",ExpectedVersionSeq:1,RetentionDays:30})
 if e!=nil||archived.RetentionUntil==nil||archived.RetentionUntil.Sub(s.now())<89*24*time.Hour{t.Fatalf("retention floor %+v %v",archived,e)}
 override:=domain.LifecyclePolicy{}
 if e:=s.SetLifecyclePolicy(ctx,admin,"folder","folder_market",&override);e!=nil{t.Fatal(e)}
 view,e:=s.LifecyclePolicy(ctx,admin,"folder","folder_market")
 if e!=nil||view.SourceID!="folder_market"||view.DueDays!=0{t.Fatalf("override %+v %v",view,e)}
 if e:=s.SetLifecyclePolicy(ctx,admin,"folder","folder_market",nil);e!=nil{t.Fatal(e)}
 view,e=s.LifecyclePolicy(ctx,admin,"folder","folder_market")
 if e!=nil||view.SourceID!="folder_root"{t.Fatalf("clear override %+v %v",view,e)}
 repo.departments=[]domain.Department{{ID:"dept_a",Name:"engineering"}}
 entry:=repo.users["u_admin"];entry.user.DepartmentID="dept_a";repo.users["u_admin"]=entry;repo.users[entry.user.Login]=entry
 deptPolicy:=domain.LifecyclePolicy{DueDays:180}
 if e:=s.SetLifecyclePolicy(ctx,admin,"department","dept_a",&deptPolicy);e!=nil{t.Fatal(e)}
 if e:=s.SetLifecyclePolicy(ctx,admin,"folder","folder_root",nil);e!=nil{t.Fatal(e)}
 effective,e:=s.effectiveLifecyclePolicy(ctx,repo,"folder_market","u_admin")
 if e!=nil||effective.SourceKind!="department"||effective.DueDays!=180{t.Fatalf("dept fallback %+v %v",effective,e)}
}
func TestLifecycleAssigneeAndBulkDue(t *testing.T){
 s,repo:=testService(t);ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true};viewer:=domain.User{ID:"u_user"}
 uploaded,e:=s.CommitUpload(ctx,admin,"folder_root","owner.txt","text/plain","",strings.NewReader("owner"));if e!=nil{t.Fatal(e)}
 if _,e=s.SetFileLifecycle(ctx,admin,uploaded.FileID,LifecycleDraft{Action:"publish",ExpectedVersionSeq:1});e!=nil{t.Fatal(e)}
 if _,e=s.SetFileLifecycle(ctx,admin,uploaded.FileID,LifecycleDraft{Action:"assign",ExpectedVersionSeq:1,ResponsibleID:"u_user"});!errors.Is(e,domain.ErrForbidden){t.Fatalf("assign to hidden user %v",e)}
 repo.seedGrant(domain.ACL{ID:"reader_role",FolderID:"folder_root",SubjectKind:"user",SubjectID:"u_user",Actions:[]domain.Action{domain.ActionList}})
 assigned,e:=s.SetFileLifecycle(ctx,admin,uploaded.FileID,LifecycleDraft{Action:"assign",ExpectedVersionSeq:1,ResponsibleID:"u_user"})
 if e!=nil||assigned.ResponsibleID==nil||*assigned.ResponsibleID!="u_user"{t.Fatalf("assign %+v %v",assigned,e)}
 due:=s.now().Add(10*24*time.Hour)
 var req LifecycleBulkDueRequest
 req.DueAt=&due
 req.Items=append(req.Items,struct{FileID string `json:"fileId"`;ExpectedVersionSeq int `json:"expectedVersionSeq"`}{FileID:uploaded.FileID,ExpectedVersionSeq:1})
 req.Items=append(req.Items,struct{FileID string `json:"fileId"`;ExpectedVersionSeq int `json:"expectedVersionSeq"`}{FileID:"invalid_file",ExpectedVersionSeq:1})
 results,e:=s.BulkLifecycleDue(ctx,admin,req)
 if e!=nil||len(results)!=2||results[0].Status!="updated"||results[1].Status!="unavailable"{t.Fatalf("bulk %+v %v",results,e)}
 if _,e=s.LifecycleStatistics(ctx,viewer);!errors.Is(e,domain.ErrForbidden){t.Fatalf("viewer stats %v",e)}
 count,e:=s.LifecycleStatistics(ctx,admin);if e!=nil||count.Released<1{t.Fatalf("stats %+v %v",count,e)}
}
