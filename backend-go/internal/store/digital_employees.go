package store

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/digital_employees"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/digital_office"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type DigitalEmployeeStore struct {
	db FullDB
}

var (
	_ digital_employees.Store = (*DigitalEmployeeStore)(nil)
	_ digital_office.Store    = (*DigitalEmployeeStore)(nil)
)

func NewDigitalEmployeeStore(db FullDB) *DigitalEmployeeStore {
	return &DigitalEmployeeStore{db: db}
}

type digitalRowScanner interface {
	Scan(dest ...any) error
}

const digitalEmployeeSelectColumns = `
	id, name, avatar_url, employee_type, status, description, last_heartbeat_at,
	is_silent_alert_threshold_minutes, created_at, updated_at`

const digitalEmployeeTaskSelectColumns = `
	id, task_id, task_name, task_type, status, progress_percent, current_step,
	started_at, ended_at, error_message, metadata_json, created_at`

const digitalEmployeeLogSelectColumns = `
	id, task_id, level, message, created_at`

func scanDigitalEmployee(row digitalRowScanner) (*digital_employees.DigitalEmployee, error) {
	var item digital_employees.DigitalEmployee
	var avatarURL, description pgtype.Text
	var lastHeartbeatAt *time.Time
	var createdAt, updatedAt time.Time
	err := row.Scan(
		&item.ID,
		&item.Name,
		&avatarURL,
		&item.EmployeeType,
		&item.Status,
		&description,
		&lastHeartbeatAt,
		&item.IsSilentAlertThresholdMinutes,
		&createdAt,
		&updatedAt,
	)
	if err != nil {
		return nil, err
	}
	item.AvatarURL = Text(avatarURL)
	item.Description = Text(description)
	item.LastHeartbeatAt = httpapi.OptionalTimestamp(lastHeartbeatAt)
	item.CreatedAt = httpapi.Timestamp(createdAt)
	item.UpdatedAt = httpapi.Timestamp(updatedAt)
	return &item, nil
}

func scanDigitalEmployeeTask(row digitalRowScanner) (*digital_employees.DigitalEmployeeTask, error) {
	var item digital_employees.DigitalEmployeeTask
	var currentStep, errorMessage, metadataJSON pgtype.Text
	var startedAt, endedAt *time.Time
	var createdAt time.Time
	err := row.Scan(
		&item.ID,
		&item.TaskID,
		&item.TaskName,
		&item.TaskType,
		&item.Status,
		&item.ProgressPercent,
		&currentStep,
		&startedAt,
		&endedAt,
		&errorMessage,
		&metadataJSON,
		&createdAt,
	)
	if err != nil {
		return nil, err
	}
	item.CurrentStep = Text(currentStep)
	item.StartedAt = httpapi.OptionalTimestamp(startedAt)
	item.EndedAt = httpapi.OptionalTimestamp(endedAt)
	item.ErrorMessage = Text(errorMessage)
	item.MetadataJSON = decodeTaskMetadata(metadataJSON)
	item.CreatedAt = httpapi.Timestamp(createdAt)
	return &item, nil
}

func scanDigitalEmployeeLog(row digitalRowScanner) (*digital_employees.DigitalEmployeeLog, error) {
	var item digital_employees.DigitalEmployeeLog
	var taskID *int64
	var createdAt time.Time
	err := row.Scan(
		&item.ID,
		&taskID,
		&item.Level,
		&item.Message,
		&createdAt,
	)
	if err != nil {
		return nil, err
	}
	item.TaskID = taskID
	item.CreatedAt = httpapi.Timestamp(createdAt)
	return &item, nil
}

func decodeTaskMetadata(value pgtype.Text) map[string]any {
	if !value.Valid || strings.TrimSpace(value.String) == "" {
		return nil
	}
	var metadata map[string]any
	if err := json.Unmarshal([]byte(value.String), &metadata); err != nil {
		return nil
	}
	return metadata
}

