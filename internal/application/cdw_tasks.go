package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
)

// These commands intentionally cover the initial single-file task slice.
// Multi-file manifests, Office deliveries and review decisions remain separate
// and MUST NOT advance merely because a subtask was delegated or accepted.
type CDWRootTaskInput struct {
	Title             string                    `json:"title"`
	FileID            string                    `json:"fileId"`
	TemplateVersionID string                    `json:"templateVersionId"`
	Assignee          ports.CDWAssignmentTarget `json:"assignee"`
}
type CDWChildTaskInput struct {
	Title    string                    `json:"childTitle"`
	Assignee ports.CDWAssignmentTarget `json:"assignee"`
}

func validCDWTaskInput(title string, target ports.CDWAssignmentTarget) bool {
	return title == strings.TrimSpace(title) && len(title) > 0 && len([]rune(title)) <= 255 &&
		(target.Kind == "user" || target.Kind == "workgroup") && strings.TrimSpace(target.ID) == target.ID && target.ID != ""
}

func cdwCommandHash(operation, id string, request any) string {
	raw, _ := json.Marshal(struct {
		Operation  string `json:"operation"`
		ResourceID string `json:"resourceId"`
		Request    any    `json:"request"`
	}{operation, id, request})
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

// cdwMutate makes operation claiming, the domain mutation, conventional audit,
// append-only domain event, outbox and persisted replay response atomic.
func (s *Service) cdwMutate(ctx context.Context, actor domain.User, operation, key, hash string, status int,
	authorize func(ports.Tx, ports.CDWTaskStore) error,
	mutate func(ports.Tx, ports.CDWTaskStore) (ports.CDWTaskResult, error),
) (ports.CDWTaskResult, error) {
	if len(key) < 8 || len(key) > 128 {
		return ports.CDWTaskResult{}, domain.ErrInvalidInput
	}
	for _, ch := range key {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_') {
			return ports.CDWTaskResult{}, domain.ErrInvalidInput
		}
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ports.CDWTaskResult{}, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return ports.CDWTaskResult{}, errors.New("CDW transaction store unavailable")
	}
	if err = authorize(tx, store); err != nil {
		return ports.CDWTaskResult{}, err
	}
	prior, replayed, err := store.CDWClaimOperation(ctx, actor.ID, operation, key, hash)
	if err != nil {
		return ports.CDWTaskResult{}, err
	}
	if replayed {
		var result ports.CDWTaskResult
		if err = json.Unmarshal(prior, &result); err != nil {
			return ports.CDWTaskResult{}, err
		}
		return result, nil
	}
	result, err := mutate(tx, store)
	if err != nil {
		return ports.CDWTaskResult{}, err
	}
	if err = store.CDWEvent(ctx, actor.ID, operation, result.TaskID, NewID("cdwreq"), result); err != nil {
		return ports.CDWTaskResult{}, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw."+operation, "task", result.TaskID, "success",
		map[string]any{"state": result.State, "parentTaskId": result.ParentTaskID, "assignmentId": result.AssignmentID}); err != nil {
		return ports.CDWTaskResult{}, err
	}
	if err = store.CDWCompleteOperation(ctx, actor.ID, operation, key, status, result); err != nil {
		return ports.CDWTaskResult{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return ports.CDWTaskResult{}, err
	}
	return result, nil
}

func (s *Service) cdwCheckReceiver(ctx context.Context, tx ports.Tx, store ports.CDWTaskStore, fileID string, target ports.CDWAssignmentTarget) error {
	recipients, err := store.CDWActiveRecipients(ctx, target)
	if err != nil {
		return err
	}
	for _, id := range recipients {
		person, err := tx.UserByID(ctx, id)
		if err != nil || person.DisabledAt != nil {
			return domain.ErrForbidden
		}
		if _, err = s.visibleFile(ctx, tx, person, fileID, domain.ActionPreview); err != nil {
			return domain.ErrForbidden
		}
	}
	return nil
}

// Administrative task creation is deliberately narrower than controlled
// document approval: admin may allocate work but gains no formal approval role.
func (s *Service) CDWCreateRootTask(ctx context.Context, actor domain.User, input CDWRootTaskInput, key string) (ports.CDWTaskResult, error) {
	if !validCDWTaskInput(input.Title, input.Assignee) || input.FileID == "" {
		return ports.CDWTaskResult{}, domain.ErrInvalidInput
	}
	if !actor.IsAdmin {
		return ports.CDWTaskResult{}, domain.ErrForbidden
	}
	return s.cdwMutate(ctx, actor, "task.create", key, cdwCommandHash("task.create", "", input), 201,
		func(tx ports.Tx, store ports.CDWTaskStore) error {
			if _, err := s.visibleFile(ctx, tx, actor, input.FileID, domain.ActionPreview); err != nil {
				return err
			}
			return s.cdwCheckReceiver(ctx, tx, store, input.FileID, input.Assignee)
		},
		func(tx ports.Tx, store ports.CDWTaskStore) (ports.CDWTaskResult, error) {
			id := NewID("cdwtask")
			return store.CDWCreateRoot(ctx, ports.CDWTaskCommand{
				TaskID: id, RootID: id, AssignmentID: NewID("cdwasn"),
				Title: input.Title, FileID: input.FileID, TemplateVersionID: input.TemplateVersionID, Target: input.Assignee,
			}, actor.ID)
		})
}

func (s *Service) CDWAcceptTask(ctx context.Context, actor domain.User, taskID string, expected int64, key string) (ports.CDWTaskResult, error) {
	if taskID == "" || expected < 1 {
		return ports.CDWTaskResult{}, domain.ErrInvalidInput
	}
	return s.cdwMutate(ctx, actor, "task.accept", key, cdwCommandHash("task.accept", taskID, expected), 200,
		func(tx ports.Tx, store ports.CDWTaskStore) error {
			fileID, _, _, err := store.CDWTaskScope(ctx, taskID)
			if err != nil {
				return err
			}
			_, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview)
			return err
		},
		func(_ ports.Tx, store ports.CDWTaskStore) (ports.CDWTaskResult, error) {
			return store.CDWAccept(ctx, taskID, actor.ID, expected)
		})
}

