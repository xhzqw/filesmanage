package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"time"
)

func cdwQMSClosureStats(lineage ports.CDWQMSFormalLineage) ports.CDWQMSClosureStats {
	out := ports.CDWQMSClosureStats{ChainStatus: "no_active_reapproval"}
	for _, n := range lineage.Nodes {
		if n.State == "conflicted" {
			out.Interrupted++
		}
		if n.PreviousApprovalID != "" {
			out.Restarted++
		}
		if n.State == "pending" {
			out.ApprovalsInProgress++
		}
		if n.State == "approved" {
			out.ApprovalsApproved++
		}
		out.UnconfirmedNotices += n.NoticeTotal - n.NoticeRead
	}
	if len(lineage.Nodes) > 0 {
		last := lineage.Nodes[len(lineage.Nodes)-1]
		switch last.State {
		case "pending":
			out.ChainStatus = "reapproval_in_progress"
		case "approved":
			if out.UnconfirmedNotices > 0 {
				out.ChainStatus = "approved_notice_pending"
			} else {
				out.ChainStatus = "approved_notice_confirmed"
			}
		case "conflicted":
			out.ChainStatus = "awaiting_reapproval"
		default:
			out.ChainStatus = "closed_without_approval"
		}
	}
	return out
}

// Audit export requires a current controller and a live file ACL for every
// link. The audit log records export REQUEST, not delivery or legal approval.
func (s *Service) CDWQMSFormalAudit(ctx context.Context, actor domain.User, id string) ([]byte, error) {
	if id == "" {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	formal, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	g18, ok := tx.(ports.CDWQMSG16Store)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	fileID, err := formal.CDWFormalApprovalFile(ctx, id)
	if err != nil {
		return nil, err
	}
	allowed, err := g18.CDWQMSAuditCanExport(ctx, actor.ID, fileID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return nil, err
	}
	chain, err := g18.CDWQMSFormalLineage(ctx, id)
	if err != nil {
		return nil, err
	}
	if chain.Truncated {
		return nil, domain.ErrConflict
	}
	ids := make([]string, 0, len(chain.Nodes))
	for _, node := range chain.Nodes {
		if node.FileID != fileID {
			return nil, domain.ErrConflict
		}
		if _, err = s.visibleFile(ctx, tx, actor, node.FileID, domain.ActionPreview); err != nil {
			return nil, err
		}
		ids = append(ids, node.ApprovalID)
	}
	facts, err := g18.CDWQMSAuditFacts(ctx, ids)
	if err != nil {
		return nil, err
	}
	packet := ports.CDWQMSAuditPacket{
		SchemaVersion: "cdw-qms-audit-v1", GeneratedAt: time.Now().UTC().Format(time.RFC3339Nano),
		RequestedBy: actor.ID, Lineage: chain, Closure: cdwQMSClosureStats(chain), Facts: facts,
	}
	raw, err := json.MarshalIndent(packet, "", "  ")
	if err != nil {
		return nil, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw.qms.formal.audit.requested", "formal_approval", id, "success",
		map[string]any{"nodeCount": len(ids), "decisionCount": len(facts.Decisions),
			"noticeCount": len(facts.Notices), "schemaVersion": packet.SchemaVersion}); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return raw, nil
}
