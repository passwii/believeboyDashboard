package main

import (
	"context"
	"fmt"

	"github.com/passwii/believeboyDashboard/backend-go/internal/mailer"
	"github.com/passwii/believeboyDashboard/backend-go/internal/scheduledreport"
	"github.com/passwii/believeboyDashboard/backend-go/internal/store"
	"github.com/passwii/believeboyDashboard/backend-go/internal/tasks"
)

type scheduledDispatchExecutor struct {
	db     store.FullDB
	sender *mailer.Mailer
}

func (executor scheduledDispatchExecutor) Execute(ctx context.Context, taskType string, payload any) (any, error) {
	switch taskType {
	case "dispatch_one":
		requestPayload, ok := payload.(*tasks.DispatchOnePayload)
		if !ok || requestPayload == nil {
			return nil, fmt.Errorf("dispatch_one payload has unexpected type %T", payload)
		}
		return scheduledreport.DispatchOne(ctx, executor.db, executor.sender, scheduledreport.DispatchRequest{
			SubscriptionID: requestPayload.SubscriptionID,
			Email:          requestPayload.Email,
			ProjectIDs:     requestPayload.ProjectIDs,
			Country:        requestPayload.Country,
			Frequency:      requestPayload.Frequency,
			ReportDate:     requestPayload.ReportDate,
			TriggeredBy:    requestPayload.TriggeredBy,
		})
	case "generate_delivery_summary":
		return nil, fmt.Errorf("generate_delivery_summary is not ported to Go yet")
	default:
		return nil, fmt.Errorf("unsupported external task type %q", taskType)
	}
}
