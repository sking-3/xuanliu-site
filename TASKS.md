# 任务清单与修复计划

本文件对应 2026-11-18 体检。当前只做诊断建档；用户回复“按计划执行”后再进入代码任务。每个任务都应独立验收，避免同时改 UI 和后端。

## 账户链路最小修复计划（本轮范围）

本计划只覆盖注册、登录、登出、个人资料显示和昵称修改；不包含首页、头像、邮件验证、找回密码或第三方 provider。每一步先完成接口/浏览器验收，再进入下一步。单个任务预计不超过 5 个文件。

### 小任务 1：先稳定注册、登录和登出

**状态：已完成代码审计与非破坏性验收；无需修改业务文件。**

**完成标准**：

- 在 `https://45-77-39-98.sslip.io/auth.html` 注册后，服务端返回 201、创建 `users`/`sessions`/`wallet_accounts`，浏览器保存 `books_session`，并进入账户页。
- 使用同一邮箱重新注册得到明确的重复邮箱错误；错误密码不能建立会话。
- 登录后 `GET /api/auth/me` 返回 `authenticated=true`；登出后同一 Cookie 再请求返回 `authenticated=false`。
- 记录正式域名、响应状态、Cookie 属性和线上静态文件版本；不能只以按钮提示作为成功证据。

**预计改动文件**：`work/books-vps-test/server.mjs`、`work/site/books-auth.js`、`work/site/auth.html`、`work/books-vps-test/test/auth.test.mjs`（最多 4 个业务/测试文件）。

**风险点**：旧页面或旧配置仍指向 GitHub Pages/本地地址；`Secure`、`SameSite=Lax`、CORS 来源和缓存版本不一致；密码规则或已有数据库迁移造成旧账户无法登录。

**已验证证据**：本地完整认证测试 8/8；正式域名健康接口 200；无 Cookie 的 `/api/auth/me`、无 Cookie 登出、无效注册和无效登录均返回预期结果；正式 Origin 的 CORS 允许凭据；线上四个账户链路文件与工作区 SHA-256 一致。为避免在正式库留下测试账户，没有执行线上成功注册写入。

### 小任务 2：再修个人资料显示

**状态：已完成正式网站验证；无需修改业务文件。**

**完成标准**：

- 登录后账户页只依赖已验证的 `/api/auth/me` 渲染 `displayName`、邮箱、三位账户号、权限、状态和注册时间。
- 未登录或会话过期时明确回到登录页；加载中、401、接口错误各有可见状态，不出现空白卡片。
- 浏览器 Network 记录显示请求发往正式 API，响应中的 `user` 字段与页面字段一一对应；不把未调用的 `/api/account/profile` 当成主链证据。

**预计改动文件**：`work/site/account.html`、`work/site/books-auth.js`，如响应契约确有差异才增加 `work/books-vps-test/server.mjs`（2–3 个文件）。

**风险点**：线上仍发布旧 HTML/JS；字段名（如 `accountNo`、`createdAt`）漂移；账户页并发读取钱包失败时误把资料失败；跨域 Cookie 问题被错误归因于资料接口。

**已验证证据**：正式 Chrome 会话已显示昵称、邮箱、账户号 `002`、权限、状态和注册时间；未登录会话保留登录入口；线上 `account.html` 与工作区 SHA-256 一致。资料显示任务已关闭，下一步进入昵称修改任务前仍需保持头像范围不变。

### 小任务 3：最后增加昵称修改和保存

**完成标准**：

- 账户页出现明确的“修改昵称”操作；提交空值、超长值或非字符串时前端和服务端都拒绝。
- 认证用户调用约定的昵称更新接口（建议 `PATCH /api/account/profile`，仅接收 `displayName`），只更新自己的 `users.display_name`。
- 保存成功后返回完整 `user`，页面立即更新；刷新页面或重新登录后昵称仍从数据库读取，其他用户不受影响。
- 增加未认证、越权、边界长度和持久化测试；不修改头像和第三方登录。

**预计改动文件**：`work/site/account.html`、`work/site/books-auth.js`、`work/books-vps-test/server.mjs`、`work/books-vps-test/test/auth.test.mjs`（4 个文件）。

