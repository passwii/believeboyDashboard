package presence

type HeartbeatRequest struct {
	CurrentPath      string `json:"current_path"`
	CurrentPageTitle string `json:"current_page_title"`
}

type UserItem struct {
	UserID           string  `json:"user_id"`
	DisplayName      string  `json:"display_name"`
	Email            *string `json:"email"`
	AvatarURL        *string `json:"avatar_url"`
	CurrentPath      string  `json:"current_path"`
	CurrentPageTitle string  `json:"current_page_title"`
	LastSeenAt       string  `json:"last_seen_at"`
	IsCurrentUser    bool    `json:"is_current_user"`
}

type Response struct {
	ServerTime string     `json:"server_time"`
	Items      []UserItem `json:"items"`
}

type UpsertInput struct {
	UserID           string
	DisplayName      string
	Email            *string
	AvatarURL        *string
	CurrentPath      string
	CurrentPageTitle string
}
