package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

type DHFCreateInput struct {
	Title      string `json:"title"`
	ReviewerID string `json:"reviewerId"`
}
type DHFItemAction struct {
	Action        string `json:"action"`
	Reason        string `json:"reason"`
	FileID        string `json:"fileId"`
	FileVersionID string `json:"fileVersionId"`
}
type DHFStageAction struct {
	Reason string `json:"reason"`
}

func (s *Service) DHFProjects(ctx context.Context, actor domain.User) ([]ports.DHFProject, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.DHFStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	return store.DHFProjects(ctx, actor.ID)
}
func (s *Service) DHFDetail(ctx context.Context, actor domain.User, id string) (ports.DHFDetail, error) {
	var out ports.DHFDetail
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.DHFStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	return s.dhfDetail(ctx, tx, store, actor, id)
}
func (s *Service) dhfDetail(ctx context.Context, tx ports.Tx, store ports.DHFStore, actor domain.User, id string) (ports.DHFDetail, error) {
	var out ports.DHFDetail
	p, err := store.DHFProjectByID(ctx, id, actor.ID, false)
	if err != nil {
		return out, err
	}
	out, err = store.DHFDetail(ctx, id)
	if err != nil {
		return out, err
	}
	out.Project = p
	// A DHF role never silently expands existing file ACLs.
	for index := range out.Items {
		if out.Items[index].FileID != "" {
			if _, e := s.visibleFile(ctx, tx, actor, out.Items[index].FileID, domain.ActionPreview); e != nil {
				out.Items[index].FileID = ""
				out.Items[index].FileVersionID = ""
				out.Items[index].FileSHA256 = ""
			}
		}
	}
	return out, nil
}
func dhfRequestHash(op, id string, input any) string {
	raw, _ := json.Marshal(struct {
		Op   string `json:"op"`
		ID   string `json:"id"`
		Body any    `json:"body"`
	}{op, id, input})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
func dhfOperationKey(key string) bool { return validCDWOperationKey(key) }
func (s *Service) DHFCreate(ctx context.Context, actor domain.User, in DHFCreateInput, key string) (ports.DHFDetail, error) {
	var out ports.DHFDetail
	in.Title = strings.TrimSpace(in.Title)
	if !actor.IsAdmin {
		return out, domain.ErrForbidden
	}
	if !dhfOperationKey(key) || !utf8.ValidString(in.Title) || utf8.RuneCountInString(in.Title) < 2 || utf8.RuneCountInString(in.Title) > 200 || in.ReviewerID == "" || in.ReviewerID == actor.ID {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.DHFStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	hash := dhfRequestHash("project.create", "", in)
	prior, replay, err := store.DHFClaim(ctx, actor.ID, key, hash)
	if err != nil {
		return out, err
	}
	if replay {
		err = json.Unmarshal(prior, &out)
		return out, err
	}
	active, err := store.DHFUserActive(ctx, in.ReviewerID)
	if err != nil {
		return out, err
	}
	if !active {
		return out, domain.ErrInvalidInput
	}
	template := DHFOutline()
	p := ports.DHFProject{ID: NewID("dhf"), Title: in.Title, OwnerID: actor.ID, ReviewerID: in.ReviewerID, TemplateSHA256: template.SHA256}
	if err = store.DHFCreate(ctx, p, template.Nodes); err != nil {
		return out, err
	}
	if err = store.DHFAppendEvent(ctx, p.ID, 0, 0, "project.create", actor.ID, map[string]any{"templateSha256": template.SHA256, "reviewerId": in.ReviewerID, "title": in.Title}); err != nil {
		return out, err
	}
	if err = auditRequired(ctx, tx, actor, "dhf.project.create", "dhf_project", p.ID, "success", map[string]any{"templateSHA256": template.SHA256}); err != nil {
		return out, err
	}
	out, err = s.dhfDetail(ctx, tx, store, actor, p.ID)
	if err != nil {
		return out, err
	}
	if err = store.DHFComplete(ctx, actor.ID, key, hash, out); err != nil {
		return out, err
	}
	err = tx.Commit(ctx)
	return out, err
}
func (s *Service) DHFActItem(ctx context.Context, actor domain.User, id string, line int, expected int64, in DHFItemAction, key string) (ports.DHFDetail, error) {
	var out ports.DHFDetail
	in.Reason = strings.TrimSpace(in.Reason)
	if !dhfOperationKey(key) || expected < 1 || line < 1 || utf8.RuneCountInString(in.Reason) > 2000 || !utf8.ValidString(in.Reason) {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.DHFStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	p, err := store.DHFProjectByID(ctx, id, actor.ID, true)
	if err != nil {
		return out, err
	}
	hash := dhfRequestHash("item."+in.Action, id+"/"+strconv.Itoa(line), struct {
		Expected int64
		Input    DHFItemAction
	}{expected, in})
	prior, replay, err := store.DHFClaim(ctx, actor.ID, key, hash)
	if err != nil {
		return out, err
	}
	if replay {
		err = json.Unmarshal(prior, &out)
		return out, err
	}
	before, err := store.DHFItemByLine(ctx, id, line)
	if err != nil {
		return out, err
	}
	detail, err := store.DHFDetail(ctx, id)
	if err != nil {
		return out, err
	}
	if before.Revision != expected {
		return out, domain.ErrVersionConflict
	}
	var stage ports.DHFStage
	for _, v := range detail.Stages {
		if v.StageNo == before.StageNo {
			stage = v
			break
		}
	}
	if stage.State != "open" {
		return out, domain.ErrConflict
	}
	after := before
	switch in.Action {
	case "required":
		if actor.ID != p.OwnerID || (before.State != "unclassified" && before.State != "missing" && before.State != "returned") {
			return out, domain.ErrForbidden
		}
		after.State = "missing"
		after.ApplicabilityReason = ""
		after.FileID = ""
		after.FileVersionID = ""
		after.FileSHA256 = ""
		after.SubmittedBy = ""
		after.SubmittedAt = ""
		after.ReviewedBy = ""
		after.ReviewedAt = ""
		after.ReviewReason = ""
	case "not_applicable":
		if actor.ID != p.OwnerID || (before.State != "unclassified" && before.State != "missing" && before.State != "returned") {
			return out, domain.ErrForbidden
		}
		if utf8.RuneCountInString(in.Reason) < 8 {
			return out, domain.ErrInvalidInput
		}
		after.State = "not_applicable"
		after.ApplicabilityReason = in.Reason
		after.FileID = ""
		after.FileVersionID = ""
		after.FileSHA256 = ""
		after.SubmittedBy = ""
		after.SubmittedAt = ""
		after.ReviewedBy = ""
		after.ReviewedAt = ""
		after.ReviewReason = ""
	case "submit":
		if actor.ID != p.OwnerID || (before.State != "missing" && before.State != "returned") || in.FileID == "" || in.FileVersionID == "" {
			return out, domain.ErrInvalidInput
		}
		if _, err = s.visibleFile(ctx, tx, actor, in.FileID, domain.ActionPreview); err != nil {
			return out, err
		}
		sha, e := store.DHFFileVersion(ctx, in.FileID, in.FileVersionID)
		if e != nil {
			return out, e
		}
		after.State = "submitted"
		after.FileID = in.FileID
		after.FileVersionID = in.FileVersionID
		after.FileSHA256 = sha
		after.SubmittedBy = actor.ID
		after.SubmittedAt = ""
		after.ReviewedBy = ""
		after.ReviewedAt = ""
		after.ReviewReason = ""
		after.ApplicabilityReason = ""
	case "accept", "return":
		if actor.ID != p.ReviewerID || before.State != "submitted" {
			return out, domain.ErrForbidden
		}
		if _, err = s.visibleFile(ctx, tx, actor, before.FileID, domain.ActionPreview); err != nil {
			return out, err
		}
		sha, e := store.DHFFileVersion(ctx, before.FileID, before.FileVersionID)
		if e != nil {
			return out, e
		}
		if sha != before.FileSHA256 {
			return out, domain.ErrConflict
		}
		if in.Action == "return" && utf8.RuneCountInString(in.Reason) < 8 {
			return out, domain.ErrInvalidInput
		}
		after.State = "accepted"
		if in.Action == "return" {
			after.State = "returned"
		}
		after.ReviewedBy = actor.ID
		after.ReviewReason = in.Reason
	default:
		return out, domain.ErrInvalidInput
	}
	if err = store.DHFUpdateItem(ctx, id, after, expected); err != nil {
		return out, err
	}
	payload := map[string]any{"from": before.State, "to": after.State, "line": line, "reason": in.Reason, "fileId": after.FileID, "versionId": after.FileVersionID, "sha256": after.FileSHA256, "priorVersionId": before.FileVersionID}
	if err = store.DHFAppendEvent(ctx, id, before.StageNo, line, "item."+in.Action, actor.ID, payload); err != nil {
		return out, err
	}
	if err = auditRequired(ctx, tx, actor, "dhf.item."+in.Action, "dhf_item", id, "success", payload); err != nil {
		return out, err
	}
	out, err = s.dhfDetail(ctx, tx, store, actor, id)
	if err != nil {
		return out, err
	}
	if err = store.DHFComplete(ctx, actor.ID, key, hash, out); err != nil {
		return out, err
	}
	err = tx.Commit(ctx)
	return out, err
}
func (s *Service) DHFAcceptStage(ctx context.Context, actor domain.User, id string, stage int, in DHFStageAction, key string) (ports.DHFDetail, error) {
	var out ports.DHFDetail
	in.Reason = strings.TrimSpace(in.Reason)
	if !dhfOperationKey(key) || stage < 1 || stage > 9 || utf8.RuneCountInString(in.Reason) < 8 || utf8.RuneCountInString(in.Reason) > 2000 {
		return out, domain.ErrInvalidInput
	}
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	store, ok := tx.(ports.DHFStore)
	if !ok {
		return out, domain.ErrInvalidInput
	}
	p, err := store.DHFProjectByID(ctx, id, actor.ID, true)
	if err != nil {
		return out, err
	}
	if actor.ID != p.ReviewerID {
		return out, domain.ErrForbidden
	}
	hash := dhfRequestHash("stage.accept", id, struct {
		Stage  int
		Reason string
	}{stage, in.Reason})
	prior, replay, err := store.DHFClaim(ctx, actor.ID, key, hash)
	if err != nil {
		return out, err
	}
	if replay {
		err = json.Unmarshal(prior, &out)
		return out, err
	}
	detail, err := store.DHFDetail(ctx, id)
	if err != nil {
		return out, err
	}
	if detail.Stages[stage-1].State != "open" || (stage > 1 && detail.Stages[stage-2].State != "accepted") {
		return out, domain.ErrConflict
	}
	rows := []string{}
	for _, i := range detail.Items {
		if i.StageNo != stage {
			continue
		}
		if i.State != "accepted" && i.State != "not_applicable" {
			return out, domain.ErrConflict
		}
		if i.State == "accepted" {
			if _, err = s.visibleFile(ctx, tx, actor, i.FileID, domain.ActionPreview); err != nil {
				return out, err
			}
			sha, e := store.DHFFileVersion(ctx, i.FileID, i.FileVersionID)
			if e != nil {
				return out, e
			}
			if sha != i.FileSHA256 {
				return out, domain.ErrConflict
			}
		}
		rows = append(rows, strings.Join([]string{strconv.Itoa(i.SourceLine), i.State, i.FileVersionID, i.FileSHA256, i.ApplicabilityReason}, "|"))
	}
	if len(rows) == 0 {
		return out, domain.ErrConflict
	}
	sort.Strings(rows)
	digest := sha256.Sum256([]byte(strings.Join(rows, "\n")))
	baseline := hex.EncodeToString(digest[:])
	if err = store.DHFAcceptStage(ctx, id, stage, actor.ID, baseline); err != nil {
		return out, err
	}
	payload := map[string]any{"baselineSha256": baseline, "items": len(rows), "reason": in.Reason}
	if err = store.DHFAppendEvent(ctx, id, stage, 0, "stage.accept", actor.ID, payload); err != nil {
		return out, err
	}
	if err = auditRequired(ctx, tx, actor, "dhf.stage.accept", "dhf_stage", id, "success", payload); err != nil {
		return out, err
	}
	out, err = s.dhfDetail(ctx, tx, store, actor, id)
	if err != nil {
		return out, err
	}
	if err = store.DHFComplete(ctx, actor.ID, key, hash, out); err != nil {
		return out, err
	}
	err = tx.Commit(ctx)
	return out, err
}

func (s *Service) DHFFileVersions(ctx context.Context, actor domain.User, file string) ([]ports.DHFFileVersion, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = s.visibleFile(ctx, tx, actor, file, domain.ActionPreview); err != nil {
		return nil, err
	}
	store, ok := tx.(ports.DHFStore)
	if !ok {
		return nil, domain.ErrInvalidInput
	}
	return store.DHFFileVersions(ctx, file)
}
