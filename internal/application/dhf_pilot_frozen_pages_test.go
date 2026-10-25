package application

import (
 "bytes"
 "context"
 "crypto/sha256"
 "encoding/hex"
 "os/exec"
 "testing"
)

func TestDHFExactPinnedDOCXAndPDFPageRenderer(t *testing.T){
 for _,bin:=range []string{"bwrap","soffice","pdftoppm"}{
  if _,err:=exec.LookPath(bin);err!=nil{t.Skip(bin+" not available")}
 }
 service,_:=testService(t)
 ctx:=context.Background()
 docx:=testOfficeDocumentZIP(t)
 hash:=sha256.Sum256(docx)
 pdfBytes,pages,err:=service.dhfFrozenPDFBytes(ctx,"historical-v1.docx",hex.EncodeToString(hash[:]),docx)
 if err!=nil||pages<1{t.Fatalf("frozen DOCX render failed: pages=%d err=%v",pages,err)}
 if !bytes.HasPrefix(pdfBytes,[]byte("%PDF-")){t.Fatal("DOCX derivative was not a PDF")}
 png,err:=renderPDFPagePNG(ctx,pdfBytes,1)
 if err!=nil||!bytes.HasPrefix(png,[]byte{137,80,78,71,13,10,26,10}){
  t.Fatalf("DOCX derivative did not rasterize: %v",err)
 }
 pdfHash:=sha256.Sum256(pdfBytes)
 originalPDF,pdfPages,err:=service.dhfFrozenPDFBytes(ctx,"historical-v1.pdf",hex.EncodeToString(pdfHash[:]),pdfBytes)
 if err!=nil||pdfPages!=pages||!bytes.Equal(pdfBytes,originalPDF){
  t.Fatalf("pinned original PDF not reused exactly: pages=%d err=%v",pdfPages,err)
 }
 if _,_,err=service.dhfFrozenPDFBytes(ctx,"unknown.html","",[]byte("<html>danger</html>"));err==nil{
  t.Fatal("unsupported untrusted Office/HTML document accepted")
 }
 if _,_,err=service.dhfFrozenPDFBytes(ctx,"fake.pdf","",[]byte("%PDF-fake"));err==nil{
  t.Fatal("syntactically invalid PDF accepted")
 }
}
