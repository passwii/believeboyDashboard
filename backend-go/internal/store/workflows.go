package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/workflows"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type WorkflowStore struct {
	db DB
}

func NewWorkflowStore(db DB) *WorkflowStore {
	return &WorkflowStore{db: db}
}

func (s *WorkflowStore) ListWorkflowTemplates(ctx context.Context) ([]workflows.TemplateOption, error) {
	rows, err := s.db.Query(
		ctx,
		`select key, kind, title
		 from public.workflow_templates
		 order by sort_order asc, id asc`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]workflows.TemplateOption, 0)
	for rows.Next() {
		var item workflows.TemplateOption
		if err := rows.Scan(&item.Key, &item.Kind, &item.Title); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *WorkflowStore) ListProjectWorkflows(
	ctx context.Context,
	projectID int64,
) ([]workflows.Workflow, error) {
	items, err := loadWorkflows(
		ctx,
		s.db,
		"w.project_id = $1",
		projectID,
	)
	if err != nil {
		return nil, err
	}
	if items == nil {
		items = []workflows.Workflow{}
	}
	return items, nil
}

func (s *WorkflowStore) GetWorkflow(
	ctx context.Context,
	workflowID int64,
) (*workflows.Workflow, error) {
	items, err := loadWorkflows(ctx, s.db, "w.id = $1", workflowID)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

func loadWorkflows(
	ctx context.Context,
	db DB,
	where string,
	args ...any,
) ([]workflows.Workflow, error) {
	rows, err := db.Query(
		ctx,
		`select w.id, w.project_id, w.kind, w.title, w.template_key,
		        w.start_date::text
		 from public.project_workflows as w
		 where `+where+`
		 order by w.id asc`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	items := make([]workflows.Workflow, 0)
	indexes := make(map[int64]int)
	workflowIDs := make([]int64, 0)
	for rows.Next() {
		var (
			item      workflows.Workflow
			startDate pgtype.Text
		)
		if err := rows.Scan(
			&item.ID,
			&item.ProjectID,
			&item.Kind,
			&item.Title,
			&item.TemplateKey,
			&startDate,
		); err != nil {
			rows.Close()
			return nil, err
		}
		item.StartDate = Text(startDate)
		item.Tasks = []workflows.Task{}
		indexes[item.ID] = len(items)
		workflowIDs = append(workflowIDs, item.ID)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(workflowIDs) == 0 {
		return items, nil
	}

	taskRows, err := db.Query(
		ctx,
		`select id, workflow_id, title, description, sort_order, status,
		        attachment_key, duration_days, start_date::text, end_date::text
		 from public.project_workflow_tasks
		 where workflow_id = any($1::bigint[])
		 order by workflow_id asc, sort_order asc, id asc`,
		workflowIDs,
	)
	if err != nil {
		return nil, err
	}
	taskIndexes := make(map[int64]struct{ workflowIndex, taskIndex int })
	taskIDs := make([]int64, 0)
	for taskRows.Next() {
		var (
			item          workflows.Task
			description   pgtype.Text
			attachmentKey pgtype.Text
			durationDays  pgtype.Int4
			startDate     pgtype.Text
			endDate       pgtype.Text
		)
		if err := taskRows.Scan(
			&item.ID,
			&item.WorkflowID,
			&item.Title,
			&description,
			&item.SortOrder,
			&item.Status,
			&attachmentKey,
			&durationDays,
			&startDate,
			&endDate,
		); err != nil {
			taskRows.Close()
			return nil, err
		}
		item.Description = Text(description)
		item.AttachmentKey = Text(attachmentKey)
		item.DurationDays = workflowInt4Pointer(durationDays)
		item.StartDate = Text(startDate)
		item.EndDate = Text(endDate)
		item.SpanDays = workflows.SpanDays(item.StartDate, item.EndDate)
		item.Contents = []workflows.Content{}
		item.Attachments = []workflows.Attachment{}
		workflowIndex, ok := indexes[item.WorkflowID]
		if !ok {
			continue
		}
		taskIndex := len(items[workflowIndex].Tasks)
		items[workflowIndex].Tasks = append(items[workflowIndex].Tasks, item)
		taskIndexes[item.ID] = struct{ workflowIndex, taskIndex int }{workflowIndex, taskIndex}
		taskIDs = append(taskIDs, item.ID)
	}
	if err := taskRows.Err(); err != nil {
		taskRows.Close()
		return nil, err
	}
	taskRows.Close()
	if len(taskIDs) == 0 {
		for index := range items {
			workflows.FinalizeWorkflow(&items[index])
		}
		return items, nil
	}

	contentRows, err := db.Query(
		ctx,
		`select id, task_id, title, body, sort_order
		 from public.project_workflow_task_contents
		 where task_id = any($1::bigint[])
		 order by task_id asc, sort_order asc, id asc`,
		taskIDs,
	)
	if err != nil {
		return nil, err
	}
	for contentRows.Next() {
		var (
			item   workflows.Content
			taskID int64
			title  pgtype.Text
		)
		if err := contentRows.Scan(&item.ID, &taskID, &title, &item.Body, &item.SortOrder); err != nil {
			contentRows.Close()
			return nil, err
		}
		item.Title = Text(title)
		if index, ok := taskIndexes[taskID]; ok {
			items[index.workflowIndex].Tasks[index.taskIndex].Contents =
				append(items[index.workflowIndex].Tasks[index.taskIndex].Contents, item)
		}
	}
	if err := contentRows.Err(); err != nil {
		contentRows.Close()
		return nil, err
	}
	contentRows.Close()

	attachmentRows, err := db.Query(
		ctx,
		`select id, task_id, filename, content_type, file_size, uploader, created_at, origin
		 from public.project_workflow_task_attachments
		 where task_id = any($1::bigint[])
		 order by task_id asc, id asc`,
		taskIDs,
	)
	if err != nil {
		return nil, err
	}
	for attachmentRows.Next() {
		var (
			item      workflows.Attachment
			taskID    int64
			uploader  pgtype.Text
			createdAt time.Time
			origin    pgtype.Text
		)
		if err := attachmentRows.Scan(
			&item.ID,
			&taskID,
			&item.Filename,
			&item.ContentType,
			&item.FileSize,
			&uploader,
			&createdAt,
			&origin,
		); err != nil {
			attachmentRows.Close()
			return nil, err
		}
		item.Uploader = Text(uploader)
		item.CreatedAt = httpapi.Timestamp(createdAt)
		item.Origin = Text(origin)
		if index, ok := taskIndexes[taskID]; ok {
			items[index.workflowIndex].Tasks[index.taskIndex].Attachments =
				append(items[index.workflowIndex].Tasks[index.taskIndex].Attachments, item)
		}
	}
	if err := attachmentRows.Err(); err != nil {
		attachmentRows.Close()
		return nil, err
	}
	attachmentRows.Close()

	for index := range items {
		workflows.FinalizeWorkflow(&items[index])
	}
	return items, nil
}

func (s *WorkflowStore) ListWorkflowSummaries(
	ctx context.Context,
	projectIDs []int64,
) (map[int64][]workflows.WorkflowSummary, error) {
	result := make(map[int64][]workflows.WorkflowSummary, len(projectIDs))
	for _, projectID := range projectIDs {
		result[projectID] = []workflows.WorkflowSummary{}
	}
	if len(projectIDs) == 0 {
		return result, nil
	}

	rows, err := s.db.Query(
		ctx,
		`select w.project_id, w.id, w.kind, w.title, w.template_key,
		        w.start_date::text, t.status, t.start_date::text, t.end_date::text
		 from public.project_workflows as w
		 left join public.project_workflow_tasks as t on t.workflow_id = w.id
		 where w.project_id = any($1::bigint[])
		 order by w.id asc, t.sort_order asc, t.id asc`,
		projectIDs,
	)
	if err != nil {
		return nil, err
	}
	type summaryGroup struct {
		projectID int64
		item      workflows.WorkflowSummary
		status    []string
		starts    []string
		ends      []string
	}
	groups := make(map[int64]*summaryGroup)
	order := make([]int64, 0)
	for rows.Next() {
		var (
			projectID   int64
			workflowID  int64
			kind        string
			title       string
			templateKey string
			startDate   pgtype.Text
			taskStatus  pgtype.Text
			taskStart   pgtype.Text
			taskEnd     pgtype.Text
		)
		if err := rows.Scan(
			&projectID, &workflowID, &kind, &title, &templateKey,
			&startDate, &taskStatus, &taskStart, &taskEnd,
		); err != nil {
			rows.Close()
			return nil, err
		}
		group, ok := groups[workflowID]
		if !ok {
			group = &summaryGroup{
				projectID: projectID,
				item: workflows.WorkflowSummary{
					ID: workflowID, Kind: kind, Title: title, TemplateKey: templateKey,
					StartDate: Text(startDate),
				},
			}
			groups[workflowID] = group
			order = append(order, workflowID)
		}
		if taskStatus.Valid {
			group.status = append(group.status, taskStatus.String)
		}
		if taskStart.Valid {
			group.starts = append(group.starts, taskStart.String)
		}
		if taskEnd.Valid {
			group.ends = append(group.ends, taskEnd.String)
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()

	for _, workflowID := range order {
		group := groups[workflowID]
		group.item.Status = workflows.AggregateStatus(group.status)
		group.item.TaskCount = len(group.status)
		for _, value := range group.status {
			if value == workflows.StatusCompleted {
				group.item.CompletedTaskCount++
			}
		}
		start := minDate(group.starts)
		end := maxDate(group.ends)
		group.item.ScheduleStart = start
		group.item.ScheduleEnd = end
		group.item.ScheduleDays = workflows.SpanDays(start, end)
		result[group.projectID] = append(result[group.projectID], group.item)
	}
	return result, nil
}

func (s *WorkflowStore) ListProjectSchedules(
	ctx context.Context,
	projectIDs []int64,
) (map[int64]workflows.ProjectSchedule, error) {
	result := make(map[int64]workflows.ProjectSchedule, len(projectIDs))
	for _, projectID := range projectIDs {
		result[projectID] = workflows.ProjectSchedule{}
	}
	if len(projectIDs) == 0 {
		return result, nil
	}
	rows, err := s.db.Query(
		ctx,
		`select w.project_id, min(t.start_date)::text, max(t.end_date)::text
		 from public.project_workflows as w
		 join public.project_workflow_tasks as t on t.workflow_id = w.id
		 where w.project_id = any($1::bigint[])
		 group by w.project_id`,
		projectIDs,
	)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var (
			projectID int64
			start     pgtype.Text
			end       pgtype.Text
		)
		if err := rows.Scan(&projectID, &start, &end); err != nil {
			rows.Close()
			return nil, err
		}
		result[projectID] = workflows.ProjectSchedule{
			ScheduleStart: Text(start),
			ScheduleEnd:   Text(end),
			ScheduleDays:  workflows.SpanDays(Text(start), Text(end)),
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	return result, nil
}

func (s *WorkflowStore) GetTaskProject(
	ctx context.Context,
	taskID int64,
) (int64, error) {
	var projectID int64
	err := s.db.QueryRow(
		ctx,
		`select w.project_id
		 from public.project_workflow_tasks as t
		 join public.project_workflows as w on w.id = t.workflow_id
		 where t.id = $1`,
		taskID,
	).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return projectID, err
}

func (s *WorkflowStore) GetContentProject(
	ctx context.Context,
	contentID int64,
) (int64, error) {
	var projectID int64
	err := s.db.QueryRow(
		ctx,
		`select w.project_id
		 from public.project_workflow_task_contents as c
		 join public.project_workflow_tasks as t on t.id = c.task_id
		 join public.project_workflows as w on w.id = t.workflow_id
		 where c.id = $1`,
		contentID,
	).Scan(&projectID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	return projectID, err
}

func (s *WorkflowStore) GetAttachmentForDownload(
	ctx context.Context,
	projectID int64,
	attachmentID int64,
) (*workflows.AttachmentDownload, error) {
	var item workflows.AttachmentDownload
	err := s.db.QueryRow(
		ctx,
		`select a.id, w.project_id, a.task_id, a.r2_key, a.filename,
		        a.content_type, a.file_size
		 from public.project_workflow_task_attachments as a
		 join public.project_workflow_tasks as t on t.id = a.task_id
		 join public.project_workflows as w on w.id = t.workflow_id
		 where a.id = $1 and w.project_id = $2`,
		attachmentID,
		projectID,
	).Scan(
		&item.ID,
		&item.ProjectID,
		&item.TaskID,
		&item.R2Key,
		&item.Filename,
		&item.ContentType,
		&item.FileSize,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

func (s *WorkflowStore) CreateWorkflow(
	ctx context.Context,
	projectID int64,
	input workflows.WorkflowCreateRequest,
) (*workflows.Workflow, error) {
	var result *workflows.Workflow
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow-create:%d:%s", projectID, input.Kind)); err != nil {
			return err
		}
		if input.Kind == workflows.KindStoreLaunch {
			existing, err := findStoreLaunchWorkflow(ctx, txDB, projectID)
			if err != nil {
				return err
			}
			if existing != nil {
				result = existing
				return nil
			}
		}
		template, err := loadTemplateRecord(
			ctx,
			txDB,
			"t.key = $1",
			strings.TrimSpace(input.TemplateKey),
		)
		if err != nil {
			return err
		}
		if template == nil {
			return projects.NewAPIError(http.StatusUnprocessableEntity, "流程模板不存在")
		}
		if template.Kind != input.Kind {
			return projects.NewAPIError(http.StatusUnprocessableEntity, "流程模板与流程类型不匹配")
		}
		title := template.Title
		if input.Title != nil && strings.TrimSpace(*input.Title) != "" {
			title = strings.TrimSpace(*input.Title)
		}
		title = truncateRunes(title, 160)
		var workflowID int64
		if err := tx.QueryRow(
			ctx,
			`insert into public.project_workflows
			 (project_id, kind, title, template_key, start_date)
			 values ($1, $2, $3, $4, $5::date)
			 returning id`,
			projectID,
			input.Kind,
			title,
			template.Key,
			input.StartDate,
		).Scan(&workflowID); err != nil {
			return mapWorkflowDBError(err)
		}

		orderedTemplate := orderedTemplateTasks(template.Tasks)
		tasks := make([]workflows.Task, 0, len(orderedTemplate))
		for _, task := range orderedTemplate {
			tasks = append(tasks, workflows.Task{
				Title:         task.Title,
				Description:   task.Description,
				SortOrder:     len(tasks),
				Status:        workflows.StatusNotStarted,
				AttachmentKey: task.AttachmentKey,
				DurationDays:  task.DurationDays,
				Contents:      []workflows.Content{},
				Attachments:   []workflows.Attachment{},
			})
		}
		workflows.RecomputeSchedule(input.StartDate, tasks)
		for index := range tasks {
			task := &tasks[index]
			if err := tx.QueryRow(
				ctx,
				`insert into public.project_workflow_tasks
				 (workflow_id, title, description, sort_order, status, attachment_key,
				  duration_days, start_date, end_date)
				 values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date)
				 returning id`,
				workflowID,
				task.Title,
				task.Description,
				task.SortOrder,
				task.Status,
				task.AttachmentKey,
				task.DurationDays,
				task.StartDate,
				task.EndDate,
			).Scan(&task.ID); err != nil {
				return err
			}
			templateTask := orderedTemplate[index]
			for _, content := range orderedTemplateContents(templateTask.Contents) {
				if _, err := tx.Exec(
					ctx,
					`insert into public.project_workflow_task_contents
					 (task_id, title, body, sort_order)
					 values ($1, $2, $3, $4)`,
					task.ID,
					content.Title,
					content.Body,
					content.SortOrder,
				); err != nil {
					return err
				}
			}
			for _, attachment := range orderedTemplateAttachments(templateTask.Attachments) {
				if _, err := tx.Exec(
					ctx,
					`insert into public.project_workflow_task_attachments
					 (task_id, r2_key, filename, content_type, file_size, uploader, origin)
					 values ($1, $2, $3, $4, $5, $6, 'template')`,
					task.ID,
					attachment.R2Key,
					attachment.Filename,
					attachment.ContentType,
					attachment.FileSize,
					attachment.Uploader,
				); err != nil {
					return err
				}
			}
		}
		created, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(created) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		result = &created[0]
		return writeWorkflowAudit(ctx, tx, "workflow.create", "project_workflow", workflowID, map[string]any{
			"project_id": projectID,
			"kind":       input.Kind,
			"title":      title,
		})
	})
	return result, err
}

func (s *WorkflowStore) UpdateWorkflowDefinition(
	ctx context.Context,
	workflowID int64,
	input workflows.WorkflowDefinitionUpdateRequest,
) (*workflows.Workflow, error) {
	var result *workflows.Workflow
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow:%d", workflowID)); err != nil {
			return err
		}
		current, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(current) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		item := &current[0]
		title := item.Title
		if input.Title != nil {
			title = truncateRunes(strings.TrimSpace(*input.Title), 160)
		}
		startDate := item.StartDate
		if input.StartDate.Present {
			startDate = input.StartDate.Value
		}
		if _, err := tx.Exec(
			ctx,
			`update public.project_workflows
			 set title = $2, start_date = $3::date, updated_at = now()
			 where id = $1`,
			workflowID,
			title,
			startDate,
		); err != nil {
			return err
		}
		item.Title = title
		item.StartDate = startDate
		workflows.RecomputeSchedule(startDate, item.Tasks)
		if err := persistTaskSchedule(ctx, txDB, item.Tasks); err != nil {
			return err
		}
		updated, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(updated) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		result = &updated[0]
		return writeWorkflowAudit(ctx, tx, "workflow.update", "project_workflow", workflowID, map[string]any{
			"title":      title,
			"start_date": startDate,
		})
	})
	return result, err
}

func (s *WorkflowStore) UpdateTaskStatus(
	ctx context.Context,
	taskID int64,
	status string,
) (*workflows.Workflow, error) {
	var result *workflows.Workflow
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var workflowID int64
		err := tx.QueryRow(
			ctx,
			`select workflow_id from public.project_workflow_tasks where id = $1`,
			taskID,
		).Scan(&workflowID)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "任务不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow:%d", workflowID)); err != nil {
			return err
		}
		tag, err := tx.Exec(
			ctx,
			`update public.project_workflow_tasks
			 set status = $2, updated_at = now()
			 where id = $1`,
			taskID,
			status,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return projects.NewAPIError(http.StatusNotFound, "任务不存在")
		}
		updated, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(updated) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		result = &updated[0]
		return writeWorkflowAudit(ctx, tx, "workflow.task.status", "project_workflow_task", taskID, map[string]any{
			"workflow_id": workflowID,
			"status":      status,
		})
	})
	return result, err
}

