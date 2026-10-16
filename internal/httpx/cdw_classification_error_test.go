package httpx

import (
	"encoding/json"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http/httptest"
	"testing"
)

func TestCDWDocumentClassificationPendingHTTP409(t *testing.T) {
	gin.SetMode(gin.TestMode)
	response := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(response)
	respondError(ctx, domain.ErrDocumentClassPending)
	if response.Code != 409 {
		t.Fatalf("expected 409, got %d", response.Code)
	}
	var data struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil ||
		data.Error.Code != "E_CD_DOCUMENT_CLASS_PENDING" {
		t.Fatalf("classification pending error contract: %q %v", response.Body.String(), err)
	}
}
