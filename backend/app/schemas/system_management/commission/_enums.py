"""
佣金管理枚举定义。

所有佣金相关的枚举定义在单独的模块中，避免循环导入。
"""
from enum import Enum


class CommissionIncomeCategory(str, Enum):
    operator = "operator"
    assistant = "assistant"


class CommissionPaymentStatus(str, Enum):
    paid = "paid"
    unpaid = "unpaid"


class CommissionProjectPaymentStatus(str, Enum):
    paid = "paid"
    partial = "partial"
    unpaid = "unpaid"


class CommissionRatioSource(str, Enum):
    rule = "rule"
    manual = "manual"