func (s *WorkflowStore) CreateProjectTask(
	ctx context.Context,
	projectID int64,
	workflowID int64,
	input workflows.TaskCreateRequest,
) (*workflows.Workflow, error) {
	var result *workflows.Workflow
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow:%d", workflowID)); err != nil {
			return err
		}
		if err := requireWorkflowProject(ctx, txDB, workflowID, projectID); err != nil {
			return err
		}
		taskIDs, maxSort, err := loadProjectTaskOrder(ctx, txDB, workflowID)
		if err != nil {
			return err
		}
		sortOrder := maxSort + 1
		if input.SortOrder != nil {
			sortOrder = *input.SortOrder
			if sortOrder > len(taskIDs) {
				sortOrder = len(taskIDs)
			}
		}
		var taskID int64
		if err := tx.QueryRow(
			ctx,
			`insert into public.project_workflow_tasks
			 (workflow_id, title, description, sort_order, status, attachment_key, duration_days)
			 values ($1, $2, $3, $4, $5, $6, $7)
			 returning id`,
			workflowID,
			truncateRunes(strings.TrimSpace(input.Title), 160),
			input.Description,
			sortOrder,
			workflows.StatusNotStarted,
			input.AttachmentKey,
			input.DurationDays,
		).Scan(&taskID); err != nil {
			return err
		}
		if input.SortOrder != nil {
			desired := insertInt64At(taskIDs, taskID, *input.SortOrder)
			if err := rewriteProjectTaskOrder(ctx, tx, workflowID, desired); err != nil {
				return err
			}
		}
		current, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(current) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		workflows.RecomputeSchedule(current[0].StartDate, current[0].Tasks)
		if err := persistTaskSchedule(ctx, txDB, current[0].Tasks); err != nil {
			return err
		}
		final, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		result = &final[0]
		return writeWorkflowAudit(ctx, tx, "workflow.task.create", "project_workflow_task", taskID, map[string]any{
			"workflow_id": workflowID,
			"title":       input.Title,
		})
	})
	return result, err
}

