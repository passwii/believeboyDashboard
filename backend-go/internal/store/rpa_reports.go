package store

import (
	"context"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/rpa_reports"
)

var rpaReportTypes = []string{
	"inventory_report",
	"business_report",
	"ad_search_term_share_report",
	"ad_budget_report",
	"ad_campaign_report",
	"ad_purchased_product_report",
	"ad_promoted_product_report",
	"ad_invalid_traffic_report",
	"ad_placement_report",
	"ad_target_report",
	"ad_search_term_report",
	"ad_time_trend_report",
	"sales_report",
	"payment_report",
	"return_report",
}

type RpaReportsStore struct {
	db FullDB
}

func NewRpaReportsStore(db FullDB) *RpaReportsStore {
	return &RpaReportsStore{db: db}
}

type projectItem struct {
	id        int64
	name      string
	sortOrder int
}

func (s *RpaReportsStore) getProjects(ctx context.Context, operator string, isAdmin bool) ([]projectItem, error) {
	var query string
	var args []any
	if isAdmin {
		query = `
			select id, project_name, coalesce(sort_order, 0)
			from public.projects
			where coalesce(is_active, true) = true
			order by sort_order asc, id asc
		`
	} else {
		operator = strings.TrimSpace(operator)
		if operator == "" {
			return []projectItem{}, nil
		}
		query = `
			select id, project_name, coalesce(sort_order, 0)
			from public.projects
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
			order by sort_order asc, id asc
		`
		args = append(args, operator)
	}

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	if rows != nil {
		defer rows.Close()
	}
	if rows == nil {
		return []projectItem{}, nil
	}

	var res []projectItem
	for rows.Next() {
		var p projectItem
		if err := rows.Scan(&p.id, &p.name, &p.sortOrder); err != nil {
			return nil, err
		}
		res = append(res, p)
	}
	return res, rows.Err()
}

