package application

import (
	"filesmanage/internal/domain"
	"testing"
)

func TestSealAdministratorRightsAndOrdinaryIsolation(t *testing.T) {
	admin := domain.User{ID: "u_admin", IsAdmin: true}
	regular := domain.User{ID: "u_user"}
	none := domain.SealUserPermission{}
	personal := domain.SealAsset{Kind: "personal", OwnerID: "another", Active: true}
	company := domain.SealAsset{Kind: "company", Active: true}
	if !sealCanApply(admin, personal, none, false) || !sealCanApply(admin, company, none, false) {
		t.Fatal("administrator cannot use all assigned active seals")
	}
	if sealCanApply(regular, personal, none, true) || sealCanApply(regular, company, none, true) {
		t.Fatal("user ignored global permission flags")
	}
	if sealCanApply(regular, personal, domain.SealUserPermission{CanSign: true}, false) {
		t.Fatal("user used another person's signature")
	}
	personal.OwnerID = regular.ID
	if !sealCanApply(regular, personal, domain.SealUserPermission{CanSign: true}, false) {
		t.Fatal("owner refused")
	}
	if sealCanApply(regular, company, domain.SealUserPermission{CanStamp: true}, false) {
		t.Fatal("company grant bypass")
	}
	if !sealCanApply(regular, company, domain.SealUserPermission{CanStamp: true}, true) {
		t.Fatal("valid grant refused")
	}
	personal.OwnerID = ""
	if sealCanApply(admin, personal, none, false) {
		t.Fatal("unbound signature was treated as assigned")
	}
	company.Active = false
	if sealCanApply(admin, company, none, false) {
		t.Fatal("retired stamp used")
	}
}
