package digital_office

import (
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
)

func Clamp(value, low, high float64) float64 {
	return math.Max(low, math.Min(high, value))
}

func StretchDurationS(realDurationS, pace float64, cfg PlaybackConfig) float64 {
	base := Clamp(realDurationS*cfg.StretchFactor, cfg.MinDisplayS, cfg.MaxDisplayS)
	return base / math.Max(pace, 1)
}

func ComputePace(queued int, cfg PlaybackConfig) float64 {
	if queued <= cfg.CalmQueue {
		return 1
	}
	return Clamp(
		1+float64(queued-cfg.CalmQueue)*cfg.PacePerExtra,
		1,
		cfg.MaxPace,
	)
}

func ClassifyBusy(totalPending int, pace float64) string {
	if totalPending == 0 {
		return "IDLE"
	}
	if pace < 1.5 {
		return "NORMAL"
	}
	if pace < 3 {
		return "BUSY"
	}
	return "SWAMPED"
}

func realDurationS(task RealTask, now time.Time) float64 {
	end := now
	if task.EndedAt != nil {
		end = *task.EndedAt
	}
	return math.Max(end.Sub(task.StartedAt).Seconds(), 1)
}

func pauseSeconds(employeeID int64, virtualIndex int, pace float64, cfg PlaybackConfig) float64 {
	sum := md5.Sum([]byte(strconv.FormatInt(employeeID, 10) + ":" + strconv.Itoa(virtualIndex)))
	seed := hex.EncodeToString(sum[:])
	fractionValue, _ := strconv.ParseUint(seed[:8], 16, 32)
	fraction := float64(fractionValue) / float64(0xFFFFFFFF)
	base := cfg.PauseMinS + (cfg.PauseMaxS-cfg.PauseMinS)*fraction
	return base / math.Max(pace, 1)
}

func stepLabel(task RealTask) string {
	project := metadataString(task.Metadata, "project_name")
	report := metadataString(task.Metadata, "report_label")
	if report == "" {
		report = task.TaskName
	}
	prefix := ""
	if strings.EqualFold(task.Status, "failed") {
		prefix = "⚠️ "
	}
	if task.CurrentStep != nil {
		return prefix + *task.CurrentStep
	}
	if project != "" {
		return prefix + "正在处理【" + project + "】的 " + report + "…"
	}
	return prefix + "正在处理 " + report + "…"
}

func metadataString(metadata map[string]any, key string) string {
	if metadata == nil {
		return ""
	}
	value, ok := metadata[key].(string)
	if !ok {
		return ""
	}
	return value
}

func roundOne(value float64) float64 {
	return math.Round(value*10) / 10
}

func Advance(
	state PlaybackState,
	realTasks []RealTask,
	now time.Time,
	cfg PlaybackConfig,
	lastHeartbeatAt *time.Time,
) (PlaybackState, VirtualSnapshot) {
	ordered := append([]RealTask(nil), realTasks...)
	sort.SliceStable(ordered, func(left, right int) bool {
		return ordered[left].StartedAt.Before(ordered[right].StartedAt)
	})
	if state.VirtualIndex < 0 {
		state.VirtualIndex = 0
	}
	if state.VirtualIndex > len(ordered) {
		state.VirtualIndex = len(ordered)
	}
	pending := ordered[state.VirtualIndex:]
	var current *RealTask
	if state.CurrentTaskID != nil {
		for index := range pending {
			if pending[index].TaskID == *state.CurrentTaskID {
				task := pending[index]
				current = &task
				break
			}
		}
	}
	queued := len(pending)
	if current == nil && len(pending) > 0 {
		queued = len(pending) - 1
	} else if current != nil {
		queued = len(pending) - 1
	}
	pace := ComputePace(queued, cfg)
	busy := ClassifyBusy(len(pending), pace)
	snapshot := func(status string, task *RealTask, progress float64, label string) VirtualSnapshot {
		return VirtualSnapshot{
			EmployeeID:      state.EmployeeID,
			DisplayStatus:   status,
			CurrentTask:     task,
			VirtualProgress: roundOne(progress),
			StepLabel:       label,
			Pace:            pace,
			BusyLevel:       busy,
			QueuedCount:     queued,
		}
	}

	newState := state
	newState.Pace = pace
	newState.BusyLevel = busy
	advancedAt := now
	newState.LastAdvancedAt = &advancedAt

	if newState.PauseUntil != nil && now.Before(*newState.PauseUntil) {
		return newState, snapshot("PAUSING", current, newState.VirtualProgress, "🍵 稍作整理…")
	}

	if current == nil {
		if len(pending) > 0 {
			next := pending[0]
			newState.CurrentTaskID = stringPointer(next.TaskID)
			startedAt := now
			newState.DisplayStartedAt = &startedAt
			newState.DisplayDurationS = StretchDurationS(realDurationS(next, now), pace, cfg)
			newState.VirtualProgress = 0
			newState.PauseUntil = nil
			return newState, snapshot("WORKING", &next, 0, stepLabel(next))
		}
		newState.CurrentTaskID = nil
		newState.VirtualProgress = 0
		if lastHeartbeatAt != nil && now.Sub(*lastHeartbeatAt).Seconds() > cfg.OfflineAfterS {
			return newState, snapshot("OFFLINE", nil, 0, "🌙 今日工作告一段落")
		}
		return newState, snapshot("IDLE", nil, 0, "🍵 静候下一批任务…")
	}

	displayStartedAt := now
	if newState.DisplayStartedAt != nil {
		displayStartedAt = *newState.DisplayStartedAt
	}
	elapsed := now.Sub(displayStartedAt).Seconds()
	progress := Clamp(elapsed/math.Max(newState.DisplayDurationS, 1)*100, 0, 100)
	newState.VirtualProgress = progress
	if progress >= 100 {
		newState.VirtualIndex = state.VirtualIndex + 1
		newState.CurrentTaskID = nil
		pauseUntil := now.Add(time.Duration(pauseSeconds(
			state.EmployeeID,
			newState.VirtualIndex,
			pace,
			cfg,
		) * float64(time.Second)))
		newState.PauseUntil = &pauseUntil
		label := "✅ 处理完成，整理中…"
		if strings.EqualFold(current.Status, "failed") {
			label = "⚠️ 处理失败，正在排查…"
		}
		return newState, snapshot("PAUSING", current, 100, label)
	}
	return newState, snapshot("WORKING", current, progress, stepLabel(*current))
}