func (s *RpaReportsStore) GetReportStatusForDate(ctx context.Context, reportDate, country, operator string, isAdmin bool) (*rpa_reports.RpaReportStatusResponse, error) {
	country = strings.ToUpper(strings.TrimSpace(country))
	if country == "" {
		country = "US"
	}

	projects, err := s.getProjects(ctx, operator, isAdmin)
	if err != nil {
		return nil, err
	}
	if len(projects) == 0 {
		return &rpa_reports.RpaReportStatusResponse{Country: country, Items: []rpa_reports.ProjectReportStatus{}}, nil
	}

	projectIDs := make([]int64, len(projects))
	statusByProject := make(map[int64]map[string]*rpa_reports.ReportTypeStatus)
	for i, p := range projects {
		projectIDs[i] = p.id
		statusMap := make(map[string]*rpa_reports.ReportTypeStatus)
		for _, rt := range rpaReportTypes {
			statusMap[rt] = &rpa_reports.ReportTypeStatus{
				ReportType: rt,
				HasData:    false,
				IsUploaded: false,
			}
		}
		statusByProject[p.id] = statusMap
	}

	// Priority 1: report_upload_logs
	logQuery := `
		select l.project_id, l.report_type, l.has_real_data, l.created_at, l.source_file_id,
		       s.original_filename, s.report_type as s_rtype, s.period_end_date::text, s.snapshot_at
		from report_upload_logs l
		left join analysis_source_files s on l.source_file_id = s.id
		where l.project_id = ANY($1) and l.country = $2 and l.upload_date = $3
		order by l.created_at asc
	`
	lRows, err := s.db.Query(ctx, logQuery, projectIDs, country, reportDate)
	if err == nil && lRows != nil {
		defer lRows.Close()
		for lRows.Next() {
			var pid int64
			var rType string
			var hasRealData bool
			var createdAt time.Time
			var sourceFileID *int64
			var origFilename, sRType, periodEndDate *string
			var snapshotAt *time.Time
			if err := lRows.Scan(&pid, &rType, &hasRealData, &createdAt, &sourceFileID,
				&origFilename, &sRType, &periodEndDate, &snapshotAt); err != nil {
				continue
			}
			pMap, ok := statusByProject[pid]
			if !ok {
				continue
			}
			st, ok := pMap[rType]
			if !ok {
				continue
			}

			latestDate := reportDate
			if sRType != nil {
				if *sRType == "inventory_report" && snapshotAt != nil {
					latestDate = snapshotAt.Format("2006-01-02")
				} else if periodEndDate != nil && *periodEndDate != "" {
					latestDate = *periodEndDate
				}
			}

			source := "upload_log"
			st.HasData = hasRealData
			st.IsUploaded = true
			st.LatestDate = &latestDate
			st.OriginalFilename = origFilename
			st.StatusSource = &source
		}
	}

	// Priority 2: fallback query on analysis_source_files
	srcQuery := `
		select project_id, report_type, original_filename, coalesce(row_count_total, 0),
		       period_end_date::text, snapshot_at, created_at
		from analysis_source_files
		where project_id = ANY($1) and country = $2 and is_current = true and ingestion_status = 'success'
		  and (
		    (report_type in ('business_report', 'payment_report', 'sales_report', 'return_report')
		     and period_start_date is not null and period_end_date is not null
		     and period_start_date <= $3 and period_end_date >= $3)
		    or
		    (report_type = 'inventory_report' and snapshot_at::date = $3)
		  )
		order by created_at asc
	`
	sRows, err := s.db.Query(ctx, srcQuery, projectIDs, country, reportDate)
	if err == nil && sRows != nil {
		defer sRows.Close()
		for sRows.Next() {
			var pid int64
			var rType string
			var origFilename, periodEndDate *string
			var rowCount int
			var snapshotAt *time.Time
			var createdAt time.Time
			if err := sRows.Scan(&pid, &rType, &origFilename, &rowCount, &periodEndDate, &snapshotAt, &createdAt); err != nil {
				continue
			}
			pMap, ok := statusByProject[pid]
			if !ok {
				continue
			}
			st, ok := pMap[rType]
			if !ok || st.IsUploaded {
				continue
			}

			var bizDate *string
			if rType == "inventory_report" && snapshotAt != nil {
				formatted := snapshotAt.Format("2006-01-02")
				bizDate = &formatted
			} else if periodEndDate != nil {
				bizDate = periodEndDate
			}

			source := "business_date_backfill"
			st.HasData = rowCount > 0
			st.IsUploaded = true
			st.LatestDate = bizDate
			st.OriginalFilename = origFilename
			st.StatusSource = &source
		}
	}

	// Priority 3: fallback query on ad_upload_files for 10 ad report types
	var adReportTypes []string
	for _, rt := range rpaReportTypes {
		if strings.HasPrefix(rt, "ad_") && strings.HasSuffix(rt, "_report") {
			adReportTypes = append(adReportTypes, rt)
		}
	}
	adQuery := `
		select project_id, report_type, original_filename, coalesce(row_count_preview, 0),
		       report_date::text, created_at
		from ad_upload_files
		where project_id = ANY($1) and country = $2 and is_current = true and ingestion_status = 'success'
		  and report_type = ANY($3)
		  and period_start_date <= $4 and period_end_date >= $4
		order by created_at asc
	`
	aRows, err := s.db.Query(ctx, adQuery, projectIDs, country, adReportTypes, reportDate)
	if err == nil && aRows != nil {
		defer aRows.Close()
		for aRows.Next() {
			var pid int64
			var rType string
			var origFilename, repDate *string
			var rowCount int
			var createdAt time.Time
			if err := aRows.Scan(&pid, &rType, &origFilename, &rowCount, &repDate, &createdAt); err != nil {
				continue
			}
			pMap, ok := statusByProject[pid]
			if !ok {
				continue
			}
			st, ok := pMap[rType]
			if !ok || st.IsUploaded {
				continue
			}

			source := "business_date_backfill"
			st.HasData = rowCount > 0
			st.IsUploaded = true
			st.LatestDate = repDate
			st.OriginalFilename = origFilename
			st.StatusSource = &source
		}
	}

	items := make([]rpa_reports.ProjectReportStatus, len(projects))
	for i, p := range projects {
		pMap := statusByProject[p.id]
		statuses := make([]rpa_reports.ReportTypeStatus, len(rpaReportTypes))
		for j, rt := range rpaReportTypes {
			statuses[j] = *pMap[rt]
		}
		items[i] = rpa_reports.ProjectReportStatus{
			ProjectID:   p.id,
			ProjectName: p.name,
			Country:     country,
			Statuses:    statuses,
		}
	}

	return &rpa_reports.RpaReportStatusResponse{
		Country: country,
		Items:   items,
	}, nil
}
