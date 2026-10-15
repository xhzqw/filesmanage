package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"io"
	"net/http"
	"strings"
	"time"
)

type CDWBranchEditorView struct {
	Branch    ports.CDWBranch        `json:"branch"`
	Session   ports.CDWBranchSession `json:"session"`
	EditorURL string                 `json:"editorUrl"`
	Config    map[string]any         `json:"config"`
}

func (s *Service) cdwBranchForActor(ctx context.Context, tx ports.Tx, actor domain.User, id string) (ports.CDWBranch, ports.CDWBranchStore, error) {
	store, ok := tx.(ports.CDWBranchStore)
	if !ok {
		return ports.CDWBranch{}, nil, errors.New("CDW branch store unavailable")
	}
	branch, err := store.CDWBranchForActor(ctx, id, actor.ID)
	if err != nil {
		return branch, nil, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, branch.FileID, domain.ActionPreview); err != nil {
		return branch, nil, err
	}
	return branch, store, nil
}
func (s *Service) CDWCreateBranch(ctx context.Context, actor domain.User, taskID string) (ports.CDWBranch, error) {
	if taskID == "" {
		return ports.CDWBranch{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ports.CDWBranch{}, err
	}
	defer tx.Rollback(ctx)
	taskStore, ok := tx.(ports.CDWTaskStore)
	if !ok {
		return ports.CDWBranch{}, domain.ErrInvalidInput
	}
	fileID, _, _, err := taskStore.CDWTaskScope(ctx, taskID)
	if err != nil {
		return ports.CDWBranch{}, err
	}
	if _, err = s.visibleFile(ctx, tx, actor, fileID, domain.ActionPreview); err != nil {
		return ports.CDWBranch{}, err
	}
	branchStore, ok := tx.(ports.CDWBranchStore)
	if !ok {
		return ports.CDWBranch{}, domain.ErrInvalidInput
	}
	branch, err := branchStore.CDWCreateBranch(ctx, NewID("cdwbranch"), taskID, fileID, actor.ID)
	if err != nil {
		return branch, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw.branch.created", "task", taskID, "success", map[string]any{"branchId": branch.ID, "fileId": fileID}); err != nil {
		return branch, err
	}
	return branch, tx.Commit(ctx)
}

// A branch owns its own document key; the legacy /office/session and normal
// file_versions mutation path are NEVER involved.
func (s *Service) CDWOpenBranchOffice(ctx context.Context, actor domain.User, branchID string) (CDWBranchEditorView, error) {
	var view CDWBranchEditorView
	if s.office.Secret == "" || s.office.EditorURL == "" {
		return view, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return view, err
	}
	defer tx.Rollback(ctx)
	branch, store, err := s.cdwBranchForActor(ctx, tx, actor, branchID)
	if err != nil {
		return view, err
	}
	file, err := tx.FileByID(ctx, branch.FileID)
	if err != nil {
		return view, err
	}
	if !looksDocx(file.Name, file.ContentType) {
		return view, domain.ErrInvalidInput
	}
	sess, err := store.CDWOpenBranchSession(ctx, branchID, actor.ID, NewID("cdwos"), NewID("cdwkey"), s.now().Add(30*time.Minute))
	if err != nil {
		return view, err
	}
	sourceClaims, err := signJWT(s.office.Secret, map[string]any{"document": map[string]any{"key": sess.DocumentKey}, "purpose": "cdw-branch-source"}, 2*time.Hour)
	if err != nil {
		return view, err
	}
	sourceURL := s.SourceURL() + "/api/internal/office/branch-source/" + sourceClaims
	config := map[string]any{
		"document": map[string]any{
			"fileType": "docx", "key": sess.DocumentKey, "title": file.Name, "url": sourceURL,
			"permissions": map[string]any{"edit": true, "download": false, "print": false},
		},
		"editorConfig": map[string]any{
			"mode": "edit", "callbackUrl": s.SourceURL() + "/api/internal/office/branch-callback",
			"user": map[string]any{"id": actor.ID, "name": actor.DisplayName},
			"lang": "zh-CN", "customization": map[string]any{"autosave": true, "forcesave": true},
		},
	}
	jwt, err := s.SignEditorConfig(config)
	if err != nil {
		return view, err
	}
	config["token"] = jwt
	if err = auditRequired(ctx, tx, actor, "cdw.office.session_open", "branch", branchID, "success", map[string]any{"sessionId": sess.ID}); err != nil {
		return view, err
	}
	if err = tx.Commit(ctx); err != nil {
		return view, err
	}
	return CDWBranchEditorView{Branch: branch, Session: sess, EditorURL: s.office.EditorURL, Config: config}, nil
}
func (s *Service) CDWBranchSource(ctx context.Context, token string) (io.ReadSeekCloser, string, int64, func(), error) {
	claims, err := verifyJWT(s.office.Secret, token)
	if err != nil {
		return nil, "", 0, nil, domain.ErrUnauthorized
	}
	purpose, _ := claims["purpose"].(string)
	document, _ := claims["document"].(map[string]any)
	key, _ := document["key"].(string)
	if purpose != "cdw-branch-source" || key == "" {
		return nil, "", 0, nil, domain.ErrUnauthorized
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, "", 0, nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.CDWBranchStore)
	if !ok {
		return nil, "", 0, nil, domain.ErrInvalidInput
	}
	source, err := store.CDWBranchSessionSource(ctx, key)
	if err != nil {
		return nil, "", 0, nil, err
	}
	reader, err := s.blobs.Open(source.StorageKey)
	if err != nil {
		return nil, "", 0, nil, err
	}
	return reader, source.Name, source.SizeBytes, func() { _ = reader.Close() }, nil
}

// A button labelled "Submit delivery" may request final save fencing. The
// visible editor Save remains ONLYOFFICE's own control; command success is
// merely 'requested', NOT proof that immutable bytes have been persisted.
func (s *Service) CDWRequestBranchSave(ctx context.Context, actor domain.User, branchID, sessionID string) (ports.CDWBranchSave, error) {
	var save ports.CDWBranchSave
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return save, err
	}
	defer tx.Rollback(ctx)
	_, store, err := s.cdwBranchForActor(ctx, tx, actor, branchID)
	if err != nil {
		return save, err
	}
	save, err = store.CDWBeginBranchSave(ctx, branchID, sessionID, actor.ID, NewID("cdwsave"))
	if err != nil {
		return save, err
	}
	session, err := store.CDWBranchSessionByID(ctx, sessionID)
	if err != nil {
		return save, err
	}
	if err = tx.Commit(ctx); err != nil {
		return save, err
	}
	command := map[string]any{"c": "forcesave", "key": session.DocumentKey, "userdata": save.ID}
	signed, err := signJWT(s.office.Secret, command, time.Minute)
	if err != nil {
		return save, err
	}
	command["token"] = signed
	encoded, err := json.Marshal(command)
	if err != nil {
		return save, err
	}
	endpoint := strings.TrimRight(s.office.EditorURL, "/") + "/command"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return save, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+signed)
	client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect disabled") }}
	response, err := client.Do(request)
	if err == nil {
		defer response.Body.Close()
		var outcome struct {
			Error *int `json:"error"`
		}
		if response.StatusCode != 200 {
			err = domain.ErrConflict
		} else if parseErr := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&outcome); parseErr != nil {
			err = parseErr
		} else if outcome.Error == nil || *outcome.Error != 0 {
			err = domain.ErrConflict
		}
	}
	if err != nil {
		// A lost command response is 'unknown' (not successful). Only the matching
		// callback may establish durable completion.
		markTx, e := s.uow.Begin(ctx)
		if e == nil {
			if handle, ok := markTx.(ports.CDWBranchStore); ok {
				_ = handle.CDWMarkBranchSaveUnknown(ctx, save.ID)
			}
			_ = markTx.Commit(ctx)
		}
		save.State = "unknown"
	}
	return save, nil
}
func (s *Service) CDWBranchSaveStatus(ctx context.Context, actor domain.User, branchID, requestID string) (ports.CDWBranchSave, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ports.CDWBranchSave{}, err
	}
	defer tx.Rollback(ctx)
	_, store, err := s.cdwBranchForActor(ctx, tx, actor, branchID)
	if err != nil {
		return ports.CDWBranchSave{}, err
	}
	return store.CDWReadBranchSave(ctx, branchID, requestID, actor.ID)
}
func (s *Service) CDWHandleBranchCallback(ctx context.Context, authorization string, payload EditorCallbackPayload) (int, error) {
	if _, err := verifyJWTWith(s.office.Secret, authorization, false); err != nil {
		return 1, domain.ErrUnauthorized
	}
	if payload.Key == "" {
		return 1, domain.ErrInvalidInput
	}
	if payload.Status != domain.CallbackStatusSaveReady && payload.Status != domain.CallbackStatusForceSave {
		return 0, nil
	}
	if payload.URL == "" {
		return 1, domain.ErrInvalidInput
	}
	// Probe a scoped session without holding database locks over download.
	probe, err := s.uow.Begin(ctx)
	if err != nil {
		return 1, err
	}
	store, ok := probe.(ports.CDWBranchStore)
	if !ok {
		_ = probe.Rollback(ctx)
		return 1, domain.ErrInvalidInput
	}
	session, err := store.CDWBranchSessionByKey(ctx, payload.Key)
	_ = probe.Rollback(ctx)
	if err != nil {
		return 1, domain.ErrUnauthorized
	}
	if session.State != "open" || !session.ExpiresAt.After(s.now()) {
		return 1, domain.ErrVersionConflict
	}
	data, err := s.downloadFromEditor(ctx, payload.URL)
	if err != nil {
		return 1, err
	}
	if !looksLikeOOXML(data) {
		return 1, domain.ErrInvalidInput
	}
	stage, err := s.blobs.Stage()
	if err != nil {
		return 1, err
	}
	if _, err = stage.Write(data); err != nil {
		_ = stage.Abort()
		return 1, err
	}
	key, _, err := stage.Commit()
	if err != nil {
		_ = stage.Abort()
		return 1, err
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return 1, err
	}
	defer tx.Rollback(ctx)
	store, ok = tx.(ports.CDWBranchStore)
	if !ok {
		return 1, domain.ErrInvalidInput
	}
	blob, err := ensureBlob(ctx, tx, key, stage.Sha256(), stage.Size())
	if err != nil {
		return 1, err
	}
	eventHash := callbackEventHash(session.ID, payload.Key, payload.Status, payload.URL, payload.UserData)
	_, err = store.CDWCommitBranchCallback(ctx, payload.Key, payload.Status, payload.UserData, eventHash, blob.ID, stage.Size(), stage.Sha256(), session.Epoch, NewID("cdwrev"))
	if err != nil {
		return 1, err
	}
	if err = auditRequired(ctx, tx, domain.User{ID: session.OpenedBy}, "cdw.office.callback", "branch", session.BranchID, "success",
		map[string]any{"sessionId": session.ID, "eventHash": eventHash}); err != nil {
		return 1, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 1, err
	}
	return 0, nil
}
func (s *Service) CDWFreezeBranch(ctx context.Context, actor domain.User, branchID, requestID, revisionID string, expected int64) (ports.CDWBranchFreeze, error) {
	if expected < 1 || requestID == "" || revisionID == "" {
		return ports.CDWBranchFreeze{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return ports.CDWBranchFreeze{}, err
	}
	defer tx.Rollback(ctx)
	_, store, err := s.cdwBranchForActor(ctx, tx, actor, branchID)
	if err != nil {
		return ports.CDWBranchFreeze{}, err
	}
	result, err := store.CDWFreezeBranchDelivery(ctx, branchID, actor.ID, requestID, revisionID, NewID("cdwdelivery"), expected, NewID("cdwfreeze"), NewID("cdwgate"), NewID("cdwidem"))
	if err != nil {
		return result, err
	}
	if err = auditRequired(ctx, tx, actor, "cdw.delivery.frozen", "branch", branchID, "success", map[string]any{"deliveryId": result.DeliveryID, "sha256": result.SHA256}); err != nil {
		return result, err
	}
	return result, tx.Commit(ctx)
}