func (s *WorkflowStore) UpdateProjectTaskDefinition(
	ctx context.Context,
	taskID int64,
	input workflows.TaskDefinitionUpdateRequest,
) (*workflows.Workflow, error) {
	var result *workflows.Workflow
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var workflowID int64
		err := tx.QueryRow(
			ctx,
			`select workflow_id from public.project_workflow_tasks where id = $1`,
			taskID,
		).Scan(&workflowID)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "任务不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow:%d", workflowID)); err != nil {
			return err
		}
		var (
			title         string
			description   pgtype.Text
			attachmentKey pgtype.Text
			durationDays  pgtype.Int4
			startDate     pgtype.Text
			endDate       pgtype.Text
		)
		err = tx.QueryRow(
			ctx,
			`select title, description, attachment_key, duration_days,
			        start_date::text, end_date::text
			 from public.project_workflow_tasks
			 where id = $1`,
			taskID,
		).Scan(
			&title,
			&description,
			&attachmentKey,
			&durationDays,
			&startDate,
			&endDate,
		)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "任务不存在")
		}
		if err != nil {
			return err
		}
		if input.Title != nil {
			title = truncateRunes(strings.TrimSpace(*input.Title), 160)
		}
		if input.Description.Present {
			description = nullableText(input.Description.Value)
		}
		if input.AttachmentKey.Present {
			if err := workflows.ValidateAttachmentKey(input.AttachmentKey.Value); err != nil {
				return projects.NewAPIError(http.StatusUnprocessableEntity, err.Error())
			}
			attachmentKey = nullableTrimmedText(input.AttachmentKey.Value)
		}
		if input.DurationDays.Present {
			durationDays = nullableInt4(input.DurationDays.Value)
			if input.DurationDays.Value != nil &&
				(*input.DurationDays.Value < 0 || *input.DurationDays.Value > workflows.MaxDurationDays) {
				return projects.NewAPIError(http.StatusUnprocessableEntity, "工期天数必须在 0..3650 之间")
			}
		}
		if input.StartDate.Present {
			startDate = nullableText(input.StartDate.Value)
		}
		if input.EndDate.Present {
			endDate = nullableText(input.EndDate.Value)
		}
		startText, _ := textPointer(startDate)
		endText, _ := textPointer(endDate)
		if err := validateWorkflowDatePair(startText, endText); err != nil {
			return err
		}
		tag, err := tx.Exec(
			ctx,
			`update public.project_workflow_tasks
			 set title = $2, description = $3, attachment_key = $4,
			     duration_days = $5, start_date = $6::date, end_date = $7::date,
			     updated_at = now()
			 where id = $1`,
			taskID,
			title,
			description,
			attachmentKey,
			durationDays,
			startDate,
			endDate,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return projects.NewAPIError(http.StatusNotFound, "任务不存在")
		}
		current, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(current) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		workflows.RecomputeSchedule(current[0].StartDate, current[0].Tasks)
		if err := persistTaskSchedule(ctx, txDB, current[0].Tasks); err != nil {
			return err
		}
		final, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		result = &final[0]
		return writeWorkflowAudit(ctx, tx, "workflow.task.update", "project_workflow_task", taskID, map[string]any{
			"workflow_id": workflowID,
			"title":       title,
		})
	})
	return result, err
}