**风险点**：需要同步更新 CORS 的预检方法；昵称与账户号/邮箱显示的回退规则可能不一致；只改内存或只改响应而未写入数据库；缓存旧的账户页导致用户看不到新操作。

## 账户链路 3 分钟验收步骤（批准实施后）

1. 在正式域名打开注册页，注册一个一次性测试邮箱，记录 Network 中 register 的状态、`Set-Cookie` 和跳转地址。
2. 在账户页确认 `/api/auth/me` 为 200，并看到昵称、邮箱、三位账户号、权限、状态和注册时间；刷新后再次确认。
3. 退出登录，确认再次访问账户页回到登录页；重新登录后修改昵称，刷新和重新登录仍保持新昵称。

本轮没有代码变更，因此现在不会产生新的线上视觉变化；回复“按计划执行”后才按上述三步逐任务实施。若某个相同问题连续两次失败，停止该任务并保留证据。

## 账户链路回滚方式

- 每个小任务单独提交；回滚到上一个已验收提交即可恢复旧接口和页面。
- 数据库变更只允许可逆迁移；昵称更新任务必须先备份 `users` 表，再发布服务端。
- 若线上版本与 GitHub 不一致，先恢复上一份 VPS 站点目录和 systemd 版本，再排查发布链路；不删除现有账户或会话数据。

## 修复顺序

### 1. P0：建立 GitHub→VPS 单一发布与网关健康证据

**目标**：证明 GitHub 源码、VPS 站点和正式域名之间的实际链路，或者明确仍需人工配置；不再把 GitHub Pages 当发布目标。

**完成标准**：

- 现场确认 DNS 指向当前 VPS IP，TLS 证书覆盖 `45-77-39-98.sslip.io`。
- Caddy 实际配置使用正式域名并反代到 `127.0.0.1:8930`。
- `/api/health` 返回 `ok=true`、`mode=production`、`liveTradingEnabled=false`。
- 用唯一版本标识证明 VPS `/index.html` 与指定 GitHub 提交一致；记录时间和回滚点。
- 明确采用手工发布还是受限自动发布，禁止同时保留两个用户入口。

**预计改动范围**：2–4 个部署/文档文件，外加 VPS 现场配置；不改业务 UI。若要新增自动发布，另拆任务。

### 2. P0：统一数据来源、刷新和陈旧状态 contract

**目标**：修复“暂未取得数据/动态来源未加载/显示保存快照”的歧义。

**完成标准**：

- 每个公开数据模块统一显示来源、源事件时间、采集时间、网页读取时间、陈旧截止、失败原因和重试动作。
- `ready/stale/error/stopped/unknown` 语义统一，未知不转成空仓，失败不擦除最后成功快照。
- 真实源时间与网页读取时间分开；轮询间隔不写成平台延迟承诺。
- 首页、带单员广场和策略研究页使用同一份状态渲染约定。

**预计改动范围**：先改 2–5 个共享状态/显示文件；不与认证或 AlphaFox 视觉重做同批实施。

### 3. P1：带单员数据刷新与 AlphaFox 信号语义对齐

**目标**：把“快照广场”和“可持续信号来源”分开表达，避免用静态排行榜冒充实时跟单信号。

**完成标准**：

- 每个平台/账户显示来源类型、最近成功采集、最近尝试、陈旧截止和当前可见范围。
- 明确哪些是公开排行榜、哪些是公开成交/持仓、哪些是页面打开时的只读连接。
- 为“交易所凭证/我的信号”建立独立需求和数据模型；本任务不接真实交易执行。
- 公开卡片提供清晰空态、刷新、详情和来源按钮，不把隐藏仓位解释为空仓。

**预计改动范围**：2–5 个 trader 数据/状态文件；UI 结构另拆，不和后端采集同批改。

### 4. P1：认证 provider 与账户流程决策

**目标**：先确定要支持的注册方式，再实现真实 provider；不在 UI 上显示“可用”假入口。

**完成标准**：

- 邮箱密码主链完成注册、登录、退出、过期会话和权限验收。
- 手机短信、Google、微信、QQ 明确标注“未配置”或完成真实 OAuth/SMS 回调；不使用伪按钮。
- 账户中心从公开站进入后保持同一 shell，不切换到廉价独立风格。
- 充值只在托管服务、Webhook、账本和审计齐全后启用，当前保持安全返回。

