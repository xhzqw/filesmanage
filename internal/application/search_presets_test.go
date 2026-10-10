package application

import(
 "context"
 "encoding/json"
 "filesmanage/internal/domain"
 "fmt"
 "testing"
)
func TestSearchPresetsIsolateOwnerAndCap(t *testing.T){
 s,_:=testService(t);ctx:=context.Background()
 a:=domain.User{ID:"u_admin",IsAdmin:true}; b:=domain.User{ID:"u_user"}
 fields:=json.RawMessage(`{"q":"workflow","category":"","tag":"","uploader":"","type":"","sort":"updated_desc","limit":50,"scope":"all","folder":"","from":"","to":""}`)
 for i:=0;i<12;i++{
  name:=fmt.Sprintf("saved-%d",i)
  if _,err:=s.SaveSearchPreset(ctx,a,domain.SearchPreset{Name:name,Fields:fields});err!=nil{t.Fatal(err)}
 }
 if _,err:=s.SaveSearchPreset(ctx,a,domain.SearchPreset{Name:"extra",Fields:fields});err==nil{t.Fatal("allowed thirteenth preset")}
 if _,err:=s.SaveSearchPreset(ctx,a,domain.SearchPreset{Name:"saved-0",Fields:fields});err!=nil{t.Fatal(err)}
 own,err:=s.ListSearchPresets(ctx,a);if err!=nil||len(own)!=12{t.Fatalf("own %d %v",len(own),err)}
 other,err:=s.ListSearchPresets(ctx,b);if err!=nil||len(other)!=0{t.Fatalf("cross user %v %v",other,err)}
 if err:=s.RemoveSearchPreset(ctx,b,"saved-0");err!=domain.ErrNotFound{t.Fatalf("cross-user deletion %v",err)}
 if err:=s.RemoveSearchPreset(ctx,a,"saved-0");err!=nil{t.Fatal(err)}
 if _,err:=s.SaveSearchPreset(ctx,a,domain.SearchPreset{Name:"extra",Fields:fields});err!=nil{t.Fatal(err)}
 if _,err:=s.SaveSearchPreset(ctx,a,domain.SearchPreset{Name:"bad",Fields:json.RawMessage(`{"q":"bad"}`)});err!=domain.ErrInvalidInput{t.Fatalf("bad input %v",err)}
}