func (s *WorkflowStore) DeleteProjectTask(
	ctx context.Context,
	taskID int64,
) (workflows.WorkflowMutation, error) {
	var result workflows.WorkflowMutation
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var (
			workflowID int64
			projectID  int64
		)
		err := tx.QueryRow(
			ctx,
			`select t.workflow_id, w.project_id
			 from public.project_workflow_tasks as t
			 join public.project_workflows as w on w.id = t.workflow_id
			 where t.id = $1`,
			taskID,
		).Scan(&workflowID, &projectID)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "任务不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow:%d", workflowID)); err != nil {
			return err
		}
		keys, err := loadProjectAttachmentKeysForTask(ctx, txDB, taskID)
		if err != nil {
			return err
		}
		if err := lockAttachmentKeys(ctx, tx, keys); err != nil {
			return err
		}
		tag, err := tx.Exec(
			ctx,
			`delete from public.project_workflow_tasks where id = $1`,
			taskID,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return projects.NewAPIError(http.StatusNotFound, "任务不存在")
		}
		if err := rewriteProjectTaskOrderDense(ctx, tx, workflowID); err != nil {
			return err
		}
		current, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(current) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		workflows.RecomputeSchedule(current[0].StartDate, current[0].Tasks)
		if err := persistTaskSchedule(ctx, txDB, current[0].Tasks); err != nil {
			return err
		}
		final, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		result.Workflow = &final[0]
		result.DeleteKeys, err = unreferencedKeys(ctx, txDB, keys)
		if err != nil {
			return err
		}
		return writeWorkflowAudit(ctx, tx, "workflow.task.delete", "project_workflow_task", taskID, map[string]any{
			"workflow_id": workflowID,
			"project_id":  projectID,
		})
	})
	return result, err
}

