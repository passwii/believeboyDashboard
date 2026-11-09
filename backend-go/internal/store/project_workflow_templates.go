package store

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/projects"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/workflows"
	"github.com/passwii/believeboyDashboard/backend-go/internal/httpapi"
)

type templateRecord struct {
	ID          int64
	Key         string
	Kind        string
	Title       string
	Description *string
	SortOrder   int
	Tasks       []templateTaskRecord
}

type templateTaskRecord struct {
	ID            int64
	TemplateID    int64
	Title         string
	Description   *string
	SortOrder     int
	AttachmentKey *string
	DurationDays  *int
	Contents      []templateContentRecord
	Attachments   []templateAttachmentRecord
}

type templateContentRecord struct {
	ID             int64
	TemplateTaskID int64
	Title          *string
	Body           string
	SortOrder      int
}

type templateAttachmentRecord struct {
	ID             int64
	TemplateTaskID int64
	R2Key          string
	Filename       string
	ContentType    string
	FileSize       int64
	Uploader       *string
	CreatedAt      time.Time
}

func (s *WorkflowStore) ListWorkflowTemplateRows(
	ctx context.Context,
) ([]workflows.TemplateListItem, error) {
	rows, err := s.db.Query(
		ctx,
		`select t.id, t.key, t.kind, t.title, t.description, t.sort_order,
		        count(tt.id)
		 from public.workflow_templates as t
		 left join public.workflow_template_tasks as tt on tt.template_id = t.id
		 group by t.id, t.key, t.kind, t.title, t.description, t.sort_order
		 order by t.sort_order asc, t.id asc`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]workflows.TemplateListItem, 0)
	for rows.Next() {
		var (
			item        workflows.TemplateListItem
			description pgtype.Text
			taskCount   int64
		)
		if err := rows.Scan(
			&item.ID,
			&item.Key,
			&item.Kind,
			&item.Title,
			&description,
			&item.SortOrder,
			&taskCount,
		); err != nil {
			return nil, err
		}
		item.Description = Text(description)
		item.TaskCount = int(taskCount)
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *WorkflowStore) GetWorkflowTemplate(
	ctx context.Context,
	templateID int64,
) (*workflows.TemplateDetail, error) {
	records, err := loadTemplateRecords(ctx, s.db, "t.id = $1", templateID)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, nil
	}
	detail := serializeTemplateRecord(records[0])
	return &detail, nil
}

func loadTemplateRecord(
	ctx context.Context,
	db DB,
	where string,
	args ...any,
) (*templateRecord, error) {
	records, err := loadTemplateRecords(ctx, db, where, args...)
	if err != nil {
		return nil, err
	}
	if len(records) == 0 {
		return nil, nil
	}
	return &records[0], nil
}