func PersonaFor(employeeType string) Persona {
	switch employeeType {
	case "auto_report_upload":
		return Persona{Emoji: "📤", ColorKey: "blue", Tagline: "报表快递员"}
	case "scheduled_job":
		return Persona{Emoji: "⏰", ColorKey: "orange", Tagline: "定时指挥官"}
	case "rpa_bot":
		return Persona{Emoji: "🤖", ColorKey: "violet", Tagline: "流程机器人"}
	case "ai_agent":
		return Persona{Emoji: "💬", ColorKey: "emerald", Tagline: "洞察分析师"}
	case "monitoring":
		return Persona{Emoji: "📊", ColorKey: "pink", Tagline: "数据观察员"}
	case "database":
		return Persona{Emoji: "🗄️", ColorKey: "slate", Tagline: "数据库守护者"}
	default:
		return Persona{Emoji: "⚙️", ColorKey: "gray", Tagline: "自定义任务"}
	}
}

func DetectChatter(
	oldState PlaybackState,
	newEngine PlaybackState,
	snapshot VirtualSnapshot,
	employeeID int64,
	employeeName, employeeType string,
	now time.Time,
) []ChatterEvent {
	persona := PersonaFor(employeeType)
	events := make([]ChatterEvent, 0)
	emit := func(eventType, text string) {
		events = append(events, ChatterEvent{
			EmployeeID: employeeID,
			Name:       employeeName,
			Emoji:      persona.Emoji,
			EventType:  eventType,
			Text:       text,
			Timestamp:  PythonISO(now),
		})
	}
	workLabel := "任务"
	if snapshot.CurrentTask != nil {
		project := metadataString(snapshot.CurrentTask.Metadata, "project_name")
		report := metadataString(snapshot.CurrentTask.Metadata, "report_label")
		switch {
		case project != "":
			workLabel = "【" + project + "】" + report
		case report != "":
			workLabel = report
		default:
			workLabel = snapshot.CurrentTask.TaskName
		}
	}

	if newEngine.VirtualIndex > 0 && snapshot.CurrentTask != nil {
		if strings.EqualFold(snapshot.CurrentTask.Status, "failed") {
			emit("task_failed", "😵 "+workLabel+" 卡住了，需要人帮忙")
		} else {
			emit("task_completed", "✅ 完成了 "+workLabel)
		}
	} else if oldState.CurrentTaskID == nil && newEngine.CurrentTaskID != nil {
		emit("task_started", "📋 开始处理 "+workLabel)
	} else if oldState.PauseUntil == nil && newEngine.PauseUntil != nil && newEngine.VirtualIndex == 0 {
		emit("pause_started", "🍵 稍作整理，喝口水…")
	}

	if snapshot.DisplayStatus == "OFFLINE" && oldState.LastAdvancedAt != nil {
		emit("went_offline", "🌙 今日工作告一段落")
	}
	return events
}

func EnrichEmployeeSnapshot(
	employeeID int64,
	name, employeeType string,
	snapshot VirtualSnapshot,
	todayDone int,
	successRate float64,
	lastHeartbeatAt *time.Time,
) EmployeeSnapshot {
	persona := PersonaFor(employeeType)
	var currentTask *CurrentTask
	var projectName, reportLabel *string
	if snapshot.CurrentTask != nil {
		currentTask = &CurrentTask{
			TaskID:   snapshot.CurrentTask.TaskID,
			TaskName: snapshot.CurrentTask.TaskName,
			Status:   snapshot.CurrentTask.Status,
		}
		if project := metadataString(snapshot.CurrentTask.Metadata, "project_name"); project != "" {
			projectName = stringPointer(project)
		}
		if report := metadataString(snapshot.CurrentTask.Metadata, "report_label"); report != "" {
			reportLabel = stringPointer(report)
		}
	}
	var heartbeat *string
	if lastHeartbeatAt != nil {
		formatted := PythonISO(*lastHeartbeatAt)
		heartbeat = &formatted
	}
	return EmployeeSnapshot{
		EmployeeID:      employeeID,
		Name:            name,
		Persona:         persona,
		DisplayStatus:   snapshot.DisplayStatus,
		BusyLevel:       snapshot.BusyLevel,
		QueuedCount:     snapshot.QueuedCount,
		Pace:            snapshot.Pace,
		CurrentTask:     currentTask,
		WorkItem:        WorkItem{ProjectName: projectName, ReportLabel: reportLabel},
		VirtualProgress: snapshot.VirtualProgress,
		StepLabel:       snapshot.StepLabel,
		TodayDone:       todayDone,
		SuccessRate:     successRate,
		LastHeartbeatAt: heartbeat,
	}
}

func PythonISO(value time.Time) string {
	value = value.UTC().Truncate(time.Microsecond)
	formatted := value.Format("2006-01-02T15:04:05")
	if value.Nanosecond() != 0 {
		formatted += fmt.Sprintf(".%06d", value.Nanosecond()/1000)
	}
	return formatted + "+00:00"
}

func stringPointer(value string) *string {
	return &value
}
