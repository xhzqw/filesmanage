package httpx

import (
 "encoding/json"
 "github.com/gin-gonic/gin"
 "net/http"
)

// Trial-only corrective-preparation operation. User identity is always the
// session's database actor, never a caller-supplied reviewer/submission owner.
// This creates a NEW preparation attempt, not formal Gate acceptance.
func(h *Handler) dhfPilotOpenRemediation(c *gin.Context){
 actor,ok:=h.auth(c);if !ok{return}
 c.Request.Body=http.MaxBytesReader(c.Writer,c.Request.Body,1<<20+4096)
 var req struct{
  Manifest json.RawMessage `json:"manifest"`
  ResolutionPlan string `json:"resolutionPlan"`
  IdempotencyKey string `json:"idempotencyKey"`
 }
 if c.ShouldBindJSON(&req)!=nil{
  c.JSON(400,gin.H{"ok":false,"error":gin.H{"code":"E_BAD"}})
  return
 }
 result,err:=h.S.DHFPilotOpenRemediation(c.Request.Context(),actor,c.Param("id"),
  req.Manifest,req.ResolutionPlan,req.IdempotencyKey)
 if err!=nil{
  c.JSON(409,gin.H{"ok":false,"error":gin.H{"code":"DHF_REMEDIATION_CONFLICT"}})
  return
 }
 if result.Reason!=""{
  status:=409
  switch result.Reason{
  case "DHF_SCOPE_DENIED":status=404
  case "DHF_IDEMPOTENCY_KEY_INVALID","DHF_REMEDIATION_PLAN_INVALID",
    "DHF_REMEDIATION_MANIFEST_INVALID","DHF_REMEDIATION_EVIDENCE_UNCHANGED":status=400
  }
  c.JSON(status,gin.H{"ok":false,"error":gin.H{"code":result.Reason}})
  return
 }
 c.Header("Cache-Control","private, no-store")
 c.JSON(201,gin.H{"ok":true,"data":result})
}
