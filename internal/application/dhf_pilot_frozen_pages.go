package application

import (
 "bytes"
 "context"
 "crypto/sha256"
 "encoding/hex"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
 "io"

 "rsc.io/pdf"
)

// These pages are generated from the immutable DHF evidence Blob, NEVER
// Finder's mutable current-version pointer or any current signature overlay.
// PDF uses the existing rasterizer; DOCX uses the existing isolated Office
// conversion and then that same rasterizer. All bytes are checksum verified
// BEFORE parsing, conversion, caching or serving a page.
type dhfReadSeekCloser struct{ *bytes.Reader }
func(dhfReadSeekCloser)Close()error{return nil}

func(s *Service) dhfPilotFrozenPDF(ctx context.Context,actor domain.User,taskID,requirementID string)([]byte,int,error){
 if actor.ID==""||taskID==""||requirementID==""{return nil,0,domain.ErrNotFound}
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return nil,0,err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotEvidenceStore)
 if !ok{return nil,0,errors.New("DHF evidence adapter missing")}
 if err=store.DHFPilotBeginSnapshot(ctx);err!=nil{return nil,0,err}
 bound,err:=s.dhfEvidenceTx(ctx,tx,store,actor,taskID)
 if err!=nil{return nil,0,err}
 for _,item:=range bound{
  if item.Pin.RequirementID!=requirementID{continue}
  ext:=extensionOf(item.File.Name)
  limit:=int64(maxDocumentPDFPreviewBytes)
  if ext==".docx"{limit=maxOfficeSourceBytes}
  if (ext!=".pdf"&&ext!=".docx")||item.Blob.SizeBytes<8||item.Blob.SizeBytes>limit{
   return nil,0,ErrPreviewUnsupported
  }
  if s.blobs==nil{return nil,0,ErrPreviewUnsupported}
  reader,openErr:=s.blobs.Open(item.Blob.StorageKey)
  if openErr!=nil{return nil,0,errors.New("DHF frozen evidence source missing")}
  raw,readErr:=io.ReadAll(io.LimitReader(reader,limit+1))
  _=reader.Close()
  if readErr!=nil{return nil,0,readErr}
  hash:=sha256.Sum256(raw)
  if ctx.Err()!=nil{return nil,0,ctx.Err()}
  if int64(len(raw))!=item.Blob.SizeBytes||hex.EncodeToString(hash[:])!=item.Pin.Sha256{
   return nil,0,errors.New("DHF frozen evidence bytes changed")
  }
  return s.dhfFrozenPDFBytes(ctx,item.File.Name,item.Pin.Sha256,raw)
 }
 return nil,0,domain.ErrNotFound
}

// The derivative path is shared by fixed file-version preview and layout
// regression tests. Its input is an already authenticated and hashed
// immutable document; unlike OfficePDFPreview it never reopens latest.
func(s *Service) dhfFrozenPDFBytes(ctx context.Context,fileName,sourceSHA string,raw []byte)([]byte,int,error){
 ext:=extensionOf(fileName)
 if ext!=".docx"&&ext!=".pdf"{return nil,0,ErrPreviewUnsupported}
 if ext==".pdf"&&(len(raw)>maxDocumentPDFPreviewBytes||len(raw)<8){return nil,0,ErrPreviewUnsupported}
 if ext==".docx"&&(len(raw)>maxOfficeSourceBytes||len(raw)<8){return nil,0,ErrPreviewUnsupported}
 pdfBytes:=raw
 if ext==".docx"{
   // The captured immutable bytes are used even if an administrator moves or
   // deletes the source after the integrity check. No second/latest read.
   key:="dhf-frozen-docx|"+sourceSHA
   pdfBytes,err=s.cachedOfficePDF(ctx,key,func(workCtx context.Context)([]byte,error){
    return renderOfficePDFSource(workCtx,Download{
     FileName:fileName,Size:int64(len(raw)),Sha256:sourceSHA,
     Reader:dhfReadSeekCloser{Reader:bytes.NewReader(raw)},
    })
   })
   if err!=nil{return nil,0,err}
  }
  if len(pdfBytes)<8||len(pdfBytes)>maxOfficePDFBytes||!bytes.HasPrefix(pdfBytes,[]byte("%PDF-")){
   return nil,0,ErrPreviewUnsupported
  }
  document,parseErr:=pdf.NewReader(bytes.NewReader(pdfBytes),int64(len(pdfBytes)))
  if parseErr!=nil||document.NumPage()<1||document.NumPage()>1000{
   return nil,0,ErrPreviewUnsupported
  }
  return pdfBytes,document.NumPage(),nil
}

func(s *Service) DHFPilotFrozenPages(ctx context.Context,actor domain.User,taskID,requirementID string)(int,error){
 _,count,err:=s.dhfPilotFrozenPDF(ctx,actor,taskID,requirementID)
 return count,err
}

func(s *Service) DHFPilotFrozenPage(ctx context.Context,actor domain.User,taskID,requirementID string,page int)([]byte,error){
 if page<1||page>1000{return nil,domain.ErrInvalidInput}
 raw,count,err:=s.dhfPilotFrozenPDF(ctx,actor,taskID,requirementID)
 if err!=nil{return nil,err}
 if page>count{return nil,domain.ErrInvalidInput}
 return renderPDFPagePNG(ctx,raw,page)
}
