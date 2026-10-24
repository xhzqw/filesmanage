package postgres_test

import (
 "archive/zip"
 "bytes"
 "context"
 "crypto/sha256"
 "encoding/hex"
 "encoding/json"
 "fmt"
 "os"
 "os/exec"
 "strings"
 "testing"

 "filesmanage/internal/adapter/blob"
 "filesmanage/internal/adapter/postgres"
 "filesmanage/internal/application"
 "filesmanage/internal/domain"
 "filesmanage/internal/domain/dhf"

 "github.com/jackc/pgx/v5/pgxpool"
)

func dhfTestPDFBytes() []byte{
 var buf bytes.Buffer
 positions:=make([]int,6)
 buf.WriteString("%PDF-1.4\n")
 object:=func(n int,body string){
  positions[n]=buf.Len()
  fmt.Fprintf(&buf,"%d 0 obj\n%s\nendobj\n",n,body)
 }
 object(1,"<< /Type /Catalog /Pages 2 0 R >>")
 object(2,"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
 object(3,"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>")
 object(4,"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
 text:="BT /F1 14 Tf 40 150 Td (DHF frozen v1 PDF) Tj ET\n"
 object(5,fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream",len(text),text))
 start:=buf.Len()
 buf.WriteString("xref\n0 6\n0000000000 65535 f \n")
 for n:=1;n<=5;n++{fmt.Fprintf(&buf,"%010d 00000 n \n",positions[n])}
 fmt.Fprintf(&buf,"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n",start)
 return buf.Bytes()
}

func dhfTestDOCXBytes(t *testing.T)[]byte{
 t.Helper()
 files:=map[string]string{
  "[Content_Types].xml":`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  "_rels/.rels":`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  "word/document.xml":`<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>G5 frozen v1 DOCX</w:t></w:r></w:p></w:body></w:document>`,
 }
 var buffer bytes.Buffer
 writer:=zip.NewWriter(&buffer)
 for _,name:=range []string{"[Content_Types].xml","_rels/.rels","word/document.xml"}{
  part,err:=writer.Create(name);if err!=nil{t.Fatal(err)}
  if _,err=part.Write([]byte(files[name]));err!=nil{t.Fatal(err)}
 }
 if err:=writer.Close();err!=nil{t.Fatal(err)}
 return buffer.Bytes()
}

// Actual PostgreSQL + filesystem + isolated DOCX conversion + PDF rasterization.
// Same guarded DB prefix as the V0.6.3+ opt-in tests; NEVER uses production DB.
func TestDHFPilotFrozenPDFDOCXRealPostgres(t *testing.T){
 for _,binary:=range []string{"bwrap","soffice","pdftoppm"}{
  if _,err:=exec.LookPath(binary);err!=nil{t.Skip(binary+" unavailable")}
 }
 dsn:=os.Getenv("DHF_TEST_DATABASE_URL")
 if dsn==""{t.Skip("isolated test database not set")}
 ctx:=context.Background()
 pool,err:=pgxpool.New(ctx,dsn);if err!=nil{t.Fatal(err)}
 defer pool.Close()
 var database string
 if err=pool.QueryRow(ctx,"SELECT current_database()").Scan(&database);err!=nil{t.Fatal(err)}
 if !strings.HasPrefix(database,"filesmanage_dhf_v063_integration_"){
  t.Fatalf("refusing non-disposable DB %q",database)
 }
 insert:=func(query string,params ...any){
  t.Helper()
  if _,err:=pool.Exec(ctx,query,params...);err!=nil{t.Fatalf("fixture SQL: %v",err)}
 }
 sha:=func(data []byte)string{hash:=sha256.Sum256(data);return hex.EncodeToString(hash[:])}
 actor:="dhf_layout_author"
 for _,id:=range []string{actor,"dhf_layout_sw","dhf_layout_mf","dhf_layout_gate"}{
  insert("INSERT INTO users(id,login,display_name,password_hash) VALUES($1,$1,$1,'dummy')",id)
 }
 insert("INSERT INTO folders(id,name,owner_id) VALUES('dhf_layout_folder','G5 Freeze',$1)",actor)
 insert("INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by) VALUES('dhf_layout_owner_acl','dhf_layout_folder','user',$1,ARRAY['list','download','preview']::text[],$1)",actor)
 for _,user:=range []string{"dhf_layout_sw","dhf_layout_mf","dhf_layout_gate"}{
  insert("INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by) VALUES($1,'dhf_layout_folder','user',$2,ARRAY['list','preview']::text[],$3)",user+"-preview",user,actor)
 }
 root:=blob.New(t.TempDir())
 docs:=[]struct{id,requirement,name string;bytes []byte}{
  {"pdf","DHF-G5-SW","g5-v1.pdf",dhfTestPDFBytes()},
  {"docx","DHF-G5-MF","g5-v1.docx",dhfTestDOCXBytes(t)},
 }
 manifest:=make([]map[string]any,0,len(docs))
 for _,doc:=range docs {
  stage,stageErr:=root.Stage();if stageErr!=nil{t.Fatal(stageErr)}
  if _,stageErr=stage.Write(doc.bytes);stageErr!=nil{t.Fatal(stageErr)}
  key,_,stageErr:=stage.Commit();if stageErr!=nil{t.Fatal(stageErr)}
  sum:=sha(doc.bytes)
  insert("INSERT INTO blobs(id,storage_key,sha256,size_bytes,state) VALUES($1,$2,$3,$4,'ready')","dhf_layout_blob_"+doc.id,key,sum,len(doc.bytes))
  insert("INSERT INTO files(id,folder_id,name,uploaded_by) VALUES($1,'dhf_layout_folder',$2,$3)","dhf_layout_file_"+doc.id,doc.name,actor)
  insert("INSERT INTO file_versions(id,file_id,seq,blob_id,sha256,size_bytes,action,created_by) VALUES($1,$2,1,$3,$4,$5,'upload',$6)","dhf_layout_v1_"+doc.id,"dhf_layout_file_"+doc.id,"dhf_layout_blob_"+doc.id,sum,len(doc.bytes),actor)
  insert("UPDATE files SET current_version_seq=1 WHERE id=$1","dhf_layout_file_"+doc.id)
  manifest=append(manifest,map[string]any{
   "id":doc.requirement,"applicability":"applicable","file_id":"dhf_layout_file_"+doc.id,
   "version_seq":1,"sha256":sum,
  })
 }
 policy,err:=json.Marshal(map[string]any{
  "stage_id":"G5","conditional_allowed":false,
  "requirements":[]dhf.RequirementPolicy{
   {ID:"DHF-G5-SW",SpecialtyKey:"G5-SW",Mandatory:true,Critical:true},
   {ID:"DHF-G5-MF",SpecialtyKey:"G5-MF",Mandatory:true,Critical:true},
  },
  "dependencies":[]dhf.DependencyPolicy{},
  "specialties":[]dhf.SpecialtyPolicy{{Key:"G5-SW"},{Key:"G5-MF"}},
 });if err!=nil{t.Fatal(err)}
 body,err:=json.Marshal(map[string]any{"requirements":manifest});if err!=nil{t.Fatal(err)}
 insert("INSERT INTO dhf_pilot_templates(id,stage_id,policy_body,policy_sha,status,approved_by,approved_at) VALUES('dhf_layout_tpl','G5',$1,$2,'published',$3,now())",policy,sha(policy),actor)
 insert("INSERT INTO dhf_pilot_projects(id,owner_id,state) VALUES('dhf_layout_project',$1,'active')",actor)
 insert("INSERT INTO dhf_pilot_baselines(project_id,stage_id,template_id,active) VALUES('dhf_layout_project','G5','dhf_layout_tpl',true)")
 insert("INSERT INTO dhf_pilot_members(project_id,user_id,can_prepare,can_submit) VALUES('dhf_layout_project',$1,true,true)",actor)
 for _,u:=range []string{"dhf_layout_sw","dhf_layout_mf","dhf_layout_gate"}{
  insert("INSERT INTO dhf_pilot_members(project_id,user_id) VALUES('dhf_layout_project',$1)",u)
 }
 for _,assignment:=range [][2]string{{"G5-SW","dhf_layout_sw"},{"G5-MF","dhf_layout_mf"},{"__gate__","dhf_layout_gate"}}{
  insert("INSERT INTO dhf_pilot_review_assignments(project_id,stage_id,review_key,reviewer_id,configured_by) VALUES('dhf_layout_project','G5',$1,$2,$3)",assignment[0],assignment[1],actor)
 }
 insert("INSERT INTO dhf_pilot_attempts(id,project_id,stage_id,template_id,manifest_body,manifest_sha,created_by) VALUES('dhf_layout_attempt','dhf_layout_project','G5','dhf_layout_tpl',$1,$2,$3)",body,sha(body),actor)
 svc:=application.New(postgres.New(pool),dhfTestBlobAdapter{Store:root})
 result,err:=svc.DHFPilotSubmit(ctx,domain.User{ID:actor},"dhf_layout_attempt","dhf-layout-submit-0001")
 if err!=nil||result.Verdict!=dhf.Allow{t.Fatalf("G5 layout submission: %+v %v",result,err)}
 tests:=[]struct{reviewKey,reviewer,requirement string}{
  {"G5-SW","dhf_layout_sw","DHF-G5-SW"},
  {"G5-MF","dhf_layout_mf","DHF-G5-MF"},
 }
 for _,test:=range tests{
  var taskID string
  if err=pool.QueryRow(ctx,"SELECT id FROM dhf_pilot_workbench_tasks WHERE submission_id=$1 AND review_key=$2",result.SubmissionID,test.reviewKey).Scan(&taskID);err!=nil{t.Fatal(err)}
  user:=domain.User{ID:test.reviewer}
  count,pageErr:=svc.DHFPilotFrozenPages(ctx,user,taskID,test.requirement)
  if pageErr!=nil||count<1{t.Fatalf("%s page count %d %v",test.reviewKey,count,pageErr)}
  png,pageErr:=svc.DHFPilotFrozenPage(ctx,user,taskID,test.requirement,1)
  if pageErr!=nil||!bytes.HasPrefix(png,[]byte{137,80,78,71,13,10,26,10}){
   t.Fatalf("%s page not actual PNG: %v",test.reviewKey,pageErr)
  }
  if _,pageErr=svc.DHFPilotFrozenPage(ctx,user,taskID,test.requirement,count+1);pageErr==nil{
   t.Fatalf("%s accepted out-of-range frozen page",test.reviewKey)
  }
  // Move Finder's current pointer to v2 AFTER DHF's v1 evidence was frozen.
  changed:=[]byte("this version 2 is not a valid historical PDF/DOCX")
  stage,stageErr:=root.Stage();if stageErr!=nil{t.Fatal(stageErr)}
  if _,stageErr=stage.Write(changed);stageErr!=nil{t.Fatal(stageErr)}
  storageKey,_,stageErr:=stage.Commit();if stageErr!=nil{t.Fatal(stageErr)}
  ext:=test.reviewKey
  blobID:="dhf_layout_new_blob_"+ext
  fileID:="dhf_layout_file_pdf"
  if ext=="G5-MF"{fileID="dhf_layout_file_docx"}
  insert("INSERT INTO blobs(id,storage_key,sha256,size_bytes,state) VALUES($1,$2,$3,$4,'ready')",blobID,storageKey,sha(changed),len(changed))
  insert("INSERT INTO file_versions(id,file_id,seq,blob_id,sha256,size_bytes,action,created_by) VALUES($1,$2,2,$3,$4,$5,'edit',$6)","dhf_layout_v2_"+ext,fileID,blobID,sha(changed),len(changed),actor)
  insert("UPDATE files SET current_version_seq=2 WHERE id=$1",fileID)
  countAfter,pageErr:=svc.DHFPilotFrozenPages(ctx,user,taskID,test.requirement)
  if pageErr!=nil||countAfter!=count{t.Fatalf("%s followed v2: %d %v",test.reviewKey,countAfter,pageErr)}
  if _,pageErr=svc.DHFPilotFrozenPages(ctx,domain.User{ID:actor},taskID,test.requirement);pageErr==nil{
   t.Fatalf("%s submitter used someone else's assigned task",test.reviewKey)
  }
  insert("DELETE FROM acls WHERE id=$1",test.reviewer+"-preview")
  if _,pageErr=svc.DHFPilotFrozenPage(ctx,user,taskID,test.requirement,1);pageErr==nil{
   t.Fatalf("%s bypassed revoked original file preview permission",test.reviewKey)
  }
 }
 fmt.Println("DHF_V069_PDF_DOCX_POSTGRES_PASS")
}
