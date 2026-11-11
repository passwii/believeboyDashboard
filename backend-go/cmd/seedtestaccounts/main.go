package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

type testAccount struct {
	Email    string
	Name     string
	FullName string
	Role     string
	IsAdmin  bool
	Password string
}

func main() {
	databaseURL := flag.String("database-url", "", "exact database URL")
	resetPassword := flag.Bool("reset-password", false, "force reset password for existing accounts")
	flag.Parse()
	url := strings.TrimSpace(*databaseURL)
	if url == "" {
		url = strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	}
	if url == "" {
		url = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	}
	if url == "" {
		fmt.Fprintln(os.Stderr, "seed_test_accounts: TEST_DATABASE_URL or DATABASE_URL is required")
		os.Exit(1)
	}
	accounts := []testAccount{
		{Email: envOrDefault("TEST_ADMIN_EMAIL", "test_admin@believeboy.com"), Name: "测试管理员", FullName: "测试管理员", Role: "admin", IsAdmin: true, Password: envOrDefault("TEST_ADMIN_PASSWORD", os.Getenv("TEST_ACCOUNT_PASSWORD"))},
		{Email: envOrDefault("TEST_OPERATOR_EMAIL", "test_operator@believeboy.com"), Name: "测试运营", FullName: "测试运营", Role: "operator", Password: envOrDefault("TEST_OPERATOR_PASSWORD", os.Getenv("TEST_ACCOUNT_PASSWORD"))},
		{Email: envOrDefault("TEST_BUSINESSDEV_EMAIL", "test_businessdev@believeboy.com"), Name: "测试招商", FullName: "测试招商", Role: "businessdev", Password: envOrDefault("TEST_BUSINESSDEV_PASSWORD", os.Getenv("TEST_ACCOUNT_PASSWORD"))},
	}
	for _, account := range accounts {
		if strings.TrimSpace(account.Password) == "" {
			fmt.Fprintf(os.Stderr, "seed_test_accounts: missing password for %s; set TEST_*_PASSWORD or TEST_ACCOUNT_PASSWORD\n", account.Role)
			os.Exit(1)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, url)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open database:", err)
		os.Exit(1)
	}
	defer pool.Close()
	db := store.NewPGXDB(pool)
	for _, account := range accounts {
		hash, err := bcrypt.GenerateFromPassword([]byte(account.Password), 10)
		if err != nil {
			fmt.Fprintln(os.Stderr, "hash password:", err)
			os.Exit(1)
		}
		query := "insert into public.user_accounts (name, email, full_name, password_hash, is_admin, is_active, role_type) " +
			"values ($1, lower($2), $3, $4, $5, true, $6) " +
			"on conflict ((lower(email))) do update set name = excluded.name, full_name = excluded.full_name, " +
			"role_type = excluded.role_type, is_active = true, is_admin = excluded.is_admin, updated_at = now()"
		args := []any{account.Name, account.Email, account.FullName, string(hash), account.IsAdmin, account.Role}
		if *resetPassword {
			query += ", password_hash = excluded.password_hash"
		}
		if _, err := db.Exec(ctx, query, args...); err != nil {
			fmt.Fprintf(os.Stderr, "seed %s failed: %v\n", account.Role, err)
			os.Exit(1)
		}
		fmt.Printf("  [OK] %-12s %s\n", account.Role, account.Email)
	}
	fmt.Println("All test accounts ready.")
}

func envOrDefault(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
