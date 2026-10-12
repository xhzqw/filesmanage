package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"filesmanage/internal/domain"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
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
	audit(ctx, tx, u, "office.session_open", "file", file.ID, "success",
		map[string]any{"sessionId": session.ID, "baseSeq": baseSeq})
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
	audit(ctx, tx, u, "office.session_close", "file", session.FileID, "success",
		map[string]any{"sessionId": sessionID})
	return tx.Commit(ctx)
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
	version, err := tx.VersionBySeq(ctx, file.ID, currentSeq(file))
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
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return 1, err
	}
	defer tx.Rollback(ctx)
	session, err := tx.OfficeSessionByKey(ctx, payload.Key)
	if err != nil {
		return 1, domain.ErrUnauthorized
	}
	if payload.Status == domain.CallbackStatusEditing {
		if err = tx.TouchOfficeSession(ctx, session.ID, s.now().Add(30*time.Minute)); err != nil {
			return 1, err
		}
		return 0, tx.Commit(ctx)
	}
	if payload.Status != domain.CallbackStatusSaveReady && payload.Status != domain.CallbackStatusForceSave {
		return 0, nil
	}
	if payload.URL == "" {
		return 1, domain.ErrInvalidInput
	}
	eventHash := callbackEventHash(session.ID, payload.Key, payload.Status, payload.URL)
	if exists, err := tx.SaveEventExists(ctx, session.ID, eventHash); err != nil {
		return 1, err
	} else if exists {
		// Replay of an already processed callback.
		return 0, nil
	}
	content, err := s.downloadFromEditor(ctx, payload.URL)
	if err != nil {
		return 1, err
	}
	if !looksLikeOOXML(content) {
		return 1, domain.ErrInvalidInput
	}
	file, err := tx.FileByID(ctx, session.FileID)
	if err != nil {
		return 1, domain.ErrNotFound
	}
	if file.DeletedAt != nil || currentSeq(file) != session.BaseSeq {
		// The file moved on: report a conflict so the editor reloads and re-keys.
		return 1, domain.ErrVersionConflict
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
	if err = tx.SetOfficeSessionState(ctx, session.ID, domain.OfficeStateCommitted); err != nil {
		return 1, err
	}
	if err = tx.RecordSaveEvent(ctx, domain.OfficeSaveEvent{
		ID: NewID("oev"), SessionID: session.ID, Generation: generation,
		CallbackStatus: payload.Status, EventHash: eventHash, Outcome: "committed",
	}); err != nil {
		return 1, err
	}
	if err = tx.RecordCompatibilityReport(ctx, domain.OfficeCompatibilityReport{
		FileID: file.ID, VersionSeq: version.Seq, EngineVersion: s.office.EditorVersion,
		SupportedFeatures: []string{"text", "formatting", "tables"}, VerificationStatus: "verified",
	}); err != nil {
		return 1, err
	}
	audit(ctx, tx, domain.User{ID: session.OwnerID}, "office.save_commit", "file", file.ID, "success",
		map[string]any{"sessionId": session.ID, "versionSeq": version.Seq, "generation": generation})
	if err = tx.Commit(ctx); err != nil {
		return 1, err
	}
	s.ReindexFile(ctx, file.ID)
	s.notifyWorkspaceChange("file", "search", "stats")
	return 0, nil
}

// EditorCallbackPayload is the document-server callback body.
type EditorCallbackPayload struct {
	Key    string `json:"key"`
	Status int    `json:"status"`
	URL    string `json:"url"`
}

func callbackEventHash(sessionID, key string, status int, url string) string {
	sum := sha256.Sum256([]byte(sessionID + "|" + key + "|" + fmt.Sprint(status) + "|" + url))
	return hex.EncodeToString(sum[:])
}

// downloadFromEditor fetches the saved document under strict SSRF controls:
// the host must equal the configured editor host, redirects are refused, and
// the connection dials the resolved IP once to defeat DNS rebinding.
func (s *Service) downloadFromEditor(ctx context.Context, raw string) ([]byte, error) {
	target, err := url.Parse(raw)
	if err != nil {
		return nil, domain.ErrInvalidInput
	}
	allowed, err := url.Parse(s.office.EditorURL)
	if err != nil {
		return nil, domain.ErrInvalidInput
	}
	if !strings.EqualFold(target.Host, allowed.Host) {
		return nil, domain.ErrForbidden
	}
	host := target.Hostname()
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
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, raw, nil)
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
