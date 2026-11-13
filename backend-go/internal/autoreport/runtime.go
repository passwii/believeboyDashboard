package autoreport

import (
	"context"
	"sync"
	"time"
)

// Summary aggregates one sweep.
type Summary struct {
	Total   int
	OK      int
	Skipped int
	Failed  int
	Results []FileResult
}

// FileResult pairs a file with its outcome.
type FileResult struct {
	File   File
	Result Result
	Err    error
}

func (s *Summary) add(file File, result Result, err error) {
	s.Total++
	switch {
	case err != nil:
		s.Failed++
	case result.Status == "ok":
		s.OK++
	case result.Status == "skipped":
		s.Skipped++
	}
	s.Results = append(s.Results, FileResult{File: file, Result: result, Err: err})
}

// Runner drives the sweep/process loop.
type Runner struct {
	Config    Config
	Processor *Processor
}

// Sweep collects eligible files and processes them with a bounded worker pool.
func (r *Runner) Sweep(ctx context.Context) (Summary, []error) {
	files, collectErrs := r.Config.Collect()
	if len(files) == 0 {
		return Summary{}, collectErrs
	}
	return r.processFiles(ctx, files), collectErrs
}

func (r *Runner) processFiles(ctx context.Context, files []File) Summary {
	workers := r.Config.Workers
	if workers < 1 {
		workers = 1
	}
	if workers > len(files) {
		workers = len(files)
	}

	var (
		mu      sync.Mutex
		wg      sync.WaitGroup
		queue   = make(chan File)
		summary Summary
	)
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for file := range queue {
				result, err := r.processWithRetry(ctx, file)
				mu.Lock()
				summary.add(file, result, err)
				mu.Unlock()
			}
		}()
	}

	for _, file := range files {
		select {
		case <-ctx.Done():
			break
		case queue <- file:
		}
		if ctx.Err() != nil {
			break
		}
	}
	close(queue)
	wg.Wait()

	mu.Lock()
	defer mu.Unlock()
	return summary
}

func (r *Runner) processWithRetry(ctx context.Context, file File) (Result, error) {
	if !WaitForStable(file.Path, r.Config.StableSamples, r.Config.StablePoll, nil) {
		return Result{Status: "skipped", Reason: "文件在等待写盘完成时消失"}, nil
	}
	var lastErr error
	for attempt := 1; attempt <= r.Config.MaxAttempts; attempt++ {
		result, err := r.Processor.Process(ctx, file)
		if err == nil {
			return result, nil
		}
		lastErr = err
		if ctx.Err() != nil {
			return Result{}, ctx.Err()
		}
		if _, clientError := clientGatewayError(err); clientError {
			// 4xx will not become 2xx by retrying the same file.
			return Result{}, err
		}
		if attempt < r.Config.MaxAttempts {
			sleep(ctx, time.Duration(attempt)*time.Second)
		}
	}
	return Result{}, lastErr
}

// Run performs an initial sweep and then polls until ctx is cancelled.
func (r *Runner) Run(ctx context.Context) error {
	r.report(r.Sweep(ctx))
	if r.Config.Once {
		return nil
	}
	ticker := time.NewTicker(r.Config.PollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			r.report(r.Sweep(ctx))
			if r.Config.Once {
				return nil
			}
		}
	}
}

func (r *Runner) report(summary Summary, collectErrs []error) {
	for _, err := range collectErrs {
		r.Config.Logf("扫描警告: %v", err)
	}
	for _, item := range summary.Results {
		switch {
		case item.Err != nil:
			r.Config.Logf("FAIL %s [%s] %v", item.File.Path, item.File.ProjectName, item.Err)
		case item.Result.Status == "skipped":
			r.Config.Logf("SKIP %s [%s] %s", item.File.Path, item.File.ProjectName, item.Result.Reason)
		default:
			r.Config.Logf("OK   %s [%s] %s -> %s", item.File.Path, item.File.ProjectName, item.Result.ReportType, item.Result.Archived)
		}
	}
	r.Config.Logf("本轮汇总: 总计 %d，成功 %d，跳过 %d，失败 %d",
		summary.Total, summary.OK, summary.Skipped, summary.Failed)
}

func sleep(ctx context.Context, duration time.Duration) {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-timer.C:
	}
}
