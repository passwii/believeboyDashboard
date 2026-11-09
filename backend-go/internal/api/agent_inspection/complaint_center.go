package agent_inspection

import (
	"context"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
	"github.com/passwii/believeboyDashboard/backend-go/internal/agentauth"
)

const maxComplaintBatchBytes int64 = 10 * 1024 * 1024

func (h *Handler) ComplaintBatch(w http.ResponseWriter, r *http.Request) {
	idempotencyKey, err := validateIdempotencyKey(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	body, err := readJSONObject(w, r, maxComplaintBatchBytes)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	input, err := parseComplaintBatch(body)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	projectIDs := complaintProjectIDs(input)
	allProjects, visibleIDs, err := credentialProjectScope(r)
	if err != nil {
		writeAPIError(w, err)
		return
	}
	if !allProjects {
		for _, projectID := range projectIDs {
			allowed := false
			for _, visibleID := range visibleIDs {
				if visibleID == projectID {
					allowed = true
					break
				}
			}
			if !allowed {
				agentauth.WriteError(
					w,
					http.StatusForbidden,
					agentauth.ErrorCodeAgentProjectOutOfScope,
					agentauth.DetailProjectNotInScope,
				)
				return
			}
		}
	}

	var result ComplaintBatchResult
	err = h.runInTx(r.Context(), func(ctx context.Context, tx pgx.Tx, txStore Store) error {
		if err := txStore.ValidateComplaintBatch(ctx, input); err != nil {
			return err
		}
		var writeErr error
		result, writeErr = txStore.UpsertComplaintBatch(
			ctx, input, credentialAgentID(r),
		)
		if writeErr != nil {
			return writeErr
		}
		return h.auditMutation(
			r, tx, txStore, "complaint_center.batch_write", "complaint_run",
			strconv.FormatInt(result.RunID, 10), nil,
			map[string]any{
				"run_date":      result.RunDate,
				"shops_checked": input.ShopsChecked,
			},
		)
	})
	if err != nil {
		writeAPIError(w, err)
		return
	}
	result.IdempotencyKey = idempotencyKey
	if result.ShopChecks == nil {
		result.ShopChecks = []ShopCheckResult{}
	}
	if result.Complaints == nil {
		result.Complaints = []ComplaintResult{}
	}
	writeSuccess(w, result, idempotencyKey)
}

func complaintProjectIDs(input ComplaintBatchInput) []int64 {
	seen := make(map[int64]bool)
	ids := make([]int64, 0, len(input.ShopChecks)+len(input.Complaints))
	for _, check := range input.ShopChecks {
		if !seen[check.ProjectID] {
			seen[check.ProjectID] = true
			ids = append(ids, check.ProjectID)
		}
	}
	for _, complaint := range input.Complaints {
		if !seen[complaint.ProjectID] {
			seen[complaint.ProjectID] = true
			ids = append(ids, complaint.ProjectID)
		}
	}
	return ids
}
