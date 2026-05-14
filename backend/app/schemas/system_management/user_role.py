"""
用户角色类型枚举。
"""
from enum import Enum


class UserRoleType(str, Enum):
    admin = "admin"
    operator = "operator"
    businessdev = "businessdev"
    factory = "factory"