func loadTemplateRecords(
	ctx context.Context,
	db DB,
	where string,
	args ...any,
) ([]templateRecord, error) {
	rows, err := db.Query(
		ctx,
		`select t.id, t.key, t.kind, t.title, t.description, t.sort_order
		 from public.workflow_templates as t
		 where `+where+`
		 order by t.sort_order asc, t.id asc`,
		args...,
	)
	if err != nil {
		return nil, err
	}
	records := make([]templateRecord, 0)
	indexes := make(map[int64]int)
	templateIDs := make([]int64, 0)
	for rows.Next() {
		var (
			item        templateRecord
			description pgtype.Text
		)
		if err := rows.Scan(
			&item.ID,
			&item.Key,
			&item.Kind,
			&item.Title,
			&description,
			&item.SortOrder,
		); err != nil {
			rows.Close()
			return nil, err
		}
		item.Description = Text(description)
		item.Tasks = []templateTaskRecord{}
		indexes[item.ID] = len(records)
		templateIDs = append(templateIDs, item.ID)
		records = append(records, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return nil, err
	}
	rows.Close()
	if len(templateIDs) == 0 {
		return records, nil
	}

	taskRows, err := db.Query(
		ctx,
		`select id, template_id, title, description, sort_order,
		        attachment_key, duration_days
		 from public.workflow_template_tasks
		 where template_id = any($1::bigint[])
		 order by template_id asc, sort_order asc, id asc`,
		templateIDs,
	)
	if err != nil {
		return nil, err
	}
	taskIndexes := make(map[int64]struct{ templateIndex, taskIndex int })
	taskIDs := make([]int64, 0)
	for taskRows.Next() {
		var (
			item          templateTaskRecord
			description   pgtype.Text
			attachmentKey pgtype.Text
			durationDays  pgtype.Int4
		)
		if err := taskRows.Scan(
			&item.ID,
			&item.TemplateID,
			&item.Title,
			&description,
			&item.SortOrder,
			&attachmentKey,
			&durationDays,
		); err != nil {
			taskRows.Close()
			return nil, err
		}
		item.Description = Text(description)
		item.AttachmentKey = Text(attachmentKey)
		item.DurationDays = workflowInt4Pointer(durationDays)
		item.Contents = []templateContentRecord{}
		item.Attachments = []templateAttachmentRecord{}
		templateIndex, ok := indexes[item.TemplateID]
		if !ok {
			continue
		}
		taskIndex := len(records[templateIndex].Tasks)
		records[templateIndex].Tasks = append(records[templateIndex].Tasks, item)
		taskIndexes[item.ID] = struct{ templateIndex, taskIndex int }{templateIndex, taskIndex}
		taskIDs = append(taskIDs, item.ID)
	}
	if err := taskRows.Err(); err != nil {
		taskRows.Close()
		return nil, err
	}
	taskRows.Close()
	if len(taskIDs) == 0 {
		return records, nil
	}

	contentRows, err := db.Query(
		ctx,
		`select id, template_task_id, title, body, sort_order
		 from public.workflow_template_task_contents
		 where template_task_id = any($1::bigint[])
		 order by template_task_id asc, sort_order asc, id asc`,
		taskIDs,
	)
	if err != nil {
		return nil, err
	}
	for contentRows.Next() {
		var (
			item  templateContentRecord
			title pgtype.Text
		)
		if err := contentRows.Scan(
			&item.ID,
			&item.TemplateTaskID,
			&title,
			&item.Body,
			&item.SortOrder,
		); err != nil {
			contentRows.Close()
			return nil, err
		}
		item.Title = Text(title)
		if index, ok := taskIndexes[item.TemplateTaskID]; ok {
			records[index.templateIndex].Tasks[index.taskIndex].Contents =
				append(records[index.templateIndex].Tasks[index.taskIndex].Contents, item)
		}
	}
	if err := contentRows.Err(); err != nil {
		contentRows.Close()
		return nil, err
	}
	contentRows.Close()

	attachmentRows, err := db.Query(
		ctx,
		`select id, template_task_id, r2_key, filename, content_type,
		        file_size, uploader, created_at
		 from public.workflow_template_task_attachments
		 where template_task_id = any($1::bigint[])
		 order by template_task_id asc, id asc`,
		taskIDs,
	)
	if err != nil {
		return nil, err
	}
	for attachmentRows.Next() {
		var (
			item     templateAttachmentRecord
			uploader pgtype.Text
		)
		if err := attachmentRows.Scan(
			&item.ID,
			&item.TemplateTaskID,
			&item.R2Key,
			&item.Filename,
			&item.ContentType,
			&item.FileSize,
			&uploader,
			&item.CreatedAt,
		); err != nil {
			attachmentRows.Close()
			return nil, err
		}
		item.Uploader = Text(uploader)
		if index, ok := taskIndexes[item.TemplateTaskID]; ok {
			records[index.templateIndex].Tasks[index.taskIndex].Attachments =
				append(records[index.templateIndex].Tasks[index.taskIndex].Attachments, item)
		}
	}
	if err := attachmentRows.Err(); err != nil {
		attachmentRows.Close()
		return nil, err
	}
	attachmentRows.Close()
	return records, nil
}

func serializeTemplateRecord(record templateRecord) workflows.TemplateDetail {
	tasks := orderedTemplateTasks(record.Tasks)
	detail := workflows.TemplateDetail{
		TemplateListItem: workflows.TemplateListItem{
			ID:          record.ID,
			Key:         record.Key,
			Kind:        record.Kind,
			Title:       record.Title,
			Description: record.Description,
			SortOrder:   record.SortOrder,
			TaskCount:   len(tasks),
		},
		Tasks: make([]workflows.TemplateTask, 0, len(tasks)),
	}
	for _, task := range tasks {
		item := workflows.TemplateTask{
			ID:            task.ID,
			TemplateID:    task.TemplateID,
			Title:         task.Title,
			Description:   task.Description,
			SortOrder:     task.SortOrder,
			AttachmentKey: task.AttachmentKey,
			DurationDays:  task.DurationDays,
			Contents:      make([]workflows.Content, 0, len(task.Contents)),
			Attachments:   make([]workflows.Attachment, 0, len(task.Attachments)),
		}
		for _, content := range orderedTemplateContents(task.Contents) {
			item.Contents = append(item.Contents, workflows.Content{
				ID:        content.ID,
				Title:     content.Title,
				Body:      content.Body,
				SortOrder: content.SortOrder,
			})
		}
		for _, attachment := range orderedTemplateAttachments(task.Attachments) {
			item.Attachments = append(item.Attachments, workflows.Attachment{
				ID:          attachment.ID,
				Filename:    attachment.Filename,
				ContentType: attachment.ContentType,
				FileSize:    attachment.FileSize,
				Uploader:    attachment.Uploader,
				CreatedAt:   httpapi.Timestamp(attachment.CreatedAt),
				Origin:      nil,
			})
		}
		detail.Tasks = append(detail.Tasks, item)
	}
	return detail
}

func (s *WorkflowStore) CreateWorkflowTemplate(
	ctx context.Context,
	input workflows.TemplateCreateRequest,
) (*workflows.TemplateDetail, error) {
	var result *workflows.TemplateDetail
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		title := truncateRunes(strings.TrimSpace(input.Title), 160)
		key := ""
		if input.Key != nil {
			key = strings.TrimSpace(*input.Key)
		}
		if key == "" {
			key = templateKeyFromTitle(title)
		}
		if utf8.RuneCountInString(key) > 80 {
			return projects.NewAPIError(http.StatusUnprocessableEntity, "模板键不能超过 80 个字符")
		}
		if err := lockEntity(ctx, tx, "template-key:"+key); err != nil {
			return err
		}
		exists, err := templateKeyExists(ctx, txDB, key, 0)
		if err != nil {
			return err
		}
		if exists {
			return projects.NewAPIError(http.StatusUnprocessableEntity, "模板键已存在")
		}
		sortOrder := input.SortOrder
		if sortOrder == nil {
			var maxSort int
			if err := tx.QueryRow(
				ctx,
				`select coalesce(max(sort_order), -1) from public.workflow_templates`,
			).Scan(&maxSort); err != nil {
				return err
			}
			next := maxSort + 1
			sortOrder = &next
		}
		var templateID int64
		if err := tx.QueryRow(
			ctx,
			`insert into public.workflow_templates
			 (key, kind, title, description, sort_order)
			 values ($1, $2, $3, $4, $5)
			 returning id`,
			key,
			input.Kind,
			title,
			input.Description,
			sortOrder,
		).Scan(&templateID); err != nil {
			return mapWorkflowDBError(err)
		}
		created, err := loadTemplateRecords(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		if len(created) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "模板不存在")
		}
		detail := serializeTemplateRecord(created[0])
		result = &detail
		return writeWorkflowAudit(ctx, tx, "workflow.template.create", "workflow_template", templateID, map[string]any{
			"key":   key,
			"kind":  input.Kind,
			"title": title,
		})
	})
	return result, err
}

