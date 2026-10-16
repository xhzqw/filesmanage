package httpx

import (
	"context"
	"errors"
	"testing"
)

func TestCDWReadingFullTransferEvidenceGate(t *testing.T) {
	broken := errors.New("network interrupted")
	for _, tc := range []struct {
		name                string
		sent, expected      int64
		copyErr, contextErr error
		allow               bool
	}{
		{"complete", 31, 31, nil, nil, true},
		{"short", 30, 31, nil, nil, false},
		{"socket-failure", 30, 31, broken, nil, false},
		{"client-gone", 31, 31, nil, context.Canceled, false},
		{"zero", 0, 0, nil, nil, false},
		{"larger-than-advertised", 32, 31, nil, nil, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := cdwFullTransferComplete(tc.sent, tc.expected, tc.copyErr, tc.contextErr)
			if got != tc.allow {
				t.Fatalf("transfer gate got %t want %t", got, tc.allow)
			}
		})
	}
}
