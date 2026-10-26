package httpx

import (
 "github.com/gin-gonic/gin"
 "net/http"
)

// Shows the COMPLETE liability chain to its assigned participants.
// Reviewing out of order does not discharge any preceding obligation.
func(h *Handler)dhfPilotDutyChain(c *gin.Context){
 actor,ok:=h.auth(c);if !ok{return}
 rows,err:=h.S.DHFPilotDutyChain(c.Request.Context(),actor)
 if err!=nil{respondError(c,err);return}
 c.Header("Cache-Control","private, no-store")
 c.JSON(200,gin.H{"ok":true,"data":gin.H{"items":rows,"trialOnly":true}})
}

// Recorded authorization by the explicitly configured final Gate reviewer
// to allow an assigned specialty to REVIEW out of order. It is never a
// formal signature, authority delegation or waiver of predecessor duty.
func(h *Handler)dhfPilotAuthorizeEarlyReview(c *gin.Context){
 actor,ok:=h.auth(c);if !ok{return}
 c.Request.Body=http.MaxBytesReader(c.Writer,c.Request.Body,4096)
 var req struct{
  Reason string `json:"reason"`
  IdempotencyKey string `json:"idempotencyKey"`
 }
 if c.ShouldBindJSON(&req)!=nil{
  c.JSON(400,gin.H{"ok":false,"error":gin.H{"code":"E_BAD"}});return
 }
 result,err:=h.S.DHFPilotAuthorizeEarlyReview(c.Request.Context(),actor,c.Param("id"),req.Reason,req.IdempotencyKey)
 if err!=nil{
  c.JSON(409,gin.H{"ok":false,"error":gin.H{"code":"DHF_INTERVENTION_CONFLICT"}});return
 }
 if result.Reason!=""{
  code:=409
  if result.Reason=="DHF_SCOPE_DENIED"{code=404}
  if result.Reason=="DHF_IDEMPOTENCY_KEY_INVALID"||result.Reason=="DHF_INTERVENTION_REASON_INVALID"{code=400}
  c.JSON(code,gin.H{"ok":false,"error":gin.H{"code":result.Reason}});return
 }
 c.Header("Cache-Control","private, no-store")
 c.JSON(200,gin.H{"ok":true,"data":result})
}
