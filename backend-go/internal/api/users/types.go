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

// ListResponse is the legacy items-only shape. Callers that need pagination
// metadata must send include_total=true and receive PaginatedListResponse,
// because existing device clients parse this contract without the extra keys.
type ListResponse struct {
	Items []UserItem `json:"items"`
}

// PaginatedListResponse adds the pagination metadata the account-management
// page needs to render real pages instead of a silently truncated first page.
type PaginatedListResponse struct {
	Items    []UserItem `json:"items"`
	Total    int        `json:"total"`
	Page     int        `json:"page"`
	PageSize int        `json:"page_size"`
}

type ItemResponse struct {
	Item UserItem `json:"item"`
}