func (s *WorkflowStore) ReorderProjectTasks(
	ctx context.Context,
	projectID int64,
	workflowID int64,
	taskIDs []int64,
) (*workflows.Workflow, error) {
	var result *workflows.Workflow
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow:%d", workflowID)); err != nil {
			return err
		}
		if err := requireWorkflowProject(ctx, txDB, workflowID, projectID); err != nil {
			return err
		}
		existing, _, err := loadProjectTaskOrder(ctx, txDB, workflowID)
		if err != nil {
			return err
		}
		if err := validateOrderSet(existing, taskIDs); err != nil {
			return projects.NewAPIError(http.StatusUnprocessableEntity, "排序列表必须恰好包含该流程的全部节点")
		}
		for index, taskID := range taskIDs {
			if _, err := tx.Exec(
				ctx,
				`update public.project_workflow_tasks
				 set sort_order = $2, updated_at = now()
				 where workflow_id = $1 and id = $3`,
				workflowID,
				index,
				taskID,
			); err != nil {
				return err
			}
		}
		current, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(current) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		workflows.RecomputeSchedule(current[0].StartDate, current[0].Tasks)
		if err := persistTaskSchedule(ctx, txDB, current[0].Tasks); err != nil {
			return err
		}
		final, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		result = &final[0]
		return writeWorkflowAudit(ctx, tx, "workflow.task.reorder", "project_workflow", workflowID, map[string]any{
			"task_ids": taskIDs,
		})
	})
	return result, err
}

func (s *WorkflowStore) CreateProjectContent(
	ctx context.Context,
	projectID int64,
	taskID int64,
	input workflows.ContentCreateRequest,
) (*workflows.Workflow, error) {
	var result *workflows.Workflow
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		workflowID, err := taskWorkflowID(ctx, txDB, taskID)
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow:%d", workflowID)); err != nil {
			return err
		}
		workflowAfterLock, err := taskWorkflowID(ctx, txDB, taskID)
		if err != nil {
			return err
		}
		if workflowAfterLock != workflowID {
			return projects.NewAPIError(http.StatusNotFound, "任务不存在")
		}
		if err := requireWorkflowProject(ctx, txDB, workflowID, projectID); err != nil {
			return projects.NewAPIError(http.StatusNotFound, "任务不存在")
		}
		sortOrder := 0
		var currentMax int
		err = tx.QueryRow(
			ctx,
			`select coalesce(max(sort_order), -1)
			 from public.project_workflow_task_contents where task_id = $1`,
			taskID,
		).Scan(&currentMax)
		if err != nil {
			return err
		}
		sortOrder = currentMax + 1
		if input.SortOrder != nil {
			sortOrder = *input.SortOrder
		}
		var contentID int64
		if err := tx.QueryRow(
			ctx,
			`insert into public.project_workflow_task_contents (task_id, title, body, sort_order)
			 values ($1, $2, $3, $4)
			 returning id`,
			taskID,
			trimmedTextPointer(input.Title),
			input.Body,
			sortOrder,
		).Scan(&contentID); err != nil {
			return err
		}
		final, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(final) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		result = &final[0]
		return writeWorkflowAudit(ctx, tx, "workflow.content.create", "project_workflow_task_content", contentID, map[string]any{
			"task_id":     taskID,
			"workflow_id": workflowID,
		})
	})
	return result, err
}

