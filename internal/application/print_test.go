package application

import (
 "bytes"
 "context"
 "errors"
 "testing"

 "filesmanage/internal/domain"
)

func TestBrowserPrintRequiresBothActionsAndCurrentDigest(t *testing.T) {
 service, _ := testService(t)
 ctx := context.Background()
 admin := domain.User{ID:"u_admin",Login:"admin",IsAdmin:true}
 member := domain.User{ID:"u_user",Login:"user1"}
 source := append([]byte("%PDF-1.7\n"),bytes.Repeat([]byte("sample\n"),40)...)
 upload,err := service.CommitUpload(ctx,admin,"folder_market","review.pdf","application/pdf","",bytes.NewReader(source))
 if err != nil {t.Fatal(err)}
 if _,err=service.PrepareBrowserPrint(ctx,member,upload.FileID,upload.Sha256);!errors.Is(err,domain.ErrForbidden) {
  t.Fatalf("unshared file must not print: %v",err)
 }
 preview,err:=service.CreateGrant(ctx,admin,"folder_market",GrantRequest{
  SubjectKind:"user",SubjectID:member.ID,Actions:[]domain.Action{domain.ActionPreview},
 })
 if err!=nil {t.Fatal(err)}
 if _,err=service.PrepareBrowserPrint(ctx,member,upload.FileID,upload.Sha256);!errors.Is(err,domain.ErrForbidden) {
  t.Fatalf("preview grant cannot print: %v",err)
 }
 if err=service.RevokeGrant(ctx,admin,preview.ID);err!=nil {t.Fatal(err)}
 printer,err:=service.CreateGrant(ctx,admin,"folder_market",GrantRequest{
  SubjectKind:"user",SubjectID:member.ID,Actions:[]domain.Action{domain.ActionPrint},
 })
 if err!=nil {t.Fatal(err)}
 if _,err=service.PrepareBrowserPrint(ctx,member,upload.FileID,upload.Sha256);!errors.Is(err,domain.ErrForbidden) {
  t.Fatalf("print grant without preview must not print: %v",err)
 }
 if _,err=service.CreateGrant(ctx,admin,"folder_market",GrantRequest{
  SubjectKind:"user",SubjectID:member.ID,Actions:[]domain.Action{domain.ActionPreview},
 });err!=nil {t.Fatal(err)}
 if _,err=service.PrepareBrowserPrint(ctx,member,upload.FileID,string(bytes.Repeat([]byte("a"),64)));err==nil {
  t.Fatal("stale digest should fail")
 }
 prepared,err:=service.PrepareBrowserPrint(ctx,member,upload.FileID,upload.Sha256)
 if err!=nil {t.Fatal(err)}
 if prepared.VersionSeq!=1||prepared.Sha256!=upload.Sha256 {t.Fatalf("wrong pinned source: %+v",prepared)}
 if _,done,e:=service.OpenDownload(ctx,member,upload.FileID);e==nil {
  done();t.Fatal("print+preview must not grant original download")
 }
 stream,done,err:=service.OpenBrowserPrintMedia(ctx,member,upload.FileID,prepared.Sha256)
 if err!=nil {t.Fatal(err)}
 if stream.ContentType!="application/pdf" {t.Fatalf("wrong print MIME: %s",stream.ContentType)}
 done()
 if err=service.RevokeGrant(ctx,admin,printer.ID);err!=nil {t.Fatal(err)}
 if _,_,err=service.OpenBrowserPrintMedia(ctx,member,upload.FileID,prepared.Sha256);!errors.Is(err,domain.ErrForbidden) {
  t.Fatalf("revoked print must invalidate content link: %v",err)
 }
}
