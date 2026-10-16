package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"io"
	"strings"
	"unicode/utf8"
)

type CDWFormalTemplateInput struct {
	TemplateKey             string                          `json:"templateKey"`
	Steps                   []ports.CDWFormalStepDefinition `json:"steps"`
	AuthorityBasisReleaseID string                          `json:"authorityBasisReleaseId,omitempty"`
}
type CDWFormalRoleInput struct {
	UserID                  string `json:"userId"`
	FileID                  string `json:"fileId"`
	AuthorityBasisReleaseID string `json:"authorityBasisReleaseId,omitempty"`
}
type CDWFormalStartInput struct {
	DeliveryID         string `json:"deliveryId"`
	TemplateVersionID  string `json:"templateVersionId"`
	ReplacesApprovalID string `json:"replacesApprovalId,omitempty"`
}
type CDWFormalDecisionInput struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}
type CDWFormalCreated struct {
	ID string `json:"id"`
}

func (s *Service) cdwFormalMutate(ctx context.Context, actor domain.User, op, key, hash, objectID string, status int,
	run func(ports.Tx, ports.CDWFormalStore) (any, error)) (json.RawMessage, error) {
	if !validCDWOperationKey(key) {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	ops, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	prior, replay, err := ops.CDWClaimOperation(ctx, actor.ID, op, key, hash)
	if err != nil {
		return nil, err
	}
	if replay {
		return prior, nil
	}
	value, err := run(tx, store)
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw."+op, "formal_approval", objectID, "success",
		map[string]any{"operation": op, "result": value}); err != nil {
		return nil, err
	}
	if err = store.CDWFormalEvent(ctx, actor.ID, op, objectID, key, map[string]any{"operation": op, "result": value}); err != nil {
		return nil, err
	}
	branch, ok := tx.(ports.CDWBranchStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	if err = branch.CDWCompleteOperationRaw(ctx, actor.ID, op, key, status, raw); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return raw, nil
}

func (s *Service) CDWPublishFormalTemplate(ctx context.Context, actor domain.User, input CDWFormalTemplateInput, key string) (CDWFormalCreated, error) {
	var result CDWFormalCreated
	if !actor.IsAdmin {
		return result, domain.ErrForbidden
	}
	name := strings.TrimSpace(input.TemplateKey)
	if name != input.TemplateKey || len(name) < 3 || len(name) > 90 || len(input.Steps) < 1 || len(input.Steps) > 30 {
		return result, domain.ErrInvalidInput
	}
	for _, ch := range name {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_') {
			return result, domain.ErrInvalidInput
		}
	}
	seen := map[string]bool{}
	for _, step := range input.Steps {
		if step.Sequence < 1 || step.Sequence > 1000 || step.NodeKey == "" || len(step.NodeKey) > 100 || strings.TrimSpace(step.NodeKey) != step.NodeKey || step.ApproverID == "" || seen[step.NodeKey] {
			return result, domain.ErrInvalidInput
		}
		seen[step.NodeKey] = true
	}
	id := NewID("cdwformaltemplate")
	raw, err := s.cdwFormalMutate(ctx, actor, "formal.template.publish", key, cdwCommandHash("formal.template.publish", "", input), id, 201,
		func(tx ports.Tx, store ports.CDWFormalStore) (any, error) {
			published, err := store.CDWPublishFormalTemplate(ctx, id, name, input.Steps, actor.ID, input.AuthorityBasisReleaseID)
			return CDWFormalCreated{ID: published}, err
		})
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(raw, &result)
	return result, err
}

func (s *Service) CDWGrantFormalApprover(ctx context.Context, actor domain.User, input CDWFormalRoleInput, key string) (CDWFormalCreated, error) {
	var result CDWFormalCreated
	if !actor.IsAdmin {
		return result, domain.ErrForbidden
	}
	if input.UserID == "" || input.FileID == "" {
		return result, domain.ErrInvalidInput
	}
	// Issuance requires the file to be visible to the administrator.
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return result, err
	}
	_, err = s.visibleFile(ctx, tx, actor, input.FileID, domain.ActionPreview)
	_ = tx.Rollback(ctx)
	if err != nil {
		return result, err
	}
	id := NewID("cdwformalrole")
	raw, err := s.cdwFormalMutate(ctx, actor, "formal.role.grant", key, cdwCommandHash("formal.role.grant", "", input), input.FileID, 201,
		func(tx ports.Tx, store ports.CDWFormalStore) (any, error) {
			if _, e := s.visibleFile(ctx, tx, actor, input.FileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			person, e := tx.UserByID(ctx, input.UserID)
			if e != nil || person.DisabledAt != nil {
				return nil, domain.ErrForbidden
			}
			if _, e = s.visibleFile(ctx, tx, person, input.FileID, domain.ActionPreview); e != nil {
				return nil, domain.ErrForbidden
			}
			actual, e := store.CDWGrantFormalApprover(ctx, id, input.UserID, input.FileID, actor.ID, input.AuthorityBasisReleaseID)
			return CDWFormalCreated{ID: actual}, e
		})
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(raw, &result)
	return result, err
}

