package users

import "time"

// User is the domain projection of a user_accounts row.
type User struct {
	ID        string
	Name      string
	Email     string
	FullName  *string
	IsAdmin   bool
	IsActive  bool
	RoleType  string
	CreatedAt time.Time
	UpdatedAt time.Time
}

type CreateInput struct {
	Name     string
	Email    string
	FullName *string
	Password string
	IsAdmin  bool
	RoleType string
}

type UpdateInput struct {
	Name     *string
	FullName *string
	IsAdmin  *bool
	IsActive *bool
	RoleType *string
	Password *string
}

type UserItem struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Email     string  `json:"email"`
	FullName  *string `json:"full_name"`
	IsAdmin   bool    `json:"is_admin"`
	IsActive  bool    `json:"is_active"`
	RoleType  string  `json:"role_type"`
	CreatedAt string  `json:"created_at"`
	UpdatedAt string  `json:"updated_at"`
}

type ListResponse struct {
	Items []UserItem `json:"items"`
}

type ItemResponse struct {
	Item UserItem `json:"item"`
}
