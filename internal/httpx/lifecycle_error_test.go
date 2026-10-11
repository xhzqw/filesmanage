package httpx

import (
 "encoding/json"
 "filesmanage/internal/domain"
 "github.com/gin-gonic/gin"
 "net/http/httptest"
 "testing"
)
func TestLifecycleStateConflictIsHTTP409(t *testing.T){
 gin.SetMode(gin.TestMode)
 recorder:=httptest.NewRecorder()
 c,_:=gin.CreateTestContext(recorder)
 respondError(c,domain.ErrConflict)
 if recorder.Code!=409{t.Fatalf("wrong HTTP code %d",recorder.Code)}
 var result struct{Error struct{Code string `json:"code"`}`json:"error"`}
 if err:=json.Unmarshal(recorder.Body.Bytes(),&result);err!=nil||result.Error.Code!="E_CONFLICT"{t.Fatalf("payload %q %v",recorder.Body.String(),err)}
}
