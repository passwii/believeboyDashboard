package scheduledreport

var returnReasonTranslations = map[string]string{
	"ACTIVATION_FAILURE":                     "激活失败",
	"APPAREL_STYLE":                          "款式问题",
	"APPAREL_TOO_LARGE":                      "服装过大",
	"APPAREL_TOO_SMALL":                      "服装过小",
	"CARRIER_BILL_NOT_AS_EXPECTED":           "承运商账单不符预期",
	"CARRIER_SWITCHING_COST":                 "承运商切换成本",
	"CHANGED_MIND":                           "改变主意",
	"DAMAGED_BY_CARRIER":                     "运输致损",
	"DAMAGED_BY_FC":                          "仓库致损",
	"DEFECTIVE":                              "有缺陷",
	"DID_NOT_LIKE_COLOR":                     "不喜欢颜色",
	"DID_NOT_LIKE_FABRIC":                    "不喜欢面料",
	"EXCESSIVE_INSTALLATION":                 "无法安装",
	"EXTRA_ITEM":                             "多发货品",
	"FOUND_BETTER_PRICE":                     "找到更低价",
	"JEWELRY_BAD_CLASP":                      "首饰搭扣损坏",
	"JEWELRY_BATTERY":                        "首饰电池失效",
	"JEWELRY_LOOSE_STONE":                    "首饰宝石脱落或松动",
	"JEWELRY_NO_CERT":                        "首饰缺少承诺的证书",
	"JEWELRY_NO_DOCS":                        "首饰缺少说明书或保修卡",
	"JEWELRY_TARNISHED":                      "首饰氧化变色",
	"JEWELRY_TOO_LARGE":                      "首饰过大或过长",
	"JEWELRY_TOO_SMALL":                      "首饰过小或过短",
	"LATE_ARRIVAL":                           "到货延迟",
	"MISORDERED":                             "订错款式尺码",
	"MISSED_ESTIMATED_DELIVERY":              "配送超时",
	"MISSING_PARTS":                          "缺少配件",
	"NEVER_ARRIVED":                          "未收到",
	"NOT_AS_DESCRIBED":                       "与描述不符",
	"NOT_AS_PHOTO":                           "与图片不符",
	"NOT_COMFORTABLE":                        "穿着不舒适",
	"NOT_COMPATIBLE":                         "不兼容",
	"NO_REASON_GIVEN":                        "未说明原因",
	"ORDERED_WRONG_ITEM":                     "误购商品",
	"OTHER":                                  "其他",
	"PART_NOT_COMPATIBLE":                    "配件不兼容",
	"POOR_FIT":                               "不合身",
	"QUALITY_UNACCEPTABLE":                   "质量不合格",
	"SWITCHEROO":                             "与订单不符",
	"UNAUTHORIZED_PURCHASE":                  "未经授权购买",
	"UNDELIVERABLE_FAILED_DELIVERY_ATTEMPTS": "无法投递（多次派送失败）",
	"UNDELIVERABLE_INSUFFICIENT_ADDRESS":     "无法投递（地址不详）",
	"UNDELIVERABLE_REFUSED":                  "无法投递（拒收）",
	"UNDELIVERABLE_UNCLAIMED":                "无法投递（无人认领）",
	"UNDELIVERABLE_UNKNOWN":                  "无法投递",
	"UNWANTED_ITEM":                          "不需要",
	"WARRANTY":                               "保修期内损坏",
	"WRONG_ITEM":                             "错发商品",
	"WRONG_SIZE":                             "尺码错误",
}

var returnReasonAliases = map[string]string{
	"AMZ-PG-APP-STYLE":       "APPAREL_STYLE",
	"AMZ-PG-APP-TOO-LARGE":   "APPAREL_TOO_LARGE",
	"AMZ-PG-APP-TOO-SMALL":   "APPAREL_TOO_SMALL",
	"AMZ-PG-BAD-DESC":        "NOT_AS_DESCRIBED",
	"AMZ-PG-MISORDERED":      "MISORDERED",
	"AMZ-PG-WJ-BAD-CLASP":    "JEWELRY_BAD_CLASP",
	"AMZ-PG-WJ-BATTERY":      "JEWELRY_BATTERY",
	"AMZ-PG-WJ-LOOSE-STONE":  "JEWELRY_LOOSE_STONE",
	"AMZ-PG-WJ-NO-CERT":      "JEWELRY_NO_CERT",
	"AMZ-PG-WJ-NO-DOCS":      "JEWELRY_NO_DOCS",
	"AMZ-PG-WJ-TARNISHED":    "JEWELRY_TARNISHED",
	"AMZ-PG-WJ-TOO-LARGE":    "JEWELRY_TOO_LARGE",
	"AMZ-PG-WJ-TOO-SMALL":    "JEWELRY_TOO_SMALL",
	"CR-MISSING_ITEM_IN_SET": "MISSING_PARTS",
}

func translateReturnReason(value string) string {
	if value == "" {
		return value
	}
	if alias, ok := returnReasonAliases[value]; ok {
		value = alias
	}
	if translated, ok := returnReasonTranslations[value]; ok {
		return translated
	}
	return value
}
