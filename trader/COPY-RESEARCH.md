# 跟单路径研究（2026-11-12）

本轮仅核对公开页面、官方文档和本站已取得的公开来源。未连接钱包、未创建 API 权限、未登录参考站账户区、未下单；现有后台排程配置未改变。

## 已观察与未验证

参考页：<https://www.alphafox.app/zh/dashboard/square/featured-leaders?source=bn-5075281354358777856&panel=forensics>。

公开页面分别提供模拟与一键跟单入口，以及策略、账户与交易导航；账户页需要登录。由此可以推测产品将交易员选择、账户连接、策略参数和执行状态分开，但公开界面不能证明它的后端路由、签名方式、订单同步算法或成交质量。本站没有调用参考站私有接口，也不将其留存历史当作本站原始数据。参考站自己的“查询起点前已有持仓”“仓位数量矛盾”提示也说明：成交样本不总能还原完整仓位。

本站可复现的研究路径是：公开成交与官方仓位汇总 → 去重、版本保留、缺口检测 → 有来源的仓位片段 → 操作明细 → 同市场 K 线回放与买卖点。只有已校验连续性的片段可以进一步用于模拟；不同来源的费用、权益与资金口径必须保留。

## 熬鹰资本的实际限制

本次币安公开 detail 于 2026-11-12 01:31:08 北京时间返回 `positionShow: false`；资料、30D 表现、PNL 曲线和历史仓位可以独立公开读取。原始响应及 SHA-256 在 `binance/evidence/aoying-analysis-20261112/` 与 `aoying-history.js`。当前真实持仓仍未知，不解除已有持仓来源停止记录。

公开操作记录没有订单 ID，属于聚合成交观察；开/加方向不能单独确认新开仓。同一记录可能后续更新，首次基线、断档补查与版本去重不能省略。5 秒是监控循环的目标读取间隔，不是平台承诺的发布延迟；GitHub 任务交接、状态提交和 CDN 也会增加延迟。因此不能把这条公开观察链路称为精确实盘跟单。

同一次 profile 快照显示跟单人数 1000/1000；这只是该次快照，不承诺当前可加入。币安原生跟单由平台内部读取带单组合状态，不能因公开界面显示历史成交就推断自建程序获得相同可见性。若使用平台原生跟单，应由用户在币安官方界面核对适用地区、名额、参数与风险；本站不代为操作。

## 自建复制的可行方案

先做只读信号与模拟复制：

1. 每条事件持久化来源、来源时间、首次发现、唯一身份、记录版本与完整性状态。
2. 初次历史仅建基线；断档、来源拒绝、未知起始仓位、歧义版本停止产生可执行意图。
3. 采用目标仓位和幂等意图设计，按比例、单笔上限、总敞口、方向限制与滑点限额生成模拟订单。
4. 逐笔记录“来源成交 → 发现 → 决策 → 模拟成交”延迟和误差；重复输入与重连不增加订单。
5. 用实际可成交行情检验精度、手续费、滑点、部分成交、精度/最小数量、反转、并发与资金不足；不以历史回放证明盈利。
6. 只有模拟对账通过，才讨论独立的常驻执行服务、数据库与账户授权。GitHub 存源码、测试和研究采集，不承担当作低延迟交易执行器。

Hyperliquid 官方只读成交含 startPosition 等字段，可校验部分仓位连续性；官方 API wallet / agent 文档提供代签机制。这是后续独立执行服务的技术依据，不能据此声称参考站必然采用该实现。真实执行还需要用户单独授权、账户风险边界、权限/撤销方案和逐单对账；密钥不得进入 GitHub Pages、仓库、前端或日志。本轮不实现或启用实盘执行。

## 官方依据

- 币安 Copy Trading 介绍：<https://www.binance.com/en/academy/articles/your-guide-to-binance-copy-trading>
- 币安 Futures 原生跟单说明：<https://www.binance.com/en/support/faq/detail/0b3a91eea664402f812fe41358c8a206>
- Hyperliquid API wallet、agent 与 nonce：<https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets>
- Hyperliquid 只读 Info API：<https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint>
- Hyperliquid Exchange API：<https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint>（仅文档研究，未调用交易动作）
