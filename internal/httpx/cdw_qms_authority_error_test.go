package httpx

import (
	"encoding/json"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http/httptest"
	"testing"
)

func TestCDWQMSAuthorityPendingHTTP409(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	respondError(ctx, domain.ErrPolicyAuthorityPending)
	if recorder.Code != 409 {
		t.Fatalf("want 409, got %d", recorder.Code)
	}
	var body struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil ||
		body.Error.Code != "E_CD_POLICY_AUTHORITY_PENDING" {
		t.Fatalf("unexpected QMS authority blocker: %q %v", recorder.Body.String(), err)
	}
}
