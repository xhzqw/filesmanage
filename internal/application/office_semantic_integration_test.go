package application

import(
 "bytes"
 "context"
 "errors"
 "filesmanage/internal/domain"
 "testing"
)

func TestSemanticVersionDiffIsACLScoped(t *testing.T){
 s,_:=testService(t);ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 viewer:=domain.User{ID:"u_user"}
 create:=func(text string)[]byte{return makePreviewZIP(t,map[string]string{
  "word/document.xml":`<document><body><p><r><t>Header</t></r></p><p><r><t>`+text+`</t></r></p></body></document>`,
 })}
 orig:=create("Review 1");newer:=create("Review 2")
 uploaded,err:=s.CommitUpload(ctx,admin,"folder_root","semantic.docx","application/vnd.openxmlformats-officedocument.wordprocessingml.document","",bytes.NewReader(orig))
 if err!=nil{t.Fatal(err)}
 lock,_,err:=s.AcquireLock(ctx,admin,uploaded.FileID,1)
 if err!=nil{t.Fatal(err)}
 if _,err=s.Save(ctx,admin,uploaded.FileID,newer,1,lock,"");err!=nil{t.Fatal(err)}
 result,err:=s.CompareVersions(ctx,admin,uploaded.FileID,1,2)
 if err!=nil||result.Mode!="text"||result.Detail!="office_semantic"||result.Added==0||result.Removed==0{
  t.Fatalf("not semantic %+v %v",result,err)
 }
 if _,err=s.CompareVersions(ctx,viewer,uploaded.FileID,1,2);!errors.Is(err,domain.ErrForbidden){
  t.Fatalf("non-reader accessed semantic diff %v",err)
 }
}
