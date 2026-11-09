package alerts

import (
	"context"
	"errors"
)

var (
	ErrDetectionConflict      = errors.New("alert detection is already running")
	ErrDetectionUnavailable   = errors.New("alert detection dependency is unavailable")
	ErrPreferencesUnavailable = errors.New("alert preferences dependency is unavailable")
)

type AuditContext struct {
	Action         string
	TargetType     string
	TargetID       *string
	Operator       *string
	TraceID        *string
	RequestMethod  *string
	RequestPath    *string
	IPAddress      *string
	UserAgent      *string
	IdempotencyKey *string
	BeforeJSON     any
	AfterJSON      any
}

type DetectionInput struct {
	Today string
	Audit AuditContext
}

type DetectionResult struct {
	RulesEvaluated int `json:"rules_evaluated"`
	EventsCreated  int `json:"events_created"`
	MessagesSent   int `json:"messages_sent"`
}

type DetectionStore interface {
	Detect(context.Context, DetectionInput) (DetectionResult, error)
}

type Preference struct {
	EmailEnabled    bool
	InAppEnabled    bool
	MinSeverity     string
	QuietHoursStart *string
	QuietHoursEnd   *string
}

type PreferencePatch struct {
	EmailEnabled       *bool
	InAppEnabled       *bool
	MinSeverity        *string
	QuietHoursStart    *string
	QuietHoursEnd      *string
	QuietHoursStartSet bool
	QuietHoursEndSet   bool
}

type UpdatePreferenceInput struct {
	Patch PreferencePatch
	Audit AuditContext
}

type PreferenceStore interface {
	GetPreference(context.Context, int64) (*Preference, error)
	UpdatePreference(context.Context, int64, UpdatePreferenceInput) (*Preference, error)
}
