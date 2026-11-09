package notification_settings

import (
	"fmt"
	"time"

	"github.com/passwii/believeboyDashboard/backend-go/internal/config"
	resendmailer "github.com/passwii/believeboyDashboard/backend-go/internal/mailer"
)

func newEnvironmentMailer() Mailer {
	cfg, err := config.Load()
	if err != nil {
		return nil
	}
	from := cfg.AlertFromEmail
	if cfg.AlertFromName != "" {
		from = fmt.Sprintf("%s <%s>", cfg.AlertFromName, cfg.AlertFromEmail)
	}
	return resendmailer.New(resendmailer.Config{
		APIKey:  cfg.ResendAPIKey,
		From:    from,
		BaseURL: cfg.ResendBaseURL,
		Timeout: 30 * time.Second,
	})
}