func (s *Service) CDWStartFormalApproval(ctx context.Context, actor domain.User, input CDWFormalStartInput, key string) (ports.CDWFormalApproval, error) {
	var result ports.CDWFormalApproval
	if !actor.IsAdmin {
		return result, domain.ErrForbidden
	}
	if input.DeliveryID == "" || input.TemplateVersionID == "" {
		return result, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return result, err
	}
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		_ = tx.Rollback(ctx)
		return result, domain.ErrInvalidInput
	}
	fileID, err := store.CDWFormalDeliveryFile(ctx, input.DeliveryID)
	if err == nil {
		_, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview)
	}
	_ = tx.Rollback(ctx)
	if err != nil {
		return result, err
	}
	id := NewID("cdwformal")
	subjectID := NewID("cdwsubject")
	raw, err := s.cdwFormalMutate(ctx, actor, "formal.start", key, cdwCommandHash("formal.start", "", input), id, 201,
		func(tx ports.Tx, store ports.CDWFormalStore) (any, error) {
			if _, e := s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
				return nil, e
			}
			g16, ok := tx.(ports.CDWQMSG16Store)
			if !ok {
				return nil, domain.ErrInvalidInput
			}
			mustLink, e := g16.CDWQMSRequiresRestart(ctx, fileID)
			if e != nil {
				return nil, e
			}
			if mustLink && input.ReplacesApprovalID == "" {
				return nil, domain.ErrConflict
			}
			created, e := store.CDWStartFormalApproval(ctx, id, subjectID, input.DeliveryID, input.TemplateVersionID, actor.ID, key)
			if e != nil {
				return nil, e
			}
			if input.ReplacesApprovalID != "" {
				if e = g16.CDWQMSRecordRestart(ctx, NewID("cdwqmsrestart"), input.ReplacesApprovalID, id, actor.ID); e != nil {
					return nil, e
				}
				created.ReplacesApprovalID = input.ReplacesApprovalID
			}
			return created, nil
		})
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(raw, &result)
	return result, err
}

func (s *Service) CDWDecideFormalApproval(ctx context.Context, actor domain.User, id string, input CDWFormalDecisionInput, expected int64, key string) (ports.CDWFormalApproval, error) {
	var result ports.CDWFormalApproval
	input.Reason = strings.TrimSpace(input.Reason)
	if id == "" || expected < 1 || (input.Decision != "approve" && input.Decision != "reject") ||
		(input.Decision == "reject" && input.Reason == "") || !utf8.ValidString(input.Reason) || utf8.RuneCountInString(input.Reason) > 3000 {
		return result, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return result, err
	}
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		_ = tx.Rollback(ctx)
		return result, domain.ErrInvalidInput
	}
	fileID, err := store.CDWFormalApprovalFile(ctx, id)
	if err == nil {
		_, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview)
	}
	_ = tx.Rollback(ctx)
	if err != nil {
		return result, err
	}
	raw, err := s.cdwFormalMutate(ctx, actor, "formal.decide", key, cdwCommandHash("formal.decide", id, struct {
		Input    CDWFormalDecisionInput `json:"input"`
		Expected int64                  `json:"expected"`
	}{input, expected}), id, 200, func(tx ports.Tx, store ports.CDWFormalStore) (any, error) {
		if _, e := s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); e != nil {
			return nil, e
		}
		return store.CDWDecideFormalApproval(ctx, id, actor.ID, NewID("cdwformaldecision"), expected, input.Decision, input.Reason, NewID("cdwcandidate"))
	})
	if err != nil {
		return result, err
	}
	err = json.Unmarshal(raw, &result)
	return result, err
}

func (s *Service) CDWFormalInbox(ctx context.Context, actor domain.User, limit int) ([]ports.CDWFormalApproval, error) {
	if limit < 1 || limit > 100 {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	all, err := store.CDWFormalInbox(ctx, actor.ID, limit)
	if err != nil {
		return nil, err
	}
	filtered := []ports.CDWFormalApproval{}
	for _, v := range all {
		if _, e := s.visibleFile(ctx, tx, actor, v.FileID, domain.ActionPreview); e == nil {
			filtered = append(filtered, v)
		}
	}
	return filtered, nil
}
func (s *Service) CDWFormalReady(ctx context.Context, actor domain.User, limit int) ([]ports.CDWFormalReadyDelivery, error) {
	if !actor.IsAdmin {
		return nil, domain.ErrForbidden
	}
	if limit < 1 || limit > 100 {
		return nil, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	records, err := store.CDWFormalReady(ctx, limit)
	if err != nil {
		return nil, err
	}
	result := []ports.CDWFormalReadyDelivery{}
	for _, record := range records {
		if _, e := s.visibleFile(ctx, tx, actor, record.FileID, domain.ActionPreview); e == nil {
			result = append(result, record)
		}
	}
	return result, nil
}
func (s *Service) cdwFormalRead(ctx context.Context, actor domain.User, id string) (ports.CDWFormalStore, ports.Tx, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	store, ok := tx.(ports.CDWFormalStore)
	if !ok {
		_ = tx.Rollback(ctx)
		return nil, nil, domain.ErrInvalidInput
	}
	fileID, err := store.CDWFormalApprovalFile(ctx, id)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	allowed, err := store.CDWFormalCanRead(ctx, id, actor.ID)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	if !allowed {
		_ = tx.Rollback(ctx)
		return nil, nil, domain.ErrForbidden
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	return store, tx, nil
}
func (s *Service) CDWFormalDetail(ctx context.Context, actor domain.User, id string) (ports.CDWFormalDetail, error) {
	store, tx, err := s.cdwFormalRead(ctx, actor, id)
	if err != nil {
		return ports.CDWFormalDetail{}, err
	}
	defer tx.Rollback(ctx)
	return store.CDWFormalDetail(ctx, id)
}
func (s *Service) CDWFormalContent(ctx context.Context, actor domain.User, id string) (io.ReadSeekCloser, string, int64, error) {
	store, tx, err := s.cdwFormalRead(ctx, actor, id)
	if err != nil {
		return nil, "", 0, err
	}
	source, err := store.CDWFormalBlobSource(ctx, id)
	_ = tx.Rollback(ctx)
	if err != nil {
		return nil, "", 0, err
	}
	reader, err := s.blobs.Open(source.StorageKey)
	return reader, source.Name, source.SizeBytes, err
}