func (s *WorkflowStore) UpdateWorkflowTemplate(
	ctx context.Context,
	templateID int64,
	input workflows.TemplateUpdateRequest,
) (*workflows.TemplateDetail, error) {
	var result *workflows.TemplateDetail
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		record, err := loadTemplateRecord(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		if record == nil {
			return projects.NewAPIError(http.StatusNotFound, "模板不存在")
		}
		title := record.Title
		if input.Title != nil {
			title = truncateRunes(strings.TrimSpace(*input.Title), 160)
		}
		description := record.Description
		if input.Description.Present {
			description = input.Description.Value
		}
		sortOrder := record.SortOrder
		if input.SortOrder != nil {
			sortOrder = *input.SortOrder
		}
		if _, err := tx.Exec(
			ctx,
			`update public.workflow_templates
			 set title = $2, description = $3, sort_order = $4, updated_at = now()
			 where id = $1`,
			templateID,
			title,
			description,
			sortOrder,
		); err != nil {
			return err
		}
		updated, err := loadTemplateRecords(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		detail := serializeTemplateRecord(updated[0])
		result = &detail
		return writeWorkflowAudit(ctx, tx, "workflow.template.update", "workflow_template", templateID, map[string]any{
			"title": title,
		})
	})
	return result, err
}

func (s *WorkflowStore) DeleteWorkflowTemplate(
	ctx context.Context,
	templateID int64,
) (workflows.TemplateMutation, error) {
	var result workflows.TemplateMutation
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		record, err := loadTemplateRecord(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		if record == nil {
			return projects.NewAPIError(http.StatusNotFound, "模板不存在")
		}
		detail := serializeTemplateRecord(*record)
		keys := templateAttachmentKeys(*record)
		if err := lockAttachmentKeys(ctx, tx, keys); err != nil {
			return err
		}
		tag, err := tx.Exec(ctx, `delete from public.workflow_templates where id = $1`, templateID)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return projects.NewAPIError(http.StatusNotFound, "模板不存在")
		}
		result.Template = &detail
		result.DeleteKeys, err = unreferencedKeys(ctx, txDB, keys)
		if err != nil {
			return err
		}
		return writeWorkflowAudit(ctx, tx, "workflow.template.delete", "workflow_template", templateID, map[string]any{
			"key": record.Key,
		})
	})
	return result, err
}

