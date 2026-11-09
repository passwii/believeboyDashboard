package store

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/ad_analysis"
)

func TestAdAnalysisStoreVerifyProjectAccess(t *testing.T) {
	ctx := context.Background()
	op := "alice"
	as := "bob"

	t.Run("admin allows any active project", func(t *testing.T) {
		db := &fakeDB{row: fakeRow{values: []any{&op, &as}}}
		s := NewAdAnalysisStore(&fakeWriteDB{fakeDB: db})
		err := s.VerifyProjectAccess(ctx, 1, "charlie", true)
		if err != nil {
			t.Fatalf("expected nil for admin, got %v", err)
		}
	})

	t.Run("operator match allows access", func(t *testing.T) {
		db := &fakeDB{row: fakeRow{values: []any{&op, &as}}}
		s := NewAdAnalysisStore(&fakeWriteDB{fakeDB: db})
		err := s.VerifyProjectAccess(ctx, 1, "alice", false)
		if err != nil {
			t.Fatalf("expected nil for matched operator, got %v", err)
		}
	})

	t.Run("operator mismatch returns forbidden", func(t *testing.T) {
		db := &fakeDB{row: fakeRow{values: []any{&op, &as}}}
		s := NewAdAnalysisStore(&fakeWriteDB{fakeDB: db})
		err := s.VerifyProjectAccess(ctx, 1, "charlie", false)
		if err != ad_analysis.ErrProjectForbidden {
			t.Fatalf("expected ErrProjectForbidden, got %v", err)
		}
	})

	t.Run("project not found returns ErrProjectNotFound", func(t *testing.T) {
		db := &fakeDB{row: fakeRow{err: pgx.ErrNoRows}}
		s := NewAdAnalysisStore(&fakeWriteDB{fakeDB: db})
		err := s.VerifyProjectAccess(ctx, 999, "alice", true)
		if err != ad_analysis.ErrProjectNotFound {
			t.Fatalf("expected ErrProjectNotFound, got %v", err)
		}
	})
}

func TestAdAnalysisCalculations(t *testing.T) {
	if g := gradeCampaign(2, 0.20, 10, 50); g != "A" {
		t.Errorf("gradeCampaign want A, got %s", g)
	}
	if g := gradeProduct(2, 0.20, 0.01, 10); g != "主推" {
		t.Errorf("gradeProduct want 主推, got %s", g)
	}
	if a := classifyBudgetAction(0.90, 2, 0.25, 20); a != "优先加预算" {
		t.Errorf("classifyBudgetAction want 优先加预算, got %s", a)
	}
	if r := classifyTrafficRisk(0.30, 0.50); r != "高风险" {
		t.Errorf("classifyTrafficRisk want 高风险, got %s", r)
	}
	if p := classifyPlacementAction(2, 0.10, 0.20, 20, 0.01); p != "可提高系数" {
		t.Errorf("classifyPlacementAction want 可提高系数, got %s", p)
	}

	dFrom := "2026-10-10"
	dTo := "2026-10-15"
	pFrom, pTo := buildPreviousPeriod(&dFrom, &dTo)
	if pFrom == nil || pTo == nil || *pFrom != "2026-10-04" || *pTo != "2026-10-09" {
		t.Errorf("buildPreviousPeriod got %v, %v", pFrom, pTo)
	}
}

func TestAdAnalysisStoreEmptyQueries(t *testing.T) {
	ctx := context.Background()
	db := &fakeDB{}
	s := NewAdAnalysisStore(&fakeWriteDB{fakeDB: db})

	filter := ad_analysis.BaseFilter{ProjectID: 1, Country: "US"}
	overview, err := s.BuildOverview(ctx, filter)
	if err != nil {
		t.Fatalf("BuildOverview error: %v", err)
	}
	if overview.ProjectID != 1 || overview.Country != "US" {
		t.Fatalf("unexpected overview response: %#v", overview)
	}

	trend, err := s.BuildTimeTrend(ctx, filter)
	if err != nil {
		t.Fatalf("BuildTimeTrend error: %v", err)
	}
	if trend.ProjectID != 1 {
		t.Fatalf("unexpected time trend response: %#v", trend)
	}
}
