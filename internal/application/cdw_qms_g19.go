package application

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strconv"
	"strings"
	"time"
)

const cdwG19MaxNodes = 512
const cdwG19SegmentNodes = 16

func cdwG19Hash(index int, first, last, previous string, bytes []byte) string {
	var b strings.Builder
	b.WriteString("cdw-qms-segment-v1\n")
	b.WriteString(strconv.Itoa(index))
	b.WriteByte('\n')
	b.WriteString(first)
	b.WriteByte('\n')
	b.WriteString(last)
	b.WriteByte('\n')
	b.WriteString(previous)
	b.WriteByte('\n')
	h := sha256.New()
	_, _ = h.Write([]byte(b.String()))
	_, _ = h.Write(bytes)
	return hex.EncodeToString(h.Sum(nil))
}

// Verify manifest length, predecessor links, and exact byte hashes. Export
// and consumers can use the same proof; never treat a missing segment as
// complete, even when every remaining digest is otherwise valid.
func cdwG19Verify(p ports.CDWQMSAuditSegmentedPacket) bool {
	if !p.Complete || p.TotalNodes < 1 || p.TotalSegments != len(p.Segments) ||
		p.RootApprovalID == "" || p.FocusApprovalID == "" {
		return false
	}
	prevHash := ""
	prevApproval := ""
	count := 0
	containsFocus := false
	for i, seg := range p.Segments {
		if seg.Index != i || seg.PreviousSegmentSHA256 != prevHash {
			return false
		}
		raw, err := base64.StdEncoding.DecodeString(seg.PayloadBase64)
		if err != nil {
			return false
		}
		var content ports.CDWQMSAuditSegmentContent
		if json.Unmarshal(raw, &content) != nil || len(content.Nodes) == 0 || len(content.Nodes) > cdwG19SegmentNodes {
			return false
		}
		if content.Nodes[0].ApprovalID != seg.FirstApprovalID ||
			content.Nodes[len(content.Nodes)-1].ApprovalID != seg.LastApprovalID {
			return false
		}
		if cdwG19Hash(i, seg.FirstApprovalID, seg.LastApprovalID, prevHash, raw) != seg.ContentSHA256 {
			return false
		}
		for j, n := range content.Nodes {
			if n.PreviousApprovalID != prevApproval || n.ApprovalID == "" {
				return false
			}
			if n.ApprovalID == p.FocusApprovalID {
				containsFocus = true
			}
			if j == 0 && i == 0 && n.ApprovalID != p.RootApprovalID {
				return false
			}
			prevApproval = n.ApprovalID
			count++
		}
		prevHash = seg.ContentSHA256
	}
	return count == p.TotalNodes && prevHash == p.LastSegmentSHA256 && containsFocus
}

func (s *Service) CDWQMSFormalAuditSegmented(ctx context.Context, actor domain.User, focus string) ([]byte, error) {
	if focus == "" {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWQMSG16Store)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	formal, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	if err = store.CDWQMSAuditBeginSnapshot(ctx); err != nil {
		return nil, err
	}
	fileID, err := formal.CDWFormalApprovalFile(ctx, focus)
	if err != nil {
		return nil, err
	}
	allowed, err := store.CDWQMSAuditCanExport(ctx, actor.ID, fileID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return nil, err
	}
	ids, truncated, err := store.CDWQMSAuditChainIDs(ctx, focus, cdwG19MaxNodes)
	if err != nil {
		return nil, err
	}
	if truncated {
		return nil, domain.ErrConflict
	}
	nodes, err := store.CDWQMSAuditNodes(ctx, ids)
	if err != nil {
		return nil, err
	}
	if len(nodes) != len(ids) {
		return nil, domain.ErrConflict
	}
	for i, n := range nodes {
		if n.ApprovalID != ids[i] || n.FileID != fileID {
			return nil, domain.ErrConflict
		}
		if i == 0 && n.PreviousApprovalID != "" {
			return nil, domain.ErrConflict
		}
		if i > 0 && n.PreviousApprovalID != nodes[i-1].ApprovalID {
			return nil, domain.ErrConflict
		}
		if _, err = s.visibleFile(ctx, tx, actor, n.FileID, domain.ActionPreview); err != nil {
			return nil, err
		}
	}
	packet := ports.CDWQMSAuditSegmentedPacket{
		SchemaVersion: "cdw-qms-segmented-v1", GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
		RequestedBy: actor.ID, FocusApprovalID: focus, RootApprovalID: ids[0],
		TotalNodes: len(nodes), Complete: true, Segments: []ports.CDWQMSAuditSegment{},
		Closure: cdwQMSClosureStats(ports.CDWQMSFormalLineage{Nodes: nodes}),
	}
	prevHash := ""
	stepCount, decisionCount, noticeCount, escalationCount := 0, 0, 0, 0
	for start := 0; start < len(nodes); start += cdwG19SegmentNodes {
		end := start + cdwG19SegmentNodes
		if end > len(nodes) {
			end = len(nodes)
		}
		facts, e := store.CDWQMSAuditFacts(ctx, ids[start:end])
		if e != nil {
			return nil, e
		}
		stepCount += len(facts.Steps)
		decisionCount += len(facts.Decisions)
		noticeCount += len(facts.Notices)
		escalationCount += len(facts.Escalations)
		part := ports.CDWQMSAuditSegmentContent{Nodes: nodes[start:end], Facts: facts}
		payload, e := json.Marshal(part)
		if e != nil {
			return nil, e
		}
		seg := ports.CDWQMSAuditSegment{
			Index: len(packet.Segments), FirstApprovalID: nodes[start].ApprovalID,
			LastApprovalID: nodes[end-1].ApprovalID, PreviousSegmentSHA256: prevHash,
			PayloadBase64: base64.StdEncoding.EncodeToString(payload),
		}
		seg.ContentSHA256 = cdwG19Hash(seg.Index, seg.FirstApprovalID, seg.LastApprovalID, prevHash, payload)
		prevHash = seg.ContentSHA256
		packet.Segments = append(packet.Segments, seg)
	}
	packet.TotalSegments = len(packet.Segments)
	packet.LastSegmentSHA256 = prevHash
	if !cdwG19Verify(packet) {
		return nil, domain.ErrConflict
	}
	raw, err := json.MarshalIndent(packet, "", "  ")
	if err != nil {
		return nil, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw.qms.formal.audit.segmented.requested",
		"formal_approval", focus, "success", map[string]any{
			"segmentCount": packet.TotalSegments, "nodeCount": packet.TotalNodes,
			"stepCount": stepCount, "decisionCount": decisionCount, "noticeCount": noticeCount, "escalationCount": escalationCount,
			"lastSegmentSHA256": packet.LastSegmentSHA256}); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return raw, nil
}

func (s *Service) CDWQMSPortfolio(ctx context.Context, actor domain.User) (ports.CDWQMSPortfolio, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ports.CDWQMSPortfolio{}, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWQMSG16Store)
	if !ok {
		return ports.CDWQMSPortfolio{}, domain.ErrInvalidInput
	}
	page, err := store.CDWQMSPortfolio(ctx, actor.ID, 100)
	if err != nil {
		return page, err
	}
	items := make([]ports.CDWQMSPortfolioItem, 0, len(page.Items))
	for _, item := range page.Items {
		if _, e := s.visibleFile(ctx, tx, actor, item.FileID, domain.ActionPreview); e == nil {
			items = append(items, item)
		}
		if ctx.Err() != nil {
			return ports.CDWQMSPortfolio{}, ctx.Err()
		}
	}
	page.Items = items
	return page, nil
}
