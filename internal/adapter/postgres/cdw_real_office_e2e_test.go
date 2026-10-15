package postgres

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"filesmanage/internal/adapter/blob"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Requires an opt-in dedicated database, a dedicated Blob directory and a
// real ONLYOFFICE Document Server. Never run against a live file repository.
type cdwG5BlobStore struct{ store *blob.Store }

func (a cdwG5BlobStore) Stage() (ports.BlobStage, error)            { return a.store.Stage() }
func (a cdwG5BlobStore) Open(key string) (io.ReadSeekCloser, error) { return a.store.Open(key) }
func cdwG5Docx(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	z := zip.NewWriter(&out)
	files := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
		"_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
		"word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>CDW G5 ISOLATED ORIGINAL CONTENT</w:t></w:r></w:p>
<w:sectPr/></w:body></w:document>`,
	}
	for _, key := range []string{"[Content_Types].xml", "_rels/.rels", "word/document.xml"} {
		f, err := z.Create(key)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.Write([]byte(files[key])); err != nil {
			t.Fatal(err)
		}
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

func TestCDWG5RealOnlyOfficeBrowserCallback(t *testing.T) {
	if os.Getenv("CDW_G5_REAL_OFFICE_E2E") != "1" {
		t.Skip("opt-in real Document Server/browser, dedicated database only")
	}
	dsn := os.Getenv("CDW_G5_TEST_DSN")
	root := os.Getenv("CDW_G5_BLOB_DIR")
	secret := os.Getenv("FILESMANAGE_OFFICE_SECRET")
	officeURL := os.Getenv("FILESMANAGE_OFFICE_URL")
	sourceBase := os.Getenv("CDW_G5_SOURCE_BASE")
	if dsn == "" || root == "" || secret == "" || officeURL == "" || sourceBase == "" {
		t.Fatal("missing dedicated test DB/Blob or Document Server config")
	}
	if !strings.Contains(root, "cdw-g5-oo-20261015") || sourceBase != "http://192.168.1.22:18095" {
		t.Fatal("G5 isolation path/source guard")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 145*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var name string
	if err = pool.QueryRow(ctx, "SELECT current_database()").Scan(&name); err != nil {
		t.Fatal(err)
	}
	if name != "cdw_g5_oo_iso_20261015" {
		t.Fatalf("unsafe test DB %q", name)
	}
	if count, err := os.ReadDir(root); err != nil || len(count) > 500 {
		t.Fatal("test Blob directory invalid")
	}
	repo := New(pool)
	svc := application.New(repo, cdwG5BlobStore{blob.New(root)}).WithOffice(application.OfficeConfig{
		EditorURL: officeURL, Secret: secret, SourceBaseURL: sourceBase, EditorVersion: "G5-real-test",
	})
	prefix := application.NewID("cdwg5")
	adminID, folderID := prefix+"_admin", prefix+"_folder"
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO users(id,login,display_name,password_hash,is_admin,must_change_password)
 VALUES($1,$1,'CDW isolated actor','fixture-no-login',true,false)`, adminID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO folders(id,name,owner_id) VALUES($1,$2,$3)`, folderID, "CDW G5 isolated "+prefix, adminID); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	admin := domain.User{ID: adminID, IsAdmin: true, DisplayName: "CDW isolated actor"}
	file, err := svc.CommitUpload(ctx, admin, folderID, "CDW-G5-e2e.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "", bytes.NewReader(cdwG5Docx(t)))
	if err != nil {
		t.Fatal("upload:", err)
	}
	task, err := svc.CDWCreateRootTask(ctx, admin, application.CDWRootTaskInput{
		Title: "G5 real OnlyOffice browser gate", FileID: file.FileID, Assignee: ports.CDWAssignmentTarget{Kind: "user", ID: adminID},
	}, prefix+"_rootcreate")
	if err != nil {
		t.Fatal("create:", err)
	}
	if _, err = svc.CDWAcceptTask(ctx, admin, task.TaskID, task.Revision, prefix+"_accept"); err != nil {
		t.Fatal("accept:", err)
	}
	branch, err := svc.CDWCreateBranch(ctx, admin, task.TaskID, prefix+"_branch")
	if err != nil {
		t.Fatal("branch:", err)
	}
	editor, err := svc.CDWOpenBranchOffice(ctx, admin, branch.ID)
	if err != nil {
		t.Fatal("open:", err)
	}
	renderedConfig, err := json.Marshal(editor.Config)
	if err != nil {
		t.Fatal(err)
	}
	var ready, changed, done atomic.Bool
	var callbackCount atomic.Int64
	var callbackErr atomic.Value
	nonce := application.NewID("e2e")
	mux := http.NewServeMux()
	mux.HandleFunc("/test", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("nonce") != nonce {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><html><head><meta charset="utf-8"><title>CDW G5 ONLYOFFICE E2E</title>
<style>html,body,#editor{width:100%%;height:100%%;margin:0;padding:0}</style>
<script src="http://192.168.1.22:18080/web-apps/apps/api/documents/api.js"></script></head>
<body><div id="editor"></div><script>
window.__g5Ready=false;window.__g5Changed=false;window.__g5Error="";
try{
 new DocsAPI.DocEditor("editor",{...%s,events:{
 onDocumentReady:()=>{window.__g5Ready=true;fetch('/test/ready',{method:'POST'})},
 onDocumentStateChange:(e)=>{if(e.data===true){window.__g5Changed=true;fetch('/test/changed',{method:'POST'})}},
 onError:(e)=>{window.__g5Error=JSON.stringify(e.data||e);fetch('/test/fail',{method:'POST',body:window.__g5Error})}
 }});
}catch(e){window.__g5Error=String(e);}
</script></body></html>`, renderedConfig)
	})
	mux.HandleFunc("/test/ready", func(w http.ResponseWriter, r *http.Request) { ready.Store(true); w.WriteHeader(204) })
	mux.HandleFunc("/test/changed", func(w http.ResponseWriter, r *http.Request) { changed.Store(true); w.WriteHeader(204) })
	mux.HandleFunc("/test/fail", func(w http.ResponseWriter, r *http.Request) {
		payload, _ := io.ReadAll(io.LimitReader(r.Body, 1000))
		callbackErr.Store(string(payload))
		w.WriteHeader(204)
	})
	mux.HandleFunc("/test/done", func(w http.ResponseWriter, r *http.Request) {
		if done.Load() {
			w.Write([]byte("done"))
		} else {
			w.Write([]byte("running"))
		}
	})
	mux.HandleFunc("/api/internal/office/branch-source/", func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimPrefix(r.URL.Path, "/api/internal/office/branch-source/")
		reader, _, size, release, err := svc.CDWBranchSource(r.Context(), token)
		if err != nil {
			http.Error(w, err.Error(), 401)
			return
		}
		defer release()
		w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
		w.Header().Set("Content-Length", fmt.Sprint(size))
		_, _ = io.Copy(w, reader)
	})
	mux.HandleFunc("/api/internal/office/branch-callback", func(w http.ResponseWriter, r *http.Request) {
		var payload application.EditorCallbackPayload
		if err := json.NewDecoder(io.LimitReader(r.Body, 10000)).Decode(&payload); err != nil {
			http.Error(w, "bad callback", 400)
			return
		}
		callbackCount.Add(1)
		code, err := svc.CDWHandleBranchCallback(r.Context(), strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), payload)
		if err != nil {
			callbackErr.Store(fmt.Sprintf("status=%d code=%d err=%v", payload.Status, code, err))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]int{"error": code})
	})
	listener, err := net.Listen("tcp", "0.0.0.0:18095")
	if err != nil {
		t.Fatal("dedicated 18095 must be free:", err)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() { _ = server.Serve(listener) }()
	defer server.Shutdown(context.Background())
	// The sole browser runner is child of this test and is reaped upon return.
	cmd := exec.CommandContext(ctx, "node", filepath.Join("..", "..", "..", "scripts", "cdw_g5_real_editor_browser.mjs"),
		"http://127.0.0.1:18095/test?nonce="+nonce)
	cmd.Env = append(os.Environ(), "CDW_G5_TEST_ROOT=http://127.0.0.1:18095")
	var browserLog bytes.Buffer
	cmd.Stdout = &browserLog
	cmd.Stderr = &browserLog
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { done.Store(true); _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	for i := 0; i < 140 && !ready.Load(); i++ {
		select {
		case <-ctx.Done():
			t.Fatalf("editor ready timeout: %v browser=%s callback=%v", ctx.Err(), browserLog.String(), callbackErr.Load())
		default:
		}
		time.Sleep(300 * time.Millisecond)
	}
	if !ready.Load() {
		t.Fatalf("ONLYOFFICE not ready, browser=%s callback=%v", browserLog.String(), callbackErr.Load())
	}
	t.Log("CDW_G5_REAL_ONLYOFFICE_EDITOR_READY")
	for i := 0; i < 65 && !changed.Load(); i++ {
		time.Sleep(300 * time.Millisecond)
	}
	if !changed.Load() {
		t.Fatalf("real editor did not emit edited state: %s", browserLog.String())
	}
	t.Log("CDW_G5_REAL_ONLYOFFICE_EDITOR_CHANGED")
	save, err := svc.CDWRequestBranchSave(ctx, admin, branch.ID, editor.Session.ID, prefix+"_save")
	if err != nil {
		t.Fatalf("forcesave command: %v browser=%s", err, browserLog.String())
	}
	if save.State == "unknown" {
		t.Fatalf("real Document Server rejected forcesave; browser=%s error=%v", browserLog.String(), callbackErr.Load())
	}
	var receipt ports.CDWBranchSave
	for i := 0; i < 140; i++ {
		receipt, err = svc.CDWBranchSaveStatus(ctx, admin, branch.ID, save.ID)
		if err != nil {
			t.Fatal(err)
		}
		if receipt.State == "persisted" {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	if receipt.State != "persisted" {
		t.Fatalf("no actual persistent callback: state=%s callbacks=%d error=%v browser=%s", receipt.State, callbackCount.Load(), callbackErr.Load(), browserLog.String())
	}
	if receipt.RevisionID == "" || receipt.SHA256 == file.Sha256 {
		t.Fatalf("saved revision invalid/unchanged: %+v", receipt)
	}
	frozenBranch, err := svc.CDWReadBranch(ctx, admin, branch.ID)
	if err != nil {
		t.Fatal(err)
	}
	delivery, err := svc.CDWFreezeBranch(ctx, admin, branch.ID, save.ID, receipt.RevisionID, frozenBranch.Revision, prefix+"_freeze")
	if err != nil {
		t.Fatalf("real save could not freeze: %v", err)
	}
	var fileSeq int
	if err = pool.QueryRow(ctx, `SELECT current_version_seq FROM files WHERE id=$1`, file.FileID).Scan(&fileSeq); err != nil || fileSeq != 1 {
		t.Fatalf("real CDW save unexpectedly modified formal file version=%d err=%v", fileSeq, err)
	}
	done.Store(true)
	t.Logf("CDW_G5_REAL_ONLYOFFICE_E2E_PASS document_ready=1 edit=1 callbacks=%d persisted_sha=%s delivery=%s original_version=1", callbackCount.Load(), receipt.SHA256, delivery.DeliveryID)
}
