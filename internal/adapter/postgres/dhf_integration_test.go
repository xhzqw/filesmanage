package postgres

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"filesmanage/internal/application"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Run only in scripts/dhf_fresh_pg_lab.sh. Never put fabricated DHF approvals in the dev DB.
func TestDHFPostgresGates(t *testing.T) {
	dsn := os.Getenv("CDW_TASK_TEST_DSN")
	if dsn == "" || os.Getenv("CDW_TASK_TEST_FRESH_LAB") == "" {
		t.Skip("requires isolated lab")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := New(pool).Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	q := tx.(txHandle).Q
	must := func(sql string, args ...any) {
		t.Helper()
		if _, e := q.Exec(ctx, sql, args...); e != nil {
			t.Fatal(e)
		}
	}
	owner, reviewer := "dhf_gate_owner", "dhf_gate_reviewer"
	must(`INSERT INTO users(id,login,display_name,password_hash) VALUES($1,$1,'Owner','fixture'),($2,$2,'Reviewer','fixture')`, owner, reviewer)
	must(`INSERT INTO folders(id,name,owner_id) VALUES('dhf_gate_folder','Fixture', $1)`, owner)
	must(`INSERT INTO blobs(id,storage_key,sha256,size_bytes,state) VALUES('dhf_gate_blob','dhf-gate-blob',$1,16,'ready')`, strings.Repeat("a", 64))
	must(`INSERT INTO files(id,folder_id,name,uploaded_by,current_version_seq) VALUES('dhf_gate_file','dhf_gate_folder','test.docx',$1,1)`, owner)
	must(`INSERT INTO file_versions(id,file_id,seq,blob_id,size_bytes,sha256,action,created_by) VALUES('dhf_gate_file_v1','dhf_gate_file',1,'dhf_gate_blob',16,$1,'upload',$2)`, strings.Repeat("a", 64), owner)
	store := tx.(ports.DHFStore)
	outline := application.DHFOutline()
	project := ports.DHFProject{ID: "dhf_gate_project", Title: "隔离项目", OwnerID: owner, ReviewerID: reviewer, TemplateSHA256: outline.SHA256}
	if err = store.DHFCreate(ctx, project, outline.Nodes); err != nil {
		t.Fatal(err)
	}
	p, err := store.DHFProjectByID(ctx, project.ID, owner, true)
	if err != nil || p.ID != project.ID {
		t.Fatalf("project lock/read failed: %+v %v", p, err)
	}
	d, err := store.DHFDetail(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Stages) != 9 || len(d.Items) < 140 || d.Stages[0].State != "open" || d.Stages[1].State != "locked" {
		t.Fatalf("incorrect gate initialization stages=%d items=%d", len(d.Stages), len(d.Items))
	}
	if err = store.DHFAcceptStage(ctx, project.ID, 1, reviewer, strings.Repeat("b", 64)); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("premature acceptance: %v", err)
	}
	items := []ports.DHFItem{}
	for _, item := range d.Items {
		if item.StageNo == 1 {
			items = append(items, item)
		}
	}
	if len(items) != 2 {
		t.Fatalf("first stage expected 2 leaves, got %d", len(items))
	}
	first := items[0]
	first.State = "missing"
	if err = store.DHFUpdateItem(ctx, project.ID, first, first.Revision); err != nil {
		t.Fatal(err)
	}
	first, err = store.DHFItemByLine(ctx, project.ID, first.SourceLine)
	if err != nil {
		t.Fatal(err)
	}
	if first.State != "missing" || first.Revision != 2 {
		t.Fatalf("classification lost: %+v", first)
	}
	if err = store.DHFUpdateItem(ctx, project.ID, first, 1); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale revision allowed: %v", err)
	}
	first.State = "submitted"
	first.FileID = "dhf_gate_file"
	first.FileVersionID = "dhf_gate_file_v1"
	first.FileSHA256 = strings.Repeat("a", 64)
	first.SubmittedBy = owner
	if err = store.DHFUpdateItem(ctx, project.ID, first, first.Revision); err != nil {
		t.Fatal(err)
	}
	first, err = store.DHFItemByLine(ctx, project.ID, first.SourceLine)
	if err != nil {
		t.Fatal(err)
	}
	if first.SubmittedAt == "" {
		t.Fatal("missing server submission timestamp")
	}
	first.State = "accepted"
	first.ReviewedBy = reviewer
	if err = store.DHFUpdateItem(ctx, project.ID, first, first.Revision); err != nil {
		t.Fatal(err)
	}
	// A returned document enters a new submission round even for the same owner.
	first, err = store.DHFItemByLine(ctx, project.ID, first.SourceLine)
	if err != nil {
		t.Fatal(err)
	}
	originalSubmittedAt := first.SubmittedAt
	first.State = "returned"
	first.ReviewedBy = reviewer
	first.ReviewReason = "需要补充证据后复核"
	if err = store.DHFUpdateItem(ctx, project.ID, first, first.Revision); err != nil {
		t.Fatal(err)
	}
	first, err = store.DHFItemByLine(ctx, project.ID, first.SourceLine)
	if err != nil {
		t.Fatal(err)
	}
	first.State = "submitted"
	first.ReviewedBy = ""
	first.ReviewedAt = ""
	first.ReviewReason = ""
	if err = store.DHFUpdateItem(ctx, project.ID, first, first.Revision); err != nil {
		t.Fatal(err)
	}
	first, err = store.DHFItemByLine(ctx, project.ID, first.SourceLine)
	if err != nil {
		t.Fatal(err)
	}
	if first.SubmittedAt == originalSubmittedAt {
		t.Fatal("resubmission reused previous delivery timestamp")
	}
	first.State = "accepted"
	first.ReviewedBy = reviewer
	if err = store.DHFUpdateItem(ctx, project.ID, first, first.Revision); err != nil {
		t.Fatal(err)
	}
	second := items[1]
	second.State = "not_applicable"
	second.ApplicabilityReason = "具体评估后判定无需本项"
	if err = store.DHFUpdateItem(ctx, project.ID, second, second.Revision); err != nil {
		t.Fatal(err)
	}
	if err = store.DHFAcceptStage(ctx, project.ID, 1, reviewer, strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	d, err = store.DHFDetail(ctx, project.ID)
	if err != nil {
		t.Fatal(err)
	}
	if d.Stages[0].State != "accepted" || d.Stages[1].State != "open" {
		t.Fatalf("stage transition failed: %+v", d.Stages[:2])
	}
	if err = store.DHFAcceptStage(ctx, project.ID, 1, reviewer, strings.Repeat("b", 64)); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("double acceptance permitted: %v", err)
	}
	hash := strings.Repeat("c", 64)
	if _, ok, e := store.DHFClaim(ctx, owner, "dhf-test-request", hash); e != nil || ok {
		t.Fatalf("first claim: %v %v", ok, e)
	}
	if err = store.DHFComplete(ctx, owner, "dhf-test-request", hash, map[string]any{"value": "saved"}); err != nil {
		t.Fatal(err)
	}
	prior, ok, e := store.DHFClaim(ctx, owner, "dhf-test-request", hash)
	if e != nil || !ok || !strings.Contains(string(prior), "saved") {
		t.Fatalf("idempotency replay %v %v %s", ok, e, prior)
	}
	if _, _, e = store.DHFClaim(ctx, owner, "dhf-test-request", strings.Repeat("d", 64)); !errors.Is(e, domain.ErrConflict) {
		t.Fatalf("idempotency key reuse accepted: %v", e)
	}
	if err = store.DHFAppendEvent(ctx, project.ID, 1, items[0].SourceLine, "item.accept", reviewer, map[string]any{"version": "dhf_gate_file_v1"}); err != nil {
		t.Fatal(err)
	}
	if err = store.DHFAppendEvent(ctx, project.ID, 1, 0, "stage.accept", reviewer, map[string]any{"digest": strings.Repeat("b", 64)}); err != nil {
		t.Fatal(err)
	}
	var prev, sha string
	if err = q.QueryRow(ctx, `SELECT previous_sha256,event_sha256 FROM dhf_events WHERE project_id=$1 ORDER BY id DESC LIMIT 1`, project.ID).Scan(&prev, &sha); err != nil {
		t.Fatal(err)
	}
	if prev == sha || len(prev) != 64 || len(sha) != 64 {
		t.Fatal("invalid chained event hash")
	}
	must(`SAVEPOINT dhf_immutable_probe`)
	if _, err = q.Exec(ctx, `UPDATE dhf_events SET action='tampered' WHERE project_id=$1`, project.ID); err == nil {
		t.Fatal("append only event accepted update")
	}
	must(`ROLLBACK TO SAVEPOINT dhf_immutable_probe`)
	t.Log("DHF_PG_STAGE_GATES_PASS: nine-stage seed, 140+ items, CAS, pinned version, reviewer, stage gate, replay and immutable hash chain")
}
