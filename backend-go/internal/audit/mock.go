package audit

import (
	"context"
	"net/http"
	"sync"

	"github.com/jackc/pgx/v5"
)

// MockService captures audit entries in memory for unit testing.
type MockService struct {
	mu      sync.Mutex
	Entries []Entry
	Views   []ViewRecord
}

type ViewRecord struct {
	Action     string
	TargetType string
	Operator   *string
	After      any
}

func NewMockService() *MockService {
	return &MockService{
		Entries: make([]Entry, 0),
		Views:   make([]ViewRecord, 0),
	}
}

func (m *MockService) LogAction(_ context.Context, entry Entry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Entries = append(m.Entries, entry)
	return nil
}

func (m *MockService) LogActionTx(_ context.Context, _ pgx.Tx, entry Entry) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Entries = append(m.Entries, entry)
	return nil
}

func (m *MockService) LogView(_ context.Context, action string, targetType string, operator *string, after any, _ *http.Request) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.Views = append(m.Views, ViewRecord{
		Action:     action,
		TargetType: targetType,
		Operator:   operator,
		After:      after,
	})
	return nil
}