**预计改动范围**：每个 provider 单独 2–5 个文件；认证后端与 UI 分开任务。

### 5. P1：AlphaFox 风格 UI 重做（最后实施）

**目标**：在状态和入口稳定后，按 AlphaFox 的信息架构重做“策略/信号”区域，而不是继续在现有 CSS 上打补丁。

**完成标准**：

- 采用浅灰背景、窄图标栏、顶部策略 tabs、白色圆角卡片、橙色主按钮、pill 控件、统一空态和居中模糊弹窗。
- `交易所凭证/我的信号` 作为明确的二级 tabs；“添加信号”四种来源有独立配置状态。
- 所有可点击文字链接改为明确按钮或可访问的 action；保留键盘焦点、`aria-busy`、错误就近提示和 reduced-motion。
- 375/768/1024/1440 宽度通过视觉和无溢出验收，加载/失败/空态不会闪烁或白屏。

**预计改动范围**：首个最小 UI 任务控制在 5 个文件内，优先新建策略信号页，不先改整个站点。

## 建议的第一个最小任务

先做“生产链路与健康证明”，理由是：

1. 现在 GitHub Pages 已关闭，但仓库仍有 `refresh-traders.yml`、`quant-research.yml`、`refresh-macro-cn.yml` 等残留 Pages 触发/校验路径；继续做 UI 会让旧工作流继续制造失败状态。
2. `books-auth-config.js` 指向 VPS，但工作区没有 Git checkout 或自动同步脚本，Caddy 配置还是占位域名；先证明唯一来源，才能知道后续改的是实际线上版本。
3. 该任务不需要改业务 HTML/CSS/后端逻辑，风险和文件范围最小，完成后可以给 UI 任务提供明确版本和回滚点。

## 3 分钟验收模板

1. 打开 `https://45-77-39-98.sslip.io`，记录页面标题、版本标识和响应时间。
2. 打开 `/api/health`，确认 `ok=true`、生产模式、真实下单关闭。
3. 通过浏览器 Network/响应头确认 HTML、API 和 Cookie 均来自正式域名；旧 Pages 地址应为 404。
4. 在 GitHub 查看对应提交/Actions 记录，确认没有把 Pages 当成第二入口。
5. 若失败，保留旧 VPS 版本，按记录的提交/文件回滚，不直接覆盖数据库或凭证。

## 回滚原则

- 文档任务：删除本次新增的四份文档即可，不触碰业务。
- 部署任务：回到上一份已验收的站点目录和 service 配置，先恢复 `/api/health`，再处理 UI。
- UI 任务：每个任务使用独立提交，保留旧 CSS/HTML 备份和可访问的上一版本 URL；禁止用 GitHub Pages 临时替代正式站。

## Git 提交建议

当前工作区没有 `.git`，无法在此执行提交。若在实际仓库 checkout 中提交，建议：

```bash
git add AGENTS.md PROJECT_CONTEXT.md CURRENT_STATE.md TASKS.md
git commit -m "docs: archive Books project audit and repair plan"
```

## 2026-11-18 只读体检计划（不改业务代码）

本轮完成标准是四份建档文档和 `ACCEPTANCE.md` 更新，业务代码保持不变。当前个人资料页的实际现象是：正式登录会话显示当前用户昵称和邮箱；未登录会话显示登录入口/占位符；没有发现跨用户资料显示。

### 体检输出

1. 技术栈、22 个主要页面、数据来源和真实性边界已补入 `PROJECT_CONTEXT.md`。
2. 注册→登录→会话→`/api/auth/me`→个人资料显示流程已补入 `CURRENT_STATE.md`；当前不认定为卡在资料接口。
3. “暂未取得数据/动态来源未加载/保存快照”被解释为各模块独立数据请求、失败保留最近成功快照以及缺少统一状态契约的结果。
4. 五个最高优先级问题已按 P0/P1 排列：明文凭证风险、发布链证明缺失、数据状态分散、认证入口/契约并存、AlphaFox 策略信号架构缺口。

### 账户资料页后续最小计划（仍需另行批准）

