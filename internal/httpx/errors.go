package httpx

import (
	"errors"
	"filesmanage/internal/application"
	"os"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
)

// respondError maps domain and application failures onto the stable SPEC §5.3
// error contract.
func respondError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, application.ErrUnauthorized):
		c.JSON(401, gin.H{"ok": false, "error": gin.H{"code": "E_AUTH"}})
	case errors.Is(err, application.ErrInvalidCredentials):
		c.JSON(401, gin.H{"ok": false, "error": gin.H{"code": "E_INVALID_CREDENTIALS"}})
	case errors.Is(err, application.ErrPasswordPolicy):
		c.JSON(422, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_POLICY"}})
	case errors.Is(err, application.ErrInvalidInput), errors.Is(err, domain.ErrInvalidInput):
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
	case errors.Is(err, domain.ErrUnauthorized):
		c.JSON(401, gin.H{"ok": false, "error": gin.H{"code": "E_AUTH"}})
	case errors.Is(err, domain.ErrNotFound):
		c.JSON(404, gin.H{"ok": false, "error": gin.H{"code": "E_NOT_FOUND"}})
	case errors.Is(err, domain.ErrForbidden):
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_FORBIDDEN"}})
	case errors.Is(err, domain.ErrNameConflict):
		c.JSON(409, gin.H{"ok": false, "error": gin.H{"code": "E_NAME_CONFLICT"}})
	case errors.Is(err, domain.ErrVersionConflict):
		c.JSON(409, gin.H{"ok": false, "error": gin.H{"code": "E_VERSION_CONFLICT"}})
	case errors.Is(err, domain.ErrMoveConflict):
		c.JSON(409, gin.H{"ok": false, "error": gin.H{"code": "E_MOVE_CONFLICT"}})
	case errors.Is(err, domain.ErrLocked):
		c.JSON(409, gin.H{"ok": false, "error": gin.H{"code": "E_LOCKED"}})
	case errors.Is(err, domain.ErrApprovalPending):
		c.JSON(409, gin.H{"ok": false, "error": gin.H{"code": "E_APPROVAL_PENDING"}})
	case errors.Is(err, domain.ErrParentMissing):
		c.JSON(409, gin.H{"ok": false, "error": gin.H{"code": "E_PARENT_MISSING"}})
	default:
		payload := gin.H{"code": "E_INTERNAL"}
		// Development-only detail switch; stays off unless explicitly enabled so
		// production responses never leak internals.
		if os.Getenv("FILESMANAGE_DEBUG_ERRORS") == "true" {
			payload["message"] = err.Error()
		}
		c.JSON(500, gin.H{"ok": false, "error": payload})
	}
}
