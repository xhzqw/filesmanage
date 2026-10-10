package application
import("context";"errors";"filesmanage/internal/domain";"fmt";"testing")
func TestResumableConcurrentSessionQuota(t *testing.T){
 s,_:=testService(t);ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 ids:=make([]string,0,3)
 for i:=0;i<3;i++{
  v,err:=s.StartResumableUpload(ctx,admin,"folder_root",fmt.Sprintf("quota-%d.dat",i),"application/octet-stream",fmt.Sprintf("quota-key-test-%d",i),"",1)
  if err!=nil{t.Fatal(err)}
  ids=append(ids,v.ID)
 }
 if _,err:=s.StartResumableUpload(ctx,admin,"folder_root","quota-fourth.dat","application/octet-stream","quota-key-test-fourth","",1);!errors.Is(err,domain.ErrInvalidInput){t.Fatalf("no session quota: %v",err)}
 if err:=s.CancelResumableUpload(ctx,admin,ids[1]);err!=nil{t.Fatal(err)}
 if _,err:=s.StartResumableUpload(ctx,admin,"folder_root","quota-fourth.dat","application/octet-stream","quota-key-test-fourth","",1);err!=nil{t.Fatalf("quota slot not released: %v",err)}
}