- **计划 A：资料显示回归**：只验证登录后显示自己的昵称和邮箱、刷新保持、退出后不可见、无红色错误；预计只改/新增 1–3 个测试或资料页相关文件，不改注册登录逻辑。
- **计划 B：昵称修改**：另行增加昵称保存接口和页面操作；不与本轮合并。
- **计划 C：头像上传**：另行处理；不与本轮合并。

在用户明确批准前，不执行上述业务代码计划。项目第一个最小实施任务仍建议先做“凭证清理 + GitHub/VPS 唯一发布链健康证明”，因为它能保证后续看到的资料页确实来自唯一正式版本。

## 第一个最小任务执行结果：凭证与唯一发布链（2026-11-18）

**范围**：只处理工作区凭证、远程发布链证据和正式域名健康检查；没有改业务代码、数据库、Actions 或 VPS 配置。

### 已完成

1. 将 `work/books-vps-test/.deploy/books_vps_ed25519` 及公钥移到 `/private/tmp/books-vps-key-quarantine-20261118/`，隔离目录 `0700`，私钥 `0600`；工作区同类私钥扫描为 0。指纹：`SHA256:xz86xBYIluRJwXmFvq0w0DivTxW0ztP4moaS8wxDc9Y`。
2. `https://45-77-39-98.sslip.io/api/health` 返回 HTTP 200、Caddy、生产模式，且 `liveTradingEnabled=false`。这证明 Books 服务交易路由关闭，其他独立进程仍需另行核验。TLS 证书覆盖正式域名并通过链验证。
3. 远程 GitHub 只读检查确认仓库为 `sking-3/xuanliu-site`，最新 `main` 提交 `5cc833008fa674d384c7964579b2dcc0f0487883`。

### 未通过/仍需拆任务

- **唯一 GitHub→VPS 发布链：未建立。** 远程 `deploy-static-pages.yml` 和本地 `work/site/.github/workflows` 中的 Pages 相关工作流仍调用 `actions/deploy-pages@v4` 或访问旧 Pages；没有 SSH/rsync/webhook/VPS API 发布步骤。不能把它当成正式站自动发布链。
- **权威 DNS→Vultr IP：未证明。** 当前网络解析 `45-77-39-98.sslip.io` 为 `198.18.0.181`；需在 VPS/权威 DNS 侧核实真实公网 IP，不能仅凭本机 DNS 结论。
- **凭证轮换：未完成。** 本轮只做可回滚隔离，没有撤销 VPS/GitHub 上旧公钥，也没有生成新密钥；这需要单独授权和现场登录。

### 验收证据

- 正式首页 `index.html` HTTP 200，响应 `server: Caddy`；本次读取 SHA-256：`ab80b0e18d3a11fc972fb9afffc37de2f84fbcc3adf2839e8e0c3a2a53615934`。
- `/api/health` 正文：`ok=true`、`mode=production`、`settlementMode=production`、`paymentConfigured=false`、`liveTradingEnabled=false`。
- TLS：主题/SAN `45-77-39-98.sslip.io`；Let's Encrypt YE2；有效期 `2026-11-17 12:16:53 GMT`–`2027-02-15 12:16:52 GMT`。

### 3 分钟验收步骤

1. 打开 `https://45-77-39-98.sslip.io`，确认页面为 HTTP 200 且响应头为 Caddy。
2. 打开 `https://45-77-39-98.sslip.io/api/health`，确认 `ok=true`、生产模式和 Books 服务 `liveTradingEnabled=false`。
3. 在 GitHub 仓库 Actions 中确认：旧 Pages workflow 仍存在；在当前版本没有“部署到 VPS”的 workflow。由此确认本轮没有误报唯一发布链已建立。
4. 在 Vultr/VPS 现场核对公网 IP、`caddy validate`、systemd `books-vps` 状态和 `/api/health` loopback；这些是下一任务的现场补证据。

### 回滚方式

- 凭证：隔离副本暂存于 `/private/tmp/books-vps-key-quarantine-20261118/`。这是临时目录，不是持久备份，系统清理或重启后可能消失。不要恢复到工作区。若轮换失败，应在受控密钥存储中恢复旧公钥对应权限，再重新验证服务。
- 文档：回退本节即可；业务代码、数据库、Actions、VPS 配置没有变更。
- 当前工作区没有 `.git`，无法执行提交或生成 `git diff`；在实际 checkout 中建议先保存文档变更，再单独提交：

