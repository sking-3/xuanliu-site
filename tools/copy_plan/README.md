# GitHub 跟单设置与模拟指令

当前实现将带单员卡片的“来源”替换为“跟单”。点击进入该账户的设置，可选择 Bitget 合约、币安 USDT 合约或 Hyperliquid 永续。原始来源链接保留在设置内。旧的 `view=paper` 链接仍打开本机模拟，新的 `view=follow` 打开 API 设置。

**这是设置与模拟意图阶段，未连接任何交易账户，没有签名和下单实现。** 本机模拟账本继续使用已有的 Hyperliquid 真实盘口预览；GitHub 模拟指令不会把源交易价格当作目标账户成交价。两个功能不能冒充真实跟单。

## 无服务器方案

用户预期的链路可以分为：公开信号采集 → 去重、基线和时效检查 → 参数与风控 → 目标市场映射、余额和权限检查 → 服务端签名 → 交易所回执与持仓对账。GitHub Actions 可运行这些服务端程序，凭证应由仓库所有者直接配置到 GitHub Secrets。GitHub Pages 只提供设置页面，不接收密钥。

参考 [AlphaFox 账户接入说明](https://www.alphafox.app/zh/docs/guides/connect-exchange)和[跟随信号说明](https://www.alphafox.app/zh/docs/guides/follow-leader-signal)，它把“执行账户连接”和“跟随某一信号源”分开，再设置比例、方向、白名单与风控。这些公开说明支持流程判断，不能证明它所有信号的内部采集路径或延迟。

普通 GitHub 托管 runner 的出口 IP 不固定；有 IP 白名单要求时，需要固定出口的执行环境或其他满足交易所规则的正式方案。GitHub 队列、启动与任务接续也会形成空档，不能承诺连续每五秒成交。不能通过解除账户安全限制、轮换 IP 或代理绕过平台限制。实盘启动仍需另外明确授权。

## 已交付范围

- 网页按“来源账户 × 执行平台”保存本机草稿，提供到 GitHub 新建/编辑非敏感 JSON 的入口。保存本机草稿不会自动提交 GitHub，也不会连接 API。
- 参数包括账户别名、固定名义金额及比例、方向、品种白名单、时效和执行前限额。试运行增仓意图金额是固定金额乘比例；源端总持仓未知，不能按其完整仓位比例推算。当前不执行余额、总敞口或滑点检查，不产生可执行订单。
- `Copy signal dry-run` 只接受 `mode: dry_run` 与 `liveTradingEnabled: false`。没有定时、接续、交易所请求或交易密钥读取。主分支修改程序时仅跑离线测试；手动运行时在 65 秒内以五秒为目标节拍读取原有公开检查点。
- 原有熬鹰公开操作观察器仍单独运行；本工作流不重复请求币安，不改动其状态、停止记录或执行频率。只保存跟单配置的提交不会触发整站行情采集或 Pages 发布。
- GitHub 试运行只接 `5075281354358777856` 的已批准公开检查点。其他来源可以保存草稿，但未接入该后台流程。公开 Hyperliquid 账户仍可使用现有本机模拟。

## 运行与证据

1. 在网页选择带单员和执行平台，调整参数，“保存跟单设置”仅保存到当前浏览器。
2. “在 GitHub 保存配置”打开官方文件编辑器，检查 JSON 后提交。以后用“编辑 GitHub 配置”修改。不要把 Key、Secret、Passphrase 或私钥写进这些 JSON。
3. 打开 `Copy signal dry-run`，手动运行，填写页面显示的 `copy-config/...json` 路径。`copy-config/example-aoying-*.json` 是明确标注的非敏感配置示例，不是真实账户、交易数据或接入证明。
4. 下载该次工作流的 `copy-dry-run-运行ID-尝试次数` artifact，查看 `report.json` 中的检查、跳过原因与意图。`ordersSent` 始终为 0，`executable` 始终为 false。本次发布的本地测试不等于已在 GitHub 完成真实试运行。

首次检查只建立基线，已有记录不生成新信号。断档超过 120 秒或时钟回退时重新建立基线。过期、零成交量、方向未解析、同身份多版本和来源时间回退等情况跳过或停止。减仓只表示“减少本站未来执行账户中属于此跟单的仓位”，没有目标仓位证据时不猜数量。来源是无稳定订单 ID 的聚合操作记录，开仓/加仓方向不等于已确认新开仓。

状态缓存按精确配置摘要区分，同一配置串行。停止状态在错误步骤之后仍尝试保存，HTTP 错误不重试；首次请求即拒绝也保存停止标记。缓存可能过期或被清理，因此它不是实盘可靠账本。缓存缺失将重新建立基线，不能补单或证明此前没有停止；发生访问拒绝后不得通过重跑、改配置或清缓存继续对应请求，应先检查错误证据。没有跨任务持久可靠状态和订单回执对账的执行器不能启用实盘。

## 正式 API 接入尚缺的内容

网页展示未来使用的 Secrets 名称，不读取、创建或验证它们。此版本即使已存在这些 Secrets，也不会读取或下单。

| 执行平台 | 预留 Secrets 后缀 | 还需核验 |
| --- | --- | --- |
| Bitget | API_KEY、API_SECRET、PASSPHRASE | Classic/UTA 账户类型、读取/合约交易权限、提现关闭、白名单、合约映射和精度 |
| Binance | API_KEY、API_SECRET | USDT 合约权限、账户/持仓模式、提现关闭、白名单、合约与数量限制 |
| Hyperliquid | AGENT_PRIVATE_KEY | 专用 Agent 授权、账户地址与权限、nonce、品种映射、最小金额和精度 |

Secrets 名称为“账户别名_后缀”。主钱包私钥不得提交到网页或仓库。正式连接时还需要只读连通测试、真实交易回执幂等核对、重启不重放、仅减自身仓位、余额与总敞口核对以及用户明确的实盘启用。本次没有执行这些验收。

官方资料：[GitHub Secrets](https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions)、[GitHub hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)、[Bitget UTA API](https://www.bitget.com/docs/uta/rest-api)、[Binance API restrictions](https://developers.binance.com/en/docs/catalog/core-trading-wallet/api/rest-api/account)、[Hyperliquid API wallets](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets)。

离线检查：`python3 -B -m unittest discover -s tools/copy_plan -p 'test_*.py'`。测试数据仅在测试进程中生成，不进入正式行情、信号或账本。
