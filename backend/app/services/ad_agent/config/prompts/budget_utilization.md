# 预算利用率分析

## 分析目标
对比建议预算 vs 实际预算，识别预算不足（限制了曝光）和预算过度（浪费）的 campaign。

## 分析步骤
1. 审视 budget_report 的 top 行
2. 对每个 campaign 计算：
   - 实际 spend
   - 建议预算
   - 利用率 = spend / budget
3. 利用率 > 90% = 预算紧张（可能限制曝光）
4. 利用率 < 50% = 预算过剩
5. 结合 campaign_report 的 impressions 判断：预算紧张的 campaign 是否 impression share 下降

## 输出格式
- budget_utilization_table: 预算利用率表
- over_under_campaigns: 预算紧张/过剩的 campaign 列表
