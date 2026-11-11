package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/api/complaints"
	"github.com/passwii/believeboyDashboard/backend-go/internal/auth"
)

type ComplaintStore struct {
	db FullDB
}

func NewComplaintStore(db FullDB) *ComplaintStore {
	return &ComplaintStore{db: db}
}

func isOperatorSeparator(r rune) bool {
	return r == ',' || r == '、' || r == '，' || r == ';' || r == '\n' || r == '\r' || r == '\t' || r == ' '
}

func textContainsName(value *string, target string) bool {
	target = strings.TrimSpace(target)
	if target == "" || value == nil {
		return false
	}
	for _, name := range strings.FieldsFunc(*value, isOperatorSeparator) {
		if strings.TrimSpace(name) == target {
			return true
		}
	}
	return false
}

func normalizeCountry(c string) string {
	upper := strings.ToUpper(strings.TrimSpace(c))
	if upper == "GB" {
		return "UK"
	}
	return upper
}

func (s *ComplaintStore) VerifyProjectAccess(ctx context.Context, projectID int64, op string, isAdmin bool) error {
	if isAdmin {
		return nil
	}
	var projOp, asstOp *string
	err := s.db.QueryRow(ctx, "select project_operator, assistant_operator from public.projects where id = $1", projectID).Scan(&projOp, &asstOp)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return complaints.ErrProjectNotFound
		}
		return err
	}
	op = strings.TrimSpace(op)
	if op == "" {
		return complaints.ErrProjectForbidden
	}
	if textContainsName(projOp, op) || textContainsName(asstOp, op) {
		return nil
	}
	return complaints.ErrProjectForbidden
}

func (s *ComplaintStore) getAccessibleProjectIDs(ctx context.Context, op string, isAdmin bool) ([]int64, error) {
	if isAdmin {
		return nil, nil
	}
	op = strings.TrimSpace(op)
	if op == "" {
		return []int64{}, nil
	}
	rows, err := s.db.Query(ctx, `
		select id from public.projects
		where coalesce(is_active, true) = true
		  and (
		    exists (
		      select 1 from unnest(regexp_split_to_array(
		        coalesce(project_operator, ''),
		        '[、,，;' || chr(10) || ']+'
		      )) as names(value)
		      where btrim(names.value) = $1
		    )
		    or exists (
		      select 1 from unnest(regexp_split_to_array(
		        coalesce(assistant_operator, ''),
		        '[、,，;' || chr(10) || ']+'
		      )) as names(value)
		      where btrim(names.value) = $1
		    )
		  )
		order by id asc
	`, op)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if ids == nil {
		ids = []int64{}
	}
	return ids, rows.Err()
}

func slaLevel(status string, sla *complaints.SlaInfo, now time.Time) string {
	if status == "replied" || status == "resolved" || status == "closed_no_response" {
		return "closed"
	}
	if sla == nil || sla.ReplyDeadline == nil || *sla.ReplyDeadline == "" {
		return "ok"
	}
	deadline, err := time.Parse(time.RFC3339, *sla.ReplyDeadline)
	if err != nil {
		deadline, err = time.Parse(time.RFC3339Nano, *sla.ReplyDeadline)
		if err != nil {
			deadline, err = time.Parse("2006-01-02T15:04:05", *sla.ReplyDeadline)
			if err != nil {
				return "ok"
			}
		}
	}
	deadline = deadline.UTC()
	if !deadline.After(now) {
		return "overdue"
	}
	if deadline.Sub(now) < 24*time.Hour {
		return "due_soon"
	}
	return "ok"
}

