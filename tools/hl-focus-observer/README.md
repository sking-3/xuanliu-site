# Hyperliquid 重点钱包只读观察器

此独立原型监听公开钱包 `0x02665a064143936ba3b5e400147b6c92560f7b24` 的官方 `userFills`，供熬鹰代理信号的研究和后续模拟对账。它不是网站服务、模拟撮合器或交易程序：没有密钥、下单、撤单、转账、交易所账户和 Bitget 合约映射；所有输出均标为 `executable:false`。

需要支持 `node:sqlite` 和原生 `WebSocket` 的 Node 版本；本机测试使用 Node 24。独立运行示例：

```sh
HL_FOCUS_DB=/private/path/hl-focus.sqlite node observer.mjs
node --test observer.test.mjs
```

路径的父目录按私有目录创建，数据库权限为 0600，SQLite WAL 保存观察记录。用户需为运行主机、目录与进程生命周期单独配置；本文件不会部署、设置开机启动、保持笔记本唤醒或承诺 24 小时运行。

## 判定和持久化

- 首次订阅的历史快照只建基线，绝不作为新成交；新事件持久存储去重后才产生只读审计输出。
- `sourceTime` 是 Hyperliquid 返回的成交时间，`observedAt` 是本机接收时间，`lagMs` 是两者之差，受时钟同步影响。它不是币安原始订单、Bitget 订单或成交延迟。
- 对 `xyz:NVDA` 等保留原始市场身份，不推测 Bitget 合约；未识别动作、时间过旧、未来时间、重连快照及基线前的事件均不能成为模拟候选。
- 断线、进程重启或基线前出现流式事件，会将 `reconciliation_required` 锁存到数据库。该原型无解除锁存的生产对账入口；之后事件仍可供审计，但不能成为模拟候选。快照补回不意味着所有缺口可恢复。
- 交易动作由 `startPosition`、成交方向和数量联合解析；精确小数使用整数逻辑，语义不一致则标记未知。候选也仅供后续人工审查，不代表跟单或交易执行。
- 明确来源 `error`、WebSocket 1008/1013 拒绝关闭会将 `source_rejected` 锁存到数据库，重启也不自动重试。未知握手失败、超时、无快照、格式异常和重连耗尽也锁存为需要检查，但不错误地归因于来源拒绝；本原型没有解除停机的生产操作。建立后发生的普通中断有有限次数和间隔的重连。此逻辑不构成对交易所访问或频率的长期保证。

## 验证与限制

本地测试覆盖快照、去重、重启、断连缺口锁存、拒绝状态、未来/过期数据和 `xyz` 方向。2026-11-17 一次本机只读连接测试中，系统 DNS 对 `api.hyperliquid.xyz` 返回 `ENOTFOUND`，WebSocket 未建立，也没有收到真实推送；不能将此错误归因于 Hyperliquid 拒绝。尚未证明后台独立运行、长时间连续性、真实新成交延迟、模拟成交、与网站的集成或任何 Bitget 权限。

`smoke.mjs` 和 `smoke.workflow.yml` 是一次性只读网络验收及手动 GitHub Actions 模板，需先将观察器放入模板所指的仓库目录。它最多观察 20 秒，失败即结束，无定时或自动接续，不写入交易记录文件；只输出是否收到快照、事件数量、可用的来源到接收时间差及零订单摘要，不包含原始成交。**此模板尚未提交、运行或部署**；短测试通过也不证明长期运行或 Bitget 端到端延迟。

Hyperliquid 初始快照与重连机制：[官方 WebSocket 订阅说明](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions)。