func (s *WorkflowStore) CopyWorkflowTemplate(
	ctx context.Context,
	templateID int64,
	input workflows.TemplateCopyRequest,
) (*workflows.TemplateDetail, error) {
	var result *workflows.TemplateDetail
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		source, err := loadTemplateRecord(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		if source == nil {
			return projects.NewAPIError(http.StatusNotFound, "模板不存在")
		}
		title := ""
		if input.Title != nil {
			title = strings.TrimSpace(*input.Title)
		}
		if title == "" {
			title = source.Title + "（副本）"
		}
		title = truncateRunes(title, 160)
		key := ""
		if input.Key != nil {
			key = strings.TrimSpace(*input.Key)
		}
		if key == "" {
			key = templateKeyFromTitle(title)
		}
		if utf8.RuneCountInString(key) > 80 {
			return projects.NewAPIError(http.StatusUnprocessableEntity, "模板键不能超过 80 个字符")
		}
		if err := lockEntity(ctx, tx, "template-key:"+key); err != nil {
			return err
		}
		exists, err := templateKeyExists(ctx, txDB, key, 0)
		if err != nil {
			return err
		}
		if exists {
			return projects.NewAPIError(http.StatusUnprocessableEntity, "模板键已存在")
		}
		var cloneID int64
		if err := tx.QueryRow(
			ctx,
			`insert into public.workflow_templates
			 (key, kind, title, description, sort_order)
			 values ($1, $2, $3, $4, $5)
			 returning id`,
			key,
			source.Kind,
			title,
			source.Description,
			source.SortOrder+1,
		).Scan(&cloneID); err != nil {
			return mapWorkflowDBError(err)
		}
		ordered := orderedTemplateTasks(source.Tasks)
		for _, sourceTask := range ordered {
			var clonedTaskID int64
			if err := tx.QueryRow(
				ctx,
				`insert into public.workflow_template_tasks
				 (template_id, title, description, sort_order, attachment_key, duration_days)
				 values ($1, $2, $3, $4, $5, $6)
				 returning id`,
				cloneID,
				sourceTask.Title,
				sourceTask.Description,
				sourceTask.SortOrder,
				sourceTask.AttachmentKey,
				sourceTask.DurationDays,
			).Scan(&clonedTaskID); err != nil {
				return err
			}
			for _, content := range orderedTemplateContents(sourceTask.Contents) {
				if _, err := tx.Exec(
					ctx,
					`insert into public.workflow_template_task_contents
					 (template_task_id, title, body, sort_order)
					 values ($1, $2, $3, $4)`,
					clonedTaskID,
					content.Title,
					content.Body,
					content.SortOrder,
				); err != nil {
					return err
				}
			}
			for _, attachment := range orderedTemplateAttachments(sourceTask.Attachments) {
				if _, err := tx.Exec(
					ctx,
					`insert into public.workflow_template_task_attachments
					 (template_task_id, r2_key, filename, content_type, file_size, uploader)
					 values ($1, $2, $3, $4, $5, $6)`,
					clonedTaskID,
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
		cloned, err := loadTemplateRecords(ctx, txDB, "t.id = $1", cloneID)
		if err != nil {
			return err
		}
		detail := serializeTemplateRecord(cloned[0])
		result = &detail
		return writeWorkflowAudit(ctx, tx, "workflow.template.copy", "workflow_template", cloneID, map[string]any{
			"source_template_id": templateID,
			"key":                key,
		})
	})
	return result, err
}

func (s *WorkflowStore) CreateTemplateTask(
	ctx context.Context,
	templateID int64,
	input workflows.TemplateTaskCreateRequest,
) (*workflows.TemplateDetail, error) {
	var result *workflows.TemplateDetail
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		record, err := loadTemplateRecord(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		if record == nil {
			return projects.NewAPIError(http.StatusNotFound, "模板不存在")
		}
		existing, maxSort, err := loadTemplateTaskOrder(ctx, txDB, templateID)
		if err != nil {
			return err
		}
		sortOrder := maxSort + 1
		if input.SortOrder != nil {
			sortOrder = *input.SortOrder
			if sortOrder > len(existing) {
				sortOrder = len(existing)
			}
		}
		var taskID int64
		if err := tx.QueryRow(
			ctx,
			`insert into public.workflow_template_tasks
			 (template_id, title, description, sort_order, attachment_key, duration_days)
			 values ($1, $2, $3, $4, $5, $6)
			 returning id`,
			templateID,
			truncateRunes(strings.TrimSpace(input.Title), 160),
			input.Description,
			sortOrder,
			input.AttachmentKey,
			input.DurationDays,
		).Scan(&taskID); err != nil {
			return err
		}
		if input.SortOrder != nil {
			desired := insertInt64At(existing, taskID, *input.SortOrder)
			if err := rewriteTemplateTaskOrder(ctx, tx, templateID, desired); err != nil {
				return err
			}
		}
		updated, err := loadTemplateRecords(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		detail := serializeTemplateRecord(updated[0])
		result = &detail
		return writeWorkflowAudit(ctx, tx, "workflow.template.task.create", "workflow_template_task", taskID, map[string]any{
			"template_id": templateID,
			"title":       input.Title,
		})
	})
	return result, err
}

func (s *WorkflowStore) UpdateTemplateTask(
	ctx context.Context,
	taskID int64,
	input workflows.TemplateTaskUpdateRequest,
) (*workflows.TemplateDetail, error) {
	var result *workflows.TemplateDetail
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var templateID int64
		err := tx.QueryRow(
			ctx,
			`select template_id from public.workflow_template_tasks where id = $1`,
			taskID,
		).Scan(&templateID)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "节点不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		var (
			title         string
			description   pgtype.Text
			attachmentKey pgtype.Text
			durationDays  pgtype.Int4
		)
		err = tx.QueryRow(
			ctx,
			`select title, description, attachment_key, duration_days
			 from public.workflow_template_tasks where id = $1`,
			taskID,
		).Scan(&title, &description, &attachmentKey, &durationDays)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "节点不存在")
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
		tag, err := tx.Exec(
			ctx,
			`update public.workflow_template_tasks
			 set title = $2, description = $3, attachment_key = $4,
			     duration_days = $5, updated_at = now()
			 where id = $1`,
			taskID,
			title,
			description,
			attachmentKey,
			durationDays,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return projects.NewAPIError(http.StatusNotFound, "节点不存在")
		}
		updated, err := loadTemplateRecords(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		detail := serializeTemplateRecord(updated[0])
		result = &detail
		return writeWorkflowAudit(ctx, tx, "workflow.template.task.update", "workflow_template_task", taskID, map[string]any{
			"template_id": templateID,
			"title":       title,
		})
	})
	return result, err
}

