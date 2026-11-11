package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/scheduledreport"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
)

func main() {
	country := flag.String("country", "US", "site country")
	projectIDs := flag.String("project-ids", "", "comma separated project ids; empty means all")
	date := flag.String("date", "", "report date YYYY-MM-DD; empty means anchor date")
	frequency := flag.String("frequency", "daily", "daily/weekly/monthly")
	flag.Parse()

	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		fmt.Fprintln(os.Stderr, "DATABASE_URL is required")
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := store.OpenPool(ctx, databaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "open database:", err)
		os.Exit(1)
	}
	defer pool.Close()
	db := store.NewPGXDB(pool)

	options := scheduledreport.DailyOptions{Country: *country, Frequency: *frequency}
	if strings.TrimSpace(*projectIDs) != "" {
		for _, part := range strings.Split(*projectIDs, ",") {
			id, err := strconv.ParseInt(strings.TrimSpace(part), 10, 64)
			if err != nil {
				fmt.Fprintln(os.Stderr, "invalid project id:", part)
				os.Exit(1)
			}
			options.ProjectIDs = append(options.ProjectIDs, id)
		}
	}
	if strings.TrimSpace(*date) != "" {
		parsed, err := time.ParseInLocation("2006-01-02", *date, time.Local)
		if err != nil {
			fmt.Fprintln(os.Stderr, "invalid date:", err)
			os.Exit(1)
		}
		options.ReferenceDate = &parsed
	}

	result, err := scheduledreport.BuildDailyReportData(ctx, db, options)
	if err != nil {
		fmt.Fprintln(os.Stderr, "build report data:", err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, "encode:", err)
		os.Exit(1)
	}
}
