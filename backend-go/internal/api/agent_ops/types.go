package agent_ops

import "time"

const MaxWindowDays = 90

type DomainSummaryItem struct {
	Domain       string     `json:"domain"`
	Calls24h     int64      `json:"calls_24h"`
	Calls7d      int64      `json:"calls_7d"`
	Writes24h    int64      `json:"writes_24h"`
	Writes7d     int64      `json:"writes_7d"`
	Errors7d     int64      `json:"errors_7d"`
	LastActiveAt *time.Time `json:"-"`
}

type DomainSummaryResponse struct {
	GeneratedAt string              `json:"generated_at"`
	WindowDays  int                 `json:"window_days"`
	Items       []DomainSummaryItem `json:"items"`
}

type EmployeeSummaryItem struct {
	APIKeyID     int64      `json:"api_key_id"`
	Calls24h     int64      `json:"calls_24h"`
	Calls7d      int64      `json:"calls_7d"`
	Writes24h    int64      `json:"writes_24h"`
	Writes7d     int64      `json:"writes_7d"`
	Errors7d     int64      `json:"errors_7d"`
	LastActiveAt *time.Time `json:"-"`
}

type EmployeeSummaryResponse struct {
	GeneratedAt string                `json:"generated_at"`
	WindowDays  int                   `json:"window_days"`
	Items       []EmployeeSummaryItem `json:"items"`
}