func (s *WorkflowStore) DeleteTemplateTask(
	ctx context.Context,
	taskID int64,
) (workflows.TemplateMutation, error) {
	var result workflows.TemplateMutation
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var templateID int64
		err := tx.QueryRow(
			ctx,
			`select template_id from public.workflow_template_tasks where id = $1`,
			taskID,
		).Scan(&templateID)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "节点不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		keys, err := loadTemplateAttachmentKeysForTask(ctx, txDB, taskID)
		if err != nil {
			return err
		}
		if err := lockAttachmentKeys(ctx, tx, keys); err != nil {
			return err
		}
		tag, err := tx.Exec(
			ctx,
			`delete from public.workflow_template_tasks where id = $1`,
			taskID,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return projects.NewAPIError(http.StatusNotFound, "节点不存在")
		}
		if err := rewriteTemplateTaskOrderDense(ctx, tx, templateID); err != nil {
			return err
		}
		updated, err := loadTemplateRecords(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		if len(updated) == 0 {
			return projects.NewAPIError(http.StatusNotFound, "模板不存在")
		}
		detail := serializeTemplateRecord(updated[0])
		result.Template = &detail
		result.DeleteKeys, err = unreferencedKeys(ctx, txDB, keys)
		if err != nil {
			return err
		}
		return writeWorkflowAudit(ctx, tx, "workflow.template.task.delete", "workflow_template_task", taskID, map[string]any{
			"template_id": templateID,
		})
	})
	return result, err
}