```bash
git add AGENTS.md PROJECT_CONTEXT.md CURRENT_STATE.md TASKS.md
git commit -m "docs: record credential and deployment-chain audit"
```

## 账户验收清单（2026-11-18）

状态：文档已完成，业务代码未修改。

- `ACCEPTANCE.md` 已覆盖注册、登录、资料显示、修改昵称、刷新、退出、重新登录，以及错误密码、重复邮箱、未登录访问资料页、修改他人资料和连续错误登录五个异常场景。
- 每一步都写明点击位置、通过现象和失败现象，适合非技术人员手动执行。
- 修改昵称当前没有实现。清单将它标为待实现，未来实现后再按保存、刷新和重登检查持久性。
- 当前正式账户链路的资料主请求是 `/api/auth/me`。清单要求退出后访问账户页不能看到资料，避免只检查登录按钮提示。
- 本轮只改项目文档，没有改业务 HTML、CSS、JavaScript、Node、数据库、Actions 或 VPS。

## 首页数据状态专项体检（2026-11-18）

状态：只读诊断已完成，业务代码未修改。

### 首页模块清单

- 顶部指数条。腾讯行情接口加 HTML 初始收盘值和 `books.indexTape.v1` 本地缓存，接口失败时保留收盘快照。
- 市场温度、核心估值、跨境资金、活跃标的和宏观官方发布。读取 `market-overview.json` 与 `macro-cn.json`，每张卡有独立状态和时间字段。
- 宏观外部快讯和跨市场观察报价。读取 TradingView 外部 iframe，失败时回到保存视图。
- A 股与美股行情卡。使用 TradingView market overview 组件，脚本和 iframe 建立不等于报价已经渲染。
- 加密行情和市场异动。使用 Bitget REST、WebSocket 和 90 秒过期判断。
- A 股收盘涨跌榜。使用 GitHub 上游快照、本地 `research-data/a-daily-movers.json` 和浏览器缓存。
- 美股涨跌榜、沪深观察和股票分钟异动。前两者依赖 TradingView，分钟异动读取 `research-data/snapshot.json`。
- 带单员收益榜。合并 Hyperliquid、Binance、OKX、Bitget 和熬鹰历史多份公开 JSON 快照。
- 研究工作台入口。只有站内导航，不属于动态数据模块。

### 当前状态判断

| 模块 | 现象 | 判断 |
|---|---|---|
| 市场研究卡 | 2026-11-13 聚合快照中估值卡 `network_error`，旧宏观卡有 BLS `http_403` | 接口或采集失败后保留快照 |
| 官方宏观卡 | `macro-cn.json` 2026-11-16 生成，国家统计局卡片 `ready` | 真有数据，动态快讯失败时才回退 |
| 股票分钟异动 | `research-data/snapshot.json` 的 `observations` 和 `alerts` 都是 0 | 成功读取但有效数据为空 |
| A 股收盘榜 | 本地快照截至 2026-11-13，有 5579 个有效报价 | 有快照。上游失败时显示旧快照 |
| Bitget 行情 | REST/WebSocket 任一来源失败时保留 90 秒内旧报价，超过后显示过期或未连接 | 需要区分断线和过期 |
| TradingView 行情 | 代码只确认脚本、iframe 和 load 事件，不确认每个价格 | 可能是前端未完成渲染，不能归因真没数据 |
| 带单员榜 | 多个交易所和 Hyperliquid 文件独立读取，更新时间不一致 | 多快照合并，可能部分陈旧或部分不可比较 |

### 四种状态定义

- 真没数据。来源读取成功，结构有效，但没有可展示行或当前周期没有符合条件的记录。
- 接口失败。请求超时、HTTP 403、网络错误、来源拒绝或数据校验失败。
- 前端没渲染。外部组件存在，但没有完成内容或逐项报价确认。
- 缓存快照。当前请求失败，页面继续显示 HTML 种子、localStorage 或最近一次成功的 JSON。

### 影响排序与完成标准

