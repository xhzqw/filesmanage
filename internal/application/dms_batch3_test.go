package application

import (
 "context"
 "errors"
 "filesmanage/internal/domain"
 "strings"
 "testing"
)

func TestVersionDiffAndVersionScopedReview(t *testing.T){
 ctx:=context.Background()
 s,repo:=testService(t)
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 viewer:=domain.User{ID:"u_user"}
 uploaded,err:=s.CommitUpload(ctx,admin,"folder_root","review.txt","text/plain","",strings.NewReader("top\noriginal\nbottom"))
 if err!=nil{t.Fatal(err)}
 lock,_,err:=s.AcquireLock(ctx,admin,uploaded.FileID,1)
 if err!=nil{t.Fatal(err)}
 if _,err=s.Save(ctx,admin,uploaded.FileID,[]byte("top\nchanged\nbottom"),1,lock,"");err!=nil{t.Fatal(err)}
 diff,err:=s.CompareVersions(ctx,admin,uploaded.FileID,1,2)
 if err!=nil{t.Fatal(err)}
 if diff.Mode!="text"||diff.Added!=1||diff.Removed!=1{t.Fatalf("incorrect diff %+v",diff)}
 if _,err=s.CompareVersions(ctx,admin,uploaded.FileID,2,2);!errors.Is(err,domain.ErrInvalidInput){t.Fatalf("identical seq accepted: %v",err)}
 if _,err=s.CompareVersions(ctx,admin,uploaded.FileID,1,9);!errors.Is(err,domain.ErrNotFound){t.Fatalf("absent version: %v",err)}
 if _,err=s.CompareVersions(ctx,viewer,uploaded.FileID,1,2);!errors.Is(err,domain.ErrForbidden){t.Fatalf("unauthorized history disclosed: %v",err)}

 repo.seedGrant(domain.ACL{ID:"acl_review",FolderID:"folder_root",SubjectKind:"user",SubjectID:viewer.ID,Actions:[]domain.Action{domain.ActionPreview}})
 line:=2
 c,err:=s.AddReviewComment(ctx,viewer,uploaded.FileID,1,&line," 字词需修订 ")
 if err!=nil{t.Fatal(err)}
 if c.VersionSeq!=1||c.LineNumber==nil||*c.LineNumber!=2||c.Body!="字词需修订"{t.Fatalf("stored: %+v",c)}
 if _,err=s.AddReviewComment(ctx,viewer,uploaded.FileID,1,nil,"   ");!errors.Is(err,domain.ErrInvalidInput){t.Fatal("blank comment accepted")}
 if _,err=s.AddReviewComment(ctx,viewer,uploaded.FileID,30,nil,"bad");!errors.Is(err,domain.ErrNotFound){t.Fatalf("nonexistent seq: %v",err)}
 c2,err:=s.AddReviewComment(ctx,admin,uploaded.FileID,2,nil,"管理员意见");if err!=nil{t.Fatal(err)}
 page,err:=s.ReviewComments(ctx,viewer,uploaded.FileID,1,"",1)
 if err!=nil||len(page.Items)!=1||page.Items[0].ID!=c.ID{t.Fatalf("version scope failure: %+v %v",page,err)}
 page,err=s.ReviewComments(ctx,viewer,uploaded.FileID,2,"",1)
 if err!=nil||len(page.Items)!=1||page.Items[0].ID!=c2.ID{t.Fatalf("cross-version leak: %+v %v",page,err)}
 if err=s.ResolveReviewComment(ctx,viewer,uploaded.FileID,c2.ID);!errors.Is(err,domain.ErrForbidden){t.Fatalf("other author resolved without modify: %v",err)}
 if err=s.ResolveReviewComment(ctx,viewer,uploaded.FileID,c.ID);err!=nil{t.Fatal(err)}
 if err=s.ResolveReviewComment(ctx,viewer,uploaded.FileID,c.ID);!errors.Is(err,domain.ErrVersionConflict){t.Fatalf("double resolution: %v",err)}
 if err=s.ResolveReviewComment(ctx,admin,uploaded.FileID,c2.ID);err!=nil{t.Fatal(err)}
 if _,err=s.ReviewComments(ctx,viewer,uploaded.FileID,2,"malformed",10);!errors.Is(err,domain.ErrInvalidInput){t.Fatalf("bad cursor: %v",err)}
 if _,err=s.ReviewComments(ctx,viewer,"no-such-file",1,"",30);!errors.Is(err,domain.ErrNotFound){t.Fatalf("file visibility: %v",err)}
}
func TestDiffLinesAreBounded(t *testing.T){
 s,_:=testService(t)
 ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 first,err:=s.CommitUpload(ctx,admin,"folder_root","huge.txt","text/plain","",strings.NewReader(strings.Repeat("one\n",360)))
 if err!=nil{t.Fatal(err)}
 token,_,err:=s.AcquireLock(ctx,admin,first.FileID,1);if err!=nil{t.Fatal(err)}
 if _,err=s.Save(ctx,admin,first.FileID,[]byte(strings.Repeat("two\n",360)),1,token,"");err!=nil{t.Fatal(err)}
 out,err:=s.CompareVersions(ctx,admin,first.FileID,1,2)
 if err!=nil||out.Mode!="large"||len(out.Lines)!=0{t.Fatalf("unbounded comparison: %+v %v",out,err)}
}
