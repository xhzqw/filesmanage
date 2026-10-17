package application

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"encoding/xml"
	"errors"
	"io"
	"strings"
)

// XMind previews are pure read-only projections of a verified ZIP package.
// Never unpack attachments, interpret HTML notes, or follow embedded links.
const (
	maxXMindContentBytes = 8 << 20
	maxXMindSheets       = 24
	maxXMindTopics       = 1400
	maxXMindDepth        = 60
)

type XMindPreview struct {
	Sheets     []XMindSheet `json:"sheets"`
	TopicCount int          `json:"topicCount"`
	Truncated  bool         `json:"truncated"`
}
type XMindSheet struct {
	Title string     `json:"title"`
	Root  XMindTopic `json:"root"`
}
type XMindTopic struct {
	Title    string       `json:"title"`
	Kind     string       `json:"kind,omitempty"`
	Notes    string       `json:"notes,omitempty"`
	Labels   []string     `json:"labels,omitempty"`
	Markers  []string     `json:"markers,omitempty"`
	Children []XMindTopic `json:"children,omitempty"`
}

type xmindJSONTopic struct {
	Title   string          `json:"title"`
	Notes   json.RawMessage `json:"notes"`
	Labels  json.RawMessage `json:"labels"`
	Markers []struct {
		MarkerID string `json:"markerId"`
	} `json:"markers"`
	Children struct {
		Attached []*xmindJSONTopic `json:"attached"`
		Detached []*xmindJSONTopic `json:"detached"`
		Summary  []*xmindJSONTopic `json:"summary"`
		Callout  []*xmindJSONTopic `json:"callout"`
	} `json:"children"`
}
type xmindJSONSheet struct {
	Title string          `json:"title"`
	Root  *xmindJSONTopic `json:"rootTopic"`
}
type xmindXMLTopic struct {
	Title string `xml:"title"`
	Notes struct {
		Plain string `xml:"plain"`
	} `xml:"notes"`
	Labels  []string `xml:"labels>label"`
	Markers []struct {
		ID string `xml:"marker-id,attr"`
	} `xml:"marker-refs>marker-ref"`
	Groups []struct {
		Type   string          `xml:"type,attr"`
		Topics []xmindXMLTopic `xml:"topic"`
	} `xml:"children>topics"`
}
type xmindXMLSheet struct {
	Title string         `xml:"title"`
	Root  *xmindXMLTopic `xml:"topic"`
}
type xmindXMLContent struct {
	XMLName xml.Name
	Sheets  []xmindXMLSheet `xml:"sheet"`
}