func encodeTaskMetadata(value map[string]any) string {
	if value == nil {
		return "{}"
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "{}"
	}
	return string(encoded)
}

func (s *DigitalEmployeeStore) ListEmployees(
	ctx context.Context,
	status, employeeType *string,
) ([]digital_employees.DigitalEmployee, error) {
	args := make([]any, 0, 2)
	where := ` where is_deleted = 0`
	if status != nil && *status != "" {
		args = append(args, *status)
		where += fmt.Sprintf(` and status = $%d`, len(args))
	}
	if employeeType != nil && *employeeType != "" {
		args = append(args, *employeeType)
		where += fmt.Sprintf(` and employee_type = $%d`, len(args))
	}
	rows, err := s.db.Query(
		ctx,
		`select `+digitalEmployeeSelectColumns+`
		 from public.digital_employees`+where+`
		 order by created_at desc`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]digital_employees.DigitalEmployee, 0)
	for rows.Next() {
		item, err := scanDigitalEmployee(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

func (s *DigitalEmployeeStore) GetEmployee(
	ctx context.Context,
	employeeID int64,
) (*digital_employees.DigitalEmployee, error) {
	item, err := scanDigitalEmployee(s.db.QueryRow(
		ctx,
		`select `+digitalEmployeeSelectColumns+`
		 from public.digital_employees
		 where id = $1 and is_deleted = 0
		 limit 1`,
		employeeID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, digital_employees.ErrEmployeeNotFound
	}
	if err != nil {
		return nil, err
	}
	return item, nil
}

func (s *DigitalEmployeeStore) CreateEmployee(
	ctx context.Context,
	input digital_employees.DigitalEmployeeCreate,
	apiSecret string,
) (*digital_employees.DigitalEmployee, error) {
	item, err := scanDigitalEmployee(s.db.QueryRow(
		ctx,
		`insert into public.digital_employees (
		   name, avatar_url, employee_type, status, description, api_secret
		 )
		 values ($1, $2, $3, 'idle', $4, $5)
		 returning `+digitalEmployeeSelectColumns,
		input.Name,
		input.AvatarURL,
		input.EmployeeType,
		input.Description,
		apiSecret,
	))
	if err != nil {
		return nil, err
	}
	return item, nil
}

func (s *DigitalEmployeeStore) UpdateEmployeeStatus(
	ctx context.Context,
	employeeID int64,
	status string,
) (*digital_employees.DigitalEmployee, error) {
	employee, err := s.GetEmployee(ctx, employeeID)
	if err != nil {
		return nil, err
	}
	if status != digital_employees.EmployeeStatusSuspended &&
		status != digital_employees.EmployeeStatusIdle {
		return nil, digital_employees.ErrInvalidStatus
	}
	item, err := scanDigitalEmployee(s.db.QueryRow(
		ctx,
		`update public.digital_employees
		 set status = $1, updated_at = now()
		 where id = $2 and is_deleted = 0
		 returning `+digitalEmployeeSelectColumns,
		status,
		employeeID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, digital_employees.ErrEmployeeNotFound
	}
	if err != nil {
		return nil, err
	}
	if employee == nil {
		return nil, digital_employees.ErrEmployeeNotFound
	}
	return item, nil
}

func (s *DigitalEmployeeStore) DeleteEmployee(ctx context.Context, employeeID int64) error {
	tag, err := s.db.Exec(
		ctx,
		`update public.digital_employees
		 set is_deleted = 1, updated_at = now()
		 where id = $1 and is_deleted = 0`,
		employeeID,
	)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return digital_employees.ErrEmployeeNotFound
	}
	return nil
}

func (s *DigitalEmployeeStore) ListTasks(
	ctx context.Context,
	employeeID int64,
	page, pageSize int,
) ([]digital_employees.DigitalEmployeeTask, int, error) {
	if _, err := s.GetEmployee(ctx, employeeID); err != nil {
		return nil, 0, err
	}
	var total int64
	if err := s.db.QueryRow(
		ctx,
		`select count(*) from public.digital_employee_tasks where employee_id = $1`,
		employeeID,
	).Scan(&total); err != nil {
		return nil, 0, err
	}
	offset := httpapi.SafeOffset(page, pageSize)
	rows, err := s.db.Query(
		ctx,
		`select `+digitalEmployeeTaskSelectColumns+`
		 from public.digital_employee_tasks
		 where employee_id = $1
		 order by started_at desc
		 offset $2 limit $3`,
		employeeID,
		offset,
		pageSize,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := make([]digital_employees.DigitalEmployeeTask, 0)
	for rows.Next() {
		item, err := scanDigitalEmployeeTask(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return items, int(total), nil
}

func (s *DigitalEmployeeStore) GetTask(
	ctx context.Context,
	employeeID, taskID int64,
) (*digital_employees.DigitalEmployeeTask, error) {
	item, err := scanDigitalEmployeeTask(s.db.QueryRow(
		ctx,
		`select `+digitalEmployeeTaskSelectColumns+`
		 from public.digital_employee_tasks
		 where id = $1 and employee_id = $2
		 limit 1`,
		taskID,
		employeeID,
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, digital_employees.ErrTaskNotFound
	}
	if err != nil {
		return nil, err
	}
	return item, nil
}

func (s *DigitalEmployeeStore) ListLogs(
	ctx context.Context,
	employeeID, taskID int64,
	cursor *int64,
	limit int,
) ([]digital_employees.DigitalEmployeeLog, bool, *int64, error) {
	if _, err := s.GetTask(ctx, employeeID, taskID); err != nil {
		return nil, false, nil, err
	}
	args := []any{taskID}
	where := ` where task_id = $1`
	if cursor != nil {
		args = append(args, *cursor)
		where += fmt.Sprintf(` and id > $%d`, len(args))
	}
	args = append(args, limit+1)
	rows, err := s.db.Query(
		ctx,
		`select `+digitalEmployeeLogSelectColumns+`
		 from public.digital_employee_logs`+where+`
		 order by id asc
		 limit $`+fmt.Sprintf("%d", len(args)),
		args...,
	)
	if err != nil {
		return nil, false, nil, err
	}
	defer rows.Close()

	items := make([]digital_employees.DigitalEmployeeLog, 0, limit+1)
	for rows.Next() {
		item, err := scanDigitalEmployeeLog(rows)
		if err != nil {
			return nil, false, nil, err
		}
		items = append(items, *item)
	}
	if err := rows.Err(); err != nil {
		return nil, false, nil, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	var nextCursor *int64
	if len(items) > 0 {
		value := items[len(items)-1].ID
		nextCursor = &value
	}
	return items, hasMore, nextCursor, nil
}

func (s *DigitalEmployeeStore) ListEmployeeLogs(
	ctx context.Context,
	employeeID int64,
	limit int,
) ([]digital_employees.DigitalEmployeeLog, error) {
	rows, err := s.db.Query(
		ctx,
		`select `+digitalEmployeeLogSelectColumns+`
		 from public.digital_employee_logs
		 where employee_id = $1
		 order by created_at desc
		 limit $2`,
		employeeID,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]digital_employees.DigitalEmployeeLog, 0)
	for rows.Next() {
		item, err := scanDigitalEmployeeLog(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *item)
	}
	return items, rows.Err()
}

func (s *DigitalEmployeeStore) RegisterEmployee(
	ctx context.Context,
	input digital_employees.RegisterInput,
	candidateSecret string,
) (int64, string, error) {
	var employeeID int64
	var apiSecret string
	err := s.db.QueryRow(
		ctx,
		`select id, api_secret
		 from public.digital_employees
		 where name = $1 and is_deleted = 0
		 limit 1`,
		input.Name,
	).Scan(&employeeID, &apiSecret)
	if err == nil {
		return employeeID, apiSecret, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return 0, "", err
	}
	err = s.db.QueryRow(
		ctx,
		`insert into public.digital_employees (
		   name, employee_type, description, api_secret, status,
		   is_silent_alert_threshold_minutes
		 )
		 values ($1, $2, $3, $4, 'idle', $5)
		 returning id, api_secret`,
		input.Name,
		input.EmployeeType,
		input.Description,
		candidateSecret,
		input.IsSilentAlertThresholdMinutes,
	).Scan(&employeeID, &apiSecret)
	if err != nil {
		return 0, "", err
	}
	return employeeID, apiSecret, nil
}

func (s *DigitalEmployeeStore) Heartbeat(
	ctx context.Context,
	input digital_employees.HeartbeatInput,
	now time.Time,
) (time.Time, error) {
	now = now.UTC()
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		db := NewTxDB(tx)
		var storedSecret, currentStatus string
		err := db.QueryRow(
			ctx,
			`select api_secret, status
			 from public.digital_employees
			 where id = $1 and is_deleted = 0
			 limit 1`,
			input.EmployeeID,
		).Scan(&storedSecret, &currentStatus)
		if errors.Is(err, pgx.ErrNoRows) {
			return digital_employees.ErrEmployeeNotFound
		}
		if err != nil {
			return err
		}
		if input.APISecret != nil && *input.APISecret != "" &&
			constantTimeStringEqual(*input.APISecret, storedSecret) == false {
			return digital_employees.ErrInvalidAPISecret
		}

		var task *digital_employees.DigitalEmployeeTask
		if input.TaskID != nil && *input.TaskID != "" {
			task, err = scanDigitalEmployeeTask(db.QueryRow(
				ctx,
				`select `+digitalEmployeeTaskSelectColumns+`
				 from public.digital_employee_tasks
				 where task_id = $1
				 limit 1`,
				*input.TaskID,
			))
			if errors.Is(err, pgx.ErrNoRows) {
				task = nil
				err = nil
			}
			if err != nil {
				return err
			}
		}

		var databaseTaskID *int64
		employeeStatus := currentStatus
		if task != nil {
			finalStatus := task.Status
			updates := []string{"updated_at = $1"}
			args := []any{now}
			if input.Status != nil && *input.Status != "" {
				finalStatus = *input.Status
				args = append(args, finalStatus)
				updates = append(updates, fmt.Sprintf("status = $%d", len(args)))
			}
			if input.ProgressPercent != nil {
				args = append(args, *input.ProgressPercent)
				updates = append(updates, fmt.Sprintf("progress_percent = $%d", len(args)))
			}
			if input.CurrentStep != nil {
				args = append(args, *input.CurrentStep)
				updates = append(updates, fmt.Sprintf("current_step = $%d", len(args)))
			}
			if input.MetadataJSON != nil {
				args = append(args, encodeTaskMetadata(input.MetadataJSON))
				updates = append(updates, fmt.Sprintf("metadata_json = $%d", len(args)))
			}
			if input.Status != nil && isTerminalTaskStatus(finalStatus) {
				args = append(args, now)
				updates = append(updates, fmt.Sprintf("ended_at = $%d", len(args)))
			}
			args = append(args, task.ID)
			_, err = db.Exec(
				ctx,
				`update public.digital_employee_tasks
				 set `+strings.Join(updates, ", ")+`
				 where id = $`+fmt.Sprintf("%d", len(args)),
				args...,
			)
			if err != nil {
				return err
			}
			value := task.ID
			databaseTaskID = &value
			if mapped := employeeStatusForTask(finalStatus); mapped != "" {
				employeeStatus = mapped
			}
		} else if input.TaskID != nil && *input.TaskID != "" &&
			input.Status != nil && *input.Status == digital_employees.TaskStatusRunning {
			taskName := *input.TaskID
			if input.TaskName != nil && *input.TaskName != "" {
				taskName = *input.TaskName
			} else if input.Message != nil && *input.Message != "" {
				taskName = *input.Message
			}
			taskType := "unknown"
			if input.TaskType != nil && *input.TaskType != "" {
				taskType = *input.TaskType
			}
			progress := 0
			if input.ProgressPercent != nil {
				progress = *input.ProgressPercent
			}
			var createdTaskID int64
			err = db.QueryRow(
				ctx,
				`insert into public.digital_employee_tasks (
				   employee_id, task_id, task_name, task_type, status,
				   progress_percent, current_step, started_at, metadata_json
				 )
				 values ($1, $2, $3, $4, 'running', $5, $6, $7, $8)
				 returning id`,
				input.EmployeeID,
				*input.TaskID,
				taskName,
				taskType,
				progress,
				input.CurrentStep,
				now,
				encodeTaskMetadata(input.MetadataJSON),
			).Scan(&createdTaskID)
			if err != nil {
				return err
			}
			databaseTaskID = &createdTaskID
			employeeStatus = digital_employees.EmployeeStatusRunning
		}

		updatedStatus := any(nil)
		if employeeStatus != "" {
			updatedStatus = employeeStatus
		}
		_, err = db.Exec(
			ctx,
			`update public.digital_employees
			 set last_heartbeat_at = $1,
			     updated_at = $1,
			     status = coalesce($2, status)
			 where id = $3`,
			now,
			updatedStatus,
			input.EmployeeID,
		)
		if err != nil {
			return err
		}

		if input.Message != nil && *input.Message != "" {
			_, err = db.Exec(
				ctx,
				`insert into public.digital_employee_logs (
				   employee_id, task_id, level, message
				 )
				 values ($1, $2, 'info', $3)`,
				input.EmployeeID,
				databaseTaskID,
				*input.Message,
			)
			if err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return time.Time{}, err
	}
	return now, nil
}

func constantTimeStringEqual(left, right string) bool {
	return subtle.ConstantTimeCompare([]byte(left), []byte(right)) == 1
}

func isTerminalTaskStatus(status string) bool {
	switch status {
	case digital_employees.TaskStatusSucceeded,
		digital_employees.TaskStatusFailed,
		digital_employees.TaskStatusCancelled:
		return true
	default:
		return false
	}
}

func employeeStatusForTask(status string) string {
	switch status {
	case digital_employees.TaskStatusRunning:
		return digital_employees.EmployeeStatusRunning
	case digital_employees.TaskStatusSucceeded:
		return digital_employees.EmployeeStatusSucceeded
	case digital_employees.TaskStatusFailed:
		return digital_employees.EmployeeStatusFailed
	default:
		return ""
	}
}

type officeEmployeeRow struct {
	ID              int64
	Name            string
	EmployeeType    string
	LastHeartbeatAt *time.Time
}

func (s *DigitalEmployeeStore) BuildWallSnapshot(
	ctx context.Context,
	now time.Time,
) ([]digital_office.EmployeeSnapshot, []digital_office.ChatterEvent, error) {
	now = now.UTC()
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanupCtx)
	}()

	db := NewTxDB(tx)
	rows, err := db.Query(
		ctx,
		`select id, name, employee_type, last_heartbeat_at
		 from public.digital_employees
		 where is_deleted = 0`,
	)
	if err != nil {
		return nil, nil, err
	}
	employees := make([]officeEmployeeRow, 0)
	for rows.Next() {
		var employee officeEmployeeRow
		if err := rows.Scan(
			&employee.ID,
			&employee.Name,
			&employee.EmployeeType,
			&employee.LastHeartbeatAt,
		); err != nil {
			rows.Close()
			return nil, nil, err
		}
		employees = append(employees, employee)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, nil, err
	}
	rows.Close()

	results := make([]digital_office.EmployeeSnapshot, 0, len(employees))
	chatter := make([]digital_office.ChatterEvent, 0)
	for _, employee := range employees {
		employeeTx, err := tx.Begin(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil, nil, ctx.Err()
			}
			slog.Error("digital office savepoint failed", "employee_id", employee.ID, "error", err)
			continue
		}
		employeeDB := NewTxDB(employeeTx)
		snapshot, events, advanceErr := s.advanceOfficeEmployee(ctx, employeeDB, employee, now)
		if advanceErr != nil {
			_ = employeeTx.Rollback(ctx)
			slog.Error("digital office employee advance failed", "employee_id", employee.ID, "error", advanceErr)
			continue
		}
		if err := employeeTx.Commit(ctx); err != nil {
			_ = employeeTx.Rollback(ctx)
			slog.Error("digital office employee commit failed", "employee_id", employee.ID, "error", err)
			continue
		}
		results = append(results, snapshot)
		chatter = append(chatter, events...)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return results, chatter, nil
}

func (s *DigitalEmployeeStore) advanceOfficeEmployee(
	ctx context.Context,
	db FullDB,
	employee officeEmployeeRow,
	now time.Time,
) (digital_office.EmployeeSnapshot, []digital_office.ChatterEvent, error) {
	state, err := loadDigitalPlaybackState(ctx, db, employee.ID)
	if err != nil {
		return digital_office.EmployeeSnapshot{}, nil, err
	}
	rows, err := db.Query(
		ctx,
		`select task_id, task_name, task_type, status, progress_percent,
		        current_step, started_at, ended_at, metadata_json, created_at
		 from public.digital_employee_tasks
		 where employee_id = $1
		 order by started_at asc
		 offset $2 limit $3`,
		employee.ID,
		state.VirtualIndex,
		digital_office.MaxPendingTasks,
	)
	if err != nil {
		return digital_office.EmployeeSnapshot{}, nil, err
	}
	tasks := make([]digital_office.RealTask, 0)
	for rows.Next() {
		var task digital_office.RealTask
		var currentStep, metadataJSON pgtype.Text
		var startedAt, endedAt *time.Time
		var createdAt time.Time
		if err := rows.Scan(
			&task.TaskID,
			&task.TaskName,
			&task.TaskType,
			&task.Status,
			&task.ProgressPercent,
			&currentStep,
			&startedAt,
			&endedAt,
			&metadataJSON,
			&createdAt,
		); err != nil {
			rows.Close()
			return digital_office.EmployeeSnapshot{}, nil, err
		}
		task.CurrentStep = Text(currentStep)
		task.EndedAt = endedAt
		task.StartedAt = createdAt
		if startedAt != nil {
			task.StartedAt = *startedAt
		}
		parsedMetadata := decodeTaskMetadata(metadataJSON)
		if parsedMetadata != nil {
			task.Metadata = parsedMetadata
		}
		tasks = append(tasks, task)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return digital_office.EmployeeSnapshot{}, nil, err
	}
	rows.Close()

	engineState := state
	engineState.VirtualIndex = 0
	newEngineState, virtualSnapshot := digital_office.Advance(
		engineState,
		tasks,
		now,
		digital_office.DefaultConfig,
		employee.LastHeartbeatAt,
	)
	absoluteState := newEngineState
	absoluteState.VirtualIndex = state.VirtualIndex + newEngineState.VirtualIndex
	if err := persistDigitalPlaybackState(ctx, db, absoluteState); err != nil {
		return digital_office.EmployeeSnapshot{}, nil, err
	}
	todayDone, successRate, err := digitalOfficeTodayStats(ctx, db, employee.ID, now)
	if err != nil {
		return digital_office.EmployeeSnapshot{}, nil, err
	}
	events := digital_office.DetectChatter(
		state,
		newEngineState,
		virtualSnapshot,
		employee.ID,
		employee.Name,
		employee.EmployeeType,
		now,
	)
	return digital_office.EnrichEmployeeSnapshot(
		employee.ID,
		employee.Name,
		employee.EmployeeType,
		virtualSnapshot,
		todayDone,
		successRate,
		employee.LastHeartbeatAt,
	), events, nil
}

func loadDigitalPlaybackState(
	ctx context.Context,
	db FullDB,
	employeeID int64,
) (digital_office.PlaybackState, error) {
	state := digital_office.PlaybackState{
		EmployeeID: employeeID,
		Pace:       1,
		BusyLevel:  "IDLE",
	}
	var currentTaskID *string
	var displayStartedAt, pauseUntil, lastAdvancedAt *time.Time
	err := db.QueryRow(
		ctx,
		`select virtual_index, current_task_id, virtual_progress, display_started_at,
		        display_duration_s, pause_until, pace, busy_level, last_advanced_at
		 from public.digital_employee_playback
		 where employee_id = $1`,
		employeeID,
	).Scan(
		&state.VirtualIndex,
		&currentTaskID,
		&state.VirtualProgress,
		&displayStartedAt,
		&state.DisplayDurationS,
		&pauseUntil,
		&state.Pace,
		&state.BusyLevel,
		&lastAdvancedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		_, insertErr := db.Exec(
			ctx,
			`insert into public.digital_employee_playback (employee_id)
			 values ($1)
			 on conflict (employee_id) do nothing`,
			employeeID,
		)
		return state, insertErr
	}
	if err != nil {
		return digital_office.PlaybackState{}, err
	}
	state.CurrentTaskID = currentTaskID
	state.DisplayStartedAt = displayStartedAt
	state.PauseUntil = pauseUntil
	state.LastAdvancedAt = lastAdvancedAt
	return state, nil
}

func persistDigitalPlaybackState(
	ctx context.Context,
	db FullDB,
	state digital_office.PlaybackState,
) error {
	_, err := db.Exec(
		ctx,
		`insert into public.digital_employee_playback (
		   employee_id, virtual_index, current_task_id, virtual_progress,
		   display_started_at, display_duration_s, pause_until, pace,
		   busy_level, last_advanced_at, updated_at
		 )
		 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
		 on conflict (employee_id) do update
		 set virtual_index = excluded.virtual_index,
		     current_task_id = excluded.current_task_id,
		     virtual_progress = excluded.virtual_progress,
		     display_started_at = excluded.display_started_at,
		     display_duration_s = excluded.display_duration_s,
		     pause_until = excluded.pause_until,
		     pace = excluded.pace,
		     busy_level = excluded.busy_level,
		     last_advanced_at = excluded.last_advanced_at,
		     updated_at = now()`,
		state.EmployeeID,
		state.VirtualIndex,
		state.CurrentTaskID,
		state.VirtualProgress,
		state.DisplayStartedAt,
		state.DisplayDurationS,
		state.PauseUntil,
		state.Pace,
		state.BusyLevel,
		state.LastAdvancedAt,
	)
	return err
}

func digitalOfficeTodayStats(
	ctx context.Context,
	db FullDB,
	employeeID int64,
	now time.Time,
) (int, float64, error) {
	todayStart := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	rows, err := db.Query(
		ctx,
		`select status
		 from public.digital_employee_tasks
		 where employee_id = $1 and started_at >= $2`,
		employeeID,
		todayStart,
	)
	if err != nil {
		return 0, 0, err
	}
	defer rows.Close()

	total := 0
	succeeded := 0
	for rows.Next() {
		var status string
		if err := rows.Scan(&status); err != nil {
			return 0, 0, err
		}
		total++
		if status == digital_employees.TaskStatusSucceeded {
			succeeded++
		}
	}
	if err := rows.Err(); err != nil {
		return 0, 0, err
	}
	if total == 0 {
		return 0, 1.0, nil
	}
	return succeeded, math.Round(float64(succeeded)/float64(total)*100) / 100, nil
}
