package inspections

func inspectionString(value string) *string {
	return &value
}

func inspectionFloat(value float64) *float64 {
	return &value
}

var inspectionTemplate = TemplateResponse{
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
			Type: "number", ThresholdWarning: inspectionFloat(1),
			ThresholdCritical: inspectionFloat(3), ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "a2z_claims", Label: "亚马逊 A-to-Z", LabelEN: "A-to-Z Claims",
			Type: "number", ThresholdWarning: inspectionFloat(1),
			ThresholdCritical: inspectionFloat(3), ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "chargeback_claims", Label: "信用卡拒付", LabelEN: "Chargeback Claims",
			Type: "number", ThresholdWarning: inspectionFloat(1),
			ThresholdCritical: inspectionFloat(3), ThresholdDirection: inspectionString("above"),
		},
	},
	ShippingPerformanceFields: []TemplateField{
		{
			Key: "late_shipment_rate", Label: "迟发率", LabelEN: "Late Shipment Rate",
			Type: "number", Unit: inspectionString("%"), ThresholdWarning: inspectionFloat(2.0),
			ThresholdCritical: inspectionFloat(4.0), ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "pre_fulfillment_cancel_rate", Label: "配送前取消率",
			LabelEN: "Pre-fulfillment Cancel Rate", Type: "number", Unit: inspectionString("%"),
		},
		{
			Key: "valid_tracking_rate", Label: "有效追踪率", LabelEN: "Valid Tracking Rate",
			Type: "number", Unit: inspectionString("%"), ThresholdWarning: inspectionFloat(97.0),
			ThresholdCritical: inspectionFloat(95.0), ThresholdDirection: inspectionString("below"),
		},
		{
			Key: "on_time_delivery_rate", Label: "准时交付率", LabelEN: "On-time Delivery Rate",
			Type: "number", Unit: inspectionString("%"), ThresholdWarning: inspectionFloat(97.0),
			ThresholdCritical: inspectionFloat(95.0), ThresholdDirection: inspectionString("below"),
		},
	},
	ComplianceFields: []TemplateField{
		{
			Key: "ip_infringement", Label: "涉嫌侵犯知识产权",
			LabelEN: "Suspected IP Infringement", Type: "number",
			ThresholdWarning: inspectionFloat(1), ThresholdCritical: inspectionFloat(3),
			ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "ip_complaints", Label: "知识产权投诉", LabelEN: "IP Complaints",
			Type: "number", ThresholdWarning: inspectionFloat(1),
			ThresholdCritical: inspectionFloat(3), ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "product_authenticity_complaints", Label: "商品真实性买家投诉",
			LabelEN: "Product Authenticity Complaints", Type: "number",
			ThresholdWarning: inspectionFloat(1), ThresholdCritical: inspectionFloat(3),
			ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "product_condition_complaints", Label: "商品状况买家投诉",
			LabelEN: "Product Condition Complaints", Type: "number",
			ThresholdWarning: inspectionFloat(1), ThresholdCritical: inspectionFloat(3),
			ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "food_product_safety", Label: "食品和商品安全问题",
			LabelEN: "Food & Product Safety", Type: "number",
			ThresholdWarning: inspectionFloat(1), ThresholdCritical: inspectionFloat(3),
			ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "listing_policy_violations", Label: "上架政策违规",
			LabelEN: "Listing Policy Violations", Type: "number",
			ThresholdWarning: inspectionFloat(1), ThresholdCritical: inspectionFloat(3),
			ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "restricted_product_violations", Label: "违反受限商品政策",
			LabelEN: "Restricted Product Violations", Type: "number",
			ThresholdWarning: inspectionFloat(1), ThresholdCritical: inspectionFloat(3),
			ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "review_policy_violations", Label: "违反买家商品评论政策",
			LabelEN: "Review Policy Violations", Type: "number",
			ThresholdWarning: inspectionFloat(1), ThresholdCritical: inspectionFloat(3),
			ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "other_policy_violations", Label: "其他违反政策",
			LabelEN: "Other Policy Violations", Type: "number",
			ThresholdWarning: inspectionFloat(1), ThresholdCritical: inspectionFloat(3),
			ThresholdDirection: inspectionString("above"),
		},
		{
			Key: "regulatory_compliance", Label: "监管合规性",
			LabelEN: "Regulatory Compliance", Type: "number",
			ThresholdWarning: inspectionFloat(1), ThresholdCritical: inspectionFloat(3),
			ThresholdDirection: inspectionString("above"),
		},
	},
}

func Template() TemplateResponse {
	return inspectionTemplate
}
