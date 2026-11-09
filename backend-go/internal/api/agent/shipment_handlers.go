package agent

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/passwii/believeboyDashboard/backend-go/internal/api/shipment_schedules"
)

func (h *Handler) ListShipments(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	page, pageSize := parsePage(r, 20, 100)
	filter := shipment_schedules.ShipmentFilter{
		ProjectID:      &projectID,
		Country:        optionalUpperQuery(r, "country"),
		Keyword:        optionalStringQuery(r, "shipment_no"),
		ShipmentStatus: optionalStringQuery(r, "shipment_status"),
		StartDate:      optionalStringQuery(r, "created_date_from"),
		EndDate:        optionalStringQuery(r, "created_date_to"),
		Page:           page,
		PageSize:       pageSize,
		IncludeTotal:   true,
	}
	resp, err := h.stores.Shipments.ListShipmentSchedules(r.Context(), filter)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetShipment(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	shipment, ok := h.resolveShipment(w, r, projectID, chiURLParam(r, "shipment_no"))
	if !ok {
		return
	}
	writeOK(w, shipment, "")
}

func (h *Handler) GetShipmentSkuSummary(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	if _, ok := h.resolveShipment(w, r, projectID, chiURLParam(r, "shipment_no")); !ok {
		return
	}
	resp, err := h.stores.Shipments.ListSkuSummary(
		r.Context(),
		&projectID,
		optionalUpperQuery(r, "country"),
		optionalStringQuery(r, "start_date"),
		optionalStringQuery(r, "end_date"),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) GetShipmentFbaBoxDetail(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	shipmentNo := strings.TrimSpace(chiURLParam(r, "shipment_no"))
	if shipmentNo == "" {
		writeValidationError(w, "shipment_no is required", nil)
		return
	}
	resp, err := h.stores.Shipments.ListFbaBoxDetails(
		r.Context(),
		[]int64{projectID},
		nil,
		[]string{shipmentNo},
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	writeOK(w, resp, "")
}

func (h *Handler) ListShipmentBatches(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	batches, err := h.stores.Shipments.ListBatches(
		r.Context(),
		&projectID,
		nil,
		optionalUpperQuery(r, "country"),
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	if batches == nil {
		batches = []string{}
	}
	writeOK(w, map[string]any{"items": batches}, "")
}

func (h *Handler) GetShipmentAudit(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	shipmentNo := chiURLParam(r, "shipment_no")
	current, ok := h.resolveShipment(w, r, projectID, shipmentNo)
	if !ok {
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if val, err := strconv.Atoi(raw); err == nil && val > 0 {
			limit = val
		}
	}
	if limit > 200 {
		limit = 200
	}
	var items []AuditItem
	if h.stores.Audit != nil {
		var err error
		items, err = h.stores.Audit.QueryAuditLogs(r.Context(), "shipment_schedule", []string{strconv.FormatInt(current.ID, 10)}, limit)
		if err != nil {
			writeStoreError(w, err)
			return
		}
	}
	if items == nil {
		items = []AuditItem{}
	}
	writeOK(w, map[string]any{
		"shipment_no": current.ShipmentNo,
		"items":       items,
	}, "")
}

func (h *Handler) CreateShipment(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	body, _, ok := h.gateConfirmation(w, r, "shipment.create", map[string]any{
		"project_id": projectID,
	}, func(body []byte) error {
		var create shipment_schedules.ShipmentScheduleCreate
		if err := json.Unmarshal(body, &create); err != nil {
			return errors.New("请求体必须是有效的货件对象")
		}
		if strings.TrimSpace(create.ShipmentNo) == "" {
			return errors.New("shipment_no is required")
		}
		return nil
	})
	if !ok {
		return
	}
	var create shipment_schedules.ShipmentScheduleCreate
	if err := json.Unmarshal(body, &create); err != nil {
		writeValidationError(w, "请求体必须是有效的货件对象", nil)
		return
	}
	create.ProjectID = projectID
	if strings.TrimSpace(create.Country) == "" {
		create.Country = "US"
	}
	if strings.TrimSpace(create.ShipmentNo) == "" {
		writeValidationError(w, "shipment_no is required", nil)
		return
	}
	credential, _ := CredentialFromContext(r.Context())
	created, err := h.stores.Shipments.CreateShipmentSchedule(
		r.Context(),
		create,
		credential.AgentID,
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.logAudit(r, credential, "shipment.create", "shipment_schedule", strconv.FormatInt(created.ID, 10), nil, created)
	writeOK(w, created, strings.TrimSpace(r.Header.Get("Idempotency-Key")))
}

func (h *Handler) ReplaceShipmentItems(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	current, ok := h.resolveShipment(w, r, projectID, chiURLParam(r, "shipment_no"))
	if !ok {
		return
	}
	body, _, ok := h.gateConfirmation(w, r, "shipment.items.replace", map[string]any{
		"project_id":  projectID,
		"shipment_no": current.ShipmentNo,
	}, func(body []byte) error {
		var payload struct {
			Items []shipment_schedules.ShipmentScheduleItemInput `json:"items"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			return errors.New("items must be an array")
		}
		return nil
	})
	if !ok {
		return
	}
	var payload struct {
		Items []shipment_schedules.ShipmentScheduleItemInput `json:"items"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		writeValidationError(w, "items must be an array", nil)
		return
	}
	update := shipmentUpdateFromDetail(current)
	update.Items = payload.Items
	credential, _ := CredentialFromContext(r.Context())
	updated, err := h.stores.Shipments.UpdateShipmentSchedule(
		r.Context(),
		current.ID,
		update,
		credential.AgentID,
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.logAudit(r, credential, "shipment.items.replace", "shipment_schedule", strconv.FormatInt(current.ID, 10), current, updated)
	writeOK(w, updated, strings.TrimSpace(r.Header.Get("Idempotency-Key")))
}

type shipmentPatchRequest struct {
	Country                      *string                                         `json:"country"`
	TrackingNo                   *string                                         `json:"tracking_no"`
	WarehouseCode                *string                                         `json:"warehouse_code"`
	ForwarderName                *string                                         `json:"forwarder_name"`
	ShippingMethod               *string                                         `json:"shipping_method"`
	CreatedDate                  *string                                         `json:"created_date"`
	EtdDate                      *string                                         `json:"etd_date"`
	EtaDate                      *string                                         `json:"eta_date"`
	ActualInboundDate            *string                                         `json:"actual_inbound_date"`
	LogisticsUnitPrice           *float64                                        `json:"logistics_unit_price"`
	IncludeInHistoryShippingCalc *bool                                           `json:"include_in_history_shipping_calc"`
	Remark                       *string                                         `json:"remark"`
	ShipmentStatus               *string                                         `json:"shipment_status"`
	ShipmentBatch                *string                                         `json:"shipment_batch"`
	Items                        *[]shipment_schedules.ShipmentScheduleItemInput `json:"items"`
}

func (h *Handler) PatchShipment(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	current, ok := h.resolveShipment(w, r, projectID, chiURLParam(r, "shipment_no"))
	if !ok {
		return
	}
	body, _, ok := h.gateConfirmation(w, r, "shipment.update", map[string]any{
		"project_id":  projectID,
		"shipment_no": current.ShipmentNo,
	})
	if !ok {
		return
	}
	var patch shipmentPatchRequest
	if err := json.Unmarshal(body, &patch); err != nil {
		writeValidationError(w, "请求体必须是有效的货件补丁", nil)
		return
	}
	update := shipmentUpdateFromDetail(current)
	applyShipmentPatch(&update, patch)
	credential, _ := CredentialFromContext(r.Context())
	updated, err := h.stores.Shipments.UpdateShipmentSchedule(
		r.Context(),
		current.ID,
		update,
		credential.AgentID,
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.logAudit(r, credential, "shipment.update", "shipment_schedule", strconv.FormatInt(current.ID, 10), current, updated)
	writeOK(w, updated, strings.TrimSpace(r.Header.Get("Idempotency-Key")))
}

func (h *Handler) UpdateShipmentStatus(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	current, ok := h.resolveShipment(w, r, projectID, chiURLParam(r, "shipment_no"))
	if !ok {
		return
	}
	body, _, ok := h.gateConfirmation(w, r, "shipment.status.transition", map[string]any{
		"project_id":  projectID,
		"shipment_no": current.ShipmentNo,
	}, func(body []byte) error {
		var payload struct {
			Status         string `json:"status"`
			ShipmentStatus string `json:"shipment_status"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			return errors.New("status is required")
		}
		status := strings.TrimSpace(payload.ShipmentStatus)
		if status == "" {
			status = strings.TrimSpace(payload.Status)
		}
		if status == "" {
			return errors.New("status is required")
		}
		return nil
	})
	if !ok {
		return
	}
	var payload struct {
		Status         string `json:"status"`
		ShipmentStatus string `json:"shipment_status"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		writeValidationError(w, "status is required", nil)
		return
	}
	status := strings.TrimSpace(payload.ShipmentStatus)
	if status == "" {
		status = strings.TrimSpace(payload.Status)
	}
	if status == "" {
		writeValidationError(w, "status is required", nil)
		return
	}
	update := shipmentUpdateFromDetail(current)
	update.ShipmentStatus = status
	credential, _ := CredentialFromContext(r.Context())
	updated, err := h.stores.Shipments.UpdateShipmentSchedule(
		r.Context(),
		current.ID,
		update,
		credential.AgentID,
	)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	h.logAudit(r, credential, "shipment.status.transition", "shipment_schedule", strconv.FormatInt(current.ID, 10), current, updated)
	writeOK(w, updated, strings.TrimSpace(r.Header.Get("Idempotency-Key")))
}

func (h *Handler) RecalculateShipmentCosts(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	current, ok := h.resolveShipment(w, r, projectID, chiURLParam(r, "shipment_no"))
	if !ok {
		return
	}
	body, _, ok := h.gateConfirmation(w, r, "shipment.recalculate_costs", map[string]any{
		"project_id":  projectID,
		"shipment_no": current.ShipmentNo,
	})
	if !ok {
		return
	}
	var payload shipment_schedules.ShipmentCostCalculateRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		writeValidationError(w, "logistics_unit_price is required", nil)
		return
	}
	updated, err := h.stores.Shipments.CalculateCosts(r.Context(), current.ID, payload)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	credential, _ := CredentialFromContext(r.Context())
	h.logAudit(r, credential, "shipment.recalculate_costs", "shipment_schedule", strconv.FormatInt(current.ID, 10), current, updated)
	writeOK(w, updated, strings.TrimSpace(r.Header.Get("Idempotency-Key")))
}

func (h *Handler) DeleteShipment(w http.ResponseWriter, r *http.Request) {
	if h.stores.Shipments == nil {
		writeAPIError(w, NewAPIError(ErrServiceUnavailable))
		return
	}
	projectID, ok := requireProjectID(w, r)
	if !ok {
		return
	}
	current, ok := h.resolveShipment(w, r, projectID, chiURLParam(r, "shipment_no"))
	if !ok {
		return
	}
	_, _, ok = h.gateConfirmation(w, r, "shipment.delete", map[string]any{
		"project_id":  projectID,
		"shipment_no": current.ShipmentNo,
	})
	if !ok {
		return
	}
	deleted, err := h.stores.Shipments.DeleteShipmentSchedule(r.Context(), current.ID)
	if err != nil {
		writeStoreError(w, err)
		return
	}
	credential, _ := CredentialFromContext(r.Context())
	h.logAudit(r, credential, "shipment.delete", "shipment_schedule", strconv.FormatInt(current.ID, 10), current, nil)
	writeOK(w, map[string]any{"deleted": deleted}, strings.TrimSpace(r.Header.Get("Idempotency-Key")))
}

func (h *Handler) resolveShipment(
	w http.ResponseWriter,
	r *http.Request,
	projectID int64,
	shipmentNo string,
) (*shipment_schedules.ShipmentScheduleDetail, bool) {
	shipmentNo = strings.TrimSpace(shipmentNo)
	if shipmentNo == "" {
		writeValidationError(w, "shipment_no is required", nil)
		return nil, false
	}
	country := optionalUpperQuery(r, "country")
	resp, err := h.stores.Shipments.ListShipmentSchedules(r.Context(), shipment_schedules.ShipmentFilter{
		ProjectID: &projectID,
		Country:   country,
		Keyword:   &shipmentNo,
		Page:      1,
		PageSize:  100,
	})
	if err != nil {
		writeStoreError(w, err)
		return nil, false
	}
	var id int64
	for _, item := range resp.Items {
		if strings.EqualFold(strings.TrimSpace(item.ShipmentNo), shipmentNo) {
			id = item.ID
			break
		}
	}
	if id == 0 && len(resp.Items) == 1 {
		id = resp.Items[0].ID
	}
	if id == 0 {
		writeAPIError(w, ErrorWithMessage(ErrResourceNotFound, "排期不存在"))
		return nil, false
	}
	detail, err := h.stores.Shipments.GetShipmentSchedule(r.Context(), id)
	if err != nil || detail == nil {
		writeStoreError(w, err)
		return nil, false
	}
	if detail.ProjectID != projectID {
		writeAPIError(w, ErrorWithReason(ErrAgentProjectOutOfScope, "project_not_in_scope"))
		return nil, false
	}
	return detail, true
}

func shipmentUpdateFromDetail(
	detail *shipment_schedules.ShipmentScheduleDetail,
) shipment_schedules.ShipmentScheduleUpdate {
	return shipment_schedules.ShipmentScheduleUpdate{
		ProjectID:                    detail.ProjectID,
		Country:                      detail.Country,
		ShipmentNo:                   detail.ShipmentNo,
		TrackingNo:                   detail.TrackingNo,
		WarehouseCode:                detail.WarehouseCode,
		ForwarderName:                detail.ForwarderName,
		ShippingMethod:               detail.ShippingMethod,
		CreatedDate:                  detail.CreatedDate,
		EtdDate:                      detail.EtdDate,
		EtaDate:                      detail.EtaDate,
		ActualInboundDate:            detail.ActualInboundDate,
		LogisticsUnitPrice:           detail.LogisticsUnitPrice,
		IncludeInHistoryShippingCalc: detail.IncludeInHistoryShippingCalc,
		Remark:                       detail.Remark,
		ShipmentStatus:               detail.ShipmentStatus,
		ShipmentBatch:                detail.ShipmentBatch,
		Items:                        shipmentItemsFromDetail(detail.Items),
	}
}

func shipmentItemsFromDetail(
	items []shipment_schedules.ShipmentScheduleItemRow,
) []shipment_schedules.ShipmentScheduleItemInput {
	result := make([]shipment_schedules.ShipmentScheduleItemInput, 0, len(items))
	for _, item := range items {
		result = append(result, shipment_schedules.ShipmentScheduleItemInput{
			SKU:         item.SKU,
			Quantity:    item.Quantity,
			CartonCount: item.CartonCount,
			ItemDate:    item.ItemDate,
			Remark:      item.Remark,
		})
	}
	return result
}

func applyShipmentPatch(
	update *shipment_schedules.ShipmentScheduleUpdate,
	patch shipmentPatchRequest,
) {
	if patch.Country != nil {
		update.Country = *patch.Country
	}
	if patch.TrackingNo != nil {
		update.TrackingNo = patch.TrackingNo
	}
	if patch.WarehouseCode != nil {
		update.WarehouseCode = patch.WarehouseCode
	}
	if patch.ForwarderName != nil {
		update.ForwarderName = patch.ForwarderName
	}
	if patch.ShippingMethod != nil {
		update.ShippingMethod = *patch.ShippingMethod
	}
	if patch.CreatedDate != nil {
		update.CreatedDate = patch.CreatedDate
	}
	if patch.EtdDate != nil {
		update.EtdDate = patch.EtdDate
	}
	if patch.EtaDate != nil {
		update.EtaDate = patch.EtaDate
	}
	if patch.ActualInboundDate != nil {
		update.ActualInboundDate = patch.ActualInboundDate
	}
	if patch.LogisticsUnitPrice != nil {
		update.LogisticsUnitPrice = *patch.LogisticsUnitPrice
	}
	if patch.IncludeInHistoryShippingCalc != nil {
		update.IncludeInHistoryShippingCalc = *patch.IncludeInHistoryShippingCalc
	}
	if patch.Remark != nil {
		update.Remark = patch.Remark
	}
	if patch.ShipmentStatus != nil {
		update.ShipmentStatus = *patch.ShipmentStatus
	}
	if patch.ShipmentBatch != nil {
		update.ShipmentBatch = patch.ShipmentBatch
	}
	if patch.Items != nil {
		update.Items = *patch.Items
	}
}

func optionalUpperQuery(r *http.Request, key string) *string {
	value := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get(key)))
	if value == "" {
		return nil
	}
	return &value
}

func parsePage(r *http.Request, defaultPageSize, maxPageSize int) (int, int) {
	page := 1
	if parsed, err := strconv.Atoi(r.URL.Query().Get("page")); err == nil && parsed > 0 {
		page = parsed
	}
	pageSize := defaultPageSize
	raw := r.URL.Query().Get("page_size")
	if raw == "" {
		raw = r.URL.Query().Get("limit")
	}
	if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 {
		pageSize = parsed
	}
	if pageSize > maxPageSize {
		pageSize = maxPageSize
	}
	return page, pageSize
}
