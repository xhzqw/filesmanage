package application

import (
	"encoding/base64"
	"encoding/json"
	"filesmanage/internal/ports"
	"fmt"
	"testing"
)

func TestCDWQMSG19SegmentContinuity(t *testing.T) {
	nodes := make([]ports.CDWQMSLineageNode, 33)
	for i := range nodes {
		nodes[i].ApprovalID = fmt.Sprintf("approval-%03d", i)
		if i > 0 {
			nodes[i].PreviousApprovalID = nodes[i-1].ApprovalID
		}
	}
	p := ports.CDWQMSAuditSegmentedPacket{
		SchemaVersion: "cdw-qms-segmented-v1", Complete: true,
		FocusApprovalID: nodes[25].ApprovalID, RootApprovalID: nodes[0].ApprovalID,
		TotalNodes: len(nodes), Segments: []ports.CDWQMSAuditSegment{},
	}
	prev := ""
	for start := 0; start < len(nodes); start += cdwG19SegmentNodes {
		end := start + cdwG19SegmentNodes
		if end > len(nodes) {
			end = len(nodes)
		}
		content := ports.CDWQMSAuditSegmentContent{Nodes: nodes[start:end], Facts: ports.CDWQMSAuditFacts{
			Steps: []ports.CDWQMSAuditStep{}, Decisions: []ports.CDWQMSAuditDecision{},
			Notices: []ports.CDWQMSAuditNotice{},
		}}
		raw, err := json.Marshal(content)
		if err != nil {
			t.Fatal(err)
		}
		seg := ports.CDWQMSAuditSegment{
			Index: len(p.Segments), FirstApprovalID: nodes[start].ApprovalID,
			LastApprovalID: nodes[end-1].ApprovalID, PreviousSegmentSHA256: prev,
			PayloadBase64: base64.StdEncoding.EncodeToString(raw),
		}
		seg.ContentSHA256 = cdwG19Hash(seg.Index, seg.FirstApprovalID, seg.LastApprovalID, prev, raw)
		p.Segments = append(p.Segments, seg)
		prev = seg.ContentSHA256
	}
	p.LastSegmentSHA256 = prev
	p.TotalSegments = len(p.Segments)
	if p.TotalSegments != 3 || !cdwG19Verify(p) {
		t.Fatal("multi-segment 33 node audit must be complete")
	}
	missing := p
	missing.Segments = append([]ports.CDWQMSAuditSegment{}, p.Segments[1:]...)
	if cdwG19Verify(missing) {
		t.Fatal("missing root segment accepted")
	}
	badHash := p
	badHash.Segments = append([]ports.CDWQMSAuditSegment{}, p.Segments...)
	badHash.Segments[1].ContentSHA256 = "0000"
	if cdwG19Verify(badHash) {
		t.Fatal("altered digest accepted")
	}
	badData := p
	badData.Segments = append([]ports.CDWQMSAuditSegment{}, p.Segments...)
	badData.Segments[1].PayloadBase64 = base64.StdEncoding.EncodeToString([]byte("{}"))
	if cdwG19Verify(badData) {
		t.Fatal("altered payload accepted")
	}
	badOrder := p
	badOrder.Segments = append([]ports.CDWQMSAuditSegment{}, p.Segments...)
	badOrder.Segments[0], badOrder.Segments[1] = badOrder.Segments[1], badOrder.Segments[0]
	if cdwG19Verify(badOrder) {
		t.Fatal("reordered segments accepted")
	}
	p.Complete = false
	if cdwG19Verify(p) {
		t.Fatal("incomplete packet accepted")
	}
}