func (s *WorkflowStore) ReorderTemplateTasks(
	ctx context.Context,
	templateID int64,
	taskIDs []int64,
) (*workflows.TemplateDetail, error) {
	var result *workflows.TemplateDetail
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		record, err := loadTemplateRecord(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		if record == nil {
			return projects.NewAPIError(http.StatusNotFound, "模板不存在")
		}
		existing, _, err := loadTemplateTaskOrder(ctx, txDB, templateID)
		if err != nil {
			return err
		}
		if err := validateOrderSet(existing, taskIDs); err != nil {
			return projects.NewAPIError(http.StatusUnprocessableEntity, "排序列表必须恰好包含该模板的全部节点")
		}
		if err := rewriteTemplateTaskOrder(ctx, tx, templateID, taskIDs); err != nil {
			return err
		}
		updated, err := loadTemplateRecords(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		detail := serializeTemplateRecord(updated[0])
		result = &detail
		return writeWorkflowAudit(ctx, tx, "workflow.template.task.reorder", "workflow_template", templateID, map[string]any{
			"task_ids": taskIDs,
		})
	})
	return result, err
}

func (s *WorkflowStore) CreateTemplateContent(
	ctx context.Context,
	taskID int64,
	input workflows.TemplateContentCreateRequest,
) (*workflows.TemplateDetail, error) {
	var result *workflows.TemplateDetail
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var templateID int64
		err := tx.QueryRow(
			ctx,
			`select template_id from public.workflow_template_tasks where id = $1`,
			taskID,
		).Scan(&templateID)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "节点不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		var templateAfterLock int64
		err = tx.QueryRow(
			ctx,
			`select template_id from public.workflow_template_tasks where id = $1`,
			taskID,
		).Scan(&templateAfterLock)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && templateAfterLock != templateID) {
			return projects.NewAPIError(http.StatusNotFound, "节点不存在")
		}
		if err != nil {
			return err
		}
		var maxSort int
		if err := tx.QueryRow(
			ctx,
			`select coalesce(max(sort_order), -1)
			 from public.workflow_template_task_contents where template_task_id = $1`,
			taskID,
		).Scan(&maxSort); err != nil {
			return err
		}
		sortOrder := maxSort + 1
		if input.SortOrder != nil {
			sortOrder = *input.SortOrder
		}
		var contentID int64
		if err := tx.QueryRow(
			ctx,
			`insert into public.workflow_template_task_contents
			 (template_task_id, title, body, sort_order)
			 values ($1, $2, $3, $4)
			 returning id`,
			taskID,
			trimmedTextPointer(input.Title),
			input.Body,
			sortOrder,
		).Scan(&contentID); err != nil {
			return err
		}
		updated, err := loadTemplateRecords(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		detail := serializeTemplateRecord(updated[0])
		result = &detail
		return writeWorkflowAudit(ctx, tx, "workflow.template.content.create", "workflow_template_task_content", contentID, map[string]any{
			"template_id":      templateID,
			"template_task_id": taskID,
		})
	})
	return result, err
}

