package httpx

import (
	"filesmanage/internal/application"
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func cdwTestContext(body string, headers map[string]string) (*gin.Context, *httptest.ResponseRecorder) {
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/workbench/tasks", strings.NewReader(body))
	for name, value := range headers {
		c.Request.Header.Set(name, value)
	}
	return c, rec
}

func TestCDWHeaderContracts(t *testing.T) {
	t.Run("missing idempotency key fails closed", func(t *testing.T) {
		c, rec := cdwTestContext("{}", nil)
		if _, ok := cdwKey(c); ok || rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "E_CD_IDEMPOTENCY_REQUIRED") {
			t.Fatalf("accepted missing idempotency header: %d %s", rec.Code, rec.Body.String())
		}
	})
	t.Run("non-ascii idempotency key rejected", func(t *testing.T) {
		c, _ := cdwTestContext("{}", map[string]string{"Idempotency-Key": "非法-key-123"})
		if _, ok := cdwKey(c); ok {
			t.Fatal("accepted non-ASCII idempotency key")
		}
	})
	t.Run("valid idempotency key", func(t *testing.T) {
		c, _ := cdwTestContext("{}", map[string]string{"Idempotency-Key": "trial-key_007"})
		if got, ok := cdwKey(c); !ok || got != "trial-key_007" {
			t.Fatalf("valid key refused: %v %q", ok, got)
		}
	})
	for _, v := range []string{"5", "rev-5", "W/\"rev-5\"", "\"rev-0\"", "\"rev--2\""} {
		t.Run("reject "+v, func(t *testing.T) {
			c, rec := cdwTestContext("{}", map[string]string{"If-Match": v})
			if _, ok := cdwIfMatch(c); ok || rec.Code != http.StatusBadRequest {
				t.Fatalf("invalid If-Match accepted: %q", v)
			}
		})
	}
	c, _ := cdwTestContext("{}", map[string]string{"If-Match": "\"rev-5\""})
	if rev, ok := cdwIfMatch(c); !ok || rev != 5 {
		t.Fatalf("valid strong ETag rejected: %d %v", rev, ok)
	}
}

func TestCDWRejectClientSuppliedActorAndTrailingJSON(t *testing.T) {
	valid := `{"title":"试验工作","fileId":"f1","assignee":{"kind":"user","id":"u1"}}`
	for _, body := range []string{
		`{"title":"试验工作","fileId":"f1","assignee":{"kind":"user","id":"u1"},"actorId":"admin"}`,
		`{"title":"试验工作","fileId":"f1","assignee":{"kind":"user","id":"u1","actualReceiverId":"admin"}}`,
		valid + " {}",
	} {
		c, rec := cdwTestContext(body, nil)
		var req application.CDWRootTaskInput
		if cdwBind(c, &req) || rec.Code != http.StatusBadRequest {
			t.Fatalf("accepted forged/ambiguous JSON: %q", body)
		}
	}
	c, rec := cdwTestContext(valid, nil)
	var req application.CDWRootTaskInput
	if !cdwBind(c, &req) || rec.Code != http.StatusOK || req.Assignee.ID != "u1" {
		t.Fatalf("valid payload refused: %d %s %#v", rec.Code, rec.Body.String(), req)
	}
}
