package autoreport

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeGateway simulates the two upload modules.
type fakeGateway struct {
	adRecognized     []string // filenames the ad endpoint accepts
	reportRecognized []string // filenames the report endpoint accepts
	projectName      string
	committed        []string
	dryRunCalls      int
	requests         int
}

func (f *fakeGateway) handler(t *testing.T) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/ad-upload/recognize", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-API-Key") == "" {
			t.Error("missing X-API-Key header")
		}
		if r.Header.Get("X-Operator") != DefaultOperator {
			t.Errorf("operator header = %q", r.Header.Get("X-Operator"))
		}
		filename, country := readMultipart(t, r)
		if !contains(f.adRecognized, filename) {
			writeDetail(w, http.StatusBadRequest, "未匹配任何广告报表类型")
			return
		}
		if country != "US" {
			t.Errorf("country = %q, want US", country)
		}
		writeJSON(w, map[string]any{
			"temp_file_id":        "ad-temp-1",
			"original_filename":   filename,
			"report_type":         "ad_campaign_report",
			"report_label":        "广告活动报告",
			"status":              "recognized",
			"country":             "US",
			"detected_start_date": "2026-10-01",
			"detected_end_date":   "2026-10-31",
			"project_match":       map[string]any{"status": "matched", "project_name": f.projectName},
		})
	})
	mux.HandleFunc("/api/v1/ad-upload/commit", func(w http.ResponseWriter, r *http.Request) {
		f.requests++
		var payload AdCommitRequest
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode ad commit: %v", err)
		}
		if payload.ReportType != "ad_campaign_report" {
			t.Errorf("report type = %q", payload.ReportType)
		}
		if payload.DryRun {
			f.dryRunCalls++
		}
		f.committed = append(f.committed, *payload.ProjectName)
		writeJSON(w, map[string]any{
			"report_type":  "ad_campaign_report",
			"project_name": *payload.ProjectName,
			"country":      payload.Country,
			"file_id":      "ad-file-1",
			"message":      "广告报表已入库",
		})
	})
	mux.HandleFunc("/api/v1/report-upload/recognize", func(w http.ResponseWriter, r *http.Request) {
		filename, _ := readMultipart(t, r)
		if !contains(f.reportRecognized, filename) {
			writeDetail(w, http.StatusBadRequest, "无法识别该报表")
			return
		}
		writeJSON(w, map[string]any{
			"temp_file_id":      "report-temp-1",
			"original_filename": filename,
			"report_type":       "sales_report",
			"status":            "recognized",
			"country":           "US",
			"detected_date":     "2026-10-15",
			"project_match":     map[string]any{"status": "matched", "project_name": f.projectName},
		})
	})
	mux.HandleFunc("/api/v1/report-upload/commit", func(w http.ResponseWriter, r *http.Request) {
		f.requests++
		var payload ReportCommitRequest
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode report commit: %v", err)
		}
		if payload.DryRun {
			f.dryRunCalls++
		}
		f.committed = append(f.committed, *payload.ProjectName)
		writeJSON(w, map[string]any{
			"report_type":  "sales_report",
			"project_name": *payload.ProjectName,
			"country":      payload.Country,
			"file_id":      "report-file-1",
			"message":      "销售报表已入库",
		})
	})
	return mux
}

func readMultipart(t *testing.T, r *http.Request) (string, string) {
	t.Helper()
	if err := r.ParseMultipartForm(64 << 20); err != nil {
		t.Errorf("parse multipart: %v", err)
		return "", ""
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		t.Errorf("form file: %v", err)
		return "", ""
	}
	file.Close()
	return header.Filename, r.FormValue("country")
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(value)
}

func writeDetail(w http.ResponseWriter, status int, detail string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"detail": detail})
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func startGateway(t *testing.T, fake *fakeGateway) (Config, func([]File, []error) error) {
	t.Helper()
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	config := testConfig(t, t.TempDir())
	config.BaseURL = server.URL
	return config, func(files []File, errs []error) error { return nil }
}

