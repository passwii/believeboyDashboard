package agent_inspection

type TemplateField struct {
	Key                string   `json:"key"`
	Label              string   `json:"label"`
	LabelEN            string   `json:"label_en"`
	Type               string   `json:"type"`
	Unit               *string  `json:"unit"`
	Options            []string `json:"options"`
	ThresholdWarning   *float64 `json:"threshold_warning"`
	ThresholdCritical  *float64 `json:"threshold_critical"`
	ThresholdDirection *string  `json:"threshold_direction"`
}

type TemplateResponse struct {
	HealthFields              []TemplateField `json:"health_fields"`
	ServicePerformanceFields  []TemplateField `json:"service_performance_fields"`
	ShippingPerformanceFields []TemplateField `json:"shipping_performance_fields"`
	ComplianceFields          []TemplateField `json:"compliance_fields"`
}

func ptrString(value string) *string {
	return &value
}

func ptrFloat(value float64) *float64 {
	return &value
}

func Template() TemplateResponse {
	return TemplateResponse{
		HealthFields: []TemplateField{
			{
				Key: "account_health_rating", Label: "账户健康评级",
				LabelEN: "Account Health Rating", Type: "select",
				Options: []string{"Healthy", "Good", "At Risk", "Critical"},
			},
		},
		ServicePerformanceFields: []TemplateField{
			{
				Key: "negative_feedback", Label: "负面反馈", LabelEN: "Negative Feedback",
				Type: "number", ThresholdWarning: ptrFloat(1), ThresholdCritical: ptrFloat(3),
				ThresholdDirection: ptrString("above"),
			},
			{
				Key: "a2z_claims", Label: "亚马逊 A-to-Z", LabelEN: "A-to-Z Claims",
				Type: "number", ThresholdWarning: ptrFloat(1), ThresholdCritical: ptrFloat(3),
				ThresholdDirection: ptrString("above"),
			},
			{
				Key: "chargeback_claims", Label: "信用卡拒付", LabelEN: "Chargeback Claims",
				Type: "number", ThresholdWarning: ptrFloat(1), ThresholdCritical: ptrFloat(3),
				ThresholdDirection: ptrString("above"),
			},
		},
		ShippingPerformanceFields: []TemplateField{
			{
				Key: "late_shipment_rate", Label: "迟发率", LabelEN: "Late Shipment Rate",
				Type: "number", Unit: ptrString("%"), ThresholdWarning: ptrFloat(2),
				ThresholdCritical: ptrFloat(4), ThresholdDirection: ptrString("above"),
			},
			{
				Key: "pre_fulfillment_cancel_rate", Label: "配送前取消率",
				LabelEN: "Pre-fulfillment Cancel Rate", Type: "number", Unit: ptrString("%"),
			},
			{
				Key: "valid_tracking_rate", Label: "有效追踪率", LabelEN: "Valid Tracking Rate",
				Type: "number", Unit: ptrString("%"), ThresholdWarning: ptrFloat(97),
				ThresholdCritical: ptrFloat(95), ThresholdDirection: ptrString("below"),
			},
			{
				Key: "on_time_delivery_rate", Label: "准时交付率",
				LabelEN: "On-time Delivery Rate", Type: "number", Unit: ptrString("%"),
				ThresholdWarning: ptrFloat(97), ThresholdCritical: ptrFloat(95),
				ThresholdDirection: ptrString("below"),
			},
		},
		ComplianceFields: complianceTemplateFields(),
	}
}

func complianceTemplateFields() []TemplateField {
	keys := []struct {
		key   string
		label string
		en    string
	}{
		{"ip_infringement", "涉嫌侵犯知识产权", "Suspected IP Infringement"},
		{"ip_complaints", "知识产权投诉", "IP Complaints"},
		{"product_authenticity_complaints", "商品真实性买家投诉", "Product Authenticity Complaints"},
		{"product_condition_complaints", "商品状况买家投诉", "Product Condition Complaints"},
		{"food_product_safety", "食品和商品安全问题", "Food & Product Safety"},
		{"listing_policy_violations", "上架政策违规", "Listing Policy Violations"},
		{"restricted_product_violations", "违反受限商品政策", "Restricted Product Violations"},
		{"review_policy_violations", "违反买家商品评论政策", "Review Policy Violations"},
		{"other_policy_violations", "其他违反政策", "Other Policy Violations"},
		{"regulatory_compliance", "监管合规性", "Regulatory Compliance"},
	}
	fields := make([]TemplateField, 0, len(keys))
	for _, item := range keys {
		fields = append(fields, TemplateField{
			Key: item.key, Label: item.label, LabelEN: item.en, Type: "number",
			ThresholdWarning: ptrFloat(1), ThresholdCritical: ptrFloat(3),
			ThresholdDirection: ptrString("above"),
		})
	}
	return fields
}
