# 搜索词浪费识别

## 分析目标
识别高花费零转化/低转化搜索词，计算浪费金额及占比。

## 分析步骤
1. 逐个审视 search_term_report 的 top 行
2. 对每个搜索词计算：spend, orders_7d, ACoS = spend/sales
3. 将结果分为三档：
   - 零转化（orders=0, 浪费=spend 全额）
   - 低转化（ACoS > 目标 2x）
   - 正常
4. 对零转化词，标注其所属 campaign（如果 campaign_report 数据可交叉）

## 输出格式
- waste_summary_table: 浪费汇总表
- waste_by_campaign: 按 campaign 统计浪费
