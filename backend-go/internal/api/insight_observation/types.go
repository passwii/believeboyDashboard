package insight_observation

import (
	"context"
	"time"
)

const ModuleName = "insight_observation"

type Store interface {
	ListObservationRows(ctx context.Context, since time.Time, capability *string) ([]ObservationRow, error)
}

type ObservationRow struct {
	Source             string
	RunID              *string
	Attempt            *int
	Capability         string
	RoleID             *string
	EndpointID         *string
	ModelID            *string
	Status             *string
	FirstDeltaMS       *int
	DurationMS         *int
	InputTokens        *int
	OutputTokens       *int
	TotalTokens        *int
	Attempts           *int
	Retries            *int
	StreamOpens        int
	StreamReconnects   int
	ReconnectCompleted bool
	StreamFrames       int
	StreamBytes        *int
	StreamXLen         *int
	StreamMemoryBytes  *int
	CancelRequested    bool
	CancelSucceeded    *bool
	ErrorCode          *string
	ErrorRetryable     *bool
	Fallback           bool
	FallbackReason     *string
	CreatedAt          time.Time
}

type Thresholds struct {
	DurationMS            int     `json:"duration_ms"`
	FirstDeltaMS          int     `json:"first_delta_ms"`
	StreamFrames          int     `json:"stream_frames"`
	FallbackRatio         float64 `json:"fallback_ratio"`
	CostAnomalyMultiplier float64 `json:"cost_anomaly_multiplier"`
}

type CapabilityMetrics struct {
	Capability           string         `json:"capability"`
	Runs                 int            `json:"runs"`
	Completed            int            `json:"completed"`
	Failed               int            `json:"failed"`
	Cancelled            int            `json:"cancelled"`
	FallbackEvents       int            `json:"fallback_events"`
	FallbackRatio        float64        `json:"fallback_ratio"`
	ErrorRate            float64        `json:"error_rate"`
	ErrorCounts          map[string]int `json:"error_counts"`
	RetriedRuns          int            `json:"retried_runs"`
	CancelRequested      int            `json:"cancel_requested"`
	CancelSucceeded      int            `json:"cancel_succeeded"`
	CancelSuccessRate    *float64       `json:"cancel_success_rate"`
	StreamOpens          int            `json:"stream_opens"`
	StreamReconnects     int            `json:"stream_reconnects"`
	ReconnectRate        float64        `json:"reconnect_rate"`
	ReconnectCompleted   int            `json:"reconnect_completed"`
	StreamFrames         int            `json:"stream_frames"`
	StreamBytes          int            `json:"stream_bytes"`
	MaxStreamXLen        *int           `json:"max_stream_xlen"`
	MaxStreamMemoryBytes *int           `json:"max_stream_memory_bytes"`
	TotalTokens          int            `json:"total_tokens"`
	AvgDurationMS        *int           `json:"avg_duration_ms"`
	P95DurationMS        *int           `json:"p95_duration_ms"`
	MaxDurationMS        *int           `json:"max_duration_ms"`
	AvgFirstDeltaMS      *int           `json:"avg_first_delta_ms"`
	P95FirstDeltaMS      *int           `json:"p95_first_delta_ms"`
	MaxFirstDeltaMS      *int           `json:"max_first_delta_ms"`
	CostAnomalies        []string       `json:"cost_anomalies"`
}

type GateFinding struct {
	Code       string `json:"code"`
	Severity   string `json:"severity"`
	Capability string `json:"capability"`
	Metric     string `json:"metric"`
	Observed   any    `json:"observed"`
	Threshold  any    `json:"threshold"`
	Detail     string `json:"detail"`
}

type GateResponse struct {
	WindowDays            int                 `json:"window_days"`
	GeneratedAt           time.Time           `json:"generated_at"`
	EligibleForRetirement bool                `json:"eligible_for_retirement"`
	RetirementReasons     []string            `json:"retirement_reasons"`
	BlockingCount         int                 `json:"blocking_count"`
	Thresholds            Thresholds          `json:"thresholds"`
	BucketCaps            map[string]int      `json:"bucket_caps"`
	Buckets               []CapabilityMetrics `json:"buckets"`
	Findings              []GateFinding       `json:"findings"`
}

type RetirementReadiness struct {
	MetricsOK            bool     `json:"metrics_ok"`
	MetricsReasons       []string `json:"metrics_reasons"`
	CanonicalDomains     []string `json:"canonical_domains"`
	FrozenLegacyDomains  []string `json:"frozen_legacy_domains"`
	RollbackSwitch       string   `json:"rollback_switch"`
	LegacyReadsPreserved bool     `json:"legacy_reads_preserved"`
	CodegraphVerified    *bool    `json:"codegraph_verified"`
	Eligible             bool     `json:"eligible"`
	BlockingCount        int      `json:"blocking_count"`
}

type Config struct {
	WindowDays       int
	Thresholds       Thresholds
	BucketCaps       map[string]int
	CanonicalDomains string
}

func DefaultConfig() Config {
	return Config{
		WindowDays: 7,
		Thresholds: Thresholds{
			DurationMS:            300000,
			FirstDeltaMS:          90000,
			StreamFrames:          10000,
			FallbackRatio:         0,
			CostAnomalyMultiplier: 5,
		},
		BucketCaps: map[string]int{"insights": 3, "ai_summary": 2},
	}
}

func (cfg Config) normalized() Config {
	if cfg.WindowDays <= 0 || cfg.WindowDays > 90 {
		cfg.WindowDays = 7
	}
	if cfg.BucketCaps == nil {
		cfg.BucketCaps = map[string]int{"insights": 3, "ai_summary": 2}
	}
	return cfg
}