func (s *WorkflowStore) UpdateTemplateContent(
	ctx context.Context,
	contentID int64,
	input workflows.TemplateContentUpdateRequest,
) (*workflows.TemplateDetail, error) {
	var result *workflows.TemplateDetail
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var (
			templateID int64
			taskID     int64
		)
		err := tx.QueryRow(
			ctx,
			`select c.template_task_id, t.template_id
			 from public.workflow_template_task_contents as c
			 join public.workflow_template_tasks as t on t.id = c.template_task_id
			 where c.id = $1`,
			contentID,
		).Scan(&taskID, &templateID)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "内容不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		var (
			body  string
			title pgtype.Text
		)
		err = tx.QueryRow(
			ctx,
			`select body, title from public.workflow_template_task_contents where id = $1`,
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
			`update public.workflow_template_task_contents
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
		updated, err := loadTemplateRecords(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		detail := serializeTemplateRecord(updated[0])
		result = &detail
		return writeWorkflowAudit(ctx, tx, "workflow.template.content.update", "workflow_template_task_content", contentID, map[string]any{
			"template_id":      templateID,
			"template_task_id": taskID,
		})
	})
	return result, err
}

func (s *WorkflowStore) DeleteTemplateContent(
	ctx context.Context,
	contentID int64,
) (*workflows.TemplateDetail, error) {
	var result *workflows.TemplateDetail
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var (
			taskID     int64
			templateID int64
		)
		err := tx.QueryRow(
			ctx,
			`select c.template_task_id, t.template_id
			 from public.workflow_template_task_contents as c
			 join public.workflow_template_tasks as t on t.id = c.template_task_id
			 where c.id = $1`,
			contentID,
		).Scan(&taskID, &templateID)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "内容不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		tag, err := tx.Exec(
			ctx,
			`delete from public.workflow_template_task_contents where id = $1`,
			contentID,
		)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return projects.NewAPIError(http.StatusNotFound, "内容不存在")
		}
		if err := rewriteTemplateContentOrderDense(ctx, tx, taskID); err != nil {
			return err
		}
		updated, err := loadTemplateRecords(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		detail := serializeTemplateRecord(updated[0])
		result = &detail
		return writeWorkflowAudit(ctx, tx, "workflow.template.content.delete", "workflow_template_task_content", contentID, map[string]any{
			"template_id":      templateID,
			"template_task_id": taskID,
		})
	})
	return result, err
}

func (s *WorkflowStore) InsertTemplateAttachment(
	ctx context.Context,
	taskID int64,
	input workflows.AttachmentUpload,
) (*workflows.TemplateDetail, error) {
	var result *workflows.TemplateDetail
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var templateID int64
		err := tx.QueryRow(
			ctx,
			`select template_id from public.workflow_template_tasks where id = $1`,
			taskID,
		).Scan(&templateID)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "节点不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		var templateAfterLock int64
		err = tx.QueryRow(
			ctx,
			`select template_id from public.workflow_template_tasks where id = $1`,
			taskID,
		).Scan(&templateAfterLock)
		if errors.Is(err, pgx.ErrNoRows) || (err == nil && templateAfterLock != templateID) {
			return projects.NewAPIError(http.StatusNotFound, "节点不存在")
		}
		if err != nil {
			return err
		}
		var attachmentID int64
		if err := tx.QueryRow(
			ctx,
			`insert into public.workflow_template_task_attachments
			 (template_task_id, r2_key, filename, content_type, file_size, uploader)
			 values ($1, $2, $3, $4, $5, $6)
			 returning id`,
			taskID,
			input.R2Key,
			input.Filename,
			input.ContentType,
			input.FileSize,
			input.Uploader,
		).Scan(&attachmentID); err != nil {
			return err
		}
		updated, err := loadTemplateRecords(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		detail := serializeTemplateRecord(updated[0])
		result = &detail
		return writeWorkflowAudit(ctx, tx, "workflow.template.attachment.upload", "workflow_template_task_attachment", attachmentID, map[string]any{
			"template_id":      templateID,
			"template_task_id": taskID,
			"filename":         input.Filename,
			"file_size":        input.FileSize,
		})
	})
	return result, err
}

func (s *WorkflowStore) DeleteTemplateAttachment(
	ctx context.Context,
	attachmentID int64,
) (workflows.TemplateMutation, error) {
	var result workflows.TemplateMutation
	err := s.inTx(ctx, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)
		var (
			taskID     int64
			templateID int64
			r2Key      string
		)
		err := tx.QueryRow(
			ctx,
			`select a.template_task_id, t.template_id, a.r2_key
			 from public.workflow_template_task_attachments as a
			 join public.workflow_template_tasks as t on t.id = a.template_task_id
			 where a.id = $1`,
			attachmentID,
		).Scan(&taskID, &templateID, &r2Key)
		if errors.Is(err, pgx.ErrNoRows) {
			return projects.NewAPIError(http.StatusNotFound, "附件不存在")
		}
		if err != nil {
			return err
		}
		if err := lockEntity(ctx, tx, fmt.Sprintf("template:%d", templateID)); err != nil {
			return err
		}
		if err := lockAttachmentKeys(ctx, tx, []string{r2Key}); err != nil {
			return err
		}
		count, err := templateAttachmentReferenceCount(ctx, txDB, r2Key, attachmentID)
		if err != nil {
			return err
		}
		tag, err := tx.Exec(
			ctx,
			`delete from public.workflow_template_task_attachments where id = $1`,
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
		updated, err := loadTemplateRecords(ctx, txDB, "t.id = $1", templateID)
		if err != nil {
			return err
		}
		detail := serializeTemplateRecord(updated[0])
		result.Template = &detail
		return writeWorkflowAudit(ctx, tx, "workflow.template.attachment.delete", "workflow_template_task_attachment", attachmentID, map[string]any{
			"template_id":      templateID,
			"template_task_id": taskID,
		})
	})
	return result, err
}

func orderedTemplateTasks(tasks []templateTaskRecord) []templateTaskRecord {
	result := append([]templateTaskRecord(nil), tasks...)
	sort.Slice(result, func(i, j int) bool {
		if result[i].SortOrder == result[j].SortOrder {
			return result[i].ID < result[j].ID
		}
		return result[i].SortOrder < result[j].SortOrder
	})
	return result
}

func orderedTemplateContents(contents []templateContentRecord) []templateContentRecord {
	result := append([]templateContentRecord(nil), contents...)
	sort.Slice(result, func(i, j int) bool {
		if result[i].SortOrder == result[j].SortOrder {
			return result[i].ID < result[j].ID
		}
		return result[i].SortOrder < result[j].SortOrder
	})
	return result
}

func orderedTemplateAttachments(attachments []templateAttachmentRecord) []templateAttachmentRecord {
	result := append([]templateAttachmentRecord(nil), attachments...)
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}

func templateAttachmentKeys(record templateRecord) []string {
	keys := make([]string, 0)
	for _, task := range record.Tasks {
		for _, attachment := range task.Attachments {
			keys = append(keys, attachment.R2Key)
		}
	}
	return keys
}

func loadTemplateTaskOrder(
	ctx context.Context,
	db DB,
	templateID int64,
) ([]int64, int, error) {
	rows, err := db.Query(
		ctx,
		`select id, sort_order
		 from public.workflow_template_tasks
		 where template_id = $1
		 order by sort_order asc, id asc`,
		templateID,
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

func rewriteTemplateTaskOrder(
	ctx context.Context,
	tx pgx.Tx,
	templateID int64,
	ids []int64,
) error {
	for index, id := range ids {
		if _, err := tx.Exec(
			ctx,
			`update public.workflow_template_tasks
			 set sort_order = $2, updated_at = now()
			 where template_id = $1 and id = $3`,
			templateID,
			index,
			id,
		); err != nil {
			return err
		}
	}
	return nil
}

func rewriteTemplateTaskOrderDense(ctx context.Context, tx pgx.Tx, templateID int64) error {
	rows, err := tx.Query(
		ctx,
		`select id
		 from public.workflow_template_tasks
		 where template_id = $1
		 order by sort_order asc, id asc`,
		templateID,
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
	return rewriteTemplateTaskOrder(ctx, tx, templateID, ids)
}

func rewriteTemplateContentOrderDense(
	ctx context.Context,
	tx pgx.Tx,
	taskID int64,
) error {
	rows, err := tx.Query(
		ctx,
		`select id
		 from public.workflow_template_task_contents
		 where template_task_id = $1
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
			`update public.workflow_template_task_contents
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

func loadTemplateAttachmentKeysForTask(
	ctx context.Context,
	db DB,
	taskID int64,
) ([]string, error) {
	rows, err := db.Query(
		ctx,
		`select r2_key
		 from public.workflow_template_task_attachments
		 where template_task_id = $1`,
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

func templateAttachmentReferenceCount(
	ctx context.Context,
	db DB,
	key string,
	excludeTemplateID int64,
) (int64, error) {
	var count int64
	err := db.QueryRow(
		ctx,
		`select
		   (select count(*) from public.workflow_template_task_attachments
		    where r2_key = $1 and id <> $2) +
		   (select count(*) from public.project_workflow_task_attachments
		    where r2_key = $1)`,
		key,
		excludeTemplateID,
	).Scan(&count)
	return count, err
}

func templateKeyExists(
	ctx context.Context,
	db DB,
	key string,
	excludeID int64,
) (bool, error) {
	var id int64
	query := `select id from public.workflow_templates where key = $1`
	args := []any{key}
	if excludeID > 0 {
		query += ` and id <> $2`
		args = append(args, excludeID)
	}
	err := db.QueryRow(ctx, query, args...).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

func templateKeyFromTitle(title string) string {
	var builder strings.Builder
	lastDash := false
	for _, current := range strings.TrimSpace(title) {
		if unicode.IsLetter(current) || unicode.IsDigit(current) {
			builder.WriteRune(current)
			lastDash = false
			continue
		}
		if !lastDash {
			builder.WriteByte('-')
			lastDash = true
		}
	}
	prefix := strings.Trim(builder.String(), "-")
	if prefix == "" {
		prefix = "template"
	}
	prefix = truncateRunes(prefix, 60)
	key := prefix + "-" + randomSuffix()
	return truncateRunes(key, 80)
}