func (s *ComplaintStore) GetOverview(ctx context.Context, targetDate string, country *string) (complaints.OverviewResponse, error) {
	parsedDate, err := time.Parse("2006-01-02", targetDate)
	if err != nil {
		parsedDate = time.Now().UTC()
		targetDate = parsedDate.Format("2006-01-02")
	}

	user, _ := auth.UserContextFromContext(ctx)
	var filterProjects bool
	var accessibleIDs []int64
	if explicitIDs, ok := complaints.AccessibleProjectIDsFromContext(ctx); ok {
		filterProjects = true
		accessibleIDs = explicitIDs
		if len(accessibleIDs) == 0 {
			return complaints.OverviewResponse{
				Date:     targetDate,
				Metrics:  complaints.OverviewMetrics{},
				Trend:    []complaints.OverviewTrendPoint{},
				Projects: []complaints.OverviewProjectRow{},
			}, nil
		}
	} else if !user.IsAdmin {
		filterProjects = true
		accessibleIDs, err = s.getAccessibleProjectIDs(ctx, user.Operator, false)
		if err != nil {
			return complaints.OverviewResponse{}, err
		}
		if len(accessibleIDs) == 0 {
			return complaints.OverviewResponse{
				Date:     targetDate,
				Metrics:  complaints.OverviewMetrics{},
				Trend:    []complaints.OverviewTrendPoint{},
				Projects: []complaints.OverviewProjectRow{},
			}, nil
		}
	}

	var runID int64
	err = s.db.QueryRow(ctx, "select id from public.complaint_runs where run_date = $1", targetDate).Scan(&runID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return complaints.OverviewResponse{
				Date:     targetDate,
				Metrics:  complaints.OverviewMetrics{},
				Trend:    []complaints.OverviewTrendPoint{},
				Projects: []complaints.OverviewProjectRow{},
			}, nil
		}
		return complaints.OverviewResponse{}, err
	}

	type shopCheckRow struct {
		ProjectID   int64
		ProjectName string
		Country     string
		CheckStatus string
		MetricsJSON *string
	}
	var shopChecks []shopCheckRow
	{
		var conditions []string
		var args []any
		args = append(args, runID)
		idx := 2
		conditions = append(conditions, "sc.run_id = $1")

		if country != nil && *country != "" {
			conditions = append(conditions, fmt.Sprintf("upper(sc.country) = $%d", idx))
			args = append(args, normalizeCountry(*country))
			idx++
		}
		if filterProjects {
			conditions = append(conditions, fmt.Sprintf("sc.project_id = any($%d)", idx))
			args = append(args, accessibleIDs)
			idx++
		}
		where := "where " + strings.Join(conditions, " and ")
		query := fmt.Sprintf(`
			select sc.project_id, coalesce(p.project_name, '#' || sc.project_id::text), sc.country, sc.check_status, sc.metrics::text
			from public.shop_checks sc
			left join public.projects p on p.id = sc.project_id
			%s
			order by sc.project_id asc
		`, where)
		rows, err := s.db.Query(ctx, query, args...)
		if err != nil {
			return complaints.OverviewResponse{}, err
		}
		defer rows.Close()
		for rows.Next() {
			var sc shopCheckRow
			if err := rows.Scan(&sc.ProjectID, &sc.ProjectName, &sc.Country, &sc.CheckStatus, &sc.MetricsJSON); err == nil {
				sc.Country = normalizeCountry(sc.Country)
				shopChecks = append(shopChecks, sc)
			}
		}
	}

	type complaintRecord struct {
		ProjectID int64
		Country   string
		Status    string
		SLA       *complaints.SlaInfo
	}
	complaintsByShop := make(map[string][]complaintRecord)
	{
		var conditions []string
		var args []any
		args = append(args, runID)
		idx := 2
		conditions = append(conditions, "c.run_id = $1")

		if country != nil && *country != "" {
			conditions = append(conditions, fmt.Sprintf("upper(c.country) = $%d", idx))
			args = append(args, normalizeCountry(*country))
			idx++
		}
		if filterProjects {
			conditions = append(conditions, fmt.Sprintf("c.project_id = any($%d)", idx))
			args = append(args, accessibleIDs)
			idx++
		}
		where := "where " + strings.Join(conditions, " and ")
		query := fmt.Sprintf(`
			select c.project_id, c.country, c.status, c.sla::text
			from public.complaints c
			%s
		`, where)
		rows, err := s.db.Query(ctx, query, args...)
		if err != nil {
			return complaints.OverviewResponse{}, err
		}
		defer rows.Close()
		for rows.Next() {
			var r complaintRecord
			var slaJSON *string
			if err := rows.Scan(&r.ProjectID, &r.Country, &r.Status, &slaJSON); err == nil {
				r.Country = normalizeCountry(r.Country)
				if slaJSON != nil {
					_ = json.Unmarshal([]byte(*slaJSON), &r.SLA)
				}
				key := fmt.Sprintf("%d:%s", r.ProjectID, r.Country)
				complaintsByShop[key] = append(complaintsByShop[key], r)
			}
		}
	}

	now := time.Now().UTC()
	var metrics complaints.OverviewMetrics
	var projectRows []complaints.OverviewProjectRow

	for _, sc := range shopChecks {
		key := fmt.Sprintf("%d:%s", sc.ProjectID, sc.Country)
		shopComplaints := complaintsByShop[key]
		needs := 0
		resolved := 0
		soon := 0
		overdue := 0

		for _, c := range shopComplaints {
			lvl := slaLevel(c.Status, c.SLA, now)
			if c.Status == "replied" || c.Status == "resolved" || c.Status == "closed_no_response" {
				resolved++
			} else {
				needs++
				if lvl == "due_soon" {
					soon++
				}
				if lvl == "overdue" {
					overdue++
				}
			}
		}

		metrics.TotalNeedsReply += needs
		metrics.TotalResolved += resolved
		metrics.SLADueSoon += soon
		metrics.SLAOverdue += overdue

		if sc.MetricsJSON != nil {
			var scm map[string]any
			if err := json.Unmarshal([]byte(*sc.MetricsJSON), &scm); err == nil {
				if v, ok := scm["reported_unresolved"].(float64); ok {
					metrics.TotalReportedUnresolved += int(v)
				}
			}
		}

		projectRows = append(projectRows, complaints.OverviewProjectRow{
			ProjectID:   sc.ProjectID,
			ProjectName: sc.ProjectName,
			Country:     sc.Country,
			CheckStatus: sc.CheckStatus,
			NeedsReply:  needs,
			Resolved:    resolved,
			SLADueSoon:  soon,
			SLAOverdue:  overdue,
		})
	}

	trendStart := parsedDate.AddDate(0, 0, -29)
	trendSQL := `
		select run_date::text, summary::text
		from public.complaint_runs
		where run_date >= $1 and run_date <= $2
		order by run_date asc
	`
	tRows, err := s.db.Query(ctx, trendSQL, trendStart.Format("2006-01-02"), targetDate)
	trendMap := make(map[string]int)
	if err == nil {
		defer tRows.Close()
		for tRows.Next() {
			var rDate, summaryStr string
			if err := tRows.Scan(&rDate, &summaryStr); err == nil {
				var summary map[string]any
				if err := json.Unmarshal([]byte(summaryStr), &summary); err == nil {
					if val, ok := summary["total_needs_reply"].(float64); ok {
						trendMap[rDate] = int(val)
					}
				}
			}
		}
	}
	trend := make([]complaints.OverviewTrendPoint, 30)
	for i := 0; i < 30; i++ {
		curDate := trendStart.AddDate(0, 0, i).Format("2006-01-02")
		trend[i] = complaints.OverviewTrendPoint{
			Date:       curDate,
			NeedsReply: trendMap[curDate],
		}
	}

	return complaints.OverviewResponse{
		Date:     targetDate,
		Metrics:  metrics,
		Trend:    trend,
		Projects: projectRows,
	}, nil
}

