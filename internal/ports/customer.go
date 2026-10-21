package ports

import (
	"context"
	"encoding/json"
)

type CustomerCertificate struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Number    string `json:"number"`
	IssuedOn  string `json:"issuedOn"`
	ExpiresOn string `json:"expiresOn"`
	FileID    string `json:"fileId"`
	Note      string `json:"note"`
}
type CustomerProfile struct {
	Contact             string                `json:"contact"`
	Phone               string                `json:"phone"`
	Address             string                `json:"address"`
	LegalRepresentative string                `json:"legalRepresentative"`
	BusinessScope       string                `json:"businessScope"`
	BusinessMethod      string                `json:"businessMethod"`
	BankName            string                `json:"bankName"`
	BankAccount         string                `json:"bankAccount"`
	TaxNumber           string                `json:"taxNumber"`
	Email               string                `json:"email"`
	Notes               string                `json:"notes"`
	Certificates        []CustomerCertificate `json:"certificates"`
}
type Customer struct {
	ID         string          `json:"id"`
	Code       string          `json:"code"`
	Name       string          `json:"name"`
	Category   string          `json:"category"`
	CreditCode string          `json:"creditCode"`
	Status     string          `json:"status"`
	Profile    CustomerProfile `json:"profile"`
	Revision   int64           `json:"revision"`
	CreatedBy  string          `json:"createdBy"`
	UpdatedBy  string          `json:"updatedBy"`
	CreatedAt  string          `json:"createdAt"`
	UpdatedAt  string          `json:"updatedAt"`
}
type CustomerEvent struct {
	ID        string          `json:"id"`
	Revision  int64           `json:"revision"`
	Action    string          `json:"action"`
	ActorID   string          `json:"actorId"`
	Before    json.RawMessage `json:"before,omitempty"`
	After     json.RawMessage `json:"after,omitempty"`
	Reason    string          `json:"reason"`
	CreatedAt string          `json:"createdAt"`
}
type CustomerRegistration struct {
	ID               string          `json:"id"`
	CustomerID       string          `json:"customerId"`
	CustomerName     string          `json:"customerName"`
	CustomerCode     string          `json:"customerCode"`
	SnapshotRevision int64           `json:"snapshotRevision"`
	Snapshot         json.RawMessage `json:"snapshot"`
	RequesterID      string          `json:"requesterId"`
	ReviewerID       string          `json:"reviewerId"`
	State            string          `json:"state"`
	Revision         int64           `json:"revision"`
	Reason           string          `json:"reason"`
	DecidedBy        string          `json:"decidedBy"`
	CreatedAt        string          `json:"createdAt"`
	DecidedAt        string          `json:"decidedAt"`
}
type CustomerStore interface {
	CustomerList(context.Context, string, string, string, string, int) ([]Customer, error)
	CustomerGet(context.Context, string, bool) (Customer, error)
	CustomerCreate(context.Context, Customer) (Customer, error)
	CustomerUpdate(context.Context, Customer, int64) (Customer, error)
	CustomerEvents(context.Context, string) ([]CustomerEvent, error)
	CustomerAppendEvent(context.Context, string, int64, string, string, any, any, string) error
	CustomerUserActive(context.Context, string) (bool, error)
	CustomerSubmitRegistration(context.Context, CustomerRegistration) error
	CustomerRegistrations(context.Context, string, string) ([]CustomerRegistration, error)
	CustomerRegistrationGet(context.Context, string, bool) (CustomerRegistration, error)
	CustomerDecideRegistration(context.Context, string, int64, string, string, string) error
}