// Delegating creates an independent child and three pending parent obligations.
// The parent's accepted state/assignee and all ancestor obligations remain.
func (s *Service) CDWDelegateTask(ctx context.Context, actor domain.User, parentID string, input CDWChildTaskInput, expected int64, key string) (ports.CDWTaskResult, error) {
	if parentID == "" || expected < 1 || !validCDWTaskInput(input.Title, input.Assignee) {
		return ports.CDWTaskResult{}, domain.ErrInvalidInput
	}
	return s.cdwMutate(ctx, actor, "task.delegate", key,
		cdwCommandHash("task.delegate", parentID, struct {
			Input    CDWChildTaskInput `json:"input"`
			Revision int64             `json:"revision"`
		}{input, expected}), 201,
		func(tx ports.Tx, store ports.CDWTaskStore) error {
			fileID, _, _, err := store.CDWTaskScope(ctx, parentID)
			if err != nil {
				return err
			}
			if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
				return err
			}
			return s.cdwCheckReceiver(ctx, tx, store, fileID, input.Assignee)
		},
		func(_ ports.Tx, store ports.CDWTaskStore) (ports.CDWTaskResult, error) {
			fileID, rootID, templateID, err := store.CDWTaskScope(ctx, parentID)
			if err != nil {
				return ports.CDWTaskResult{}, err
			}
			cmd := ports.CDWTaskCommand{TaskID: NewID("cdwtask"), RootID: rootID, ParentID: parentID,
				TemplateVersionID: templateID, FileID: fileID, Title: input.Title,
				AssignmentID: NewID("cdwasn"), Target: input.Assignee}
			return store.CDWDelegate(ctx, parentID, actor.ID, expected, cmd,
				[3]string{NewID("cdwobl"), NewID("cdwobl"), NewID("cdwobl")})
		})
}

func (s *Service) CDWTaskInbox(ctx context.Context, actor domain.User, limit int) ([]ports.CDWInboxItem, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 100 {
		limit = 100
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return nil, errors.New("CDW transaction store unavailable")
	}
	// Fetch additional rows to account for ACL-revoked items hidden below.
	raw, err := store.CDWInbox(ctx, actor.ID, limit*4)
	if err != nil {
		return nil, err
	}
	result := make([]ports.CDWInboxItem, 0, limit)
	for _, item := range raw {
		if _, err = s.visibleFile(ctx, tx, actor, item.FileID, domain.ActionPreview); err == nil {
			result = append(result, item)
			if len(result) >= limit {
				break
			}
		}
	}
	return result, nil
}