func (s *ComplaintStore) ListComplaints(ctx context.Context, filter complaints.ComplaintFilter) (complaints.ComplaintListResponse, error) {
	var conditions []string
	var args []any
	idx := 1

	if filter.Date != nil && *filter.Date != "" {
		conditions = append(conditions, fmt.Sprintf("c.run_id in (select id from public.complaint_runs where run_date = $%d)", idx))
		args = append(args, *filter.Date)
		idx++
	}

	if filter.ProjectID != nil && *filter.ProjectID > 0 {
		conditions = append(conditions, fmt.Sprintf("c.project_id = $%d", idx))
		args = append(args, *filter.ProjectID)
		idx++
	} else if len(filter.ProjectIDs) > 0 {
		conditions = append(conditions, fmt.Sprintf("c.project_id = any($%d)", idx))
		args = append(args, filter.ProjectIDs)
		idx++
	} else if !filter.IsAdmin {
		accessible, err := s.getAccessibleProjectIDs(ctx, filter.Operator, false)
		if err != nil {
			return complaints.ComplaintListResponse{}, err
		}
		if len(accessible) == 0 {
			return complaints.ComplaintListResponse{
				Items:     []complaints.ComplaintListItem{},
				Total:     0,
				Page:      filter.Page,
				PageSize:  filter.PageSize,
				SpamCount: 0,
			}, nil
		}
		conditions = append(conditions, fmt.Sprintf("c.project_id = any($%d)", idx))
		args = append(args, accessible)
		idx++
	}

	if filter.Country != nil && *filter.Country != "" {
		conditions = append(conditions, fmt.Sprintf("upper(c.country) = $%d", idx))
		args = append(args, normalizeCountry(*filter.Country))
		idx++
	}
	if filter.Category != nil && *filter.Category != "" {
		conditions = append(conditions, fmt.Sprintf("c.category = $%d", idx))
		args = append(args, *filter.Category)
		idx++
	}
	if filter.Status != nil && *filter.Status != "" {
		conditions = append(conditions, fmt.Sprintf("c.status = $%d", idx))
		args = append(args, *filter.Status)
		idx++
	}
	if filter.Keyword != nil && *filter.Keyword != "" {
		conditions = append(conditions, fmt.Sprintf("(c.buyer_name ilike $%d or c.subject ilike $%d or c.message_body ilike $%d)", idx, idx, idx))
		args = append(args, "%"+*filter.Keyword+"%")
		idx++
	}
	if filter.FirstMessageDate != nil && *filter.FirstMessageDate != "" {
		conditions = append(conditions, fmt.Sprintf("c.first_message_date = $%d", idx))
		args = append(args, *filter.FirstMessageDate)
		idx++
	}

	where := ""
	if len(conditions) > 0 {
		where = "where " + strings.Join(conditions, " and ")
	}

	var total int
	err := s.db.QueryRow(ctx, fmt.Sprintf("select count(*) from public.complaints c %s", where), args...).Scan(&total)
	if err != nil {
		return complaints.ComplaintListResponse{}, err
	}

	var spamCount int
	spamWhere := ""
	if where != "" {
		spamWhere = where + " and c.category = 'spam'"
	} else {
		spamWhere = "where c.category = 'spam'"
	}
	_ = s.db.QueryRow(ctx, fmt.Sprintf("select count(*) from public.complaints c %s", spamWhere), args...).Scan(&spamCount)

	sortClause := "(case when c.status in ('pending', 'drafted', 'replied') then 0 else 1 end) asc, c.sla->>'reply_deadline' asc nulls last, c.id asc"
	switch filter.Sort {
	case "sla_desc":
		sortClause = "(case when c.status in ('pending', 'drafted', 'replied') then 0 else 1 end) asc, c.sla->>'reply_deadline' desc nulls last, c.id asc"
	case "date_asc":
		sortClause = "(case when c.status in ('pending', 'drafted', 'replied') then 0 else 1 end) asc, c.message_date asc, c.id asc"
	case "date_desc":
		sortClause = "(case when c.status in ('pending', 'drafted', 'replied') then 0 else 1 end) asc, c.message_date desc, c.id asc"
	}

	limit := filter.PageSize
	offset := (filter.Page - 1) * filter.PageSize
	if offset < 0 {
		offset = 0
	}

	querySQL := fmt.Sprintf(`
		select
			c.id, c.run_id, c.project_id, coalesce(p.project_name, '#' || c.project_id::text), c.country,
			c.buyer_name, c.first_message_date::text, c.message_date::text,
			c.subject, c.category, c.has_order, c.status,
			c.triage::text, c.order_info::text, c.sla::text, c.status_history::text,
			c.draft_path, c.reply_sent_at, c.handler_note,
			c.message_count, c.created_at, c.updated_at
		from public.complaints c
		left join public.projects p on p.id = c.project_id
		%s
		order by %s
		limit $%d offset $%d
	`, where, sortClause, idx, idx+1)
	args = append(args, limit, offset)

	rows, err := s.db.Query(ctx, querySQL, args...)
	if err != nil {
		return complaints.ComplaintListResponse{}, err
	}
	defer rows.Close()

	var items []complaints.ComplaintListItem
	for rows.Next() {
		var it complaints.ComplaintListItem
		var triageJSON, orderInfoJSON, slaJSON, historyJSON *string
		var replySentAt, createdAt, updatedAt *time.Time

		if err := rows.Scan(
			&it.ID, &it.RunID, &it.ProjectID, &it.ProjectName, &it.Country,
			&it.BuyerName, &it.FirstMessageDate, &it.MessageDate,
			&it.Subject, &it.Category, &it.HasOrder, &it.Status,
			&triageJSON, &orderInfoJSON, &slaJSON, &historyJSON,
			&it.DraftPath, &replySentAt, &it.HandlerNote,
			&it.MessageCount, &createdAt, &updatedAt,
		); err == nil {
			it.Country = normalizeCountry(it.Country)
			if triageJSON != nil {
				_ = json.Unmarshal([]byte(*triageJSON), &it.Triage)
			}
			if orderInfoJSON != nil {
				_ = json.Unmarshal([]byte(*orderInfoJSON), &it.OrderInfo)
			}
			if slaJSON != nil {
				_ = json.Unmarshal([]byte(*slaJSON), &it.SLA)
			}
			if historyJSON != nil {
				_ = json.Unmarshal([]byte(*historyJSON), &it.StatusHistory)
			}
			if replySentAt != nil {
				t := replySentAt.UTC().Format(time.RFC3339Nano)
				it.ReplySentAt = &t
			}
			if createdAt != nil {
				it.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
			}
			if updatedAt != nil {
				it.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
			}
			items = append(items, it)
		}
	}

	return complaints.ComplaintListResponse{
		Items:     items,
		Total:     total,
		Page:      filter.Page,
		PageSize:  filter.PageSize,
		SpamCount: spamCount,
	}, nil
}