func setupProject(t *testing.T, config Config, project, filename string) File {
	t.Helper()
	path := filepath.Join(config.WatchRoot, project, filename)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("col1,col2\n1,2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return File{Path: path, ProjectName: project, Country: "US"}
}

func TestProcessorCommitsAdReportAndArchivesToAdFolder(t *testing.T) {
	fake := &fakeGateway{adRecognized: []string{"ad.xlsx"}, projectName: "博朗姆"}
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	config := testConfig(t, t.TempDir())
	config.BaseURL = server.URL

	file := setupProject(t, config, "博朗姆", "ad.xlsx")
	processor := &Processor{Config: config, Client: NewClient(config)}
	result, err := processor.Process(t.Context(), file)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if result.Status != "ok" {
		t.Fatalf("status = %q (%s)", result.Status, result.Reason)
	}
	if !result.AdReport || result.ReportType != "ad_campaign_report" {
		t.Fatalf("result = %+v", result)
	}
	if !strings.HasSuffix(result.Archived, filepath.Join("广告Processed", "ad.xlsx")) {
		t.Fatalf("archived = %q", result.Archived)
	}
	if _, err := os.Stat(file.Path); !os.IsNotExist(err) {
		t.Fatal("source file should have moved")
	}
	if len(fake.committed) != 1 || fake.committed[0] != "博朗姆" {
		t.Fatalf("committed projects = %v", fake.committed)
	}
}

func TestProcessorFallsBackToGenericReport(t *testing.T) {
	fake := &fakeGateway{reportRecognized: []string{"sales.csv"}, projectName: "卡斯摩"}
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	config := testConfig(t, t.TempDir())
	config.BaseURL = server.URL

	file := setupProject(t, config, "卡斯摩", "sales.csv")
	processor := &Processor{Config: config, Client: NewClient(config)}
	result, err := processor.Process(t.Context(), file)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if result.Status != "ok" || result.ReportType != "sales_report" || result.AdReport {
		t.Fatalf("result = %+v", result)
	}
	if !strings.HasSuffix(result.Archived, filepath.Join("processed", "sales.csv")) {
		t.Fatalf("archived = %q", result.Archived)
	}
}

func TestProcessorSkipsUnknownReportAndKeepsFile(t *testing.T) {
	fake := &fakeGateway{projectName: "博朗姆"}
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	config := testConfig(t, t.TempDir())
	config.BaseURL = server.URL

	file := setupProject(t, config, "博朗姆", "unknown.xlsx")
	processor := &Processor{Config: config, Client: NewClient(config)}
	result, err := processor.Process(t.Context(), file)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if result.Status != "skipped" || result.Reason == "" {
		t.Fatalf("result = %+v", result)
	}
	if _, err := os.Stat(file.Path); err != nil {
		t.Fatal("skipped file must stay in place")
	}
}

func TestProcessorSkipsProjectMismatch(t *testing.T) {
	fake := &fakeGateway{adRecognized: []string{"ad.xlsx"}, projectName: "卡斯摩"}
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	config := testConfig(t, t.TempDir())
	config.BaseURL = server.URL

	file := setupProject(t, config, "博朗姆", "ad.xlsx")
	processor := &Processor{Config: config, Client: NewClient(config)}
	result, err := processor.Process(t.Context(), file)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if result.Status != "skipped" || !strings.Contains(result.Reason, "不一致") {
		t.Fatalf("result = %+v", result)
	}
	if _, err := os.Stat(file.Path); err != nil {
		t.Fatal("mismatched file must stay in place")
	}
}

func TestProcessorDryRunDoesNotMove(t *testing.T) {
	fake := &fakeGateway{adRecognized: []string{"ad.xlsx"}, projectName: "博朗姆"}
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	config := testConfig(t, t.TempDir())
	config.BaseURL = server.URL
	config.DryRun = true

	file := setupProject(t, config, "博朗姆", "ad.xlsx")
	processor := &Processor{Config: config, Client: NewClient(config)}
	result, err := processor.Process(t.Context(), file)
	if err != nil {
		t.Fatalf("Process: %v", err)
	}
	if result.Status != "ok" || result.Archived != "" {
		t.Fatalf("result = %+v", result)
	}
	if _, err := os.Stat(file.Path); err != nil {
		t.Fatal("dry run must not move the file")
	}
	if fake.dryRunCalls != 1 {
		t.Fatalf("dry run calls = %d", fake.dryRunCalls)
	}
}

func TestClientMapsGatewayErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeDetail(w, http.StatusBadRequest, "bad request")
	}))
	t.Cleanup(server.Close)
	config := testConfig(t, t.TempDir())
	config.BaseURL = server.URL
	client := NewClient(config)

	_, err := client.RecognizeReport(t.Context(), setupProject(t, config, "博朗姆", "x.xlsx").Path, "US")
	var gatewayErr *GatewayError
	if !errors.As(err, &gatewayErr) || gatewayErr.Status != http.StatusBadRequest {
		t.Fatalf("err = %v", err)
	}
}

func TestRunnerSweepArchivesAllRecognizedFiles(t *testing.T) {
	fake := &fakeGateway{
		adRecognized:     []string{"ad.xlsx"},
		reportRecognized: []string{"sales.csv"},
		projectName:      "博朗姆",
	}
	server := httptest.NewServer(fake.handler(t))
	t.Cleanup(server.Close)
	config := testConfig(t, t.TempDir())
	config.BaseURL = server.URL

	setupProject(t, config, "博朗姆", "ad.xlsx")
	setupProject(t, config, "博朗姆", "sales.csv")
	setupProject(t, config, "博朗姆", "unknown.xlsx")

	runner := &Runner{Config: config, Processor: &Processor{Config: config, Client: NewClient(config)}}
	summary, errs := runner.Sweep(t.Context())
	if len(errs) != 0 {
		t.Fatalf("collect errors: %v", errs)
	}
	if summary.Total != 3 || summary.OK != 2 || summary.Skipped != 1 {
		t.Fatalf("summary = %+v", summary)
	}
	if _, err := os.Stat(filepath.Join(config.WatchRoot, "博朗姆", ProcessedSubdir, "sales.csv")); err != nil {
		t.Fatalf("sales report not archived: %v", err)
	}
	if _, err := os.Stat(filepath.Join(config.WatchRoot, "博朗姆", AdProcessedSubdir, "ad.xlsx")); err != nil {
		t.Fatalf("ad report not archived: %v", err)
	}
}

func TestRunnerRetriesTransientErrors(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/recognize") {
			attempts++
			if attempts == 1 {
				http.Error(w, "temporary failure", http.StatusInternalServerError)
				return
			}
		}
		writeDetail(w, http.StatusBadRequest, "unmatched")
	}))
	t.Cleanup(server.Close)
	config := testConfig(t, t.TempDir())
	config.BaseURL = server.URL
	config.MaxAttempts = 3
	config.Workers = 1
	config.StableSamples = 1

	file := setupProject(t, config, "博朗姆", "x.xlsx")
	processor := &Processor{Config: config, Client: NewClient(config)}
	runner := &Runner{Config: config, Processor: processor}
	result, err := runner.processWithRetry(t.Context(), File{Path: file.Path, ProjectName: file.ProjectName, Country: "US"})
	if err != nil {
		t.Fatalf("retry failed: %v", err)
	}
	if result.Status != "skipped" {
		t.Fatalf("result = %+v", result)
	}
	if attempts < 2 {
		t.Fatalf("expected a retry, attempts = %d", attempts)
	}
}
