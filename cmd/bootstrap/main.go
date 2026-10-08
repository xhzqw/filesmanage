package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
	"log"
	"os"
	"strings"
	"time"
)

func main() {
	if os.Getenv("FILESMANAGE_ALLOW_BOOTSTRAP") != "new-empty-database" {
		log.Fatal("bootstrap explicitly disabled; set FILESMANAGE_ALLOW_BOOTSTRAP=new-empty-database")
	}
	// The initial password is read from a protected target-local file;
	// it never appears in argv, application logs or the process environment.
	passwordFile := os.Getenv("BOOTSTRAP_ADMIN_PASSWORD_FILE")
	if passwordFile == "" {
		log.Fatal("BOOTSTRAP_ADMIN_PASSWORD_FILE required")
	}
	info, statErr := os.Stat(passwordFile)
	if statErr != nil || info.Mode().Perm()&0077 != 0 {
		log.Fatal("bootstrap password file missing or not owner-only")
	}
	passwordBytes, readErr := os.ReadFile(passwordFile)
	if readErr != nil {
		log.Fatal("cannot read bootstrap password file")
	}
	password := strings.TrimSpace(string(passwordBytes))
	if len(password) < 20 {
		log.Fatal("strong bootstrap password file required (>=20 characters)")
	}
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		log.Fatal("DATABASE_URL required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		log.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(21007722)"); err != nil {
		log.Fatal(err)
	}
	var count int
	if err = tx.QueryRow(ctx, "SELECT count(*) FROM users").Scan(&count); err != nil {
		log.Fatal("run migrations first: ", err)
	}
	if count != 0 {
		log.Fatal("bootstrap REFUSED: target already has users")
	}
	h, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		log.Fatal(err)
	}
	if _, err = tx.Exec(ctx, "INSERT INTO users(id,login,display_name,password_hash,is_admin,must_change_password) VALUES($1,$2,$3,$4,true,true)", "u_admin", "admin", "系统管理员", string(h)); err != nil {
		log.Fatal(err)
	}
	departments := [][2]string{{"dept_market", "市场部"}, {"dept_rd", "研发部"}}
	for _, d := range departments {
		if _, err = tx.Exec(ctx, "INSERT INTO departments(id,name) VALUES($1,$2)", d[0], d[1]); err != nil {
			log.Fatal(err)
		}
	}
	if _, err = tx.Exec(ctx, "INSERT INTO workgroups(id,department_id,name) VALUES($1,$2,$3)", "group_market", "dept_market", "市场部工作组"); err != nil {
		log.Fatal(err)
	}
	roles := [][4]string{
		{"1000001", "市场部文员", "dept_market", "group_market"},
		{"1000002", "市场部主管", "dept_market", "group_market"},
		{"1000003", "市场部专员", "dept_market", "group_market"},
		{"1000004", "研发工程师", "dept_rd", ""},
		{"1000005", "项目经理", "dept_rd", ""},
	}
	for _, role := range roles {
		secret := make([]byte, 32)
		if _, err = rand.Read(secret); err != nil {
			log.Fatal(err)
		}
		unusable, err := bcrypt.GenerateFromPassword([]byte(hex.EncodeToString(secret)), bcrypt.MinCost)
		if err != nil {
			log.Fatal(err)
		}
		if _, err = tx.Exec(ctx, "INSERT INTO users(id,login,display_name,password_hash,department_id,must_change_password) VALUES($1,$2,$3,$4,$5,true)", role[0], role[0], role[1], string(unusable), role[2]); err != nil {
			log.Fatal(err)
		}
		if role[3] != "" {
			if _, err = tx.Exec(ctx, "INSERT INTO workgroup_members(group_id,user_id) VALUES($1,$2)", role[3], role[0]); err != nil {
				log.Fatal(err)
			}
		}
	}
	folders := [][3]string{
		{"folder_root", "中晟生物科技", ""},
		{"folder_market", "市场部", "folder_root"},
		{"folder_rd", "研发部", "folder_root"},
		{"folder_marketing_material", "市场资料", "folder_market"},
		{"folder_assets", "活动素材", "folder_market"},
		{"folder_project", "示范项目", "folder_root"},
		{"folder_budget", "项目预算", "folder_project"},
		{"folder_engineering", "技术文档", "folder_rd"},
	}
	for _, folder := range folders {
		if folder[2] == "" {
			_, err = tx.Exec(ctx, "INSERT INTO folders(id,name,owner_id) VALUES($1,$2,'u_admin')", folder[0], folder[1])
		} else {
			_, err = tx.Exec(ctx, "INSERT INTO folders(id,name,parent_id,owner_id) VALUES($1,$2,$3,'u_admin')", folder[0], folder[1], folder[2])
		}
		if err != nil {
			log.Fatal(err)
		}
	}
	grants := [][3]string{
		{"acl_root", "folder_root", "{list}"},
		{"acl_market", "folder_market", "{list,preview,upload}"},
	}
	for _, g := range grants {
		if _, err = tx.Exec(ctx, "INSERT INTO acls(id,folder_id,subject_kind,subject_id,actions,granted_by) VALUES($1,$2,'group','group_market',$3::text[],'u_admin')", g[0], g[1], g[2]); err != nil {
			log.Fatal(err)
		}
	}
	if _, err = tx.Exec(ctx, "INSERT INTO audit_events(actor_id,event_type,target_kind,target_id,request_id,outcome) VALUES('u_admin','bootstrap','system','new-install','bootstrap','success')"); err != nil {
		log.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		log.Fatal(err)
	}
	fmt.Println("BOOTSTRAP_OK users=6 departments=2 groups=1 folders=8 legacy_data_imported=0")
}

var _ = errors.Is
var _ = pgx.ErrNoRows
