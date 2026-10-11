package application

import (
 "context"
 "encoding/base64"
 "filesmanage/internal/domain"
 "strings"
 "testing"
 "time"
)

func TestSearchRelevanceRanksAndStableKeysets(t *testing.T) {
 s,repo:=testService(t)
 admin:=adminUser()
 base:=time.Date(2026,10,12,12,0,0,0,time.UTC)
 for _,f:=range []struct{id,name string;minutes int}{
  {"r_exact_a","预算",1},
  {"r_exact_b","预算",1}, // same rank/time: file id breaks ties
  {"r_contains_new","年度预算.txt",110},
  {"r_contains_old","预算方案.txt",2},
  {"r_text_new","其他材料.txt",200},
  {"r_text_old","历史材料.txt",30},
 }{
  seedSearchFile(repo,f.id,f.name,10,base.Add(time.Duration(f.minutes)*time.Minute))
 }
 for _,id:=range []string{"r_text_new","r_text_old"} {
  if err:=repo.UpsertFileText(context.Background(),id,1,"本月预算研究",SpaceCJK("本月预算研究"));err!=nil{t.Fatal(err)}
 }
 expected:=[]string{"r_exact_b","r_exact_a","r_contains_new","r_contains_old","r_text_new","r_text_old"}
 cursor:=""
 var got []string
 for page:=0;page<8;page++ {
  result,err:=s.Search(context.Background(),admin,SearchFilter{FolderID:"folder_market",Query:"预算",Sort:"relevance",Cursor:cursor,Limit:2})
  if err!=nil{t.Fatal(err)}
  if result.Total!=len(expected){t.Fatalf("page %d total=%d",page,result.Total)}
  for _,f:=range result.Items{got=append(got,f.ID)}
  if result.NextCursor==""{break}
  decoded:=DecodeFileCursor("relevance",result.NextCursor)
  if decoded.ID==""||decoded.Rank<0||decoded.Rank>2{t.Fatalf("invalid tier cursor: %+v",decoded)}
  cursor=result.NextCursor
 }
 if strings.Join(got,",")!=strings.Join(expected,","){t.Fatalf("relevance pages mismatch got=%v want=%v",got,expected)}
 // Choosing the legacy recency sort must remain a real override, not a
 // client-side reorder of a relevance-ranked first page.
 legacy,err:=s.Search(context.Background(),admin,SearchFilter{FolderID:"folder_market",Query:"预算",Sort:"updated_desc",Limit:2})
 if err!=nil{t.Fatal(err)}
 if len(legacy.Items)!=2||legacy.Items[0].ID!="r_text_new"||legacy.Items[1].ID!="r_contains_new" {
  t.Fatalf("explicit newest sort was overridden: %+v",legacy.Items)
 }
 if searchFilenameRank("预算","预算")!=0||searchFilenameRank("年度预算.txt","预算")!=1||
    searchFilenameRank("其他材料.txt","预算")!=2 {t.Fatal("search tier classifier drift")}
}

func TestRelevanceCursorRejectsMalformedInput(t *testing.T){
 timestamp:=time.Date(2026,10,12,10,30,0,0,time.UTC)
 for tier:=0;tier<=2;tier++{
  file:=domain.File{ID:"file_x",UpdatedAt:timestamp,SearchRank:tier}
  token:=encodeCursor("relevance",file)
  parsed:=DecodeFileCursor("relevance",token)
  if parsed.ID!=file.ID||parsed.Rank!=tier||!parsed.Time.Equal(timestamp) {t.Fatalf("tier %d cursor %+v",tier,parsed)}
 }
 for _,raw:=range []string{"", "not-base64",base64.RawURLEncoding.EncodeToString([]byte("3\x1f2026-10-12T10:30:00Z\x1ffile_x")),
  base64.RawURLEncoding.EncodeToString([]byte("1\x1finvalid-date\x1ffile_x")),
  base64.RawURLEncoding.EncodeToString([]byte("1\x1f2026-10-12T10:30:00Z"))} {
  if got:=DecodeFileCursor("relevance",raw);got.ID!=""{t.Fatalf("invalid cursor %q accepted: %+v",raw,got)}
 }
}
