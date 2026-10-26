package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"testing"

	"filesmanage/internal/adapter/blob"
	"filesmanage/internal/ports"
)

type dhfIntegrityBlobPort struct { store *blob.Store }
func (p dhfIntegrityBlobPort) Stage() (ports.BlobStage,error) { return p.store.Stage() }
func (p dhfIntegrityBlobPort) Open(key string) (io.ReadSeekCloser,error) { return p.store.Open(key) }

func TestDHFPilotPhysicalEvidenceDigestAndSize(t *testing.T) {
	storage := blob.New(t.TempDir())
	stage, err := storage.Stage()
	if err != nil { t.Fatal(err) }
	bytes := []byte("document content for actual DHF verification")
	if _, err = stage.Write(bytes); err != nil { t.Fatal(err) }
	key,_,err := stage.Commit()
	if err != nil { t.Fatal(err) }
	hash := sha256.Sum256(bytes)
	digest := hex.EncodeToString(hash[:])
	port := dhfIntegrityBlobPort{store:storage}
	if err := verifyDHFPilotPhysicalBlob(context.Background(),port,key,digest,int64(len(bytes))); err!=nil {
		t.Fatalf("valid physical evidence denied: %v",err)
	}
	path,err:=storage.PathFor(key)
	if err!=nil {t.Fatal(err)}
	changed:=append([]byte{},bytes...)
	changed[0]^=1
	if err=os.WriteFile(path,changed,0600);err!=nil {t.Fatal(err)}
	if err=verifyDHFPilotPhysicalBlob(context.Background(),port,key,digest,int64(len(bytes)));err==nil {
		t.Fatal("same-length disk corruption passed SHA check")
	}
	if err=verifyDHFPilotPhysicalBlob(context.Background(),port,key,digest,int64(len(bytes)-1));err==nil {
		t.Fatal("different physical size passed check")
	}
	if err=os.Remove(path);err!=nil {t.Fatal(err)}
	if err=verifyDHFPilotPhysicalBlob(context.Background(),port,key,digest,int64(len(bytes)));err==nil {
		t.Fatal("missing physical bytes passed check")
	}
	if err=verifyDHFPilotPhysicalBlob(context.Background(),nil,key,digest,int64(len(bytes)));err==nil {
		t.Fatal("missing physical store accepted")
	}
}

func TestDHFPilotPhysicalEvidenceCancellation(t *testing.T) {
	storage:=blob.New(t.TempDir())
	stage,err:=storage.Stage()
	if err!=nil {t.Fatal(err)}
	content:=[]byte("document")
	if _,err=stage.Write(content);err!=nil {t.Fatal(err)}
	key,_,err:=stage.Commit()
	if err!=nil {t.Fatal(err)}
	digest:=sha256.Sum256(content)
	ctx,cancel:=context.WithCancel(context.Background())
	cancel()
	if err=verifyDHFPilotPhysicalBlob(ctx,dhfIntegrityBlobPort{store:storage},key,hex.EncodeToString(digest[:]),int64(len(content)));err==nil {
		t.Fatal("cancelled verification must fail")
	}
}
