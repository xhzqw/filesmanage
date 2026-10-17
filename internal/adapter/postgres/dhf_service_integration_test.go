package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"filesmanage/internal/ports"
	"io"
	"os"
	"strings"
	"testing"

	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"github.com/jackc/pgx/v5/pgxpool"
)

type dhfLabBytes struct{ *bytes.Reader }

func (d dhfLabBytes) Close() error { return nil }

type dhfLabBlobs struct{}

func (dhfLabBlobs) Stage() (ports.BlobStage, error) { return nil, errors.New("read-only lab blob") }
func (dhfLabBlobs) Open(key string) (io.ReadSeekCloser, error) {
	if key != "dhf_svc_immutable_evidence" {
		return nil, errors.New("unknown immutable evidence")
	}
	return dhfLabBytes{bytes.NewReader([]byte("immutable DHF lab evidence"))}, nil
}

// Real Service and PostgreSQL transactions; test database is created/dropped by dhf_fresh_pg_lab.sh.
func TestDHFServiceWorkflow(t *testing.T) {
	if os.Getenv("CDW_TASK_TEST_DSN") == "" || os.Getenv("CDW_TASK_TEST_FRESH_LAB") == "" {
		t.Skip("isolated PostgreSQL lab only")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, os.Getenv("CDW_TASK_TEST_DSN"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, e := pool.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	owner := domain.User{ID: "dhf_service_owner", Login: "dhf_service_owner", DisplayName: "项目负责人", IsAdmin: true}
	reviewer := domain.User{ID: "dhf_service_reviewer", Login: "dhf_service_reviewer", DisplayName: "独立验收人", IsAdmin: true}
	exec(`INSERT INTO users(id,login,display_name,password_hash,is_admin) VALUES($1,$1,'项目负责人','fixture',true),($2,$2,'独立验收人','fixture',true)`, owner.ID, reviewer.ID)
	service := application.New(New(pool), dhfLabBlobs{})
	createInput := application.DHFCreateInput{Title: "DHF真实事务测试项目", ReviewerID: reviewer.ID}
	first, err := service.DHFCreate(ctx, owner, createInput, "dhf_svc_create_01")
	if err != nil {
		t.Fatalf("project create must commit project+event+audit: %v", err)
	}
	if first.Project.ID == "" || len(first.Items) < 140 || len(first.Stages) != 9 || len(first.Events) != 1 {
		t.Fatalf("incomplete created project %+v", first.Project)
	}
	if first.Events[0].StageNo != 0 || first.Events[0].Action != "project.create" {
		t.Fatalf("project-level event incorrect: %+v", first.Events)
	}
	var stageNo *int
	if err = pool.QueryRow(ctx, `SELECT stage_no FROM dhf_events WHERE project_id=$1`, first.Project.ID).Scan(&stageNo); err != nil || stageNo != nil {
		t.Fatalf("project event must store NULL stage, got %v: %v", stageNo, err)
	}
	repeated, err := service.DHFCreate(ctx, owner, createInput, "dhf_svc_create_01")
	if err != nil || repeated.Project.ID != first.Project.ID {
		t.Fatalf("idempotency replay %v", err)
	}
	second, err := service.DHFCreate(ctx, owner, createInput, "dhf_svc_create_02")
	if err != nil || second.Project.ID == first.Project.ID || second.Events[0].EventSHA256 == first.Events[0].EventSHA256 {
		t.Fatalf("separate project domain hash/commit failed: %v", err)
	}
	if _, err = service.DHFDetail(ctx, domain.User{ID: "dhf_unauthorized"}, first.Project.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("DHF unauthorized lookup leaked: %v", err)
	}
	var stageOne []int
	for _, item := range first.Items {
		if item.StageNo == 1 {
			stageOne = append(stageOne, item.SourceLine)
		}
	}
	if len(stageOne) != 2 {
		t.Fatalf("stage 1 expected two leaf items, got %d", len(stageOne))
	}
	getItem := func(line int) (int64, string) {
		t.Helper()
		d, e := service.DHFDetail(ctx, owner, first.Project.ID)
		if e != nil {
			t.Fatal(e)
		}
		for _, i := range d.Items {
			if i.SourceLine == line {
				return i.Revision, i.State
			}
		}
		t.Fatalf("missing line %d", line)
		return 0, ""
	}
	if _, err = service.DHFAcceptStage(ctx, reviewer, first.Project.ID, 1, application.DHFStageAction{Reason: "仍有项目未提交不能验收"}, "dhf_svc_early_gate"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("premature stage accepted: %v", err)
	}
	line := stageOne[0]
	rev, _ := getItem(line)
	if _, err = service.DHFActItem(ctx, reviewer, first.Project.ID, line, rev, application.DHFItemAction{Action: "not_applicable", Reason: "具有充分依据的例外申请"}, "dhf_svc_owner_only"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("reviewer impersonated owner: %v", err)
	}
	requested, err := service.DHFActItem(ctx, owner, first.Project.ID, line, rev, application.DHFItemAction{Action: "not_applicable", Reason: "基于产品结构本项不适用"}, "dhf_svc_na_request")
	if err != nil {
		t.Fatalf("request NA: %v", err)
	}
	if requested.Items[0].State != "not_applicable_pending" {
		t.Fatalf("NA must not be auto-approved: %s", requested.Items[0].State)
	}
	if _, err = service.DHFAcceptStage(ctx, reviewer, first.Project.ID, 1, application.DHFStageAction{Reason: "未经复核例外项目不能计入完成"}, "dhf_svc_gate_block"); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("unreviewed NA allowed stage acceptance: %v", err)
	}
	rev, _ = getItem(line)
	if _, err = service.DHFActItem(ctx, owner, first.Project.ID, line, rev, application.DHFItemAction{Action: "confirm_not_applicable", Reason: "同意其不适用理由"}, "dhf_svc_self_confirm"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("owner confirmed own exception: %v", err)
	}
	if _, err = service.DHFActItem(ctx, reviewer, first.Project.ID, line, rev, application.DHFItemAction{Action: "confirm_not_applicable", Reason: "核验后同意例外申请"}, "dhf_svc_na_confirm"); err != nil {
		t.Fatalf("independent NA confirmation: %v", err)
	}
	// Second item follows the genuine versioned file delivery path.
	sum := sha256.Sum256([]byte("immutable DHF lab evidence"))
	sha := hex.EncodeToString(sum[:])
	exec(`INSERT INTO folders(id,name,owner_id) VALUES('dhf_svc_folder','Fixture',$1)`, owner.ID)
	exec(`INSERT INTO blobs(id,storage_key,sha256,size_bytes,state) VALUES('dhf_svc_blob','dhf_svc_immutable_evidence',$1,26,'ready')`, sha)
	exec(`INSERT INTO files(id,folder_id,name,uploaded_by,current_version_seq) VALUES('dhf_svc_file','dhf_svc_folder','evidence.txt',$1,NULL)`, owner.ID)
	exec(`INSERT INTO file_versions(id,file_id,seq,blob_id,size_bytes,sha256,action,created_by) VALUES('dhf_svc_file_v1','dhf_svc_file',1,'dhf_svc_blob',26,$1,'upload',$2)`, sha, owner.ID)
	exec(`UPDATE files SET current_version_seq=1 WHERE id='dhf_svc_file'`)
	line = stageOne[1]
	rev, _ = getItem(line)
	if _, err = service.DHFActItem(ctx, owner, first.Project.ID, line, rev, application.DHFItemAction{Action: "required"}, "dhf_svc_required"); err != nil {
		t.Fatalf("mark required: %v", err)
	}
	rev, _ = getItem(line)
	if _, err = service.DHFActItem(ctx, owner, first.Project.ID, line, rev, application.DHFItemAction{Action: "submit", FileID: "dhf_svc_file", FileVersionID: "dhf_svc_file_v1"}, "dhf_svc_submit"); err != nil {
		t.Fatalf("deliver pinned version: %v", err)
	}
	rev, _ = getItem(line)
	if _, err = service.DHFActItem(ctx, reviewer, first.Project.ID, line, rev, application.DHFItemAction{Action: "accept", Reason: ""}, "dhf_svc_empty_accept"); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("empty review rationale allowed: %v", err)
	}
	if _, err = service.DHFActItem(ctx, reviewer, first.Project.ID, line, rev, application.DHFItemAction{Action: "accept", Reason: "确认证据版本符合本项要求"}, "dhf_svc_accept"); err != nil {
		t.Fatalf("review pinned file: %v", err)
	}
	// Updating the source file's latest sequence cannot substitute for the pinned DHF version.
	updated := sha256.Sum256([]byte("later source revision"))
	laterSHA := hex.EncodeToString(updated[:])
	exec(`INSERT INTO blobs(id,storage_key,sha256,size_bytes,state) VALUES('dhf_svc_blob_v2','dhf_svc_later_revision',$1,21,'ready')`, laterSHA)
	exec(`INSERT INTO file_versions(id,file_id,seq,blob_id,size_bytes,sha256,action,created_by) VALUES('dhf_svc_file_v2','dhf_svc_file',2,'dhf_svc_blob_v2',21,$1,'edit',$2)`, laterSHA, owner.ID)
	exec(`UPDATE files SET current_version_seq=2 WHERE id='dhf_svc_file'`)
	evidence, closeEvidence, err := service.DHFOpenEvidence(ctx, reviewer, first.Project.ID, line)
	if err != nil {
		t.Fatalf("reviewer open pinned evidence: %v", err)
	}
	evidenceBytes, readErr := io.ReadAll(evidence.Reader)
	closeEvidence()
	if readErr != nil || string(evidenceBytes) != "immutable DHF lab evidence" || evidence.Sha256 != sha {
		t.Fatalf("evidence followed newest version or wrong hash: %v %s", readErr, evidenceBytes)
	}
	if _, _, err = service.DHFOpenEvidence(ctx, domain.User{ID: "unknown"}, first.Project.ID, line); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("cross-project evidence leaked: %v", err)
	}
	stage, err := service.DHFAcceptStage(ctx, reviewer, first.Project.ID, 1, application.DHFStageAction{Reason: "本阶段文件和例外均已独立验收"}, "dhf_svc_gate_accept")
	if err != nil {
		t.Fatalf("stage gate with baseline: %v", err)
	}
	if stage.Stages[0].State != "accepted" || stage.Stages[1].State != "open" || len(stage.Stages[0].BaselineSHA256) != 64 {
		t.Fatalf("bad stage gate: %+v", stage.Stages[:2])
	}
	for i := 1; i < len(stage.Events); i++ {
		if stage.Events[i-1].PreviousSHA256 != stage.Events[i].EventSHA256 {
			t.Fatalf("broken event chain at %d", i)
		}
	}
	if strings.EqualFold(first.Events[0].EventSHA256, second.Events[0].EventSHA256) {
		t.Fatal("duplicate project hash")
	}
	t.Log("DHF_SERVICE_FULL_TRANSACTION_PASS create/replay/ACL/independent NA/pinned file/accept/stage baseline")
}
