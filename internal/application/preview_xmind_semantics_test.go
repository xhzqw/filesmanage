package application

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestXMindSemanticsRelationshipsAndSafeAssets(t *testing.T) {
	tiny, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2q8AAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	payload := makePreviewZIP(t, map[string]string{
		"content.json": `[{"title":"DHF 受控导图","rootTopic":{"id":"root","title":"文件验收",
   "structureClass":"org.xmind.ui.org-chart.down",
   "style":{"properties":{"svg:fill":"#eaf3ff","fo:color":"#223344","fo:font-size":20}},
   "children":{"attached":[
    {"id":"phase-1","title":"接收","branch":"folded","href":"https://example.org/guidance",
     "image":{"src":"xap:resources/pixel.png"},
     "boundaries":[{"title":"质量环节","range":"(0,1)"}],
     "summaries":[{"title":"合规汇总","range":"(0,1)"}],
     "labels":"体系文件,责任部门","markers":[{"markerId":"priority-1"}]},
    {"id":"phase-2","title":"审批","href":"javascript:alert(1)","image":{"src":"../../outside.png"},
     "style":{"properties":{"svg:fill":"#zzzzzz","fo:color":"red"}}}
   ]}},
   "relationships":[
    {"end1Id":"phase-1","end2Id":"phase-2","title":"互相制约"},
    {"end1Id":"phase-2","end2Id":"missing","title":"无效"}
   ]}]`,
		"resources/pixel.png":  string(tiny),
		"resources/script.svg": `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>`,
	})
	result, err := inspectZIP(bytes.NewReader(payload), int64(len(payload)), "real.xmind")
	if err != nil {
		t.Fatal(err)
	}
	if result.Kind != "mindmap" || result.MindMap == nil {
		t.Fatalf("missing diagram: %+v", result)
	}
	diagram := result.MindMap
	if len(diagram.Sheets) != 1 || diagram.Sheets[0].Structure != "org.xmind.ui.org-chart.down" {
		t.Fatalf("lost structure: %+v", diagram.Sheets)
	}
	if len(diagram.Sheets[0].Relationships) != 1 || diagram.Sheets[0].Relationships[0].Title != "互相制约" {
		t.Fatalf("invalid relationships: %+v", diagram.Sheets[0].Relationships)
	}
	parent := diagram.Sheets[0].Root
	if parent.ID != "root" || parent.Color == nil || parent.Color.Fill != "#eaf3ff" || parent.Color.Text != "#223344" {
		t.Fatalf("root metadata: %+v", parent)
	}
	first := parent.Children[0]
	if first.ID != "phase-1" || !first.Collapsed || first.Link != "https://example.org/guidance" {
		t.Fatalf("lost topic ID, folded state or link: %+v", first)
	}
	if first.Image != "resources/pixel.png" || !strings.HasPrefix(diagram.Images[first.Image], "data:image/png;base64,") {
		t.Fatalf("missing validated in-package PNG: %+v", diagram.Images)
	}
	if len(first.Boundaries) != 1 || len(first.Summaries) != 1 || first.Boundaries[0].Title != "质量环节" {
		t.Fatalf("lost annotations: %+v", first)
	}
	if len(first.Labels) != 2 || len(first.Markers) != 1 {
		t.Fatalf("lost labels or marker: %+v", first)
	}
	second := parent.Children[1]
	if second.Link != "" || second.Image != "" || second.Color != nil {
		t.Fatalf("unsanitized untrusted metadata: %+v", second)
	}
	b, err := json.Marshal(result)
	if err != nil || !json.Valid(b) {
		t.Fatalf("invalid JSON: %v", err)
	}
	if bytes.Contains(b, []byte("resources/script.svg")) || bytes.Contains(b, []byte("javascript:")) {
		t.Fatalf("untrusted resource or scheme included in preview")
	}
}
func TestXMindAssetSecurityAndDuplicateIDs(t *testing.T) {
	png, err := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2q8AAAAASUVORK5CYII=")
	if err != nil {
		t.Fatal(err)
	}
	payload := makePreviewZIP(t, map[string]string{
		"content.json": `[{"rootTopic":{"id":"root","title":"root","children":{"attached":[
   {"id":"dup","title":"duplicate A","image":{"src":"xap:resources/script.svg"},"href":"file:///etc/passwd"},
   {"id":"dup","title":"duplicate B","image":{"src":"xap:resources/oversize.png"},"href":"xmind:#root"},
   {"id":"unique","title":"unique","image":{"src":"resources/test.png"}}
  ]}},"relationships":[{"end1Id":"dup","end2Id":"unique","title":"not allowed"},
  {"end1Id":"unique","end2Id":"root","title":"allowed"}]}]`,
		"resources/script.svg":   `<svg onload="alert(1)"></svg>`,
		"resources/oversize.png": string(append(png, bytes.Repeat([]byte{'A'}, maxXMindResourceBytes)...)),
		"resources/test.png":     string(png),
	})
	result, err := containerSummary(payload)
	if err != nil || result.MindMap == nil {
		t.Fatalf("parse error: %v", err)
	}
	sheet := result.MindMap.Sheets[0]
	if len(sheet.Relationships) != 1 || sheet.Relationships[0].Title != "allowed" {
		t.Fatalf("duplicate node accepted as endpoint: %+v", sheet.Relationships)
	}
	if len(result.MindMap.Images) != 1 || !strings.HasPrefix(result.MindMap.Images["resources/test.png"], "data:image/png;base64,") {
		t.Fatalf("unsafe or oversized member included: %+v", result.MindMap.Images)
	}
	if sheet.Root.Children[0].Link != "" || sheet.Root.Children[1].Link != "xmind:#root" {
		t.Fatalf("invalid link policy: %+v", sheet.Root.Children)
	}
}