func (s *WorkflowStore) UpdateProjectContent(
	ctx context.Context,
	contentID int64,
	input workflows.ContentUpdateRequest,
) (*workflows.Workflow, error) {
	var result *workflows.Workflow
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var (
			workflowID int64
			taskID     int64
		)
		err := tx.QueryRow(
			ctx,
			`select c.task_id, t.workflow_id
			 from public.project_workflow_task_contents as c
			 join public.project_workflow_tasks as t on t.id = c.task_id
			 where c.id = $1`,
			contentID,
		).Scan(&taskID, &workflowID)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "内容不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow:%d", workflowID)); err != nil {
			return err
		}
		var (
			body  string
			title pgtype.Text
		)
		err = tx.QueryRow(
			ctx,
			`select body, title from public.project_workflow_task_contents where id = $1`,
			contentID,
		).Scan(&body, &title)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "内容不存在")
		}
		if err != nil {
			return err
		}
		if input.Body != nil {
			if strings.TrimSpace(*input.Body) == "" {
				return projects.NewAPIError(http.StatusUnprocessableEntity, "内容正文不能为空")
			}
			body = *input.Body
		}
		if input.Title.Present {
			title = nullableTrimmedText(input.Title.Value)
		}
		tag, err := tx.Exec(
			ctx,
			`update public.project_workflow_task_contents
			 set body = $2, title = $3, updated_at = now()
			 where id = $1`,
			contentID,
			body,
			title,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return projects.NewAPIError(http.StatusNotFound, "内容不存在")
		}
		final, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(final) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		result = &final[0]
		return writeWorkflowAudit(ctx, tx, "workflow.content.update", "project_workflow_task_content", contentID, map[string]any{
			"task_id":     taskID,
			"workflow_id": workflowID,
		})
	})
	return result, err
}

func (s *WorkflowStore) DeleteProjectContent(
	ctx context.Context,
	contentID int64,
) (*workflows.Workflow, error) {
	var result *workflows.Workflow
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var (
			taskID     int64
			workflowID int64
		)
		err := tx.QueryRow(
			ctx,
			`select c.task_id, t.workflow_id
			 from public.project_workflow_task_contents as c
			 join public.project_workflow_tasks as t on t.id = c.task_id
			 where c.id = $1`,
			contentID,
		).Scan(&taskID, &workflowID)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "内容不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow:%d", workflowID)); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `delete from public.project_workflow_task_contents where id = $1`, contentID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return projects.NewAPIError(http.StatusNotFound, "内容不存在")
		}
		if err := rewriteProjectContentOrderDense(ctx, tx, taskID); err != nil {
			return err
		}
		final, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(final) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		result = &final[0]
		return writeWorkflowAudit(ctx, tx, "workflow.content.delete", "project_workflow_task_content", contentID, map[string]any{
			"task_id":     taskID,
			"workflow_id": workflowID,
		})
	})
	return result, err
}

func (s *WorkflowStore) InsertProjectAttachment(
	ctx context.Context,
	projectID int64,
	taskID int64,
	input workflows.AttachmentUpload,
) (*workflows.Workflow, error) {
	var result *workflows.Workflow
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		workflowID, err := taskWorkflowID(ctx, txDB, taskID)
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow:%d", workflowID)); err != nil {
			return err
		}
		workflowAfterLock, err := taskWorkflowID(ctx, txDB, taskID)
		if err != nil {
			return err
		}
		if workflowAfterLock != workflowID {
			return projects.NewAPIError(http.StatusNotFound, "任务不存在")
		}
		if err := requireWorkflowProject(ctx, txDB, workflowID, projectID); err != nil {
			return projects.NewAPIError(http.StatusNotFound, "任务不存在")
		}
		var attachmentID int64
		if err := tx.QueryRow(
			ctx,
			`insert into public.project_workflow_task_attachments
			 (task_id, r2_key, filename, content_type, file_size, uploader, origin)
			 values ($1, $2, $3, $4, $5, $6, $7)
			 returning id`,
			taskID,
			input.R2Key,
			input.Filename,
			input.ContentType,
			input.FileSize,
			input.Uploader,
			input.Origin,
		).Scan(&attachmentID); err != nil {
			return err
		}
		final, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(final) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		result = &final[0]
		return writeWorkflowAudit(ctx, tx, "workflow.attachment.upload", "project_workflow_task_attachment", attachmentID, map[string]any{
			"task_id":     taskID,
			"workflow_id": workflowID,
			"filename":    input.Filename,
			"file_size":   input.FileSize,
		})
	})
	return result, err
}

