package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"filesmanage/internal/domain"
	"filesmanage/internal/ports"
	"github.com/jackc/pgx/v5"
)

const customerCols = `id,'KH'||lpad(serial_no::text,6,'0'),name,category,credit_code,status,profile,revision,created_by,updated_by,created_at::text,updated_at::text`

func scanCustomer(row pgx.Row) (ports.Customer, error) {
	var c ports.Customer
	var data []byte
	err := row.Scan(&c.ID, &c.Code, &c.Name, &c.Category, &c.CreditCode, &c.Status, &data, &c.Revision, &c.CreatedBy, &c.UpdatedBy, &c.CreatedAt, &c.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, domain.ErrNotFound
	}
	if err != nil {
		return c, err
	}
	err = json.Unmarshal(data, &c.Profile)
	if c.Profile.Certificates == nil {
		c.Profile.Certificates = []ports.CustomerCertificate{}
	}
	return c, err
}
func (r *Repository) CustomerList(ctx context.Context, term, category, status, cursor string, limit int) ([]ports.Customer, error) {
	rows, err := r.Q.Query(ctx, `SELECT `+customerCols+` FROM customers WHERE
 ($1='' OR name ILIKE '%'||$1||'%' OR credit_code ILIKE '%'||$1||'%' OR ('KH'||lpad(serial_no::text,6,'0')) ILIKE '%'||$1||'%')
 AND ($2='' OR category=$2) AND ($3='' OR status=$3)
 AND ($4='' OR serial_no < (SELECT serial_no FROM customers WHERE id=$4))
 ORDER BY serial_no DESC LIMIT $5`, term, category, status, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.Customer{}
	for rows.Next() {
		c, e := scanCustomer(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
func (r *Repository) CustomerGet(ctx context.Context, id string, lock bool) (ports.Customer, error) {
	q := `SELECT ` + customerCols + ` FROM customers WHERE id=$1`
	if lock {
		q += ` FOR UPDATE`
	}
	return scanCustomer(r.Q.QueryRow(ctx, q, id))
}
func (r *Repository) CustomerCreate(ctx context.Context, c ports.Customer) (ports.Customer, error) {
	raw, err := json.Marshal(c.Profile)
	if err != nil {
		return c, err
	}
	_, err = r.Q.Exec(ctx, `INSERT INTO customers(id,name,category,credit_code,status,profile,created_by,updated_by)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, c.ID, c.Name, c.Category, c.CreditCode, c.Status, string(raw), c.CreatedBy, c.UpdatedBy)
	if err != nil {
		if isUniqueViolation(err) {
			return c, domain.ErrNameConflict
		}
		return c, err
	}
	return r.CustomerGet(ctx, c.ID, false)
}
func (r *Repository) CustomerUpdate(ctx context.Context, c ports.Customer, expected int64) (ports.Customer, error) {
	raw, err := json.Marshal(c.Profile)
	if err != nil {
		return c, err
	}
	tag, err := r.Q.Exec(ctx, `UPDATE customers SET name=$2,category=$3,credit_code=$4,status=$5,
 profile=$6,updated_by=$7,revision=revision+1,updated_at=now()
 WHERE id=$1 AND revision=$8 AND NOT EXISTS(
 SELECT 1 FROM customer_registration_cases x WHERE x.customer_id=$1 AND x.state='pending')`,
		c.ID, c.Name, c.Category, c.CreditCode, c.Status, string(raw), c.UpdatedBy, expected)
	if err != nil {
		if isUniqueViolation(err) {
			return c, domain.ErrNameConflict
		}
		return c, err
	}
	if tag.RowsAffected() != 1 {
		return c, domain.ErrConflict
	}
	return r.CustomerGet(ctx, c.ID, false)
}
func (r *Repository) CustomerEvents(ctx context.Context, id string) ([]ports.CustomerEvent, error) {
	rows, err := r.Q.Query(ctx, `SELECT id,revision,action,actor_id,before_snapshot,after_snapshot,reason,created_at::text
 FROM customer_events WHERE customer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CustomerEvent{}
	for rows.Next() {
		var e ports.CustomerEvent
		if err = rows.Scan(&e.ID, &e.Revision, &e.Action, &e.ActorID, &e.Before, &e.After, &e.Reason, &e.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
func (r *Repository) CustomerAppendEvent(ctx context.Context, id string, revision int64, action, actor string, before, after any, reason string) error {
	var b, a any
	if before != nil {
		raw, e := json.Marshal(before)
		if e != nil {
			return e
		}
		b = string(raw)
	}
	if after != nil {
		raw, e := json.Marshal(after)
		if e != nil {
			return e
		}
		a = string(raw)
	}
	_, err := r.Q.Exec(ctx, `INSERT INTO customer_events(id,customer_id,revision,action,actor_id,before_snapshot,after_snapshot,reason)
 VALUES(gen_random_uuid()::text,$1,$2,$3,$4,$5,$6,$7)`, id, revision, action, actor, b, a, reason)
	return err
}
func (r *Repository) CustomerUserActive(ctx context.Context, id string) (bool, error) {
	var ok bool
	err := r.Q.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id=$1 AND disabled_at IS NULL)`, id).Scan(&ok)
	return ok, err
}

const registrationCols = `r.id,r.customer_id,c.name,'KH'||lpad(c.serial_no::text,6,'0'),r.snapshot_revision,r.snapshot,r.requester_id,r.reviewer_id,r.state,r.revision,r.reason,coalesce(r.decided_by,''),r.created_at::text,coalesce(r.decided_at::text,'')`

func scanCustomerRegistration(row pgx.Row) (ports.CustomerRegistration, error) {
	var c ports.CustomerRegistration
	var data []byte
	err := row.Scan(&c.ID, &c.CustomerID, &c.CustomerName, &c.CustomerCode, &c.SnapshotRevision, &data, &c.RequesterID, &c.ReviewerID, &c.State, &c.Revision, &c.Reason, &c.DecidedBy, &c.CreatedAt, &c.DecidedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return c, domain.ErrNotFound
	}
	if err != nil {
		return c, err
	}
	c.Snapshot = json.RawMessage(data)
	return c, nil
}
func (r *Repository) CustomerSubmitRegistration(ctx context.Context, c ports.CustomerRegistration) error {
	_, err := r.Q.Exec(ctx, `INSERT INTO customer_registration_cases(id,customer_id,snapshot_revision,snapshot,requester_id,reviewer_id)
 VALUES($1,$2,$3,$4,$5,$6)`, c.ID, c.CustomerID, c.SnapshotRevision, string(c.Snapshot), c.RequesterID, c.ReviewerID)
	if isUniqueViolation(err) {
		return domain.ErrConflict
	}
	return err
}
func (r *Repository) CustomerRegistrations(ctx context.Context, scope, actor string) ([]ports.CustomerRegistration, error) {
	rows, err := r.Q.Query(ctx, `SELECT `+registrationCols+` FROM customer_registration_cases r JOIN customers c ON c.id=r.customer_id
 WHERE ($1='inbox' AND r.reviewer_id=$2 OR $1='mine' AND r.requester_id=$2)
 ORDER BY r.created_at DESC,r.id DESC LIMIT 100`, scope, actor)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ports.CustomerRegistration{}
	for rows.Next() {
		v, e := scanCustomerRegistration(rows)
		if e != nil {
			return nil, e
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (r *Repository) CustomerRegistrationGet(ctx context.Context, id string, lock bool) (ports.CustomerRegistration, error) {
	q := `SELECT ` + registrationCols + ` FROM customer_registration_cases r JOIN customers c ON c.id=r.customer_id WHERE r.id=$1`
	if lock {
		q += ` FOR UPDATE OF r`
	}
	return scanCustomerRegistration(r.Q.QueryRow(ctx, q, id))
}
func (r *Repository) CustomerDecideRegistration(ctx context.Context, id string, rev int64, reviewer, decision, reason string) error {
	tag, err := r.Q.Exec(ctx, `UPDATE customer_registration_cases SET state=$4,reason=$5,decided_by=$3,
 decided_at=now(),revision=revision+1 WHERE id=$1 AND revision=$2 AND reviewer_id=$3 AND state='pending'`,
		id, rev, reviewer, decision, reason)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return domain.ErrConflict
	}
	return nil
}
