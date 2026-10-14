package application

import (
	"context"
	"net"
	"strings"
)

type loginMetadataKey struct{}
type loginMetadata struct{ address, device, mac string }

// WithLoginMetadata is used by the HTTP ingress only; the value never comes
// from a JSON login request. User-Agent is a label, not a trusted device ID.
func WithLoginMetadata(ctx context.Context, address, agent string) context.Context {
	return WithLoginNetworkMetadata(ctx, address, agent, "")
}

// MAC is observational network metadata, never authentication evidence.
func WithLoginNetworkMetadata(ctx context.Context, address, agent, mac string) context.Context {
	if net.ParseIP(address) == nil {
		address = ""
	}
	if len(address) > 48 {
		address = ""
	}
	hw, err := net.ParseMAC(mac)
	if err != nil || len(hw) != 6 {
		mac = ""
	} else {
		mac = hw.String()
	}
	return context.WithValue(ctx, loginMetadataKey{}, loginMetadata{address: address, device: deviceLabel(agent), mac: mac})
}
func deviceLabel(agent string) string {
	a := strings.ToLower(agent)
	os := "其他设备"
	switch {
	case strings.Contains(a, "iphone") || strings.Contains(a, "ipad"):
		os = "iOS"
	case strings.Contains(a, "android"):
		os = "Android"
	case strings.Contains(a, "windows"):
		os = "Windows"
	case strings.Contains(a, "macintosh") || strings.Contains(a, "mac os"):
		os = "macOS"
	case strings.Contains(a, "linux"):
		os = "Linux"
	}
	browser := "浏览器"
	switch {
	case strings.Contains(a, "edg/"):
		browser = "Edge"
	case strings.Contains(a, "firefox/"):
		browser = "Firefox"
	case strings.Contains(a, "chrome/") || strings.Contains(a, "crios/"):
		browser = "Chrome"
	case strings.Contains(a, "safari/"):
		browser = "Safari"
	}
	return browser + " · " + os
}
func metadataOf(ctx context.Context) loginMetadata {
	if meta, ok := ctx.Value(loginMetadataKey{}).(loginMetadata); ok {
		return meta
	}
	return loginMetadata{device: "未知浏览器"}
}