func (s *WorkflowStore) DeleteProjectAttachment(
	ctx context.Context,
	projectID int64,
	attachmentID int64,
) (workflows.WorkflowMutation, error) {
	var result workflows.WorkflowMutation
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var (
			taskID     int64
			workflowID int64
			r2Key      string
		)
		err := tx.QueryRow(
			ctx,
			`select a.task_id, t.workflow_id, a.r2_key
			 from public.project_workflow_task_attachments as a
			 join public.project_workflow_tasks as t on t.id = a.task_id
			 join public.project_workflows as w on w.id = t.workflow_id
			 where a.id = $1 and w.project_id = $2`,
			attachmentID,
			projectID,
		).Scan(&taskID, &workflowID, &r2Key)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "附件不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("workflow:%d", workflowID)); err != nil {
			return err
		}
		if err := lockAttachmentKeys(ctx, tx, []string{r2Key}); err != nil {
			return err
		}
		count, err := projectAttachmentReferenceCount(ctx, txDB, r2Key, attachmentID)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(
			ctx,
			`delete from public.project_workflow_task_attachments where id = $1`,
			attachmentID,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return projects.NewAPIError(http.StatusNotFound, "附件不存在")
		}
		if count == 0 {
			result.DeleteKeys = []string{r2Key}
		}
		final, err := loadWorkflows(ctx, txDB, "w.id = $1", workflowID)
		if err != nil {
			return err
		}
		if len(final) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "流程不存在")
		}
		result.Workflow = &final[0]
		return writeWorkflowAudit(ctx, tx, "workflow.attachment.delete", "project_workflow_task_attachment", attachmentID, map[string]any{
			"task_id":     taskID,
			"workflow_id": workflowID,
		})
	})
	return result, err
}

func (s *WorkflowStore) inTx(ctx context.Context, fn func(pgx.Tx) error) error {
	txer, ok := s.db.(Transactor)
	if !ok || txer == nil {
		return fmt.Errorf("workflow store database does not support transactions")
	}
	return RunInTx(ctx, txer, fn)
}

func findStoreLaunchWorkflow(
	ctx context.Context,
	db DB,
	projectID int64,
) (*workflows.Workflow, error) {
	items, err := loadWorkflows(
		ctx,
		db,
		"w.project_id = $1 and w.kind = $2",
		projectID,
		workflows.KindStoreLaunch,
	)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, nil
	}
	return &items[0], nil
}

func taskWorkflowID(ctx context.Context, db DB, taskID int64) (int64, error) {
	var workflowID int64
	err := db.QueryRow(
		ctx,
		`select workflow_id from public.project_workflow_tasks where id = $1`,
		taskID,
	).Scan(&workflowID)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, projects.NewAPIError(http.StatusNotFound, "任务不存在")
	}
	return workflowID, err
}

func requireWorkflowProject(
	ctx context.Context,
	db DB,
	workflowID int64,
	projectID int64,
) error {
	var foundProjectID int64
	err := db.QueryRow(
		ctx,
		`select project_id from public.project_workflows where id = $1`,
		workflowID,
	).Scan(&foundProjectID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && foundProjectID != projectID) {
		return projects.NewAPIError(http.StatusNotFound, "流程不存在")
	}
	return err
}

func loadProjectTaskOrder(
	ctx context.Context,
	db DB,
	workflowID int64,
) ([]int64, int, error) {
	rows, err := db.Query(
		ctx,
		`select id, sort_order
		 from public.project_workflow_tasks
		 where workflow_id = $1
		 order by sort_order asc, id asc`,
		workflowID,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	ids := make([]int64, 0)
	maxSort := -1
	for rows.Next() {
		var (
			id        int64
			sortOrder int
		)
		if err := rows.Scan(&id, &sortOrder); err != nil {
			return nil, 0, err
		}
		ids = append(ids, id)
		if sortOrder > maxSort {
			maxSort = sortOrder
		}
	}
	return ids, maxSort, rows.Err()
}

func rewriteProjectTaskOrder(
	ctx context.Context,
	tx pgx.Tx,
	workflowID int64,
	ids []int64,
) error {
	for index, id := range ids {
		if _, err := tx.Exec(
			ctx,
			`update public.project_workflow_tasks
			 set sort_order = $2, updated_at = now()
			 where workflow_id = $1 and id = $3`,
			workflowID,
			index,
			id,
		); err != nil {
			return err
		}
	}
	return nil
}

func rewriteProjectTaskOrderDense(
	ctx context.Context,
	tx pgx.Tx,
	workflowID int64,
) error {
	rows, err := tx.Query(
		ctx,
		`select id
		 from public.project_workflow_tasks
		 where workflow_id = $1
		 order by sort_order asc, id asc`,
		workflowID,
	)
	if err != nil {
		return err
	}
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	return rewriteProjectTaskOrder(ctx, tx, workflowID, ids)
}

func rewriteProjectContentOrderDense(
	ctx context.Context,
	tx pgx.Tx,
	taskID int64,
) error {
	rows, err := tx.Query(
		ctx,
		`select id
		 from public.project_workflow_task_contents
		 where task_id = $1
		 order by sort_order asc, id asc`,
		taskID,
	)
	if err != nil {
		return err
	}
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for index, id := range ids {
		if _, err := tx.Exec(
			ctx,
			`update public.project_workflow_task_contents
			 set sort_order = $2, updated_at = now()
			 where id = $1`,
			id,
			index,
		); err != nil {
			return err
		}
	}
	return nil
}

func persistTaskSchedule(
	ctx context.Context,
	execer Execer,
	tasks []workflows.Task,
) error {
	for _, task := range tasks {
		if _, err := execer.Exec(
			ctx,
			`update public.project_workflow_tasks
			 set start_date = $2::date, end_date = $3::date, updated_at = now()
			 where id = $1`,
			task.ID,
			task.StartDate,
			task.EndDate,
		); err != nil {
			return err
		}
	}
	return nil
}

func loadProjectAttachmentKeysForTask(
	ctx context.Context,
	db DB,
	taskID int64,
) ([]string, error) {
	rows, err := db.Query(
		ctx,
		`select r2_key
		 from public.project_workflow_task_attachments
		 where task_id = $1`,
		taskID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	keys := make([]string, 0)
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			return nil, err
		}
		keys = append(keys, key)
	}
	return keys, rows.Err()
}

