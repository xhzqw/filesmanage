package postgres

import "testing"

func TestCDWQMSFormalTemplateClassification(t *testing.T) {
	for _, tt := range []struct {
		key  string
		want bool
	}{
		{"qms_document_correction", true},
		{"cdw_qms_dhf", true},
		{"QMS_RECALL", true},
		{"CDW_QMS_ECR", true},
		{"formal_document_generic", false},
		{"other_qms_nested", false},
		{"cdw_task_template", false},
	} {
		if got := cdwIsQMSFormalTemplate(tt.key); got != tt.want {
			t.Errorf("key %q classified QMS=%v, want %v", tt.key, got, tt.want)
		}
	}
}
