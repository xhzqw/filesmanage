package postgres

import (
	"context"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"testing"

	"github.com/jackc/pgx/v5"
)

// Scratch-only synthetic policy fixture. Nothing is committed to the
// development database or represented as a real signed company procedure.
func exerciseCDWQMSSpecialAuthority(t *testing.T, ctx context.Context, tx pgx.Tx, r *Repository,
	prefix string, admin, alice, bob, charlie domain.User, subjectFileID, baseFileID, blobID, sha, basePolicy string) {
	t.Helper()
	if _, err := tx.Exec(ctx, "SAVEPOINT cdw_g12_special"); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := tx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_g12_special"); err != nil {
			t.Fatal(err)
		}
	}()
	const reason = "隔离测试：依据正式设计历史文档管理规定独立核对专属签批节点、范围与文件适用性。"
	policyFile := prefix + "_dhf_policy_file"
	policySubject := prefix + "_dhf_policy_subject"
	policyApproval := prefix + "_dhf_policy_approval"
	policyCandidate := prefix + "_dhf_policy_candidate"
	policyRelease := prefix + "_dhf_policy_release"
	policyTemplate := prefix + "_dhf_template"
	if _, err := tx.Exec(ctx, `UPDATE files SET name='DHF-测试设计历史文档.docx' WHERE id=$1`, subjectFileID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO files(id,folder_id,name,uploaded_by)
 SELECT $1,folder_id,'产品设计历史文档管理规定.docx',$2 FROM files WHERE id=$3`,
		policyFile, admin.ID, baseFileID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO cdw_business_role_bindings
 (id,user_id,role,file_id,granted_by) VALUES($1,$2,'document_control',$3,$4)`,
		prefix+"_special_policy_controller", charlie.ID, policyFile, admin.ID); err != nil {
		t.Fatal(err)
	}
	if classified, err := r.CDWFormalClassify(ctx, policyFile, "qms", reason, charlie.ID); err != nil || classified.ApprovalClass != "qms" {
		t.Fatalf("synthetic dedicated policy not QMS-classified: %+v %v", classified, err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO cdw_approval_subjects
 (id,file_id,source_kind,blob_id,sha256,size_bytes,frozen_by)
 VALUES($1,$2,'existing_version',$3,$4,31,$5)`, policySubject, policyFile, blobID, sha, admin.ID); err != nil {
		t.Fatal(err)
	}
	var sourceTemplateID string
	if err := tx.QueryRow(ctx, `SELECT id FROM cdw_workflow_template_versions
 WHERE authority_basis_release_id=$1 AND lifecycle='published'
 AND lower(template_key)~'^(cdw_)?qms_' ORDER BY published_at DESC LIMIT 1`,
		basePolicy).Scan(&sourceTemplateID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO cdw_formal_approval_instances
 (id,subject_id,template_version_id,state,requested_by,completed_at)
 VALUES($1,$2,$3,'approved',$4,clock_timestamp())`,
		policyApproval, policySubject, sourceTemplateID, admin.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO cdw_approved_candidates
 (id,subject_id,file_id,approval_instance_id,content_sha256)
 VALUES($1,$2,$3,$4,$5)`, policyCandidate, policySubject, policyFile, policyApproval, sha); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO cdw_controlled_releases
 (id,file_id,approved_candidate_id,controlled_revision,display_name_snapshot,state,
 policy_snapshot,prepared_by,issued_by,issued_at,actual_effective_at)
 VALUES($1,$2,$3,'A/0','产品设计历史文档管理规定.docx','effective','{}'::jsonb,
 $4,$4,clock_timestamp(),clock_timestamp())`, policyRelease, policyFile, policyCandidate, admin.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO cdw_effective_pointers
 (file_id,release_id,state,activated_at) VALUES($1,$2,'active',clock_timestamp())`,
		policyFile, policyRelease); err != nil {
		t.Fatal(err)
	}
	if qualified, err := r.cdwQMSPolicyEffective(ctx, policyRelease); err != nil || !qualified {
		t.Fatalf("fixture dedicated policy release not effective: %t %v", qualified, err)
	}
	tpl, err := r.CDWPublishFormalTemplate(ctx, policyTemplate,
		"qms_"+policyTemplate, []ports.CDWFormalStepDefinition{
			{NodeKey: "management_representative", Sequence: 1, ApproverID: bob.ID},
			{NodeKey: "general_manager", Sequence: 2, ApproverID: alice.ID}}, admin.ID, policyRelease)
	if err != nil || tpl == "" {
		t.Fatalf("dedicated QMS template not published: %q %v", tpl, err)
	}
	var active bool
	if err = tx.QueryRow(ctx, "SELECT cdw_qms_special_authority_current($1,$2)",
		subjectFileID, tpl).Scan(&active); err != nil || active {
		t.Fatalf("unverified dedicated policy was active: %t %v", active, err)
	}
	if err = r.cdwFormalValidateClass(ctx, subjectFileID, tpl, "qms_"+policyTemplate, policyRelease); !errors.Is(err, domain.ErrPolicyAuthorityPending) {
		t.Fatalf("DHF approval started without independent policy: %v", err)
	}
	recordID := prefix + "_dhf_dedicated_authority"
	claims := []ports.CDWQMSSpecialNodeClaim{
		{NodeKey: "management_representative", ClauseRef: "§4.3.2", BasisSummary: "管理者代表核对设计历史文档过程完整性和阶段批准记录"},
		{NodeKey: "general_manager", ClauseRef: "§4.4.1", BasisSummary: "总经理按公司规定签署设计主文件的最终批准"},
	}
	if _, err = r.CDWQMSSpecialPropose(ctx, prefix+"_incomplete_special", subjectFileID, "dhf", tpl,
		policyRelease, admin.ID, reason, claims[:1]); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("incomplete node clause coverage accepted: %v", err)
	}
	wrongNode := []ports.CDWQMSSpecialNodeClaim{claims[0],
		{NodeKey: "unrelated_qa_role", ClauseRef: "§4.4.1", BasisSummary: "没有发布的岗位不得冒用指定审批条款"}}
	if _, err = r.CDWQMSSpecialPropose(ctx, prefix+"_wrong_node", subjectFileID, "dhf", tpl,
		policyRelease, admin.ID, reason, wrongNode); !errors.Is(err, domain.ErrInvalidInput) {
		t.Fatalf("unrelated node substituted for mandatory approver: %v", err)
	}
	record, err := r.CDWQMSSpecialPropose(ctx, recordID, subjectFileID, "dhf", tpl,
		policyRelease, admin.ID, reason, claims)
	if err != nil || record.Status != "pending" {
		t.Fatalf("dedicated policy proposal: %+v %v", record, err)
	}
	if _, err = r.CDWQMSSpecialReview(ctx, recordID, admin.ID, reason, "verify"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("self-verified dedicated approval: %v", err)
	}
	if _, err = r.CDWQMSSpecialReview(ctx, recordID, bob.ID, reason, "verify"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("non document-controller verified dedicated approval: %v", err)
	}
	record, err = r.CDWQMSSpecialReview(ctx, recordID, charlie.ID, reason, "verify")
	if err != nil || record.Status != "verified" || record.VerifiedBy != charlie.ID {
		t.Fatalf("independently verified dedicated authority: %+v %v", record, err)
	}
	if err = r.cdwFormalValidateClass(ctx, subjectFileID, tpl, "qms_"+policyTemplate, policyRelease); err != nil {
		t.Fatalf("dedicated policy did not technically unblock matching template: %v", err)
	}
	if source, sourceErr := r.CDWQMSSpecialEvidenceSource(ctx, recordID); !errors.Is(sourceErr, domain.ErrPolicyAuthorityPending) {
		t.Fatalf("non-dispatched policy artifact was served instead of failing closed: %+v %v", source, sourceErr)
	}
	if err = r.cdwFormalValidateClass(ctx, subjectFileID, "bogus", "qms_"+policyTemplate, policyRelease); !errors.Is(err, domain.ErrPolicyAuthorityPending) {
		t.Fatalf("other template inherited dedicated authority: %v", err)
	}
	if _, err = tx.Exec(ctx, `UPDATE files SET name='普通文件.docx' WHERE id=$1`, subjectFileID); err != nil {
		t.Fatal(err)
	}
	var kind *string
	if err = tx.QueryRow(ctx, "SELECT cdw_qms_special_kind($1)", subjectFileID).Scan(&kind); err != nil || kind == nil || *kind != "dhf" {
		t.Fatalf("rename erased scoped DHF classification: %v %v", kind, err)
	}
	if _, err = tx.Exec(ctx, `UPDATE files SET name='DHF-测试设计历史文档.docx' WHERE id=$1`, subjectFileID); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE cdw_effective_pointers SET state='none',release_id=NULL
 WHERE file_id=$1`, policyFile); err != nil {
		t.Fatal(err)
	}
	impactRows, impactErr := r.CDWQMSSpecialImpacts(ctx, charlie.ID, 30)
	if impactErr != nil || len(impactRows) != 1 || impactRows[0].State != "open" ||
		impactRows[0].OldReleaseID != policyRelease || impactRows[0].NewReleaseID != "" {
		t.Fatalf("policy change did not create exactly one scoped review task: %+v %v", impactRows, impactErr)
	}
	impactID := impactRows[0].ID
	if _, impactErr = r.CDWQMSSpecialAssessImpact(ctx, impactID, admin.ID,
		"reapproval_required", reason); !errors.Is(impactErr, domain.ErrForbidden) {
		t.Fatalf("policy proposer self-assessed impact: %v", impactErr)
	}
	if _, impactErr = r.CDWQMSSpecialAssessImpact(ctx, impactID, bob.ID,
		"reapproval_required", reason); !errors.Is(impactErr, domain.ErrForbidden) {
		t.Fatalf("unauthorized approver assessed impact: %v", impactErr)
	}
	result, impactErr := r.CDWQMSSpecialAssessImpact(ctx, impactID, charlie.ID,
		"reapproval_required", reason)
	if impactErr != nil || result.State != "assessed" || result.Disposition != "reapproval_required" {
		t.Fatalf("independent policy impact assessment failed: %+v %v", result, impactErr)
	}
	if _, impactErr = r.CDWQMSSpecialAssessImpact(ctx, impactID, charlie.ID,
		"no_effect_on_existing_records", reason); !errors.Is(impactErr, domain.ErrConflict) {
		t.Fatalf("assessed obligation was mutated: %v", impactErr)
	}
	if _, err = tx.Exec(ctx, "SAVEPOINT cdw_policy_impact_sql"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE cdw_qms_special_policy_impacts SET state='open' WHERE id=$1`, impactID); err == nil {
		t.Fatal("direct SQL restored assessed impact")
	}
	if _, err = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_policy_impact_sql"); err != nil {
		t.Fatal(err)
	}
	if source, sourceErr := r.CDWQMSSpecialEvidenceSource(ctx, recordID); !errors.Is(sourceErr, domain.ErrPolicyAuthorityPending) {
		t.Fatalf("old evidence opened after controlled pointer withdrawal: %+v %v", source, sourceErr)
	}
	if err = r.cdwFormalValidateClass(ctx, subjectFileID, tpl, "qms_"+policyTemplate, policyRelease); !errors.Is(err, domain.ErrPolicyAuthorityPending) {
		t.Fatalf("superseded dedicated rule still signed: %v", err)
	}
	if _, err = tx.Exec(ctx, `UPDATE cdw_effective_pointers SET state='active',
 release_id=$2,activated_at=clock_timestamp() WHERE file_id=$1`, policyFile, policyRelease); err != nil {
		t.Fatal(err)
	}
	record, err = r.CDWQMSSpecialReview(ctx, recordID, charlie.ID, reason, "revoke")
	if err != nil || record.Status != "revoked" {
		t.Fatalf("dedicated rule revocation failed: %+v %v", record, err)
	}
	if err = r.cdwFormalValidateClass(ctx, subjectFileID, tpl, "qms_"+policyTemplate, policyRelease); !errors.Is(err, domain.ErrPolicyAuthorityPending) {
		t.Fatalf("revoked dedicated policy still signs: %v", err)
	}
	alerts, err := r.CDWQMSSpecialAlerts(ctx, bob.ID, 20)
	if err != nil || len(alerts) != 1 || alerts[0].EventKind != "revoked" {
		t.Fatalf("template approver did not receive revocation notice: %+v %v", alerts, err)
	}
	if seen, err := r.CDWQMSSpecialReadAlert(ctx, alerts[0].ID, charlie.ID); err != nil || seen {
		t.Fatalf("another recipient acknowledged Bob alert: %t %v", seen, err)
	}
	if seen, err := r.CDWQMSSpecialReadAlert(ctx, alerts[0].ID, bob.ID); err != nil || !seen {
		t.Fatalf("target recipient did not acknowledge: %t %v", seen, err)
	}
	if _, err = tx.Exec(ctx, "SAVEPOINT cdw_special_rewrite"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `UPDATE cdw_qms_special_authorities SET status='verified'
 WHERE id=$1`, recordID); err == nil {
		t.Fatal("database permitted restoring revoked dedicated authority")
	}
	if _, err = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_special_rewrite"); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, "SAVEPOINT cdw_special_new_review"); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"return", "reject"} {
		newID := prefix + "_special_" + action
		_, err = r.CDWQMSSpecialPropose(ctx, newID, subjectFileID, "dhf", tpl, policyRelease, admin.ID, reason, claims)
		if err != nil {
			t.Fatalf("resubmission after revoked: %v", err)
		}
		if _, err = r.CDWQMSSpecialReview(ctx, newID, admin.ID, reason, action); !errors.Is(err, domain.ErrForbidden) {
			t.Fatalf("proposer self-%s: %v", action, err)
		}
		res, err := r.CDWQMSSpecialReview(ctx, newID, charlie.ID, reason, action)
		if err != nil || res.Status != map[string]string{"return": "returned", "reject": "rejected"}[action] {
			t.Fatalf("review %s invalid: %+v %v", action, res, err)
		}
		if _, err = r.CDWQMSSpecialReview(ctx, newID, charlie.ID, reason, "verify"); !errors.Is(err, domain.ErrConflict) {
			t.Fatalf("terminal %s got verified: %v", action, err)
		}
		if _, err = tx.Exec(ctx, "SAVEPOINT cdw_special_terminal_sql"); err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(ctx, `UPDATE cdw_qms_special_authorities SET status='pending'
 WHERE id=$1`, newID); err == nil {
			t.Fatalf("direct SQL revived %s evidence", action)
		}
		if _, err = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_special_terminal_sql"); err != nil {
			t.Fatal(err)
		}
		messages, e := r.CDWQMSSpecialAlerts(ctx, admin.ID, 30)
		if e != nil || len(messages) < 1 || messages[0].EventKind != res.Status {
			t.Fatalf("proposer did not get %s notice %+v %v", action, messages, e)
		}
	}
	if _, err = tx.Exec(ctx, "ROLLBACK TO SAVEPOINT cdw_special_new_review"); err != nil {
		t.Fatal(err)
	}
	t.Log("CDW_G14_POLICY_IMPACT_PASS automatic pointer review, independent assessment, irreversible history, exact-artifact fail-closed")
	t.Log("CDW_QMS_SPECIAL_AUTHORITY_PASS node clauses, return/reject/resubmit, revoked alerts+recipient ACK, exact template, sticky kind, pointer rotation")
}
