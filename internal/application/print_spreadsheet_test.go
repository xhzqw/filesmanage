package application

import (
 "archive/zip"
 "bytes"
 "context"
 "io"
 "os/exec"
 "strings"
 "testing"

 "filesmanage/internal/domain"
)

func testMultiSheetWorkbook(t *testing.T)[]byte{
 t.Helper()
 return makePreviewZIP(t,map[string]string{
  "[Content_Types].xml":`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
  "_rels/.rels":`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  "xl/workbook.xml":`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="收入数据" sheetId="1" r:id="rId1"/><sheet name="Expenses" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels":`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
  "xl/worksheets/sheet1.xml":`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>OnlyIncome</t></is></c></row></sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml":`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>OnlyExpenses</t></is></c></row></sheetData></worksheet>`,
 })
}

func TestPrintSpreadsheetSelectionPreservesOriginal(t *testing.T){
 raw:=testMultiSheetWorkbook(t)
 sheets,err:=workbookSheets(raw)
 if err!=nil||len(sheets)!=2||sheets[0].name!="收入数据"||sheets[1].name!="Expenses"{
  t.Fatalf("sheet metadata: %+v %v",sheets,err)
 }
 patched,err:=selectWorkbookSheet(raw,"Expenses")
 if err!=nil{t.Fatal(err)}
 if !bytes.Contains(raw,[]byte(`name="收入数据" sheetId="1"`)){
  t.Fatal("immutable workbook source was modified")
 }
 zr,err:=zip.NewReader(bytes.NewReader(patched),int64(len(patched)))
 if err!=nil{t.Fatal(err)}
 var xml string
 for _,f:=range zr.File {
  if f.Name=="xl/workbook.xml" {
   stream,e:=f.Open()
   if e!=nil{t.Fatal(e)}
   result,e:=io.ReadAll(stream);stream.Close()
   if e!=nil{t.Fatal(e)}
   xml=string(result)
  }
 }
 if !strings.Contains(xml,`name="收入数据" sheetId="1" r:id="rId1" state="hidden"`) ||
  !strings.Contains(xml,`name="Expenses" sheetId="2" r:id="rId2" state="visible"`) {
  t.Fatalf("wrong sheet visibility in temporary print package: %s",xml)
 }
 if _,err=selectWorkbookSheet(raw,"nonexistent");err==nil{t.Fatal("unknown sheet selected")}
 if _,err=selectWorkbookSheet(raw,"收入数据<evil>");err==nil{t.Fatal("untrusted sheet name")}
}

func TestBrowserPrintSpecificWorkbookSheetUnderPrintACL(t *testing.T){
 for _,tool:=range []string{"bwrap","soffice","pdftotext"}{
  if _,err:=exec.LookPath(tool);err!=nil{t.Skip(tool+" unavailable")}
 }
 s,_:=testService(t)
 ctx:=context.Background()
 admin:=domain.User{ID:"u_admin",Login:"admin",IsAdmin:true}
 member:=domain.User{ID:"u_user",Login:"user1"}
 upload,err:=s.CommitUpload(ctx,admin,"folder_market","Workbook.xlsx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","",bytes.NewReader(testMultiSheetWorkbook(t)))
 if err!=nil{t.Fatal(err)}
 if _,err=s.BrowserPrintSheets(ctx,member,upload.FileID,upload.Sha256);err!=domain.ErrForbidden {
  t.Fatalf("unshared worksheet names leaked: %v",err)
 }
 grant,err:=s.CreateShare(ctx,admin,ShareDraft{ResourceKind:"file",ResourceID:upload.FileID,
  RecipientKind:"user",RecipientID:member.ID,Actions:[]domain.Action{domain.ActionPreview,domain.ActionPrint}})
 if err!=nil{t.Fatal(err)}
 names,err:=s.BrowserPrintSheets(ctx,member,upload.FileID,upload.Sha256)
 if err!=nil||len(names)!=2||names[0].Name!="收入数据" {t.Fatalf("sheet choices: %+v %v",names,err)}
 if _,done,e:=s.OpenDownload(ctx,member,upload.FileID);e==nil{done();t.Fatal("print leaked source bytes")}
 pdf,err:=s.BrowserPrintOfficePDFSheet(ctx,member,upload.FileID,upload.Sha256,"Expenses")
 if err!=nil{t.Fatal(err)}
 cmd:=exec.Command("pdftotext","-layout","-","-")
 cmd.Stdin=bytes.NewReader(pdf)
 printed,err:=cmd.Output()
 if err!=nil{t.Fatal(err)}
 if !strings.Contains(string(printed),"OnlyExpenses")||strings.Contains(string(printed),"OnlyIncome"){
  t.Fatalf("wrong Excel sheet included in printed PDF: %q",string(printed))
 }
 if err=s.RevokeShare(ctx,admin,grant.ID);err!=nil{t.Fatal(err)}
 if _,err=s.BrowserPrintSheets(ctx,member,upload.FileID,upload.Sha256);err!=domain.ErrForbidden {
  t.Fatalf("sheet listing retained after revoke: %v",err)
 }
}