1. **先修市场研究卡状态统一**。完成标准是五张卡独立显示来源、来源时间、采集时间、最后尝试、陈旧截止和失败原因。预计改动 2–5 个市场状态和采集文件。
2. **再修股票分钟异动采集**。完成标准是页面明确区分“有效行数为零”和“文件读取失败”，并显示快照发布与读取时间。预计改动 2–5 个采集、快照和测试文件。
3. **再核验 TradingView 渲染**。完成标准是分别显示脚本加载、iframe 建立、内容完成和超时状态。预计改动 2–5 个外部组件状态和测试文件。
4. **再核验 Bitget 过期与断线**。完成标准是 REST、WebSocket、最后来源时间、90 秒陈旧状态和重试结果一致。预计改动 2–4 个加密行情文件。
5. **最后处理带单员榜合并状态**。完成标准是每个平台和周期显示独立读取时间、状态和可比较账户数，单个平台失败不影响其他平台。预计改动 2–5 个榜单数据和测试文件。

本专项只完成诊断和建档，不修账户、不新增功能、不改页面设计。

## 头像界面批次（2026-11-18）

状态：代码已写入 GitHub，正式域名浏览器验收待发布链恢复。

- 变更文件：`work/site/account.html`、`work/site/account.css`。
- 交互结果：当前头像、选择图片、本地预览和保存上传全部居中；HTTPS 图片地址、预设头像选择和相关文字入口已移除。
- 验证：账户页内联脚本和 `books-auth.js` 语法检查通过；认证测试 8/8 通过；账户实时状态测试 26 项通过。
- GitHub 提交：`f355a767b40cfa4c529ead465c99cdc8bb49d1ff`、`200d5cbc26e0130d582df2044659699f375f0dce`、`b52b86645017f0ec353944b4975266bd3fb93e7b`。
- 待验收：正式域名本次 DNS 无法解析，尚未确认 VPS 页面已加载新 HTML/CSS。不能把远程仓库状态当成线上页面状态。

## 首页状态批次（2026-11-18）

状态：代码已写入 GitHub，正式域名浏览器验收待发布链恢复。

- 变更文件：`work/site/market-overview.js`、`work/site/audit/market-overview-state-unit.cjs`。
- 结果：市场温度、核心估值、跨境资金、活跃标的和宏观卡现在区分已更新、历史快照、来源读取失败和暂无可核验数据，不再把这些情况统一显示成“暂未取得数据”。
- 验证：脚本语法检查通过，状态单元测试通过，认证测试 8/8 通过。
- GitHub 提交：`fff32e2a8ec1597ef7e5dea6c013e36b0d1417c5`、`32fc7e0a7c191ce374acd2c26b2e5dba98b4de4d`。
- 待验收：正式域名本次 DNS 无法解析，不能把 GitHub 主分支状态当成线上页面已刷新。


## 2026-11-18 只读收尾

### 状态

本次只完成体检、证据整理和文档收尾，没有改业务代码。用户提供的首页目标模块仍为“【填模块名】”，因此没有选择或修复任意首页模块。

### 已更新内容

- 技术栈和页面清单：静态 HTML/CSS/原生 JavaScript、Node ESM、`node:sqlite`，并列出公开行情、研究、带单员和账户页面。
- 账户流程：注册/登录建会话，账户页调用 `/api/auth/me` 渲染当前用户，退出清除会话；昵称修改和第三方 provider 尚未实现或配置。
- 首页状态：分别记录真没数据、接口失败、前端未渲染和缓存快照，保留来源和时间字段要求。
- 部署边界：GitHub 分支、正式域名和 VPS 页面仍需分层验收，不能互相替代。

### 下一步最小任务建议

先指定一个真实首页模块，例如“核心估值卡”，并提供当前实际显示文字。随后只改该模块的来源读取、空态和失败态，控制在 2–5 个必要文件内。

完成标准是有数据时显示来源数据和时间，无数据时显示“暂无数据”，请求失败时显示“数据加载失败，请稍后重试”，不再以旧快照冒充实时，其他模块无变化。

### 3 分钟验收

1. 打开正式域名并记录目标模块的实际文案和版本标识。
2. 在正常来源、空数据和失败来源三种状态下分别确认文案与来源时间。
3. 刷新页面，确认其他模块无变化且浏览器无新增红色报错。

### 回滚与提交建议

