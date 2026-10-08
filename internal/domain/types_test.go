package domain

import "testing"

func TestAllowedAction(t *testing.T) {
	for _, a := range []Action{ActionList, ActionPreview, ActionUpload, ActionDownload, ActionModify, ActionDelete, ActionRename, ActionMove, ActionPrint} {
		if !AllowedAction(a) {
			t.Fatalf("rejected %q", a)
		}
	}
	if AllowedAction("manage_acl") || AllowedAction("purge_trash") || AllowedAction("") {
		t.Fatal("admin operations must not be included in nine-file-action grant set")
	}
}
