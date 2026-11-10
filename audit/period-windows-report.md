# 公开账户周期指标：永续范围修正

日期：2026-11-10（UTC）。状态：**本地候选，待主任务完成回归、浏览器验收及发布**。本报告不表示部署已完成；最终提交、部署时间及线上验证由主任务补记。

## 收益率与实际区间

周度、月度和“来源累计”的 ROI/PnL 继续直接采用官方榜单的 week/month/allTime 对应值，不用本地采样估算覆盖来源值。“来源累计”不是多个窗口相加，也不保证覆盖账户完整生命周期。

按用户本轮最新要求，**90/180/365 天 ROI 在缺少可靠资金基数时保持 `null`**，显示“—／该周期收益率暂缺”；不把金额换成收益率、不用月度或累计 ROI 代替，也不接入采样收益率估算。各周期都保留相同的收益率主指标和 USD 盈亏副行，缺值不变成 0%。

新曲线与来源采样回撤明确取永续系列：

| 展示窗口 | portfolio 来源 | 范围 |
| --- | --- | --- |
| 7D | perpWeek | perp_account |
| 30D | perpMonth | perp_account |
| ALL／来源累计 | perpAllTime | perp_account |
| 90D／180D／365D | 从 perpAllTime 截取 | perp_account |

长周期仍以最后一个真实来源点为终点，只保留落入请求区间的真实点，不插值；显示实际起止、覆盖天数及样本数。区间盈亏是实际末点减首点，样本不足则留空。长周期是本站从来源采样中选取的区间，不是官方直接提供的同名窗口。

## 来源范围的证据与边界

[官方 Leaderboard 组件](https://app.hyperliquid.xyz/assets/Leaderboard-D06I9MTf.js)直接读取 `windowPerformances[window].pnl/roi`；[官方 config 模块](https://app.hyperliquid.xyz/assets/config-BOv79UVk.js)中的读取函数访问 stats-data 的 leaderboard 快照。该组件没有明确写出各字段的 perp/all-account 范围映射，不能把推断包装成官方字段声明。

对既有同一账户、近时但非同时的两份捕获独立复算：月度榜单 PnL/ROI 倒推资金基数为 185,327,285.770666 USD，perpMonth 采样基数为 185,327,285.776996 USD；累计两者为 323,338,064.361752 与 323,338,064.360000 USD，差异仅约 0.00633／0.00175 USD。全账户系列不吻合。这是本轮将表现曲线与回撤切到永续范围的强证据，**不构成所有账户、所有窗口已精确同时对账的证明**；周度边界仍受采集时点差异影响。

榜单 `accountValue` 继续保留其来源含义，**不得直接改名为“永续权益”**。该旧样本的榜单值约 1.8449 亿 USD，更接近全账户 portfolio 末值约 1.8329 亿，而永续末值约 1.1080 亿；不同采集时间不能做精确余额对账，但足以说明不能将整行数据一律解释为永续权益。

## 恢复实际 Hyperliquid 前端的峰值参考算法

本轮恢复的是“**永续来源采样回撤（HL 前端口径参考）**”，不是标准净值最大回撤或 TWR。

只读核验 [官方 config 中的 Gce（导出名 Mn）](https://app.hyperliquid.xyz/assets/config-BOv79UVk.js)显示：维护累计 PnL 的运行峰值及该峰值时的账户权益；每个后续点计算 `(峰值 PnL − 当前 PnL) / 峰值时权益`，保留最大值；PnL 创新高或持平时更新峰值及对应权益。其结果按百分比格式化。[官方 Portfolio 组件](https://app.hyperliquid.xyz/assets/Portfolio-CGEhWz7d.js)为该指标的前端调用证据。

这不是枚举所有历史起点 `i < j` 的算法。官方 [Miscellaneous UI 文档](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/miscellaneous-ui)用任意起终点描述指标，且书面分子符号与通常正向亏损幅度有出入；本轮以实际可核验的 Gce 实现作为“来源前端口径”依据，不宣称二者已数学等价。

保护边界：

- 盈亏与权益必须属于同一永续系列、逐点时间配对、数值有效；不拿全账户权益给永续 PnL 作分母。
- 零或无效权益不能拿来做除法；有效比较不足时保留缺值，不能以 0% 冒充无回撤。
- 原生窗口复用其来源系列；90/180/365 天先截取并归零 PnL 基线，再采用同一峰值流程，明确属于本站派生区间。
- 先用完整原始窗口点计算，再对绘图点降采样；不从最多 120 个图点反推指标。
- **允许超过 100%，不裁剪、不仅删除大于 100% 的值。**它是 PnL 与特定时点权益之比，资金变化可使其超出通常净值回撤范围；不能解释成净值损失相同比例。

新后台缓存方法版本为 `portfolio-periods-v2`，仅接受 `perp_account` 与上述 perp* 来源。旧 v1/all_account 缓存不能直接转换或混入；等待新一轮已配置采集产生正确范围的结果。

## 采集、胜率与历史审计

既有只读 portfolio 采集器继续保存实际样本范围、采集时间和失败时的旧结果状态；采用独立限额，并传递 403/429 停止状态。本轮范围修正不代表新增交易权限、账户密钥或实时流采集。

“近期永续平仓分笔样本胜率”继续与所选表现周期独立。它只反映最近最多 2000 条来源成交中的合格平仓分笔，不变成 90/180/365 天胜率。界面应保留真实样本区间、有效及排除数量、截断状态、仅扣当次平仓费等边界。

[trader-metric-semantics-report.md](trader-metric-semantics-report.md)保留旧截图审计：19.15%／226.36% 来自此前全账户曲线范围；931/931 胜率来自约 97 分钟的永续平仓分笔，并排除了现货卖出。该报告中“将标准回撤留空”的建议属于前一轮候选处理，**不代表本轮恢复来源峰值参考值后已发布，也不能把旧全账户数值冒充新的永续结果**。

官方资料：[Info／portfolio](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)、[Portfolio graphs](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/portfolio-graphs)、[官方榜单及 ROI 公式](https://app.hyperliquid.xyz/leaderboard)。测试和部署结果待主任务以本轮最终版本记录。
