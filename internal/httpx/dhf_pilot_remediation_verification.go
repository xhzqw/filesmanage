package httpx

import(
 "github.com/gin-gonic/gin"
 "net/http"
)

// This confirms only the returned reviewer's verification of the revised
// submitted evidence. No official Stage Gate or CDW issuance action is called.
func(h *Handler)dhfPilotVerifyRemediation(c *gin.Context){
 actor,ok:=h.auth(c);if !ok{return}
 c.Request.Body=http.MaxBytesReader(c.Writer,c.Request.Body,4096)
 var req struct{
  Comment string `json:"comment"`
  Password string `json:"password"`
  VerificationIntent string `json:"verificationIntent"`
  IdempotencyKey string `json:"idempotencyKey"`
 }
 if c.ShouldBindJSON(&req)!=nil{
  c.JSON(400,gin.H{"ok":false,"error":gin.H{"code":"E_BAD"}});return
 }
 result,err:=h.S.DHFPilotVerifyRemediation(c.Request.Context(),actor,c.Param("id"),
  req.Comment,req.Password,req.VerificationIntent,req.IdempotencyKey)
 if err!=nil{
  c.JSON(409,gin.H{"ok":false,"error":gin.H{"code":"DHF_VERIFICATION_PRECONDITION"}});return
 }
 if result.Reason!=""{
  code:=409
  switch result.Reason{
  case "DHF_SCOPE_DENIED":code=404
  case "DHF_REAUTH_FAILED":code=401
  case "DHF_REAUTH_RATE_LIMITED":code=429
  case "DHF_VERIFICATION_COMMENT_INVALID","DHF_IDEMPOTENCY_KEY_INVALID",
    "DHF_VERIFICATION_INTENT_REQUIRED":code=400
  }
  c.Header("Cache-Control","private, no-store")
  c.JSON(code,gin.H{"ok":false,"error":gin.H{"code":result.Reason}});return
 }
 c.Header("Cache-Control","private, no-store")
 c.JSON(http.StatusOK,gin.H{"ok":true,"data":result})
}