func projectAttachmentReferenceCount(
	ctx context.Context,
	db DB,
	key string,
	excludeProjectID int64,
) (int64, error) {
	var count int64
	err := db.QueryRow(
		ctx,
		`select
		   (select count(*) from public.project_workflow_task_attachments
		    where r2_key = $1 and id <> $2) +
		   (select count(*) from public.workflow_template_task_attachments
		    where r2_key = $1)`,
		key,
		excludeProjectID,
	).Scan(&count)
	return count, err
}

func unreferencedKeys(
	ctx context.Context,
	db DB,
	keys []string,
) ([]string, error) {
	result := make([]string, 0)
	seen := make(map[string]bool, len(keys))
	for _, key := range keys {
		if seen[key] {
			continue
		}
		seen[key] = true
		var count int64
		err := db.QueryRow(
			ctx,
			`select
			   (select count(*) from public.project_workflow_task_attachments where r2_key = $1) +
			   (select count(*) from public.workflow_template_task_attachments where r2_key = $1)`,
			key,
		).Scan(&count)
		if err != nil {
			return nil, err
		}
		if count == 0 {
			result = append(result, key)
		}
	}
	return result, nil
}

func lockEntity(ctx context.Context, tx pgx.Tx, key string) error {
	_, err := tx.Exec(
		ctx,
		`select pg_advisory_xact_lock(hashtext($1)::bigint)`,
		key,
	)
	return err
}

func lockAttachmentKeys(ctx context.Context, tx pgx.Tx, keys []string) error {
	sortedKeys := append([]string(nil), keys...)
	sort.Strings(sortedKeys)
	lastKey := ""
	hasLast := false
	for _, key := range sortedKeys {
		if hasLast && key == lastKey {
			continue
		}
		lastKey = key
		hasLast = true
		if err := lockEntity(ctx, tx, "attachment-key:"+key); err != nil {
			return err
		}
	}
	return nil
}

func writeWorkflowAudit(
	ctx context.Context,
	tx pgx.Tx,
	action string,
	targetType string,
	targetID int64,
	after any,
) error {
	meta := workflows.MutationMetaFromContext(ctx)
	afterJSON, err := json.Marshal(after)
	if err != nil {
		return err
	}
	target := fmt.Sprintf("%d", targetID)
	_, err = tx.Exec(
		ctx,
		`insert into public.operation_audit_logs
		 (operator, action, target_type, target_id, result, trace_id,
		  request_method, request_path, ip_address, user_agent,
		  before_json, after_json, created_at)
		 values ($1, $2, $3, $4, 'success', $5, $6, $7, $8, $9, null, $10, now())`,
		meta.Operator,
		action,
		targetType,
		target,
		meta.TraceID,
		meta.RequestMethod,
		meta.RequestPath,
		meta.IPAddress,
		meta.UserAgent,
		afterJSON,
	)
	return err
}

func mapWorkflowDBError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return projects.NewAPIError(http.StatusConflict, "资源已存在")
	}
	return err
}

func validateOrderSet(existing []int64, requested []int64) error {
	if len(existing) != len(requested) {
		return errors.New("order length mismatch")
	}
	left := append([]int64(nil), existing...)
	right := append([]int64(nil), requested...)
	sort.Slice(left, func(i, j int) bool { return left[i] < left[j] })
	sort.Slice(right, func(i, j int) bool { return right[i] < right[j] })
	for index := range left {
		if left[index] != right[index] {
			return errors.New("order set mismatch")
		}
	}
	return nil
}

func insertInt64At(existing []int64, inserted int64, position int) []int64 {
	if position < 0 {
		position = 0
	}
	if position > len(existing) {
		position = len(existing)
	}
	result := make([]int64, 0, len(existing)+1)
	result = append(result, existing[:position]...)
	result = append(result, inserted)
	result = append(result, existing[position:]...)
	return result
}

func validateWorkflowDatePair(start, end *string) error {
	if start == nil || end == nil {
		return nil
	}
	startDate, startErr := time.Parse("2006-01-02", *start)
	endDate, endErr := time.Parse("2006-01-02", *end)
	if startErr != nil || endErr != nil {
		return projects.NewAPIError(http.StatusUnprocessableEntity, "日期格式必须为 YYYY-MM-DD")
	}
	if endDate.Before(startDate) {
		return projects.NewAPIError(http.StatusUnprocessableEntity, "结束日期不能早于开始日期")
	}
	return nil
}

func nullableText(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	return pgtype.Text{String: *value, Valid: true}
}

func nullableTrimmedText(value *string) pgtype.Text {
	if value == nil {
		return pgtype.Text{}
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: trimmed, Valid: true}
}

func nullableInt4(value *int) pgtype.Int4 {
	if value == nil {
		return pgtype.Int4{}
	}
	return pgtype.Int4{Int32: int32(*value), Valid: true}
}

func workflowInt4Pointer(value pgtype.Int4) *int {
	if !value.Valid {
		return nil
	}
	number := int(value.Int32)
	return &number
}

func textPointer(value pgtype.Text) (*string, bool) {
	if !value.Valid {
		return nil, false
	}
	return &value.String, true
}

func trimmedTextPointer(value *string) *string {
	if value == nil {
		return nil
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if limit > 0 && len(runes) > limit {
		runes = runes[:limit]
	}
	return string(runes)
}

func randomSuffix() string {
	var bytes [3]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "fallback"
	}
	return hex.EncodeToString(bytes[:])
}

func minDate(values []string) *string {
	if len(values) == 0 {
		return nil
	}
	sort.Strings(values)
	value := values[0]
	return &value
}

func maxDate(values []string) *string {
	if len(values) == 0 {
		return nil
	}
	sort.Strings(values)
	value := values[len(values)-1]
	return &value
}