- 文档收尾可回退本节及对应文档提交，不触碰业务数据。
- 模块修复应使用独立提交，回滚到上一个已验收提交即可。
- 当前工作区没有 `.git`，无法执行提交。实际仓库可使用：`git add AGENTS.md PROJECT_CONTEXT.md CURRENT_STATE.md TASKS.md && git commit -m "docs: close Books audit and define single-module follow-up"`。


## 2026-11-18 账户回归收尾

### 回归记录

- 按 `ACCEPTANCE.md` 核对了账户主链、异常场景和未实现项。
- 本地完整认证测试为 9/9 通过。
- 正式域名回归在打开 `/auth.html` 时被 DNS 解析阻断，线上主链不能标记为通过。
- `/api/health` 和无 Cookie `/api/auth/me` 的成功响应只作为局部健康证据。

### 最高优先级单一 bug

**正式域名 DNS/唯一发布链无法稳定复核。**

完成标准是域名可解析到实际 VPS，TLS 覆盖正式域名，Caddy 反代 `127.0.0.1:8930`，`/api/health` 返回 200，VPS 页面版本可追溯到指定 GitHub 提交，旧 Pages 不再作为入口。

预计改动范围为 2–4 个部署或文档文件及 VPS 现场配置。风险是 DNS 或 Caddy 调整可能造成短暂中断。账户逻辑、数据库、首页业务代码和交易接口保持不动。

### 待用户确认后执行

收到确认后只执行上述一个发布链路任务。完成后重新跑 `ACCEPTANCE.md` 受影响的线上步骤，并确认本地 9/9 测试不退化。

### 本次收尾验收

1. 打开正式域名并记录页面 GET、证书和版本标识。
2. 打开 `/api/health`，确认生产模式和真实下单关闭。
3. 按注册、登录、资料显示、刷新、退出和重登顺序复跑。
4. 确认旧 Pages 地址不是入口，浏览器无新增红色报错。

### 回滚和提交建议

回滚到上一个已验收的 DNS/Caddy/VPS 版本，不触碰数据库和账户数据。当前工作区没有 `.git`，无法执行提交。实际仓库可使用：

```bash
git add AGENTS.md PROJECT_CONTEXT.md CURRENT_STATE.md TASKS.md
git commit -m "docs: record account regression and deployment blocker"
```


## 发布链路任务结果（2026-11-18）

### 完成项

- 已核验 DNS、TLS、Caddy、Node 和 VPS 文件版本。
- 已将 GitHub `main` 提交 `fb030fc914dfc9f1360095b946a3b70ea2d3f845` 对应的站点文件同步到 VPS。
- 已加入 `X-Books-Release` 响应头，正式 GET、健康接口、CORS 和旧 Pages 404 均已验证。
- 站点和 Caddy 原文件已保留备份。

### 未完成项

- 当前 DNS 查询返回 `198.18.0.71`，仍需在外部权威网络确认它与 VPS 公网 IP 的关系。
- 自动 GitHub→VPS workflow 尚未建立。后续自动化需要单独配置受控 SSH 密钥或部署令牌，不在本次范围内。

### 3 分钟验收

1. 打开 `https://45-77-39-98.sslip.io/index.html`，确认响应头包含 `X-Books-Release`。
2. 打开 `/api/health`，确认 `ok=true`、`mode=production`、`liveTradingEnabled=false`。
3. 打开 `/auth.html` 和 `/account.html`，确认页面 GET 为 200，账户头像弹窗为本地上传布局。
4. 确认旧 GitHub Pages 地址返回 404。
5. 在 VPS 中确认 `systemctl is-active books-vps` 和 `caddy validate` 均通过。

### 回滚

将 `/opt/books/site.prev.20261118-release-chain` 恢复到 `/opt/books/site`，将 `/etc/caddy/Caddyfile.prev.20261118-release-chain` 恢复为 `/etc/caddy/Caddyfile`，然后 reload Caddy 并复核 `/api/health`。

### 建议提交信息

```bash
git add AGENTS.md PROJECT_CONTEXT.md CURRENT_STATE.md TASKS.md ACCEPTANCE.md
git commit -m "ops: bind VPS release to GitHub main"
```


## 账户与金融安全基线审计（2026-11-18）

### 状态

只读审计完成，没有实现新功能、接入真实资金或改变交易权限。

### 风险排序与最小修复顺序