func (s *ComplaintStore) getComplaintWithDB(ctx context.Context, db DB, id int64) (*complaints.ComplaintDetail, error) {
	querySQL := `
		select
			c.id, c.run_id, c.project_id, coalesce(p.project_name, '#' || c.project_id::text), c.country,
			c.buyer_name, c.first_message_date::text, c.message_date::text,
			c.subject, c.category, c.has_order, c.status,
			c.triage::text, c.order_info::text, c.sla::text, c.status_history::text,
			c.draft_path, c.reply_sent_at, c.handler_note,
			c.message_count, c.message_body, c.messages::text, c.created_at, c.updated_at
		from public.complaints c
		left join public.projects p on p.id = c.project_id
		where c.id = $1
	`
	row := db.QueryRow(ctx, querySQL, id)
	var d complaints.ComplaintDetail
	var triageJSON, orderInfoJSON, slaJSON, historyJSON, messagesJSON *string
	var replySentAt, createdAt, updatedAt *time.Time

	err := row.Scan(
		&d.ID, &d.RunID, &d.ProjectID, &d.ProjectName, &d.Country,
		&d.BuyerName, &d.FirstMessageDate, &d.MessageDate,
		&d.Subject, &d.Category, &d.HasOrder, &d.Status,
		&triageJSON, &orderInfoJSON, &slaJSON, &historyJSON,
		&d.DraftPath, &replySentAt, &d.HandlerNote,
		&d.MessageCount, &d.MessageBody, &messagesJSON, &createdAt, &updatedAt,
	)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}

	d.Country = normalizeCountry(d.Country)
	if triageJSON != nil {
		_ = json.Unmarshal([]byte(*triageJSON), &d.Triage)
	}
	if orderInfoJSON != nil {
		_ = json.Unmarshal([]byte(*orderInfoJSON), &d.OrderInfo)
	}
	if slaJSON != nil {
		_ = json.Unmarshal([]byte(*slaJSON), &d.SLA)
	}
	if historyJSON != nil {
		_ = json.Unmarshal([]byte(*historyJSON), &d.StatusHistory)
	}
	if messagesJSON != nil {
		_ = json.Unmarshal([]byte(*messagesJSON), &d.Messages)
	}
	if replySentAt != nil {
		t := replySentAt.UTC().Format(time.RFC3339Nano)
		d.ReplySentAt = &t
	}
	if createdAt != nil {
		d.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	}
	if updatedAt != nil {
		d.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	}

	return &d, nil
}