func boundedXMindMember(f *zip.File) ([]byte, error) {
	if f == nil || f.UncompressedSize64 > maxXMindContentBytes {
		return nil, errors.New("XMind content exceeds preview limit")
	}
	r, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	data, err := io.ReadAll(io.LimitReader(r, maxXMindContentBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxXMindContentBytes {
		return nil, errors.New("XMind content exceeds preview limit")
	}
	return data, nil
}
func xmindText(text string, limit int) string {
	text = strings.TrimSpace(text)
	r := []rune(text)
	if len(r) > limit {
		return string(r[:limit]) + "…"
	}
	return text
}
func xmindLabels(raw json.RawMessage) []string {
	var items []string
	if json.Unmarshal(raw, &items) != nil {
		var wrapper struct {
			Labels []string `json:"labels"`
		}
		if json.Unmarshal(raw, &wrapper) == nil {
			items = wrapper.Labels
		}
	}
	return xmindLimitStrings(items)
}
func xmindLimitStrings(items []string) []string {
	var out []string
	for _, v := range items {
		if len(out) >= 12 {
			break
		}
		if t := xmindText(v, 80); t != "" {
			out = append(out, t)
		}
	}
	return out
}
func xmindNote(raw json.RawMessage) string {
	var note string
	if json.Unmarshal(raw, &note) == nil {
		return xmindText(note, 1800)
	}
	var shape struct {
		Plain json.RawMessage `json:"plain"`
	}
	if json.Unmarshal(raw, &shape) != nil {
		return ""
	}
	if json.Unmarshal(shape.Plain, &note) == nil {
		return xmindText(note, 1800)
	}
	var content struct {
		Content string `json:"content"`
	}
	if json.Unmarshal(shape.Plain, &content) == nil {
		return xmindText(content.Content, 1800)
	}
	return ""
}
func xmindJSONNode(topic *xmindJSONTopic, kind string, depth int, out *XMindPreview) *XMindTopic {
	if topic == nil {
		return nil
	}
	if out.TopicCount >= maxXMindTopics || depth >= maxXMindDepth {
		out.Truncated = true
		return nil
	}
	out.TopicCount++
	node := &XMindTopic{Title: xmindText(topic.Title, 240), Kind: kind, Notes: xmindNote(topic.Notes),
		Labels: xmindLabels(topic.Labels)}
	if node.Title == "" {
		node.Title = "未命名主题"
	}
	for _, m := range topic.Markers {
		if len(node.Markers) >= 12 {
			break
		}
		if t := xmindText(m.MarkerID, 80); t != "" {
			node.Markers = append(node.Markers, t)
		}
	}
	groups := []struct {
		nodes []*xmindJSONTopic
		kind  string
	}{
		{topic.Children.Attached, ""}, {topic.Children.Detached, "floating"},
		{topic.Children.Summary, "summary"}, {topic.Children.Callout, "callout"},
	}
	for _, group := range groups {
		for _, child := range group.nodes {
			if out.TopicCount >= maxXMindTopics {
				out.Truncated = true
				break
			}
			if next := xmindJSONNode(child, group.kind, depth+1, out); next != nil {
				node.Children = append(node.Children, *next)
			}
		}
	}
	return node
}
func xmindXMLNode(topic *xmindXMLTopic, kind string, depth int, out *XMindPreview) *XMindTopic {
	if topic == nil {
		return nil
	}
	if out.TopicCount >= maxXMindTopics || depth >= maxXMindDepth {
		out.Truncated = true
		return nil
	}
	out.TopicCount++
	node := &XMindTopic{Title: xmindText(topic.Title, 240), Kind: kind, Notes: xmindText(topic.Notes.Plain, 1800),
		Labels: xmindLimitStrings(topic.Labels)}
	if node.Title == "" {
		node.Title = "未命名主题"
	}
	for _, marker := range topic.Markers {
		if len(node.Markers) >= 12 {
			break
		}
		if t := xmindText(marker.ID, 80); t != "" {
			node.Markers = append(node.Markers, t)
		}
	}
	for _, group := range topic.Groups {
		branch := ""
		switch group.Type {
		case "detached":
			branch = "floating"
		case "summary":
			branch = "summary"
		case "callout":
			branch = "callout"
		}
		for i := range group.Topics {
			if child := xmindXMLNode(&group.Topics[i], branch, depth+1, out); child != nil {
				node.Children = append(node.Children, *child)
			}
		}
	}
	return node
}

// parseXMindZIP checks actual content structure, not the filename or MIME type.
// Modern content.json takes precedence over the legacy content.xml marker.
// parseXMindZIP prefers the modern content.json, but tolerates a corrupt JSON
// member when a valid classic XMind content.xml is also present.
func parseXMindZIP(files map[string]*zip.File) (*XMindPreview, error) {
	if f := files["content.json"]; f != nil {
		if raw, err := boundedXMindMember(f); err == nil {
			if out, parseErr := parseXMindJSON(raw); parseErr == nil {
				return out, nil
			}
		}
	}
	if f := files["content.xml"]; f != nil {
		raw, err := boundedXMindMember(f)
		if err != nil {
			return nil, err
		}
		return parseXMindXML(raw)
	}
	return nil, errors.New("no valid XMind content")
}
func parseXMindJSON(raw []byte) (*XMindPreview, error) {
	var sheets []xmindJSONSheet
	if err := json.Unmarshal(raw, &sheets); err != nil {
		var object struct {
			Sheets []xmindJSONSheet `json:"sheets"`
			Root   *xmindJSONTopic  `json:"rootTopic"`
			Title  string           `json:"title"`
		}
		if err = json.Unmarshal(raw, &object); err != nil {
			return nil, err
		}
		sheets = object.Sheets
		if object.Root != nil {
			sheets = []xmindJSONSheet{{Title: object.Title, Root: object.Root}}
		}
	}
	if len(sheets) == 0 {
		return nil, errors.New("XMind sheets missing")
	}
	out := &XMindPreview{Sheets: make([]XMindSheet, 0, min(len(sheets), maxXMindSheets))}
	if len(sheets) > maxXMindSheets {
		out.Truncated = true
	}
	for _, sheet := range sheets[:min(len(sheets), maxXMindSheets)] {
		if sheet.Root == nil {
			continue
		}
		root := xmindJSONNode(sheet.Root, "", 0, out)
		if root == nil {
			break
		}
		title := xmindText(sheet.Title, 120)
		if title == "" {
			title = "画布"
		}
		out.Sheets = append(out.Sheets, XMindSheet{Title: title, Root: *root})
	}
	if len(out.Sheets) == 0 {
		return nil, errors.New("XMind has no root topics")
	}
	return out, nil
}
func parseXMindXML(raw []byte) (*XMindPreview, error) {
	var content xmindXMLContent
	if err := xml.NewDecoder(bytes.NewReader(raw)).Decode(&content); err != nil {
		return nil, err
	}
	if content.XMLName.Local != "xmap-content" || len(content.Sheets) == 0 {
		return nil, errors.New("not XMind content XML")
	}
	out := &XMindPreview{Sheets: make([]XMindSheet, 0, min(len(content.Sheets), maxXMindSheets))}
	if len(content.Sheets) > maxXMindSheets {
		out.Truncated = true
	}
	for i := range content.Sheets[:min(len(content.Sheets), maxXMindSheets)] {
		sheet := &content.Sheets[i]
		if sheet.Root == nil {
			continue
		}
		root := xmindXMLNode(sheet.Root, "", 0, out)
		if root == nil {
			break
		}
		title := xmindText(sheet.Title, 120)
		if title == "" {
			title = "画布"
		}
		out.Sheets = append(out.Sheets, XMindSheet{Title: title, Root: *root})
	}
	if len(out.Sheets) == 0 {
		return nil, errors.New("XMind has no root topics")
	}
	return out, nil
}
