package application

import (
	"archive/zip"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
)

const (
	maxXMindResourceBytes = 128 << 10
	maxXMindResourceTotal = 2 << 20
	maxXMindResourceCount = 36
	maxXMindRelationships = 200
)

// Ignore XMind's external file/attachment schemes and disallow implicit URL
// requests. Browsers only receive safe, user-clickable web links or same-map
// topic IDs. No server-side URL fetches occur.
func xmindSafeHref(raw string) string {
	href := strings.TrimSpace(raw)
	if len(href) == 0 || len(href) > 900 {
		return ""
	}
	if strings.HasPrefix(href, "xmind:#") {
		id := strings.TrimPrefix(href, "xmind:#")
		if len(id) > 0 && len(id) <= 128 && !strings.ContainsAny(id, "/?#\\\r\n\t") {
			return href
		}
		return ""
	}
	if strings.ContainsAny(href, "\\\r\n\t") {
		return ""
	}
	u, err := url.Parse(href)
	if err != nil || u.Hostname() == "" || u.User != nil {
		return ""
	}
	if u.Scheme != "https" && u.Scheme != "http" {
		return ""
	}
	return u.String()
}

func xmindSafeColor(raw json.RawMessage) string {
	var color string
	if json.Unmarshal(raw, &color) != nil {
		return ""
	}
	if len(color) != 4 && len(color) != 7 {
		return ""
	}
	if color[0] != '#' {
		return ""
	}
	for _, r := range color[1:] {
		if !((r >= '0' && r <= '9') || (r >= 'A' && r <= 'F') || (r >= 'a' && r <= 'f')) {
			return ""
		}
	}
	return color
}

func xmindJSONAnnotations(entries []struct {
	Title string `json:"title"`
	Range string `json:"range"`
}) []XMindAnnotation {
	out := []XMindAnnotation{}
	for _, entry := range entries {
		if len(out) >= 16 {
			break
		}
		title, span := xmindText(entry.Title, 160), xmindText(entry.Range, 80)
		if title != "" || span != "" {
			out = append(out, XMindAnnotation{Title: title, Range: span})
		}
	}
	return out
}

func xmindJSONRelationships(entries []struct {
	End1ID string `json:"end1Id"`
	End2ID string `json:"end2Id"`
	Title  string `json:"title"`
}, root XMindTopic) []XMindRelationship {
	ids := map[string]int{}
	var walk func(XMindTopic)
	walk = func(topic XMindTopic) {
		if topic.ID != "" {
			ids[topic.ID]++
		}
		for _, child := range topic.Children {
			walk(child)
		}
	}
	walk(root)
	out := []XMindRelationship{}
	for _, r := range entries {
		if len(out) >= maxXMindRelationships {
			break
		}
		a, b := xmindText(r.End1ID, 128), xmindText(r.End2ID, 128)
		if a == "" || b == "" || a == b || ids[a] != 1 || ids[b] != 1 {
			continue
		}
		out = append(out, XMindRelationship{FromID: a, ToID: b, Title: xmindText(r.Title, 160)})
	}
	return out
}

// Accept only in-package images listed by a topic. SVG/HTML, external URLs,
// scripts, filesystem paths, and over-budget media are never embedded.
func xmindResourcePath(src string) string {
	name := strings.TrimPrefix(strings.TrimSpace(src), "xap:")
	if !strings.HasPrefix(name, "resources/") || len(name) > 250 {
		return ""
	}
	if path.Clean(name) != name || strings.Contains(name, "\\") || strings.Contains(name, "..") || strings.ContainsAny(name, "\x00\r\n") {
		return ""
	}
	return name
}
func xmindLoadImages(out *XMindPreview, files map[string]*zip.File) {
	if out == nil {
		return
	}
	remaining := maxXMindResourceTotal
	images := map[string]string{}
	var walk func(XMindTopic)
	walk = func(topic XMindTopic) {
		name := topic.Image
		if name != "" && len(images) < maxXMindResourceCount && remaining > 0 {
			if _, ok := images[name]; !ok {
				f := files[name]
				if f != nil && f.UncompressedSize64 <= maxXMindResourceBytes && f.UncompressedSize64 <= uint64(remaining) {
					reader, err := f.Open()
					if err == nil {
						bytes, readErr := io.ReadAll(io.LimitReader(reader, maxXMindResourceBytes+1))
						_ = reader.Close()
						if readErr == nil && len(bytes) > 0 && len(bytes) <= maxXMindResourceBytes && len(bytes) <= remaining {
							mime := http.DetectContentType(bytes)
							switch mime {
							case "image/png", "image/jpeg", "image/gif", "image/webp":
								images[name] = "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(bytes)
								remaining -= len(bytes)
							}
						}
					}
				}
			}
		}
		for _, child := range topic.Children {
			walk(child)
		}
	}
	for _, sheet := range out.Sheets {
		walk(sheet.Root)
	}
	if len(images) > 0 {
		out.Images = images
	}
}
