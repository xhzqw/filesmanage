package application

import(
 "bytes"
 "context"
 "errors"
 "fmt"
 "filesmanage/internal/domain"
 "strings"
 "testing"
)

func TestDocumentMetadataAndActivityAccess(t *testing.T){
 s,_:=testService(t);ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",IsAdmin:true}
 viewer:=domain.User{ID:"u_user"}
 result,err:=s.CommitUpload(ctx,admin,"folder_market","business-test.txt","text/plain","",strings.NewReader("business test"))
 if err!=nil{t.Fatal(err)}
 empty,err:=s.FileMetadata(ctx,admin,result.FileID);if err!=nil||empty.Category!=""||len(empty.Tags)!=0{t.Fatalf("empty metadata: %+v %v",empty,err)}
 updated,err:=s.SetFileMetadata(ctx,admin,result.FileID,domain.FileMetadata{
  Category:" 工程图纸 ",Tags:[]string{" 待审核 ","待审核","重点"},Description:"计划摘要",
 })
 if err!=nil{t.Fatal(err)}
 if updated.Category!="工程图纸"||len(updated.Tags)!=2{t.Fatalf("normalized metadata %+v",updated)}
 if _,err:=s.SetFileMetadata(ctx,admin,result.FileID,domain.FileMetadata{Category:strings.Repeat("X",81)});!errors.Is(err,domain.ErrInvalidInput){t.Fatalf("invalid category accepted: %v",err)}
 if _,err:=s.FileMetadata(ctx,viewer,result.FileID);!errors.Is(err,domain.ErrForbidden)&&!errors.Is(err,domain.ErrNotFound){t.Fatalf("metadata read leak: %v",err)}
 if _,err:=s.SetFileMetadata(ctx,viewer,result.FileID,domain.FileMetadata{Category:"secret"});!errors.Is(err,domain.ErrForbidden)&&!errors.Is(err,domain.ErrNotFound){t.Fatalf("unauthorized metadata edit: %v",err)}
 page,err:=s.Search(ctx,admin,SearchFilter{Category:"工程图纸",Tag:"重点",Limit:10})
 if err!=nil||len(page.Items)!=1{t.Fatalf("category filter: %+v %v",page,err)}
 page,err=s.Search(ctx,admin,SearchFilter{Category:"其他",Limit:10})
 if err!=nil||len(page.Items)!=0{t.Fatalf("category mismatch: %+v %v",page,err)}
 activity,err:=s.ListDocumentAudit(ctx,admin,"",1,result.FileID,"","file.")
 if err!=nil||len(activity.Items)!=1||activity.Items[0].EventType!="file.metadata_update"{t.Fatalf("activity: %+v %v",activity,err)}
 if _,err=s.ListDocumentAudit(ctx,viewer,"",10,"","","");!errors.Is(err,domain.ErrForbidden){t.Fatalf("non-auditor activity leak: %v",err)}
 if _,err=s.ListDocumentAudit(ctx,admin,"broken",10,"","","");!errors.Is(err,domain.ErrInvalidInput){t.Fatalf("invalid cursor accepted: %v",err)}
}

// Standard single-page, unencrypted PDF with a text layer (no OCR).
func makeTextPDF(t *testing.T,label string)[]byte{
 t.Helper()
 stream:="BT /F1 12 Tf 72 720 Td ("+label+") Tj ET"
 objs:=[]string{
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream",len(stream),stream),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
 }
 var buf bytes.Buffer
 buf.WriteString("%PDF-1.4\n")
 offsets:=[]int{0}
 for i,obj:=range objs{
  offsets=append(offsets,buf.Len())
  fmt.Fprintf(&buf,"%d 0 obj\n%s\nendobj\n",i+1,obj)
 }
 xref:=buf.Len()
 fmt.Fprintf(&buf,"xref\n0 %d\n0000000000 65535 f \n",len(offsets))
 for _,off:=range offsets[1:]{fmt.Fprintf(&buf,"%010d 00000 n \n",off)}
 fmt.Fprintf(&buf,"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n",len(offsets),xref)
 return buf.Bytes()
}
func TestPDFTextLayerBoundedExtraction(t *testing.T){
 raw:=makeTextPDF(t,"BUDGET2026")
 got:=ExtractText("annual.pdf","application/pdf",raw)
 if !strings.Contains(got,"BUDGET2026"){t.Fatalf("PDF text missing: %q",got)}
 if ExtractText("bad.pdf","application/pdf",[]byte("junk"))!=""{t.Fatal("invalid PDF contributed text")}
 if pdfTextLayer(bytes.Repeat([]byte{'A'},maxPDFIndexSource+1))!=""{t.Fatal("oversized PDF contributed text")}
}
