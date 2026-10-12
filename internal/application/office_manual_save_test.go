package application

import (
	"bytes"
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestOfficeManualSaveReceiptsAndRepeatedVersions(t *testing.T) {
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	original := []byte("PK\x03\x04[Content_Types].xml-Original")
	edited := []byte("PK\x03\x04[Content_Types].xml-Updated")
	editedAgain := []byte("PK\x03\x04[Content_Types].xml-Updated-Again")
	current := edited
	var command map[string]any
	docServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/command" {
			if r.Method != http.MethodPost {
				t.Errorf("command method %s", r.Method)
			}
			if err := json.NewDecoder(r.Body).Decode(&command); err != nil {
				t.Errorf("decode command: %v", err)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"error":0}`))
			return
		}
		if r.URL.Path == "/saved" {
			_, _ = w.Write(current)
			return
		}
		http.NotFound(w, r)
	}))
	defer docServer.Close()
	s, _ := officeService(t)
	s.office.EditorURL = docServer.URL
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "manual.docx",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "", bytes.NewReader(original))
	if err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenOfficeSession(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := signJWT(s.office.Secret, map[string]any{"key": view.DocumentKey}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	for i, content := range [][]byte{edited, edited, editedAgain} {
		current = content
		rid, unchanged, err := s.StartOfficeSave(ctx, admin, uploaded.FileID, view.SessionID)
		if err != nil || unchanged || !strings.HasPrefix(rid, "osave_") {
			t.Fatalf("start #%d: %s %v %v", i, rid, unchanged, err)
		}
		if command["c"] != "forcesave" || command["key"] != view.DocumentKey || command["userdata"] != rid || command["token"] == "" {
			t.Fatalf("invalid command: %#v", command)
		}
		pre, err := s.OfficeSaveStatus(ctx, admin, uploaded.FileID, view.SessionID, rid)
		if err != nil || pre.Status != "pending" {
			t.Fatalf("before callback #%d: %+v %v", i, pre, err)
		}
		if code, err := s.HandleEditorCallback(ctx, token, EditorCallbackPayload{
			Key: view.DocumentKey, Status: domain.CallbackStatusForceSave, URL: docServer.URL + "/saved", UserData: rid,
		}); err != nil || code != 0 {
			t.Fatalf("callback #%d: %d %v", i, code, err)
		}
		receipt, err := s.OfficeSaveStatus(ctx, admin, uploaded.FileID, view.SessionID, rid)
		wanted := 2
		if i == 2 {
			wanted = 3
		}
		if err != nil || receipt.Status != "committed" || receipt.VersionSeq != wanted {
			t.Fatalf("save receipt #%d: %+v %v expected v%d", i, receipt, err, wanted)
		}
	}
	// Closing the ONLYOFFICE editor must not produce a redundant version.
	if code, err := s.HandleEditorCallback(ctx, token, EditorCallbackPayload{
		Key: view.DocumentKey, Status: domain.CallbackStatusSaveReady, URL: docServer.URL + "/saved",
	}); err != nil || code != 0 {
		t.Fatalf("final save callback: %d %v", code, err)
	}
	_, versions, err := s.FileMeta(ctx, admin, uploaded.FileID)
	if err != nil || len(versions) != 3 {
		t.Fatalf("expected 3 versions, got %d %v", len(versions), err)
	}
	if _, _, err := s.StartOfficeSave(ctx, admin, uploaded.FileID, view.SessionID); err == nil {
		t.Fatal("finished session must not accept new save commands")
	}
}

func TestOfficeManualSaveFailureReceipt(t *testing.T) {
	s, _ := officeService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "failure.docx",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "",
		strings.NewReader("PK\x03\x04[Content_Types].xml-Original"))
	if err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenOfficeSession(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := signJWT(s.office.Secret, map[string]any{"key": view.DocumentKey}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	requestID := NewID("osave")
	if code, err := s.HandleEditorCallback(ctx, token, EditorCallbackPayload{
		Key: view.DocumentKey, Status: domain.CallbackStatusCorrupted, UserData: requestID,
	}); err != nil || code != 0 {
		t.Fatalf("failure callback: %d %v", code, err)
	}
	receipt, err := s.OfficeSaveStatus(ctx, admin, uploaded.FileID, view.SessionID, requestID)
	if err != nil || receipt.Status != "failed" || receipt.VersionSeq != 1 {
		t.Fatalf("failure receipt: %+v %v", receipt, err)
	}
}

// Built-in ONLYOFFICE Save sends status=6, forcesavetype=1, and normally no
// userdata. Unlike /command force-save it must still have an observable
// durable receipt and remain possible repeatedly in the same editor session.
func TestOfficeNativeSaveCallbackReceipts(t *testing.T) {
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	current := []byte("PK\x03\x04[Content_Types].xml-native-v2")
	docServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(current)
	}))
	defer docServer.Close()
	s, _ := officeService(t)
	s.office.EditorURL = docServer.URL
	uploaded, err := s.CommitUpload(ctx, admin, "folder_root", "native.docx",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document", "",
		bytes.NewReader([]byte("PK\x03\x04[Content_Types].xml-original")))
	if err != nil {
		t.Fatal(err)
	}
	view, err := s.OpenOfficeSession(ctx, admin, uploaded.FileID)
	if err != nil {
		t.Fatal(err)
	}
	token, err := signJWT(s.office.Secret, map[string]any{"key": view.DocumentKey}, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	verify := func(seq int, saved, failed int64) {
		t.Helper()
		state, e := s.OfficeNativeSaveStatus(ctx, admin, uploaded.FileID, view.SessionID)
		if e != nil || state.VersionSeq != seq || state.SavedCount != saved || state.FailedCount != failed {
			t.Fatalf("native status: %+v %v, expected v%d saves=%d errors=%d", state, e, seq, saved, failed)
		}
	}
	verify(1, 0, 0)
	callback := func(status int, url string) {
		t.Helper()
		code, e := s.HandleEditorCallback(ctx, token, EditorCallbackPayload{
			Key: view.DocumentKey, Status: status, URL: url, ForceSaveType: 1,
		})
		if code != 0 || e != nil {
			t.Fatalf("native callback: %d %v", code, e)
		}
	}
	callback(domain.CallbackStatusForceSave, docServer.URL+"/native-v2")
	verify(2, 1, 0)
	callback(domain.CallbackStatusForceSave, docServer.URL+"/native-v2") // replay
	verify(2, 1, 0)
	current = []byte("PK\x03\x04[Content_Types].xml-native-v3")
	callback(domain.CallbackStatusForceSave, docServer.URL+"/native-v3")
	verify(3, 2, 0)
	callback(domain.CallbackStatusCorrupted, "")
	verify(3, 2, 1)
	if err := s.CloseOfficeSession(ctx, admin, view.SessionID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.OfficeNativeSaveStatus(ctx, domain.User{ID: "u_other"}, uploaded.FileID, view.SessionID); err == nil {
		t.Fatal("unrelated user must not view the native save receipt")
	}
}
