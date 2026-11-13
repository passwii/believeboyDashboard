// Command autoreport-upload watches project report folders and uploads new
// reports through the Go gateway.
//
// It is the Go replacement for the legacy autoReportUpload Python service:
//
//	autoreport-upload            # initial sweep + poll loop
//	autoreport-upload --once     # one sweep, then exit
//	autoreport-upload --dry-run  # recognize only, no commit, no file moves
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/passwii/believeboyDashboard/backend-go/internal/autoreport"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "autoreport-upload:", err)
		os.Exit(1)
	}
}

func run() error {
	root := flag.String("root", "", "watch root (default: WATCH_ROOT or /Users/damon/Documents/RPA)")
	once := flag.Bool("once", false, "run a single sweep and exit")
	dryRun := flag.Bool("dry-run", false, "recognize but do not commit or move files")
	workers := flag.Int("workers", 0, "concurrent file workers (default from AUTORUN_WATCH_WORKERS)")
	flag.Parse()

	env := osEnviron()
	if *root != "" {
		env["WATCH_ROOT"] = *root
	}
	if *once {
		env["AUTORUN_ONCE"] = "1"
	}
	if *dryRun {
		env["AUTORUN_DRY_RUN"] = "1"
	}
	if *workers > 0 {
		env["AUTORUN_WATCH_WORKERS"] = fmt.Sprintf("%d", *workers)
	}

	config, err := autoreport.LoadConfig(env)
	if err != nil {
		return err
	}
	if _, err := os.Stat(config.WatchRoot); err != nil {
		return fmt.Errorf("watch root %s is not readable: %w", config.WatchRoot, err)
	}

	lock, err := autoreport.AcquireLock(config.WatchRoot)
	if err != nil {
		return err
	}
	defer lock.Release()
	config.Logf("autoreport-upload 启动：root=%s workers=%d dry_run=%v once=%v lock=%s",
		config.WatchRoot, config.Workers, config.DryRun, config.Once, lock.Path())

	client := autoreport.NewClient(config)
	runner := &autoreport.Runner{
		Config:    config,
		Processor: &autoreport.Processor{Config: config, Client: client},
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	return runner.Run(ctx)
}

func osEnviron() map[string]string {
	env := make(map[string]string, 64)
	for _, entry := range os.Environ() {
		for index := 0; index < len(entry); index++ {
			if entry[index] == '=' {
				env[entry[:index]] = entry[index+1:]
				break
			}
		}
	}
	return env
}
