package httpx

import (
	"errors"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net/http"
)

func (h *Handler) signFileSealsBatch(c *gin.Context) {
	actor, ok := h.auth(c)
	if !ok {
		return
	}
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
	var input struct {
		Password   string `json:"password"`
		VersionSeq int    `json:"versionSeq"`
		FileSha256 string `json:"fileSha256"`
		Placements []struct {
			AssetID      string  `json:"assetId"`
			PageNumber   int     `json:"pageNumber"`
			X            float64 `json:"x"`
			Y            float64 `json:"y"`
			Width        float64 `json:"width"`
			Height       float64 `json:"height"`
			AngleDegrees float64 `json:"angleDegrees"`
		} `json:"placements"`
	}
	if c.ShouldBindJSON(&input) != nil || len(input.Placements) < 1 || len(input.Placements) > 20 {
		respondError(c, domain.ErrInvalidInput)
		return
	}
	placements := make([]application.SealPlacement, 0, len(input.Placements))
	for _, p := range input.Placements {
		placements = append(placements, application.SealPlacement{
			AssetID: p.AssetID, VersionSeq: input.VersionSeq, FileSha256: input.FileSha256, Password: input.Password,
			PageNumber: p.PageNumber, X: p.X, Y: p.Y, Width: p.Width, Height: p.Height, AngleDegrees: p.AngleDegrees,
		})
	}
	marks, err := h.S.SignFileBatch(c.Request.Context(), actor, c.Param("id"), placements)
	if errors.Is(err, application.ErrInvalidCredentials) {
		c.JSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_SIGN_PASSWORD", "message": "签署密码错误"}})
		return
	}
	if err != nil {
		respondError(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusCreated, gin.H{"ok": true, "data": marks})
}
