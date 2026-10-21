package application

import (
	"context"
	"encoding/json"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"strings"
	"time"
	"unicode/utf8"
)

type CustomerWriteInput struct {
	Name             string                `json:"name"`
	Category         string                `json:"category"`
	CreditCode       string                `json:"creditCode"`
	Status           string                `json:"status"`
	Profile          ports.CustomerProfile `json:"profile"`
	ExpectedRevision int64                 `json:"expectedRevision"`
}
type CustomerPage struct {
	Items      []ports.Customer `json:"items"`
	NextCursor string           `json:"nextCursor"`
}

func validCustomerText(v string, n int) bool {
	return utf8.ValidString(v) && utf8.RuneCountInString(v) <= n
}
func validateCustomer(in *CustomerWriteInput) bool {
	in.Name = strings.TrimSpace(in.Name)
	in.CreditCode = strings.TrimSpace(in.CreditCode)
	if len([]rune(in.Name)) < 2 || !validCustomerText(in.Name, 200) || !validCustomerText(in.CreditCode, 32) {
		return false
	}
	switch in.Category {
	case "wholesale", "retail", "mixed", "medical", "other":
	default:
		return false
	}
	if in.Status != "active" && in.Status != "disabled" {
		return false
	}
	for _, v := range []string{in.Profile.Contact, in.Profile.Phone, in.Profile.Address, in.Profile.LegalRepresentative, in.Profile.BusinessScope, in.Profile.BusinessMethod, in.Profile.BankName, in.Profile.BankAccount, in.Profile.TaxNumber, in.Profile.Email, in.Profile.Notes} {
		if !validCustomerText(v, 4000) {
			return false
		}
	}
	if len(in.Profile.Certificates) > 40 {
		return false
	}
	seen := map[string]bool{}
	for i := range in.Profile.Certificates {
		c := &in.Profile.Certificates[i]
		if c.ID == "" {
			c.ID = NewID("cert")
		}
		if seen[c.ID] || !validCustomerText(c.ID, 100) || !validCustomerText(c.Kind, 120) || !validCustomerText(c.Number, 120) || !validCustomerText(c.Note, 500) {
			return false
		}
		seen[c.ID] = true
		if c.IssuedOn != "" {
			if _, err := time.Parse("2006-01-02", c.IssuedOn); err != nil {
				return false
			}
		}
		if c.ExpiresOn != "" {
			if _, err := time.Parse("2006-01-02", c.ExpiresOn); err != nil {
				return false
			}
		}
		if c.IssuedOn != "" && c.ExpiresOn != "" && c.IssuedOn > c.ExpiresOn {
			return false
		}
	}
	return true
}
func (s *Service) customerTx(ctx context.Context) (ports.Tx, ports.CustomerStore, error) {
	tx, err := s.uow.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	store, ok := tx.(ports.CustomerStore)
	if !ok {
		tx.Rollback(ctx)
		return nil, nil, domain.ErrInvalidInput
	}
	return tx, store, nil
}
func (s *Service) CustomerList(ctx context.Context, actor domain.User, term, category, status, cursor string, limit int) (CustomerPage, error) {
	out := CustomerPage{Items: []ports.Customer{}}
	if !actor.IsAdmin {
		return out, domain.ErrForbidden
	}
	if limit < 1 || limit > 100 || len(term) > 120 || len(cursor) > 120 {
		return out, domain.ErrInvalidInput
	}
	if category != "" {
		switch category {
		case "wholesale", "retail", "mixed", "medical", "other":
		default:
			return out, domain.ErrInvalidInput
		}
	}
	if status != "" && status != "active" && status != "disabled" {
		return out, domain.ErrInvalidInput
	}
	tx, store, err := s.customerTx(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	rows, err := store.CustomerList(ctx, strings.TrimSpace(term), category, status, cursor, limit+1)
	if err != nil {
		return out, err
	}
	if len(rows) > limit {
		out.NextCursor = rows[limit-1].ID
		rows = rows[:limit]
	}
	out.Items = rows
	return out, nil
}
func (s *Service) CustomerGet(ctx context.Context, actor domain.User, id string) (ports.Customer, error) {
	if !actor.IsAdmin {
		return ports.Customer{}, domain.ErrForbidden
	}
	tx, store, err := s.customerTx(ctx)
	if err != nil {
		return ports.Customer{}, err
	}
	defer tx.Rollback(ctx)
	return store.CustomerGet(ctx, id, false)
}
func (s *Service) CustomerHistory(ctx context.Context, actor domain.User, id string) ([]ports.CustomerEvent, error) {
	if !actor.IsAdmin {
		return nil, domain.ErrForbidden
	}
	tx, store, err := s.customerTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = store.CustomerGet(ctx, id, false); err != nil {
		return nil, err
	}
	return store.CustomerEvents(ctx, id)
}
func (s *Service) customerCheckFiles(ctx context.Context, tx ports.Tx, actor domain.User, profile ports.CustomerProfile) error {
	for _, c := range profile.Certificates {
		if c.FileID == "" {
			continue
		}
		if _, err := s.visibleFile(ctx, tx, actor, c.FileID, domain.ActionPreview); err != nil {
			return err
		}
	}
	return nil
}
func (s *Service) CustomerCreate(ctx context.Context, actor domain.User, in CustomerWriteInput) (ports.Customer, error) {
	var out ports.Customer
	if !actor.IsAdmin {
		return out, domain.ErrForbidden
	}
	in.Status = "active"
	if !validateCustomer(&in) {
		return out, domain.ErrInvalidInput
	}
	tx, store, err := s.customerTx(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	if err = s.customerCheckFiles(ctx, tx, actor, in.Profile); err != nil {
		return out, err
	}
	c := ports.Customer{ID: NewID("customer"), Name: in.Name, Category: in.Category, CreditCode: in.CreditCode, Status: in.Status, Profile: in.Profile, CreatedBy: actor.ID, UpdatedBy: actor.ID}
	out, err = store.CustomerCreate(ctx, c)
	if err != nil {
		return out, err
	}
	if err = store.CustomerAppendEvent(ctx, out.ID, out.Revision, "created", actor.ID, nil, out, ""); err != nil {
		return ports.Customer{}, err
	}
	if err = auditRequired(ctx, tx, actor, "customer.create", "customer", out.ID, "success", map[string]any{"revision": out.Revision}); err != nil {
		return ports.Customer{}, err
	}
	return out, tx.Commit(ctx)
}
func (s *Service) CustomerUpdate(ctx context.Context, actor domain.User, id string, in CustomerWriteInput) (ports.Customer, error) {
	var out ports.Customer
	if !actor.IsAdmin {
		return out, domain.ErrForbidden
	}
	if in.ExpectedRevision < 1 || !validateCustomer(&in) {
		return out, domain.ErrInvalidInput
	}
	tx, store, err := s.customerTx(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	before, err := store.CustomerGet(ctx, id, true)
	if err != nil {
		return out, err
	}
	if before.Revision != in.ExpectedRevision {
		return out, domain.ErrConflict
	}
	if err = s.customerCheckFiles(ctx, tx, actor, in.Profile); err != nil {
		return out, err
	}
	target := before
	target.Name = in.Name
	target.Category = in.Category
	target.CreditCode = in.CreditCode
	target.Status = in.Status
	target.Profile = in.Profile
	target.UpdatedBy = actor.ID
	out, err = store.CustomerUpdate(ctx, target, in.ExpectedRevision)
	if err != nil {
		return out, err
	}
	action := "updated"
	if before.Status != out.Status {
		if out.Status == "disabled" {
			action = "disabled"
		} else {
			action = "enabled"
		}
	}
	if err = store.CustomerAppendEvent(ctx, id, out.Revision, action, actor.ID, before, out, ""); err != nil {
		return ports.Customer{}, err
	}
	if err = auditRequired(ctx, tx, actor, "customer."+action, "customer", id, "success", map[string]any{"revision": out.Revision, "oldRevision": before.Revision}); err != nil {
		return ports.Customer{}, err
	}
	return out, tx.Commit(ctx)
}
func (s *Service) CustomerSubmitRegistration(ctx context.Context, actor domain.User, id, reviewerID string) (ports.CustomerRegistration, error) {
	var out ports.CustomerRegistration
	if !actor.IsAdmin {
		return out, domain.ErrForbidden
	}
	if reviewerID == "" || reviewerID == actor.ID {
		return out, domain.ErrInvalidInput
	}
	tx, store, err := s.customerTx(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	customer, err := store.CustomerGet(ctx, id, true)
	if err != nil {
		return out, err
	}
	if customer.Status != "active" {
		return out, domain.ErrConflict
	}
	active, err := store.CustomerUserActive(ctx, reviewerID)
	if err != nil {
		return out, err
	}
	if !active {
		return out, domain.ErrInvalidInput
	}
	reviewer, err := tx.UserByID(ctx, reviewerID)
	if err != nil {
		return out, err
	}
	if err = s.customerCheckFiles(ctx, tx, reviewer, customer.Profile); err != nil {
		return out, domain.ErrForbidden
	}
	data, err := json.Marshal(customer)
	if err != nil {
		return out, err
	}
	out = ports.CustomerRegistration{ID: NewID("custreg"), CustomerID: id, CustomerName: customer.Name, CustomerCode: customer.Code, SnapshotRevision: customer.Revision, Snapshot: data, RequesterID: actor.ID, ReviewerID: reviewerID, State: "pending", Revision: 1}
	if err = store.CustomerSubmitRegistration(ctx, out); err != nil {
		return ports.CustomerRegistration{}, err
	}
	if err = store.CustomerAppendEvent(ctx, id, customer.Revision, "registration_submitted", actor.ID, nil, out, ""); err != nil {
		return ports.CustomerRegistration{}, err
	}
	if err = auditRequired(ctx, tx, actor, "customer.registration.submit", "customer_registration", out.ID, "success", map[string]any{"customerId": id, "snapshotRevision": customer.Revision, "reviewerId": reviewerID}); err != nil {
		return ports.CustomerRegistration{}, err
	}
	return out, tx.Commit(ctx)
}
func (s *Service) CustomerRegistrations(ctx context.Context, actor domain.User, scope string) ([]ports.CustomerRegistration, error) {
	if scope != "inbox" && scope != "mine" {
		return nil, domain.ErrInvalidInput
	}
	tx, store, err := s.customerTx(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	return store.CustomerRegistrations(ctx, scope, actor.ID)
}
func (s *Service) CustomerRegistrationGet(ctx context.Context, actor domain.User, id string) (ports.CustomerRegistration, error) {
	tx, store, err := s.customerTx(ctx)
	if err != nil {
		return ports.CustomerRegistration{}, err
	}
	defer tx.Rollback(ctx)
	c, err := store.CustomerRegistrationGet(ctx, id, false)
	if err != nil {
		return c, err
	}
	if c.RequesterID != actor.ID && c.ReviewerID != actor.ID {
		return ports.CustomerRegistration{}, domain.ErrForbidden
	}
	return c, nil
}
func (s *Service) CustomerDecideRegistration(ctx context.Context, actor domain.User, id string, revision int64, decision, reason string) (ports.CustomerRegistration, error) {
	var out ports.CustomerRegistration
	reason = strings.TrimSpace(reason)
	if revision < 1 || (decision != "approved" && decision != "rejected") || len([]rune(reason)) > 1000 || (decision == "rejected" && len([]rune(reason)) < 3) {
		return out, domain.ErrInvalidInput
	}
	tx, store, err := s.customerTx(ctx)
	if err != nil {
		return out, err
	}
	defer tx.Rollback(ctx)
	before, err := store.CustomerRegistrationGet(ctx, id, true)
	if err != nil {
		return out, err
	}
	if before.ReviewerID != actor.ID {
		return out, domain.ErrForbidden
	}
	if before.State != "pending" || before.Revision != revision {
		return out, domain.ErrConflict
	}
	if err = store.CustomerDecideRegistration(ctx, id, revision, actor.ID, decision, reason); err != nil {
		return out, err
	}
	out, err = store.CustomerRegistrationGet(ctx, id, false)
	if err != nil {
		return out, err
	}
	action := "registration_" + decision
	if err = store.CustomerAppendEvent(ctx, out.CustomerID, out.SnapshotRevision, action, actor.ID, before, out, reason); err != nil {
		return out, err
	}
	if err = auditRequired(ctx, tx, actor, "customer."+action, "customer_registration", id, "success", map[string]any{"customerId": out.CustomerID, "snapshotRevision": out.SnapshotRevision}); err != nil {
		return out, err
	}
	return out, tx.Commit(ctx)
}
