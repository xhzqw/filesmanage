package httpx

import (
	"context"
	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/gin-gonic/gin"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Handler struct {
	S             *application.Service
	SecureCookies bool
	Dist          string
}

// parseAllowlist fails closed: an unreadable or malformed allowlist must stop startup
// rather than silently widen or narrow network exposure.
func parseAllowlist(spec string) []*net.IPNet {
	if strings.TrimSpace(spec) == "" {
		spec = "127.0.0.1/32,::1/128,192.168.1.0/24"
	}
	var nets []*net.IPNet
	for _, item := range strings.Split(spec, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if !strings.Contains(item, "/") {
			item = item + "/32"
		}
		_, network, err := net.ParseCIDR(item)
		if err != nil {
			panic("invalid FILESMANAGE_LAN_ALLOW_CIDRS entry: " + item)
		}
		nets = append(nets, network)
	}
	if len(nets) == 0 {
		panic("FILESMANAGE_LAN_ALLOW_CIDRS resolved to an empty allowlist")
	}
	return nets
}

// lanGuard admits only socket peers inside the configured CIDRs. It reads the kernel
// peer address (never forwarded headers) so a client cannot spoof its way past it.
func lanGuard(nets []*net.IPNet) gin.HandlerFunc {
	return func(c *gin.Context) {
		host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_NETWORK"}})
			return
		}
		ip := net.ParseIP(host)
		if ip == nil {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_NETWORK"}})
			return
		}
		for _, network := range nets {
			if network.Contains(ip) {
				c.Next()
				return
			}
		}
		c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"ok": false, "error": gin.H{"code": "E_NETWORK"}})
	}
}

func New(s *application.Service, secure bool, dist string) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	h := &Handler{S: s, SecureCookies: secure, Dist: dist}
	r := gin.New()
	r.Use(gin.Recovery(), lanGuard(parseAllowlist(os.Getenv("FILESMANAGE_LAN_ALLOW_CIDRS"))), gin.Logger())
	r.GET("/health/live", func(c *gin.Context) { c.JSON(200, gin.H{"ok": true}) })
	r.GET("/health/ready", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 2*time.Second)
		defer cancel()
		if s.Ready(ctx) != nil {
			c.JSON(503, gin.H{"ok": false})
			return
		}
		c.JSON(200, gin.H{"ok": true})
	})
	api := r.Group("/api")
	api.Use(checkOrigin)
	api.POST("/login", h.login)
	api.POST("/logout", h.logout)
	api.POST("/me/password", h.changePassword)
	api.GET("/me", h.me)
	api.GET("/folders/tree", h.folders)
	r.NoRoute(func(c *gin.Context) {
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.JSON(404, gin.H{"ok": false, "error": gin.H{"code": "E_NOT_FOUND"}})
			return
		}
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.Status(405)
			return
		}
		path := filepath.Clean(strings.TrimPrefix(c.Request.URL.Path, "/"))
		if path == "." {
			path = "index.html"
		}
		full := filepath.Join(dist, path)
		if !strings.HasPrefix(full, filepath.Clean(dist)+string(filepath.Separator)) {
			c.Status(404)
			return
		}
		info, err := os.Stat(full)
		if err != nil || info.IsDir() {
			full = filepath.Join(dist, "index.html")
		}
		if _, err = os.Stat(full); err != nil {
			c.JSON(404, gin.H{"ok": false, "error": gin.H{"code": "E_UI_NOT_BUILT"}})
			return
		}
		c.File(full)
	})
	return r
}
func checkOrigin(c *gin.Context) {
	if c.Request.Method == "POST" || c.Request.Method == "PUT" || c.Request.Method == "PATCH" || c.Request.Method == "DELETE" {
		if o := c.GetHeader("Origin"); o != "" {
			u, e := url.Parse(o)
			if e != nil || !strings.EqualFold(u.Host, c.Request.Host) {
				c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_ORIGIN"}})
				c.Abort()
				return
			}
		}
	}
	c.Next()
}
func (h *Handler) auth(c *gin.Context) (domain.User, bool) {
	token, _ := c.Cookie("fm_session")
	a, err := h.S.Session(c.Request.Context(), token)
	if err != nil {
		c.JSON(401, gin.H{"ok": false, "error": gin.H{"code": "E_AUTH"}})
		return domain.User{}, false
	}
	return a.User, true
}
func (h *Handler) login(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 4096)
	var req struct {
		Login    string
		Password string
	}
	if c.ShouldBindJSON(&req) != nil {
		c.JSON(400, gin.H{"ok": false, "error": gin.H{"code": "E_BAD"}})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 4*time.Second)
	defer cancel()
	token, user, err := h.S.Login(ctx, req.Login, req.Password)
	if err != nil {
		c.JSON(401, gin.H{"ok": false, "error": gin.H{"code": "E_INVALID_CREDENTIALS"}})
		return
	}
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie("fm_session", token, 86400, "/", "", h.SecureCookies, true)
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"id": user.ID, "displayName": user.DisplayName, "isAdmin": user.IsAdmin, "mustChangePassword": user.MustChangePassword}})
}
func (h *Handler) logout(c *gin.Context) {
	token, _ := c.Cookie("fm_session")
	_ = h.S.Logout(c.Request.Context(), token)
	c.SetSameSite(http.SameSiteStrictMode)
	c.SetCookie("fm_session", "", -1, "/", "", h.SecureCookies, true)
	c.JSON(200, gin.H{"ok": true})
}
func (h *Handler) me(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	c.JSON(200, gin.H{"ok": true, "data": gin.H{"id": u.ID, "displayName": u.DisplayName, "isAdmin": u.IsAdmin, "mustChangePassword": u.MustChangePassword}})
}
func (h *Handler) folders(c *gin.Context) {
	u, ok := h.auth(c)
	if !ok {
		return
	}
	if u.MustChangePassword {
		c.JSON(403, gin.H{"ok": false, "error": gin.H{"code": "E_PASSWORD_CHANGE_REQUIRED"}})
		return
	}
	ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
	defer cancel()
	items, err := h.S.Folders(ctx, u)
	if err != nil {
		c.JSON(503, gin.H{"ok": false, "error": gin.H{"code": "E_DEPENDENCY"}})
		return
	}
	data := make([]gin.H, 0, len(items))
	for _, f := range items {
		data = append(data, gin.H{"id": f.ID, "name": f.Name, "parentId": f.ParentID})
	}
	c.JSON(200, gin.H{"ok": true, "data": data})
}
