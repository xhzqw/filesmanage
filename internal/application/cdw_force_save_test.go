package application

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestCDWForceSaveRetriesOnlyTransientUnsyncedCode4(t *testing.T) {
	var calls atomic.Int32
	var firstPayload string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/command" || r.Header.Get("Authorization") != "Bearer isolated-jwt" {
			t.Errorf("bad command authority: %s", r.URL.Path)
			w.WriteHeader(403)
			return
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
			return
		}
		raw, _ := json.Marshal(payload)
		if firstPayload == "" {
			firstPayload = string(raw)
		} else if firstPayload != string(raw) {
			t.Errorf("retry mutated request identity")
		}
		call := calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		if call < 3 {
			_, _ = w.Write([]byte(`{"error":4}`))
		} else {
			_, _ = w.Write([]byte(`{"error":0}`))
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	defer cancel()
	err := cdwSendForceSaveCommand(ctx, server.URL+"/command", "isolated-jwt", []byte(`{"c":"forcesave","key":"isolated-doc","userdata":"one-request"}`))
	if err != nil || calls.Load() != 3 {
		t.Fatalf("transient code4 not retried: calls=%d err=%v", calls.Load(), err)
	}
}
func TestCDWForceSaveNonRetryableCodeDoesNotReplay(t *testing.T) {
	for _, code := range []int{1, 2, 3, 5, 6, 7} {
		t.Run(string(rune('A'+code)), func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]int{"error": code})
			}))
			defer server.Close()
			err := cdwSendForceSaveCommand(context.Background(), server.URL, "isolated-jwt", []byte("{}"))
			if !errors.Is(err, domain.ErrConflict) || calls.Load() != 1 {
				t.Fatalf("nonretry code %d replayed: %v %d", code, err, calls.Load())
			}
		})
	}
}
func TestCDWForceSaveStopsOnCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		cancel()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":4}`))
	}))
	defer server.Close()
	err := cdwSendForceSaveCommand(ctx, server.URL, "isolated-jwt", []byte("{}"))
	if !errors.Is(err, context.Canceled) || calls.Load() != 1 {
		t.Fatalf("cancel must stop retries: calls=%d err=%v", calls.Load(), err)
	}
}