func (s *ComplaintStore) GetComplaint(ctx context.Context, id int64) (*complaints.ComplaintDetail, error) {
	return s.getComplaintWithDB(ctx, s.db, id)
}

func (s *ComplaintStore) PatchComplaint(ctx context.Context, id int64, req complaints.ComplaintPatchRequest, op string) (*complaints.ComplaintDetail, error) {
	var updatedDetail *complaints.ComplaintDetail
	err := RunInTx(ctx, s.db, func(tx pgx.Tx) error {
		txDB := NewTxDB(tx)

		// 1. SELECT FOR UPDATE to lock the row
		querySQL := `
			select
				c.id, c.run_id, c.project_id, coalesce(p.project_name, '#' || c.project_id::text), c.country,
				c.buyer_name, c.first_message_date::text, c.message_date::text,
				c.subject, c.category, c.has_order, c.status,
				c.triage::text, c.order_info::text, c.sla::text, c.status_history::text,
				c.draft_path, c.reply_sent_at, c.handler_note,
				c.message_count, c.message_body, c.messages::text, c.created_at, c.updated_at
			from public.complaints c
			left join public.projects p on p.id = c.project_id
			where c.id = $1
			for update of c
		`
		row := txDB.QueryRow(ctx, querySQL, id)
		var d complaints.ComplaintDetail
		var triageJSON, orderInfoJSON, slaJSON, historyJSON, messagesJSON *string
		var replySentAt, createdAt, updatedAt *time.Time

		err := row.Scan(
			&d.ID, &d.RunID, &d.ProjectID, &d.ProjectName, &d.Country,
			&d.BuyerName, &d.FirstMessageDate, &d.MessageDate,
			&d.Subject, &d.Category, &d.HasOrder, &d.Status,
			&triageJSON, &orderInfoJSON, &slaJSON, &historyJSON,
			&d.DraftPath, &replySentAt, &d.HandlerNote,
			&d.MessageCount, &d.MessageBody, &messagesJSON, &createdAt, &updatedAt,
		)
		if err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return fmt.Errorf("404: 客诉 %d 不存在", id)
			}
			return err
		}

		currentStatus := d.Status
		if historyJSON != nil {
			_ = json.Unmarshal([]byte(*historyJSON), &d.StatusHistory)
		}

		var sets []string
		var args []any
		idx := 2
		args = append(args, id)

		statusChanged := false
		if req.Status != nil && *req.Status != currentStatus {
			if !complaints.CanTransition(currentStatus, *req.Status) {
				return fmt.Errorf("400: 非法状态流转：%s → %s", currentStatus, *req.Status)
			}
			now := time.Now().UTC()
			nowStr := now.Format(time.RFC3339Nano)
			entry := complaints.ComplaintStatusHistoryEntry{
				From:       &currentStatus,
				FromStatus: &currentStatus,
				To:         *req.Status,
				ToStatus:   *req.Status,
				At:         nowStr,
				Timestamp:  nowStr,
				By:         op,
				Operator:   op,
				Note:       req.HandlerNote,
			}
			d.StatusHistory = append(d.StatusHistory, entry)
			historyBytes, _ := json.Marshal(d.StatusHistory)

			sets = append(sets, fmt.Sprintf("status = $%d", idx))
			args = append(args, *req.Status)
			idx++

			sets = append(sets, fmt.Sprintf("status_history = $%d::jsonb", idx))
			args = append(args, string(historyBytes))
			idx++
			statusChanged = true
		}

		if req.DraftPath != nil {
			sets = append(sets, fmt.Sprintf("draft_path = $%d", idx))
			args = append(args, *req.DraftPath)
			idx++
		}
		if req.HandlerNote != nil {
			sets = append(sets, fmt.Sprintf("handler_note = $%d", idx))
			args = append(args, *req.HandlerNote)
			idx++
		}
		if req.ReplySentAt != nil {
			if *req.ReplySentAt == "" {
				sets = append(sets, "reply_sent_at = null")
			} else {
				parsedTime, parseErr := time.Parse(time.RFC3339, *req.ReplySentAt)
				if parseErr != nil {
					parsedTime, parseErr = time.Parse(time.RFC3339Nano, *req.ReplySentAt)
				}
				if parseErr != nil {
					return fmt.Errorf("400: reply_sent_at 时间格式无效: %s", *req.ReplySentAt)
				}
				sets = append(sets, fmt.Sprintf("reply_sent_at = $%d", idx))
				args = append(args, parsedTime)
				idx++
			}
		}

		if len(sets) == 0 {
			updatedDetail = &d
			return nil
		}

		sets = append(sets, "updated_at = now()")

		var updateSQL string
		if statusChanged {
			updateSQL = fmt.Sprintf(`update public.complaints set %s where id = $1 and status = $%d`, strings.Join(sets, ", "), idx)
			args = append(args, currentStatus)
		} else {
			updateSQL = fmt.Sprintf(`update public.complaints set %s where id = $1`, strings.Join(sets, ", "))
		}

		tag, err := txDB.Exec(ctx, updateSQL, args...)
		if err != nil {
			return err
		}
		if tag.RowsAffected() == 0 {
			return fmt.Errorf("409: 客诉状态已被并发修改，请刷新后重试")
		}

		reloaded, err := s.getComplaintWithDB(ctx, txDB, id)
		if err != nil {
			return err
		}
		updatedDetail = reloaded
		return nil
	})
	if err != nil {
		if strings.Contains(err.Error(), "404") {
			return nil, nil
		}
		return nil, err
	}
	return updatedDetail, nil
}
