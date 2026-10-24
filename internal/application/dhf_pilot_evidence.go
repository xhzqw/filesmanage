package application

import (
 "context"
 "errors"
 "filesmanage/internal/domain"
 "filesmanage/internal/ports"
)

type DHFPilotEvidenceItem struct {
 RequirementID string `json:"requirementId"`
 FileID string `json:"fileId"`
 FileName string `json:"fileName"`
 VersionSeq int `json:"versionSeq"`
 Sha256 string `json:"sha256"`
 SizeBytes int64 `json:"sizeBytes"`
}

type dhfEvidenceBound struct {
 Pin ports.DHFPilotEvidencePin
 File domain.File
 Blob domain.Blob
}

// Every request checks both recipient assignment and actual file ACL.
// A DHF review task never implicitly grants access to a document.
func (s *Service) dhfEvidenceTx(ctx context.Context,tx ports.Tx,store ports.DHFPilotEvidenceStore,actor domain.User,taskID string)([]dhfEvidenceBound,error){
 trusted,err:=tx.UserByID(ctx,actor.ID)
 if err!=nil || trusted.ID!=actor.ID || trusted.DisabledAt!=nil{return nil,domain.ErrForbidden}
 pins,err:=store.DHFPilotEvidenceForReviewer(ctx,taskID,actor.ID)
 if errors.Is(err,ports.ErrRowMissing){return nil,domain.ErrNotFound}
 if err!=nil{return nil,err}
 result:=make([]dhfEvidenceBound,0,len(pins))
 for _,pin:=range pins {
  file,err:=s.visibleFile(ctx,tx,trusted,pin.FileID,domain.ActionPreview)
  if err!=nil{return nil,err}
  version,err:=tx.VersionBySeq(ctx,pin.FileID,pin.VersionSeq)
  if err!=nil || version.Sha256!=pin.Sha256 || version.BlobID!=pin.BlobID{
   return nil,errors.New("DHF pinned evidence version identity mismatch")
  }
  blob,err:=tx.BlobByID(ctx,pin.BlobID)
  if err!=nil || blob.State!="ready" || blob.Sha256!=pin.Sha256 {
   return nil,errors.New("DHF pinned evidence Blob identity mismatch")
  }
  result=append(result,dhfEvidenceBound{Pin:pin,File:file,Blob:blob})
 }
 return result,nil
}

// DHFPilotReviewerEvidence is an ACL-checked list of exact historical
// file versions; it never falls back to the mutable latest version pointer.
func(s *Service) DHFPilotReviewerEvidence(ctx context.Context,actor domain.User,taskID string)([]DHFPilotEvidenceItem,error){
 if actor.ID==""||taskID=="" {return nil,domain.ErrNotFound}
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return nil,err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotEvidenceStore)
 if !ok{return nil,errors.New("DHF evidence transaction unavailable")}
 if err=store.DHFPilotBeginSnapshot(ctx);err!=nil{return nil,err}
 bound,err:=s.dhfEvidenceTx(ctx,tx,store,actor,taskID)
 if err!=nil{return nil,err}
 items:=make([]DHFPilotEvidenceItem,0,len(bound))
 for _,item:=range bound {
  items=append(items,DHFPilotEvidenceItem{
    RequirementID:item.Pin.RequirementID,FileID:item.Pin.FileID,
    FileName:item.File.Name,VersionSeq:item.Pin.VersionSeq,
    Sha256:item.Pin.Sha256,SizeBytes:item.Blob.SizeBytes,
  })
 }
 return items,nil
}

// DHFPilotReviewerEvidencePreview revalidates the reviewer, file preview
// rights, exact immutable file+Blob tuple AND physical content digest.
// previewBlob provides bounded text/structured metadata, not a false
// claim that complex Office/PDF layouts were rendered as exact evidence.
func(s *Service) DHFPilotReviewerEvidencePreview(ctx context.Context,actor domain.User,taskID,requirementID string)(Preview,error){
 if actor.ID==""||taskID==""||requirementID==""{return Preview{},domain.ErrNotFound}
 tx,err:=s.uow.Begin(ctx)
 if err!=nil{return Preview{},err}
 defer tx.Rollback(ctx)
 store,ok:=any(tx).(ports.DHFPilotEvidenceStore)
 if !ok{return Preview{},errors.New("DHF evidence preview transaction unavailable")}
 if err=store.DHFPilotBeginSnapshot(ctx);err!=nil{return Preview{},err}
 bound,err:=s.dhfEvidenceTx(ctx,tx,store,actor,taskID)
 if err!=nil{return Preview{},err}
 for _,item:=range bound {
  if item.Pin.RequirementID!=requirementID{continue}
  if err=verifyDHFPilotPhysicalBlob(ctx,s.blobs,item.Blob.StorageKey,item.Pin.Sha256,item.Blob.SizeBytes);err!=nil{
   return Preview{},errors.New("DHF physical evidence content integrity verification failed")
  }
  return s.previewBlob(item.File,item.Blob)
 }
 return Preview{},domain.ErrNotFound
}
