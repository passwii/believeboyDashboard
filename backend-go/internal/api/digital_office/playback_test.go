package digital_office

import (
	"strings"
	"testing"
	"time"
)

func TestPlaybackAdvanceAndChatter(t *testing.T) {
	now := time.Date(2026, 11, 8, 8, 0, 0, 0, time.UTC)
	task := RealTask{
		TaskID:          "task-1",
		TaskName:        "Payment Report",
		TaskType:        "payment_report",
		Status:          "running",
		ProgressPercent: 30,
		StartedAt:       now.Add(-2 * time.Minute),
		Metadata: map[string]any{
			"project_name": "润茗",
			"report_label": "Payment Report",
		},
	}
	state := PlaybackState{EmployeeID: 3, Pace: 1, BusyLevel: "IDLE"}
	firstState, firstSnapshot := Advance(state, []RealTask{task}, now, DefaultConfig, nil)
	if firstSnapshot.DisplayStatus != "WORKING" ||
		firstSnapshot.CurrentTask == nil ||
		!strings.Contains(firstSnapshot.StepLabel, "润茗") {
		t.Fatalf("first snapshot = %#v", firstSnapshot)
	}

	secondTime := now.Add(31 * time.Minute)
	secondState, secondSnapshot := Advance(
		firstState,
		[]RealTask{task},
		secondTime,
		DefaultConfig,
		nil,
	)
	if secondSnapshot.DisplayStatus != "PAUSING" ||
		secondState.VirtualIndex != 1 ||
		secondSnapshot.VirtualProgress != 100 {
		t.Fatalf("second state/snapshot = %#v / %#v", secondState, secondSnapshot)
	}
	events := DetectChatter(
		firstState,
		secondState,
		secondSnapshot,
		3,
		"报表快递员",
		"auto_report_upload",
		secondTime,
	)
	if len(events) != 1 ||
		events[0].EventType != "task_completed" ||
		!strings.Contains(events[0].Text, "【润茗】Payment Report") {
		t.Fatalf("chatter = %#v", events)
	}
}

func TestPlaybackOfflineAndPythonISO(t *testing.T) {
	now := time.Date(2026, 11, 8, 10, 11, 12, 123456000, time.UTC)
	lastHeartbeat := now.Add(-31 * time.Minute)
	_, snapshot := Advance(
		PlaybackState{EmployeeID: 1, Pace: 1, BusyLevel: "IDLE"},
		nil,
		now,
		DefaultConfig,
		&lastHeartbeat,
	)
	if snapshot.DisplayStatus != "OFFLINE" {
		t.Fatalf("display status = %q, want OFFLINE", snapshot.DisplayStatus)
	}
	if got := PythonISO(now); got != "2026-11-08T10:11:12.123456+00:00" {
		t.Errorf("PythonISO() = %q", got)
	}
	if persona := PersonaFor("custom"); persona.Emoji != "⚙️" {
		t.Errorf("custom persona = %#v", persona)
	}
}
