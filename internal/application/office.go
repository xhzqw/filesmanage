package application

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// OfficeConfig wires the document editor endpoints. EditorURL is the ONLY host
// the callback downloader will talk to; SourceBaseURL is the externally
// reachable base of this API for callback registration.
type OfficeConfig struct {
	EditorURL     string
	Secret        string
	SourceBaseURL string
	EditorVersion string
}

// SourceURL is the externally reachable base of this API for editor source
// and callback URLs.
func (s *Service) SourceURL() string { return s.office.SourceBaseURL }

// SignEditorConfig signs the complete editor configuration as one JWT, which
// is how the document server validates the session it is asked to open.
func (s *Service) SignEditorConfig(config map[string]any) (string, error) {
	return signJWT(s.office.Secret, config, 2*time.Hour)
}

type OfficeSessionView struct {
	SessionID   string
	DocumentKey string
	Token       string
	EditorURL   string
	FileID      string
	BaseSeq     int
	Generation  int64
}

// OpenSession starts a DOCX editing session for a file the user can modify.
// Only one live session per file; pending approvals and foreign edit locks
// both block opening.
func (s *Service) OpenOfficeSession(ctx context.Context, u domain.User, fileID string) (OfficeSessionView, error) {
	if s.office.Secret == "" || s.office.EditorURL == "" {
		return OfficeSessionView{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return OfficeSessionView{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionModify)
	if err != nil {
		return OfficeSessionView{}, err
	}
	if !looksDocx(file.Name, file.ContentType) {
		return OfficeSessionView{}, domain.ErrInvalidInput
	}
	if _, pending, err := tx.PendingApprovalForFile(ctx, file.ID); err != nil {
		return OfficeSessionView{}, err
	} else if pending {
		return OfficeSessionView{}, domain.ErrApprovalPending
	}
	if lock, err := tx.LockByFileID(ctx, file.ID); err == nil && lock.ExpiresAt.After(s.now()) && lock.OwnerID != u.ID {
		return OfficeSessionView{}, domain.ErrLocked
	}
	if existing, alive, err := tx.ActiveOfficeSessionForFile(ctx, file.ID); err != nil {
		return OfficeSessionView{}, err
	} else if alive {
		if existing.OwnerID != u.ID {
			return OfficeSessionView{}, domain.ErrLocked
		}
		// The same user opening again (second tab) invalidates the previous
		// session: a fresh key and generation are issued so a stale tab can no
		// longer save against the old document key.
		if err = tx.CloseOfficeSession(ctx, existing.ID); err != nil {
			return OfficeSessionView{}, err
		}
	}
	baseSeq := currentSeq(file)
	// ONLYOFFICE document keys accept only [0-9-.a-zA-Z_=]; colons break the
	// docservice socket key.
	documentKey := file.ID + "-" + fmt.Sprint(baseSeq) + "-" + strings.TrimPrefix(NewID("doc"), "doc_")
	session := domain.OfficeSession{
		ID: NewID("oses"), FileID: file.ID, OwnerID: u.ID, BaseSeq: baseSeq,
		DocumentKey: documentKey, State: domain.OfficeStateOpen, LockGeneration: 1,
		ExpiresAt: s.now().Add(30 * time.Minute),
	}
	if err = tx.CreateOfficeSession(ctx, session); err != nil {
		return OfficeSessionView{}, mapError(err)
	}
	token, err := signJWT(s.office.Secret, map[string]any{
		"document": map[string]any{"key": documentKey, "fileId": file.ID, "baseSeq": baseSeq},
		"userId":   u.ID,
	}, 2*time.Hour)
	if err != nil {
		return OfficeSessionView{}, err
	}
	if err = auditRequired(ctx, tx, u, "office.session_open", "file", file.ID, "success",
		map[string]any{"sessionId": session.ID, "baseSeq": baseSeq}); err != nil {
		return OfficeSessionView{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return OfficeSessionView{}, err
	}
	return OfficeSessionView{
		SessionID: session.ID, DocumentKey: documentKey, Token: token,
		EditorURL: s.office.EditorURL, FileID: file.ID, BaseSeq: baseSeq, Generation: session.LockGeneration,
	}, nil
}

// CloseOfficeSession abandons a live session; the caller must own it.
func (s *Service) CloseOfficeSession(ctx context.Context, u domain.User, sessionID string) error {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	session, err := tx.OfficeSessionByID(ctx, sessionID)
	if err != nil {
		return notFoundOr(err)
	}
	if session.OwnerID != u.ID && !u.IsAdmin {
		return domain.ErrForbidden
	}
	if err = tx.CloseOfficeSession(ctx, sessionID); err != nil {
		return err
	}
	if err = auditRequired(ctx, tx, u, "office.session_close", "file", session.FileID, "success",
		map[string]any{"sessionId": sessionID}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// StartOfficeSave requests a point-in-time snapshot from ONLYOFFICE. A
// successful command response is NOT evidence of persisted file bytes.
func (s *Service) StartOfficeSave(ctx context.Context, u domain.User, fileID, sessionID string) (string, bool, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionModify)
	if err != nil {
		return "", false, err
	}
	session, err := tx.OfficeSessionByID(ctx, sessionID)
	if err != nil {
		return "", false, domain.ErrNotFound
	}
	if session.FileID != fileID || session.OwnerID != u.ID {
		return "", false, domain.ErrForbidden
	}
	if session.ClosedAt != nil || session.State != domain.OfficeStateOpen || session.ExpiresAt.Before(s.now()) {
		return "", false, domain.ErrConflict
	}
	if currentSeq(file) != session.BaseSeq {
		return "", false, domain.ErrVersionConflict
	}
	requestID := NewID("osave")
	// No database transaction is held while waiting for the document server.
	if err = tx.Rollback(ctx); err != nil {
		return "", false, err
	}
	command := map[string]any{"c": "forcesave", "key": session.DocumentKey, "userdata": requestID}
	token, err := signJWT(s.office.Secret, command, time.Minute)
	if err != nil {
		return "", false, err
	}
	command["token"] = token
	encoded, err := json.Marshal(command)
	if err != nil {
		return "", false, err
	}
	endpoint := strings.TrimRight(s.office.EditorURL, "/") + "/command"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	client := &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error {
		return errors.New("editor command redirects are disabled")
	}}
	response, err := client.Do(req)
	if err != nil {
		return "", false, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", false, domain.ErrInvalidInput
	}
	var result struct {
		Error *int `json:"error"`
	}
	if err = json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&result); err != nil {
		return "", false, err
	}
	if result.Error == nil {
		return "", false, domain.ErrInvalidInput
	}
	if *result.Error == 4 {
		return "", true, nil
	}
	if *result.Error != 0 {
		return "", false, domain.ErrInvalidInput
	}
	return requestID, false, nil
}

type OfficeSaveReceipt struct {
	Status     string `json:"status"`
	VersionSeq int    `json:"versionSeq"`
}

// RecordOfficeCallbackFailure records an authenticated, request-correlated
// failure so the editor can stop waiting when ONLYOFFICE rejects a save.
func (s *Service) RecordOfficeCallbackFailure(ctx context.Context, authorization string, payload EditorCallbackPayload) error {
	if payload.Status != domain.CallbackStatusForceSave || !strings.HasPrefix(payload.UserData, "osave_") || len(payload.UserData) > 128 {
		return nil
	}
	if _, err := verifyJWTWith(s.office.Secret, authorization, false); err != nil {
		return domain.ErrUnauthorized
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = tx.LockOfficeSessionByKey(ctx, payload.Key); err != nil {
		return err
	}
	session, err := tx.OfficeSessionByKey(ctx, payload.Key)
	if err != nil {
		return err
	}
	if session.ClosedAt != nil {
		return nil
	}
	key := officeSaveReceiptHash(session.ID, payload.UserData)
	outcome, err := tx.OfficeSaveEventOutcome(ctx, session.ID, key)
	if err != nil {
		return err
	}
	if strings.HasPrefix(outcome, "committed:") || outcome == "failed" {
		return nil
	}
	if err = tx.RecordSaveEvent(ctx, domain.OfficeSaveEvent{
		ID: NewID("oev"), SessionID: session.ID, Generation: session.LockGeneration,
		CallbackStatus: payload.Status, EventHash: key, Outcome: "failed",
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// OfficeSaveStatus reports a correlated callback receipt, never an
// optimistic editor-side "all changes saved" notification.
func (s *Service) OfficeSaveStatus(ctx context.Context, u domain.User, fileID, sessionID, requestID string) (OfficeSaveReceipt, error) {
	if !strings.HasPrefix(requestID, "osave_") || len(requestID) > 128 {
		return OfficeSaveReceipt{}, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return OfficeSaveReceipt{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview)
	if err != nil {
		return OfficeSaveReceipt{}, err
	}
	session, err := tx.OfficeSessionByID(ctx, sessionID)
	if err != nil {
		return OfficeSaveReceipt{}, domain.ErrNotFound
	}
	if session.FileID != fileID || session.OwnerID != u.ID {
		return OfficeSaveReceipt{}, domain.ErrForbidden
	}
	outcome, err := tx.OfficeSaveEventOutcome(ctx, session.ID, officeSaveReceiptHash(session.ID, requestID))
	if err != nil {
		return OfficeSaveReceipt{}, err
	}
	if strings.HasPrefix(outcome, "committed:") {
		seq, err := strconv.Atoi(strings.TrimPrefix(outcome, "committed:"))
		if err != nil {
			return OfficeSaveReceipt{}, err
		}
		return OfficeSaveReceipt{Status: "committed", VersionSeq: seq}, nil
	}
	if outcome == "failed" || session.State == domain.OfficeStateFailed {
		return OfficeSaveReceipt{Status: "failed", VersionSeq: currentSeq(file)}, nil
	}
	if session.ClosedAt != nil || session.State == domain.OfficeStateAbandoned {
		return OfficeSaveReceipt{Status: "failed", VersionSeq: currentSeq(file)}, nil
	}
	return OfficeSaveReceipt{Status: "pending", VersionSeq: currentSeq(file)}, nil
}

func officeSaveReceiptHash(sessionID, requestID string) string {
	sum := sha256.Sum256([]byte("manual-save|" + sessionID + "|" + requestID))
	return hex.EncodeToString(sum[:])
}

// OfficeNativeSaveStatus provides an authoritative, monotonically increasing
// receipt count for ONLYOFFICE's built-in Save button (forcesavetype=1).
// The document server's local "saved" state is not proof of persistence.
type OfficeNativeSaveStatusView struct {
	VersionSeq  int   `json:"versionSeq"`
	SavedCount  int64 `json:"savedCount"`
	FailedCount int64 `json:"failedCount"`
}

func (s *Service) OfficeNativeSaveStatus(ctx context.Context, u domain.User, fileID, sessionID string) (OfficeNativeSaveStatusView, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return OfficeNativeSaveStatusView{}, err
	}
	defer tx.Rollback(ctx)
	file, err := s.visibleFile(ctx, tx, u, fileID, domain.ActionPreview)
	if err != nil {
		return OfficeNativeSaveStatusView{}, err
	}
	session, err := tx.OfficeSessionByID(ctx, sessionID)
	if err != nil {
		return OfficeNativeSaveStatusView{}, domain.ErrNotFound
	}
	if session.FileID != fileID || session.OwnerID != u.ID {
		return OfficeNativeSaveStatusView{}, domain.ErrForbidden
	}
	saved, failed, err := tx.OfficeNativeSaveCounts(ctx, session.ID)
	if err != nil {
		return OfficeNativeSaveStatusView{}, err
	}
	return OfficeNativeSaveStatusView{VersionSeq: currentSeq(file), SavedCount: saved, FailedCount: failed}, nil
}

// EditorSource resolves a source token to the current version's bytes. The
// token is short-lived and bound to one document key.
func (s *Service) EditorSource(ctx context.Context, token string) (io.ReadSeekCloser, string, int64, func(), error) {
	claims, err := verifyJWT(s.office.Secret, token)
	if err != nil {
		return nil, "", 0, nil, domain.ErrUnauthorized
	}
	document, ok := claims["document"].(map[string]any)
	if !ok {
		return nil, "", 0, nil, domain.ErrUnauthorized
	}
	key, _ := document["key"].(string)
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, "", 0, nil, err
	}
	defer tx.Rollback(ctx)
	session, err := tx.OfficeSessionByKey(ctx, key)
	if err != nil {
		return nil, "", 0, nil, domain.ErrUnauthorized
	}
	if session.State == domain.OfficeStateAbandoned || session.ClosedAt != nil {
		return nil, "", 0, nil, domain.ErrUnauthorized
	}
	file, err := tx.FileByID(ctx, session.FileID)
	if err != nil {
		return nil, "", 0, nil, domain.ErrNotFound
	}
	version, err := tx.VersionBySeq(ctx, file.ID, session.BaseSeq)
	if err != nil {
		return nil, "", 0, nil, domain.ErrNotFound
	}
	blob, err := tx.BlobByID(ctx, version.BlobID)
	if err != nil {
		return nil, "", 0, nil, domain.ErrNotFound
	}
	reader, err := s.blobs.Open(blob.StorageKey)
	if err != nil {
		return nil, "", 0, nil, err
	}
	return reader, file.Name, blob.SizeBytes, func() { _ = reader.Close() }, nil
}

// HandleEditorCallback processes one document-server callback. Status 2 saves
// are idempotent per (session, event hash): a replay returns success without
// creating another version.
func (s *Service) HandleEditorCallback(ctx context.Context, authorization string, payload EditorCallbackPayload) (int, error) {
	_, err := verifyJWTWith(s.office.Secret, authorization, false)
	if err != nil {
		return 1, domain.ErrUnauthorized
	}
	if payload.Key == "" {
		return 1, domain.ErrInvalidInput
	}
	var content []byte
	if payload.Status == domain.CallbackStatusSaveReady || payload.Status == domain.CallbackStatusForceSave {
		if payload.URL == "" {
			return 1, domain.ErrInvalidInput
		}
		// The editor may take several seconds to produce and send the OOXML
		// snapshot. Check its session first, but DO NOT hold a PostgreSQL
		// transaction or its FOR UPDATE lock across the network download.
		// A second locked check below prevents stale/cancelled callbacks from
		// committing if the session changes while the document downloads.
		probe, probeErr := s.uow.Begin(ctx)
		if probeErr != nil {
			return 1, probeErr
		}
		prior, priorErr := probe.OfficeSessionByKey(ctx, payload.Key)
		if priorErr == nil && (prior.ClosedAt != nil || prior.State == domain.OfficeStateAbandoned) {
			priorErr = domain.ErrVersionConflict
		}
		var seen bool
		if priorErr == nil {
			seen, priorErr = probe.SaveEventExists(ctx, prior.ID,
				callbackEventHash(prior.ID, payload.Key, payload.Status, payload.URL, payload.UserData))
		}
		rollbackErr := probe.Rollback(ctx)
		if priorErr != nil {
			if errors.Is(priorErr, ports.ErrRowMissing) {
				return 1, domain.ErrUnauthorized
			}
			return 1, priorErr
		}
		if rollbackErr != nil {
			return 1, rollbackErr
		}
		if seen {
			return 0, nil
		}
		content, err = s.downloadFromEditor(ctx, payload.URL)
		if err != nil {
			return 1, err
		}
		if !looksLikeOOXML(content) {
			return 1, domain.ErrInvalidInput
		}
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return 1, err
	}
	defer tx.Rollback(ctx)
	if err = tx.LockOfficeSessionByKey(ctx, payload.Key); err != nil {
		return 1, domain.ErrUnauthorized
	}
	session, err := tx.OfficeSessionByKey(ctx, payload.Key)
	if err != nil {
		return 1, domain.ErrUnauthorized
	}
	if session.ClosedAt != nil || session.State == domain.OfficeStateAbandoned {
		return 1, domain.ErrVersionConflict
	}
	if payload.Status == domain.CallbackStatusEditing {
		if err = tx.TouchOfficeSession(ctx, session.ID, s.now().Add(30*time.Minute)); err != nil {
			return 1, err
		}
		return 0, tx.Commit(ctx)
	}
	if payload.Status == domain.CallbackStatusCorrupted {
		if err = recordOfficeSaveReceipt(ctx, tx, session, payload, "failed", session.LockGeneration); err != nil {
			return 1, err
		}
		if payload.ForceSaveType == 1 {
			if err = tx.RecordSaveEvent(ctx, domain.OfficeSaveEvent{
				ID: NewID("oev"), SessionID: session.ID, Generation: session.LockGeneration,
				CallbackStatus: payload.Status, EventHash: callbackEventHash(session.ID, payload.Key, payload.Status, payload.URL, payload.UserData), Outcome: "native_failed",
			}); err != nil {
				return 1, err
			}
		}
		return 0, tx.Commit(ctx)
	}
	if payload.Status != domain.CallbackStatusSaveReady && payload.Status != domain.CallbackStatusForceSave {
		return 0, nil
	}
	eventHash := callbackEventHash(session.ID, payload.Key, payload.Status, payload.URL, payload.UserData)
	if exists, err := tx.SaveEventExists(ctx, session.ID, eventHash); err != nil {
		return 1, err
	} else if exists {
		// Replay of an already processed callback.
		return 0, nil
	}
	file, err := tx.FileByID(ctx, session.FileID)
	if err != nil {
		return 1, domain.ErrNotFound
	}
	if file.DeletedAt != nil || currentSeq(file) != session.BaseSeq {
		// The file moved on: report a conflict so the editor reloads and re-keys.
		return 1, domain.ErrVersionConflict
	}
	// Ignore duplicate document content while still confirming its receipt.
	currentVersion, err := tx.VersionBySeq(ctx, file.ID, currentSeq(file))
	if err != nil {
		return 1, err
	}
	currentHash := sha256.Sum256(content)
	if hex.EncodeToString(currentHash[:]) == currentVersion.Sha256 {
		if err = tx.RecordSaveEvent(ctx, domain.OfficeSaveEvent{
			ID: NewID("oev"), SessionID: session.ID, Generation: session.LockGeneration,
			CallbackStatus: payload.Status, EventHash: eventHash, Outcome: officeCallbackOutcome(payload),
		}); err != nil {
			return 1, err
		}
		if err = recordOfficeSaveReceipt(ctx, tx, session, payload, fmt.Sprintf("committed:%d", currentSeq(file)), session.LockGeneration); err != nil {
			return 1, err
		}
		if payload.Status == domain.CallbackStatusSaveReady {
			if err = tx.SetOfficeSessionState(ctx, session.ID, domain.OfficeStateCommitted); err != nil {
				return 1, err
			}
		}
		return 0, tx.Commit(ctx)
	}
	stage, err := s.blobs.Stage()
	if err != nil {
		return 1, err
	}
	if _, err = stage.Write(content); err != nil {
		_ = stage.Abort()
		return 1, err
	}
	storageKey, _, err := stage.Commit()
	if err != nil {
		_ = stage.Abort()
		return 1, err
	}
	blob, err := ensureBlob(ctx, tx, storageKey, stage.Sha256(), stage.Size())
	if err != nil {
		return 1, err
	}
	generation, err := tx.BumpOfficeSessionGeneration(ctx, session.ID)
	if err != nil {
		return 1, err
	}
	version, err := s.appendVersionTx(ctx, tx, domain.User{ID: session.OwnerID}, file, blob, stage.Sha256(), stage.Size(), domain.VersionActionEdit, nil, "")
	if err != nil {
		return 1, err
	}
	_ = tx.SetBlobState(ctx, blob.ID, "ready")
	if err = tx.SetOfficeSessionBaseSeq(ctx, session.ID, version.Seq); err != nil {
		return 1, err
	}
	// Status 6 is a checkpoint: editing may continue within this session.
	nextState := domain.OfficeStateOpen
	if payload.Status == domain.CallbackStatusSaveReady {
		nextState = domain.OfficeStateCommitted
	}
	if err = tx.SetOfficeSessionState(ctx, session.ID, nextState); err != nil {
		return 1, err
	}
	if err = tx.RecordSaveEvent(ctx, domain.OfficeSaveEvent{
		ID: NewID("oev"), SessionID: session.ID, Generation: generation,
		CallbackStatus: payload.Status, EventHash: eventHash, Outcome: officeCallbackOutcome(payload),
	}); err != nil {
		return 1, err
	}
	if err = recordOfficeSaveReceipt(ctx, tx, session, payload, fmt.Sprintf("committed:%d", version.Seq), generation); err != nil {
		return 1, err
	}
	if err = tx.RecordCompatibilityReport(ctx, domain.OfficeCompatibilityReport{
		FileID: file.ID, VersionSeq: version.Seq, EngineVersion: s.office.EditorVersion,
		SupportedFeatures: []string{"text", "formatting", "tables"}, VerificationStatus: "verified",
	}); err != nil {
		return 1, err
	}
	if err = auditRequired(ctx, tx, domain.User{ID: session.OwnerID}, "office.save_commit", "file", file.ID, "success",
		map[string]any{"sessionId": session.ID, "versionSeq": version.Seq, "generation": generation}); err != nil {
		return 1, err
	}
	if err = tx.Commit(ctx); err != nil {
		return 1, err
	}
	s.ReindexFile(ctx, file.ID)
	s.notifyWorkspaceChange("file", "search", "stats")
	return 0, nil
}

// EditorCallbackPayload is the document-server callback body.
type EditorCallbackPayload struct {
	Key           string `json:"key"`
	Status        int    `json:"status"`
	URL           string `json:"url"`
	UserData      string `json:"userdata"`
	ForceSaveType int    `json:"forcesavetype"`
}

func officeCallbackOutcome(payload EditorCallbackPayload) string {
	if payload.Status == domain.CallbackStatusForceSave && payload.ForceSaveType == 1 {
		return "native_committed"
	}
	return "committed"
}

func callbackEventHash(sessionID, key string, status int, url, userdata string) string {
	sum := sha256.Sum256([]byte(sessionID + "|" + key + "|" + fmt.Sprint(status) + "|" + url + "|" + userdata))
	return hex.EncodeToString(sum[:])
}

func recordOfficeSaveReceipt(ctx context.Context, tx ports.Repository, session domain.OfficeSession, payload EditorCallbackPayload, outcome string, generation int64) error {
	if payload.Status != domain.CallbackStatusForceSave && payload.Status != domain.CallbackStatusCorrupted {
		return nil
	}
	if !strings.HasPrefix(payload.UserData, "osave_") || len(payload.UserData) > 128 {
		return nil
	}
	return tx.RecordSaveEvent(ctx, domain.OfficeSaveEvent{
		ID: NewID("oev"), SessionID: session.ID, Generation: generation,
		CallbackStatus: payload.Status, EventHash: officeSaveReceiptHash(session.ID, payload.UserData), Outcome: outcome,
	})
}

// downloadFromEditor fetches the saved document under strict SSRF controls.
// ONLYOFFICE may emit an internal Docker hostname in callback URLs even when
// the API reaches the same Document Server via a LAN proxy. Never dial that
// supplied hostname: reuse only its generated path/query on the pinned,
// configured Document Server origin. This prevents false callback failures
// without permitting the Document Server to trigger arbitrary outbound URLs.
func (s *Service) downloadFromEditor(ctx context.Context, raw string) ([]byte, error) {
	target, err := url.Parse(raw)
	if err != nil {
		return nil, domain.ErrInvalidInput
	}
	allowed, err := url.Parse(s.office.EditorURL)
	if err != nil {
		return nil, domain.ErrInvalidInput
	}
	if (target.Scheme != "http" && target.Scheme != "https") || target.Host == "" ||
		target.User != nil || target.Fragment != "" ||
		(allowed.Scheme != "http" && allowed.Scheme != "https") || allowed.Host == "" {
		return nil, domain.ErrForbidden
	}
	// Do not accept arbitrary foreign hosts. The ONLYOFFICE Docker service
	// publishes /cache/files/ under its internal name on port 80, which may
	// differ from the operator's trusted reverse-proxy origin.
	internalCacheOrigin := (target.Host == "filesmanage-office" || target.Host == "filesmanage-office:80") &&
		strings.HasPrefix(target.EscapedPath(), "/cache/files/")
	if !strings.EqualFold(target.Host, allowed.Host) && !internalCacheOrigin {
		return nil, domain.ErrForbidden
	}
	// Path is part of the signed ONLYOFFICE callback but never a URL origin.
	// Force all network traffic onto the server configured by the operator.
	target.Scheme = allowed.Scheme
	target.Host = allowed.Host
	target.User = nil
	callbackURL := target.String()
	host := allowed.Hostname()
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return nil, domain.ErrInvalidInput
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			_, port, splitErr := net.SplitHostPort(addr)
			if splitErr != nil {
				return nil, splitErr
			}
			// Pin every dial to the first resolved address.
			return dialer.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
		},
	}
	client := &http.Client{
		Timeout:   60 * time.Second,
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirects are not followed for editor downloads")
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, callbackURL, nil)
	if err != nil {
		return nil, err
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, domain.ErrInvalidInput
	}
	limited := io.LimitReader(resp.Body, 64<<20)
	return io.ReadAll(limited)
}

// looksDocx gates the editor to DOCX files only.
func looksDocx(name, contentType string) bool {
	if strings.Contains(strings.ToLower(contentType), "wordprocessingml") {
		return true
	}
	return strings.EqualFold(extensionOf(name), ".docx")
}

// looksLikeOOXML performs the structural check required before a saved file is
// published as a new version: a DOCX is a ZIP whose first entry is [Content_Types].xml.
func looksLikeOOXML(data []byte) bool {
	if len(data) < 4 || data[0] != 'P' || data[1] != 'K' || data[2] != 0x03 || data[3] != 0x04 {
		return false
	}
	const window = 4096
	if len(data) < window {
		return strings.Index(string(data), "[Content_Types].xml") >= 0
	}
	return strings.Index(string(data[:window]), "[Content_Types].xml") >= 0
}
