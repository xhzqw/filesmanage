package httpx

import (
	"encoding/json"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http/httptest"
	"testing"
)

func TestCDWQMSAppointmentPendingHTTP409(t *testing.T) {
	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	respondError(c, domain.ErrQMSAppointmentPending)
	if w.Code != 409 {
		t.Fatalf("expected 409, got %d", w.Code)
	}
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &payload); err != nil ||
		payload.Error.Code != "E_CD_QMS_APPOINTMENT_PENDING" {
		t.Fatalf("unexpected QMS appointment blocker: %q %v", w.Body.String(), err)
	}
}
