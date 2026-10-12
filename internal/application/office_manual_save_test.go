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