1. **P0/P1 凭证撤销与轮换**
   - 风险：隔离的旧 SSH key 仍在 VPS `/root/.ssh/authorized_keys`，旧指纹仍具备连接能力。
   - 最小修复：在 VPS 撤销旧指纹，生成最小权限新 key，并重新验证连接。
   - 验收现象：旧 key 连接失败，新 key 按最小权限连接成功。
   - 范围：2–4 个部署/凭证文件及 VPS 操作。

2. **P1 数据库文件权限**
   - 风险：`books.sqlite`、`-wal`、`-shm` 当前为 644，包含账户、会话哈希和金融数据。
   - 最小修复：改为 600 或 640，设置服务 umask，验证非 `books` 用户不可读。
   - 验收现象：`stat` 权限收紧，非服务用户读取失败，服务仍能启动。
   - 范围：service 配置和 VPS 文件权限。

3. **P1 速率限制与邮箱枚举**
   - 风险：登录限流仅单进程按邮箱，注册无限流；重复邮箱返回明确存在提示。
   - 最小修复：共享账号/IP/设备限流，注册与重置覆盖，统一注册外观响应。
   - 验收现象：错误尝试达到阈值后锁定，跨实例仍生效，新旧邮箱注册外观一致。
   - 范围：2–5 个服务端、前端和测试文件。

4. **P1 关键操作审计**
   - 风险：没有 `audit_events` 或等价脱敏事件，充值、webhook 和管理员动作不可追溯。
   - 最小修复：增加 append-only 审计记录，禁止记录密码、Cookie、token、密钥和支付地址。
   - 验收现象：按用户、时间和动作能查到成功/失败事件，敏感字段为空。
   - 范围：2–5 个服务端、数据库和测试文件。

5. **P2 传输和密码格式加固**
   - 风险：HTTPS 已可用但未发 HSTS，scrypt 参数未版本化，webhook secret 使用普通字符串比较。
   - 最小修复：增加 HSTS，给 hash 增加版本字段，后续改用常量时间 secret 比较。
   - 验收现象：响应含 HSTS，旧 hash 可迁移，webhook 签名比较保持安全。
   - 范围：1–4 个配置/服务端/测试文件。

### 本次 3 分钟验收

1. 查看 `server.mjs` 的 hash、限流和错误码位置。
2. 查看 VPS `/root/.ssh/authorized_keys`、`/var/lib/books/books.sqlite*` 权限和 `/etc/books/books.env` 是否存在。
3. 打开正式域名检查 HTTP→HTTPS、TLS、HSTS 和 `/api/health`。
4. 检查 `journalctl -u books-vps` 不出现密码、Cookie、token、secret。
5. 确认数据库 schema 没有审计表，并将其记录为待修复项。

### 回滚和提交建议

本次没有业务代码或数据变更，文档回滚到本节之前即可。当前工作区没有 `.git`，无法执行提交。实际仓库可使用：

```bash
git add AGENTS.md PROJECT_CONTEXT.md CURRENT_STATE.md TASKS.md
git commit -m "docs: record account and financial security baseline"
```


## SSH 密钥轮换任务结果（2026-11-18）

### 已完成

- 旧指纹 `SHA256:xz86xBYIluRJwXmFvq0w0DivTxW0ztP4moaS8wxDc9Y` 已从 VPS 授权列表撤销。
- 新指纹 `SHA256:mAhNEtPnJlfh1BlFfbMxq9jJMGFj6HcxDl6LWOqlcmo` 已安装并验证可用。
- 旧钥连接测试失败，新钥连接测试成功。
- `books-vps`、Caddy 和 `/api/health` 均保持正常。
- 旧私钥临时隔离副本已删除。

### 未完成的安全基线

数据库文件权限、共享认证限流、邮箱抗枚举、关键操作审计、HSTS、scrypt 参数版本化和 webhook secret 常量时间比较仍需独立任务。

### 回滚说明

本次轮换不保留旧私钥回滚路径。若新钥丢失，应通过 VPS 控制台重新安装新的公钥，不得恢复已撤销旧钥。

### 建议提交信息

```bash
git add AGENTS.md PROJECT_CONTEXT.md CURRENT_STATE.md TASKS.md
git commit -m "docs: record SSH key rotation and security verification"
```
