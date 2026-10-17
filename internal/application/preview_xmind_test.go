package application

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"filesmanage/internal/domain"
)

func TestXMindPreviewModernAndLegacy(t *testing.T) {
	modern := makePreviewZIP(t, map[string]string{
		"content.json": `[
   {"title":"产品 DHR","rootTopic":{"title":"总流程","notes":{"plain":{"content":"审核记录"}},"labels":["受控"],"children":{
    "attached":[{"title":"需求确认","children":{"attached":[{"title":"审批"}]}}],
    "detached":[{"title":"风险识别","markers":[{"markerId":"priority-1"}]}]}}},
   {"title":"第二画布","rootTopic":{"title":"CAPA"}}]`,
		"content.xml": `<xmap-content><sheet><title>旧版标记</title><topic><title>不应显示</title></topic></sheet></xmap-content>`,
	})
	legacy := makePreviewZIP(t, map[string]string{"content.xml": `<?xml version="1.0" encoding="UTF-8"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0">
    <sheet><title>旧版流程</title><topic><title>主节点</title><children><topics type="attached">
    <topic><title>部门接收</title><notes><plain>需记录负责人</plain></notes></topic>
    </topics><topics type="detached"><topic><title>孤立主题</title></topic></topics></children></topic></sheet></xmap-content>`})
	for _, tc := range []struct {
		name  string
		data  []byte
		first string
		count int
	}{
		{"json", modern, "总流程", 5}, {"xml", legacy, "主节点", 3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err := inspectZIP(bytes.NewReader(tc.data), int64(len(tc.data)), "flow.xmind")
			if err != nil {
				t.Fatal(err)
			}
			if result.Kind != "mindmap" || result.MindMap == nil {
				t.Fatalf("not rendered as mindmap: %+v", result)
			}
			if result.MindMap.TopicCount != tc.count {
				t.Fatalf("node count: %d != %d", result.MindMap.TopicCount, tc.count)
			}
			if result.MindMap.Sheets[0].Root.Title != tc.first {
				t.Fatalf("wrong title: %+v", result.MindMap)
			}
			data, _ := json.Marshal(result.MindMap)
			if !json.Valid(data) {
				t.Fatal("invalid preview JSON")
			}
			if tc.name == "json" {
				if len(result.MindMap.Sheets) != 2 || result.MindMap.Sheets[0].Root.Notes != "审核记录" {
					t.Fatalf("lost sheet or note: %+v", result.MindMap)
				}
				if children := result.MindMap.Sheets[0].Root.Children; len(children) != 2 || children[1].Kind != "floating" {
					t.Fatalf("lost floating topic: %+v", children)
				}
			} else if result.MindMap.Sheets[0].Root.Children[0].Notes != "需记录负责人" {
				t.Fatalf("legacy notes lost: %+v", result.MindMap)
			}
		})
	}
}

func TestXMindPreviewResistsSpoofAndOversize(t *testing.T) {
	wrong := makePreviewZIP(t, map[string]string{"content.json": `{"anything":"else"}`})
	result, err := containerSummary(wrong)
	if err != nil || result.Kind != "archive" || result.MindMap != nil {
		t.Fatalf("non-XMind ZIP spoofed diagram: %+v %v", result, err)
	}
	giant := makePreviewZIP(t, map[string]string{"content.json": `[{"title":"big","rootTopic":{"title":"secret"}}]` +
		strings.Repeat(" ", maxXMindContentBytes)})
	result, err = containerSummary(giant)
	if err != nil || result.Kind != "archive" || result.MindMap != nil {
		t.Fatalf("oversized content was decoded: %+v %v", result, err)
	}
	root := map[string]interface{}{"title": "root"}
	children := make([]map[string]interface{}, maxXMindTopics+20)
	for i := range children {
		children[i] = map[string]interface{}{"title": "part"}
	}
	root["children"] = map[string]interface{}{"attached": children}
	raw, err := json.Marshal([]map[string]interface{}{{"title": "trunc", "rootTopic": root}})
	if err != nil {
		t.Fatal(err)
	}
	huge := makePreviewZIP(t, map[string]string{"content.json": string(raw)})
	result, err = containerSummary(huge)
	if err != nil || result.MindMap == nil || !result.Truncated || result.MindMap.TopicCount != maxXMindTopics {
		t.Fatalf("expected capped nodes: %+v %v", result, err)
	}
}

func TestXMindPreviewOnlyACLAndVersion(t *testing.T) {
	svc, _ := testService(t)
	ctx := context.Background()
	admin := domain.User{ID: "u_admin", Login: "admin", IsAdmin: true}
	member := domain.User{ID: "u_user", Login: "user1"}
	payload := makePreviewZIP(t, map[string]string{"content.json": `[{"title":"审计方案","rootTopic":{"title":"受控节点","children":{"attached":[{"title":"签收"}]}}}]`})
	uploaded, err := svc.CommitUpload(ctx, admin, "folder_market", "DHF.xmind", "application/vnd.xmind.workbook", "", bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Preview(ctx, member, uploaded.FileID); err != domain.ErrForbidden {
		t.Fatalf("unexpected access: %v", err)
	}
	share, err := svc.CreateShare(ctx, admin, ShareDraft{ResourceKind: "file", ResourceID: uploaded.FileID, RecipientKind: "user",
		RecipientID: member.ID, Actions: []domain.Action{domain.ActionPreview}})
	if err != nil {
		t.Fatal(err)
	}
	preview, err := svc.Preview(ctx, member, uploaded.FileID)
	if err != nil || preview.Renderer != "mindmap" || preview.Structured == nil || preview.Structured.MindMap == nil {
		t.Fatalf("no preview-only XMind: %+v %v", preview, err)
	}
	if preview.Sha256 != uploaded.Sha256 {
		t.Fatalf("sha mismatch: %s", preview.Sha256)
	}
	if _, _, err = svc.OpenDownload(ctx, member, uploaded.FileID); err != domain.ErrForbidden {
		t.Fatalf("preview must not grant downloads: %v", err)
	}
	if err = svc.RevokeShare(ctx, admin, share.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = svc.Preview(ctx, member, uploaded.FileID); err != domain.ErrForbidden {
		t.Fatalf("revoked preview allowed: %v", err)
	}
}
