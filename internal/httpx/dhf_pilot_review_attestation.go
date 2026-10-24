package httpx

import(
 "filesmanage/internal/application"
 "github.com/gin-gonic/gin"
 "net/http"
)

// Independent authentication of an existing, frozen trial recommendation.
// Never accepts actor, role, outcome, evidence SHA, or timestamp from caller.
func(h *Handler)dhfPilotAttestReview(c *gin.Context){
 actor,ok:=h.auth(c);if !ok{return}
 c.Request.Body=http.MaxBytesReader(c.Writer,c.Request.Body,4096)
 var req struct{
  DecisionID string `json:"decisionId"`
  Password string `json:"password"`
  SignIntent string `json:"signIntent"`
  IdempotencyKey string `json:"idempotencyKey"`
 }
 if c.ShouldBindJSON(&req)!=nil{
  c.JSON(400,gin.H{"ok":false,"error":gin.H{"code":"E_BAD"}});return
 }
 outcome,err:=h.S.DHFPilotAttestReview(c.Request.Context(),actor,c.Param("id"),
  req.DecisionID,req.Password,req.SignIntent,req.IdempotencyKey)
 if err!=nil{
  c.JSON(409,gin.H{"ok":false,"error":gin.H{"code":"DHF_ATTESTATION_CONFLICT"}});return
 }
 if outcome.Reason!=""{
  status:=409
  switch outcome.Reason{
  case "DHF_SCOPE_DENIED":status=404
  case "DHF_REAUTH_FAILED":status=401
  case "DHF_REAUTH_RATE_LIMITED":status=429
  case "DHF_ATTESTATION_INTENT_REQUIRED","DHF_IDEMPOTENCY_KEY_INVALID":status=400
  }
  c.Header("Cache-Control","private, no-store")
  c.JSON(status,gin.H{"ok":false,"error":gin.H{"code":outcome.Reason}});return
 }
 c.Header("Cache-Control","private, no-store")
 c.JSON(200,gin.H{"ok":true,"data":outcome})
}

func(h *Handler)dhfPilotAttestationInbox(c *gin.Context){
 actor,ok:=h.auth(c);if !ok{return}
 rows,err:=h.S.DHFPilotAttestationInbox(c.Request.Context(),actor)
 if err!=nil{respondError(c,err);return}
 c.Header("Cache-Control","private, no-store")
 c.JSON(http.StatusOK,gin.H{"ok":true,"data":gin.H{"items":rows,"trialOnly":true,
  "signIntent":application.DHFPilotAttestationIntent}})
}
