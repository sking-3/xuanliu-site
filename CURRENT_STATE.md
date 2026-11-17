# 当前状态（项目体检）

审计时间：2026-11-18（Asia/Shanghai）  
审计范围：只读检查根目录、`work/site`、`work/books-vps-test`、GitHub Actions 配置和 AlphaFox 公开页面。  
本轮变更：只新增/更新项目文档和账户验收清单，没有修改业务代码、工作流、数据库或 VPS。

## 已确认

- 根目录原先不存在 `AGENTS.md`、`PROJECT_CONTEXT.md`、`CURRENT_STATE.md`、`TASKS.md`；本轮已建立。
- 前端是静态 HTML/CSS/原生 JS；服务端是 Node ESM + `node:sqlite`；生产进程由 systemd 管理，Caddy 反代到 `127.0.0.1:8930`。
- 正式前端 API 基址为 `https://45-77-39-98.sslip.io`；服务允许来源也写成该地址。
- 旧 Pages 地址实测显示 GitHub 404，但远程 `sking-3/xuanliu-site` 的 `main` 仍保留 `deploy-static-pages.yml` 文件，文件内容包含 `actions/deploy-pages@v4` 和 `sking-3.github.io/xuanliu-site/` 校验地址。本地 `work/site/.github/workflows` 也有 14 个工作流，多个文件仍引用 Pages。配置文件残留不等于 GitHub 设置中当前一定会执行，实际启用状态仍需单独查看 Actions。
- VPS 正式页面可打开 `Books · 账户中心`，并能读取账户资料结构、三位账户号、头像入口和钱包卡。
- 邮箱/密码注册和登录主链已存在：注册成功即建立会话并跳转账户中心；账户页通过 `/api/auth/me` 做会话门禁。
- 账户号对外使用三位递增编号，内部仍保留 UUID 主键。
- 交易执行路由保持关闭：`/api/orders`、`/api/trades`、`/api/copy` 返回 403，`liveTrading=false`。
- AlphaFox `/zh/dashboard/strategy/signals` 的真实页面结构与浅色 UI 已只读记录；Books 当前没有等价的“交易所凭证/我的信号”层。

## 认证流程体检

### 可用主链

`auth.html` → `/api/auth/register` 或 `/api/auth/login` → HttpOnly session → `account.html` → `/api/auth/me` → profile/wallet/recharges。代码路径和生产页面结构均可定位。

### 当前卡点

1. 手机短信、Google、微信、QQ 只有 provider 声明，均为 `enabled=false`，不是可用注册通道。
2. 旧 Pages 入口已经 404；若用户从旧地址进入，认证不会再有第二入口，必须统一跳到 VPS 正式地址。
3. 当前工作区不能证明生产网关的 DNS、TLS 证书、Caddy 实际域名块和反代配置已与仓库约定一致。
4. 注册即自动登录，产品上没有独立“注册后验证邮箱/再登录”的流程；如果未来需要第三方 provider 或邮箱验证，需另拆认证任务。

## 首页“暂无数据/快照”原因

- `index.html` 初始 DOM 就写入“读取中/快照读取中”，避免空白；脚本失败或返回空结构时会保留这些状态。
- 市场温度、估值、跨境资金由首页脚本读取各自公开数据；宏观和活跃标的有外部实时组件与站内保存快照两个视图。
- TradingView/外部行情组件采用加载中→失败/重试状态，并保留最近一次保存结果；组件加载成功不等于所有证券报价都已返回。
- 带单员首页 `home-trader-data.js` 和 `trader/plaza.js` 主要读取已提交 JSON 快照；页面会显示快照文件更新时间、采集时间和陈旧/限制状态。
- Hyperliquid 的公开批次约 30 分钟；Binance、熬鹰、OKX、Bitget 的公开资料按采集任务生成快照；页面打开时的读取频率不等于源平台发布频率。
- 因此“显示保存的快照”是保留最后成功数据的设计，不表示当前来源已经实时恢复；问题在于各页面的状态层没有统一到 AlphaFox 那种清晰的来源/刷新/空态组件。

## 最严重的五个问题

| 严重度 | 问题 | 证据/影响 |
|---|---|---|
| P0 | GitHub→VPS 交付链没有独立证明 | 工作区无 `.git`、无 Actions→VPS 发布脚本；Caddy 示例仍为 `books.example.com` 占位；无法从仓库证明提交会到达 VPS |
| P0 | 来源时间与状态分散，快照容易被误读为实时 | 首页、广场、研究页各自维护加载/失败/陈旧文案，源时间、读取时间、发布时间和陈旧截止没有统一 contract |
| P1 | 带单员数据仍以提交快照为主 | Hyperliquid 约 30 分钟批次，Binance/OKX/Bitget 为静态采集结果；与“严格模仿 AlphaFox 的信号管理/实时体验”不匹配 |
| P1 | 外部注册方式未接通 | 手机短信、Google、微信、QQ 均禁用；当前只有邮箱/QQ 邮箱本地密码路径 |
| P1 | UI 壳和组件层分散，无法保持 AlphaFox 一致性 | 旧式文字侧栏、多个 CSS/JS 文件、多个加载态和 dialog 规则并存；缺少窄图标栏、顶栏 tabs、pill、统一空态和 motion token |

另有一项必须在部署任务开始前核查的安全风险：部署目录/备份中是否残留 SSH 私钥或其他凭证。若确认存在，优先从仓库和备份清除并轮换，不能把密钥内容写入本报告。

## 当前结论

本项目不是“没有功能”，而是“业务主链存在，但入口、来源新鲜度、交付证明和 UI 体系没有统一”。本轮不应直接重做 AlphaFox 外观；第一步应先建立单一生产链路和统一数据状态证据，再拆 UI 与 provider 任务。

## 账户链路专项体检（2026-11-18）

本次只检查注册、登录、登出、个人资料显示和修改昵称；没有修改业务 HTML、CSS、JavaScript、Node 服务、数据库、Actions 或 VPS 配置。四份根文档已先读取。本轮使用项目自带 Node 运行时重新执行认证测试，8 个测试全部通过。

### 当前流程与文件/接口/数据表

```text
auth.html
  └─ books-auth-config.js → https://45-77-39-98.sslip.io
  └─ books-auth.js
       ├─ POST /api/auth/register  ─┐
       ├─ POST /api/auth/login     ─┼→ books-vps-test/server.mjs
       └─ POST /api/auth/logout   ──┘       ├─ users
                                             ├─ sessions
                                             └─ wallet_accounts
                                               ↓ books_session（HttpOnly Cookie）
account.html
  └─ GET /api/auth/me → renderUser(me.user)
  └─ GET /api/wallet、GET /api/wallet/recharges
```

- 注册在 `work/site/auth.html:143-156` 组装邮箱、密码和可选 `displayName`，由 `work/site/books-auth.js:49` 调用 `/api/auth/register`。
- `work/books-vps-test/server.mjs:359-376` 校验密码、写入 `users`，创建钱包行和 `sessions` 行，并返回 `books_session` Cookie；密码由 `passwordHash()` 使用 `scrypt` 加盐保存，未保存明文。
- 登录在 `server.mjs:378-397` 从 `users` 查找并用 `verifyPassword()` 校验，再写入 `sessions` 和 Cookie。
- 登出在 `server.mjs:399-403` 按 Cookie 哈希删除 `sessions` 行并清除 Cookie。
- 账户页在 `work/site/account.html:57-61` 只调用 `/api/auth/me` 后渲染姓名、邮箱、三位账户号、权限、状态和注册时间；虽然服务端存在 `GET /api/account/profile`（`server.mjs:405-407`），当前账户页并不调用它。
- 当前数据库有 `users.display_name` 字段，但没有昵称修改表单、前端 API 方法或昵称更新路由。现有资料写入只发生在注册和头像相关路由。

### 注册后资料不显示：最可能的卡点

最可能不是“资料没有写入数据库”，而是会话或部署入口不一致：

1. `books-auth.js` 使用 `credentials: 'include'`，服务端 Cookie 在生产使用 `Secure; SameSite=Lax`。若页面来自旧 GitHub Pages、`127.0.0.1` 或其他域名，登录响应即使返回成功，后续跨站请求也可能不带 `books_session`，`/api/auth/me` 会返回未认证，账户页随后跳回登录页。
2. 账户页依赖 `/api/auth/me` 的 `{ authenticated, user }` 结构；它不会用 `/api/account/profile` 补救。若线上仍加载旧的 `account.html`、`books-auth.js` 或 `books-auth-config.js`，实际请求地址/响应契约不一致，资料就会空白或被重定向。
3. 因此验收必须在唯一正式入口 `https://45-77-39-98.sslip.io` 上同时记录 HTML 版本、`/api/auth/me` 状态、`Set-Cookie` 和下一次请求的 Cookie；不能只看注册按钮返回成功。

### 密码、会话、资料是否混在一起

逻辑上已有分层：密码处理是 `passwordHash/verifyPassword`，会话处理是 `currentUser/requireUser` 和 `sessions` 表，资料输出是 `userView` 与 `/api/account/profile`。但物理上都集中在一个 `server.mjs`，前端也由一个 `books-auth.js` API 客户端供 `auth.html` 和 `account.html` 共用；昵称更新目前完全缺失。这种“逻辑分开、文件共置”的状态可以先按小任务修复，不应借机重构成新框架。

### 本轮诊断结论

- 注册→自动登录→账户中心的邮箱密码主链已存在。
- 个人资料渲染的唯一实际门禁是 `/api/auth/me`，不是 `/api/account/profile`。
- 昵称修改没有现成链路，是明确的功能缺口。
- 任何代码修复都应先锁定正式域名和 Cookie/Origin 证据，再逐步做注册登录、资料显示、昵称保存；本轮不改代码。

## 小任务 1 验收记录（2026-11-18）

用户已批准先执行注册、登录、登出和会话状态任务。本次没有改业务文件，因为现有实现已经覆盖该任务，新增的是验证证据：

- 使用项目自带认证测试运行时执行 `work/books-vps-test/test/auth.test.mjs`：8 个测试全部通过，覆盖注册建会话、登录、重复注册、错误密码、登出后会话失效、Origin/CORS 和 Cookie 行为。
- 正式域名 `https://45-77-39-98.sslip.io/api/health` 返回 HTTP 200，`mode=production`，`liveTradingEnabled=false`。
- 正式域名 `/api/auth/me` 在无 Cookie 时返回 HTTP 200、`authenticated=false`；无 Cookie 登出返回 `loggedOut=true` 并清除 `books_session`。
- 正式域名对无效注册返回 `invalid_registration`，对不存在账户登录返回 `invalid_credentials`；这些检查没有写入生产账户。
- 带正式 Origin 的 `/api/auth/me` 返回 `access-control-allow-origin: https://45-77-39-98.sslip.io` 和 `access-control-allow-credentials: true`。
- 线上 `auth.html`、`books-auth-config.js`、`books-auth.js`、`account.html` 的 SHA-256 与当前工作区一致，证明这四个账户链路文件已发布到正式域名。

未执行“线上成功注册→登录→登出”的写入式演练，因为这会在正式数据库创建永久测试账户；本地同一服务的完整成功路径已通过 8/8。若要补做线上写入演练，需要先指定可清理的测试账户策略。

## 小任务 2 验收记录（2026-11-18）

用户已批准执行个人资料显示任务。本次没有改业务文件，因为正式账户页的资料渲染链已经正常，修改会增加无必要风险。

- 在 Chrome 的正式登录会话中打开 `https://45-77-39-98.sslip.io/account.html`，页面实际显示昵称 `Sking`、邮箱 `3413142786@qq.com`、账户号 `002`、权限“用户”、状态“正常”和注册时间 `2026/11/17 23:51:06`。
- 页面顶部同时显示已登录用户和“退出登录”，说明 `/api/auth/me` 成功通过会话门禁后才进入 `renderUser(me.user)`。
- 未登录的独立浏览器会话仍显示登录入口和占位状态，符合未认证重定向/门禁逻辑；不能把未登录空态误判为资料读取失败。
- 正式线上 `account.html` 与当前工作区 SHA-256 一致：`0e41e2ca0a24f1e999734e14fa4ef103bc755aa762b8f402df0de4dc73496629`。
- 本地渲染契约仍明确为 `GET /api/auth/me` → `renderUser(me.user)`，字段覆盖 `displayName/email/accountNo/role/status/createdAt`。

结论：个人资料显示任务已通过正式网站验收，无需代码修复。后续若用户看到空白，应优先检查是否使用了未登录会话、旧域名或旧缓存，而不是继续修改资料字段。

## 项目体检与个人资料页计划（2026-11-18）

本轮只做体检、证据整理和计划建档，没有修改业务代码。

### 1. 技术栈、页面和数据来源

- 技术栈：静态 HTML/CSS/原生 JavaScript；Node 24 ESM；内置 `node:sqlite`；Caddy 反代；systemd 常驻；GitHub Actions 负责采集、快照和校验。
- 页面：公开行情/研究、带单员/策略、账户三组，共 22 个主要 HTML 页面，完整清单已写入 `PROJECT_CONTEXT.md`。
- 数据：A 股公开/日终和 TradingView；美股 TradingView/延迟公开行情；Bitget/TradingView 加密行情；Hyperliquid、Binance、OKX、Bitget 公开快照和详情只读接口；宏观/研究 JSON 快照；账户 SQLite 的 `users`、`sessions`、`wallet_accounts`。

### 2. 账户流程与卡点

```text
注册/登录表单 → books-auth.js → /api/auth/register 或 /api/auth/login
→ books_session HttpOnly Cookie → account.html
→ /api/auth/me → renderUser(me.user) → 昵称/邮箱/账户号等
```

当前正式登录会话已显示当前用户昵称和邮箱；独立未登录会话显示登录入口和占位符，这是门禁结果，不是他人资料。当前没有发现资料显示卡点。潜在风险是旧 Pages/本地入口、跨域 Cookie 或线上静态文件版本不一致。

### 3. 首页显示“暂未取得数据/快照”的原因

首页各模块独立请求外部数据或读取最近成功快照；初始 DOM 先显示加载/快照状态，失败时保留最近成功数据，并将源时间、采集时间、读取时间和陈旧状态分开。外部组件可能延迟、拒绝或只返回部分数据，所以“暂无数据”表示当前模块没有可验证的最新结果，不代表数据库为空；目前缺少全站统一的状态组件和来源契约。

### 4. 最需要修的五个问题

| 严重度 | 问题 | 影响 |
|---|---|---|
| P0 | 部署目录存在明文 SSH 私钥风险 | 可能导致 VPS/GitHub 凭证泄漏，必须先轮换并移出工作区 |
| P0 | GitHub→VPS 发布链和 Caddy 正式域名缺少现场证明 | 代码改动可能没有到达用户看到的唯一正式站 |
| P0 | 数据来源、刷新和陈旧状态分散 | 快照、失败、未知和实时行情容易被混为一谈 |
| P1 | 认证入口/资料接口存在旧实现与当前实现并存 | 旧 `public/auth.html`、当前 `auth.html` 和 `/api/account/profile` 可能造成入口或契约误判；第三方 provider 仍未配置 |
| P1 | Books 与 AlphaFox 的策略/信号信息架构仍不一致 | 缺少“交易所凭证/我的信号”结构、统一空态和一致交互 |

### 5. 修复顺序、完成标准和范围

1. **凭证与唯一发布链**：完成标准是移除并轮换明文密钥、确认 DNS/TLS/Caddy/Node `/api/health`、证明正式站版本来源；预计改动 2–4 个部署/文档文件及 VPS 配置。
2. **统一数据状态契约**：完成标准是所有模块显示来源、源时间、采集时间、读取时间、陈旧截止和失败原因；预计改动 2–5 个共享状态/显示文件。
3. **认证与个人资料显示验收**：完成标准是正式登录用户看到自己的昵称/邮箱，刷新保持，退出后不可见，跨用户隔离；当前代码和正式站已通过验证，后续只需补自动化回归，预计 1–3 个测试/资料显示文件，不改注册登录逻辑。
4. **第三方 provider 边界**：完成标准是手机、Google、微信、QQ 要么真实接通，要么明确未配置；预计每个 provider 2–5 个文件，分开实施。
5. **AlphaFox 策略信号 UI**：完成标准是策略 tabs、凭证/我的信号、来源筛选、按钮化操作、统一空态和动效；首个任务控制在 5 个 UI 文件内。

### 6. 第一个最小任务建议

先做“凭证清理 + GitHub/VPS 唯一发布链健康证明”。它不改业务页面，不会影响当前已经正常的个人资料显示，却能先解决最高风险的私钥和版本漂移问题；否则任何后续 UI 或账户修复都可能改到非正式版本。

## 第一个最小任务执行记录：凭证、发布链与健康（2026-11-18）

本轮只处理部署安全和发布证据，没有修改业务 HTML、CSS、JavaScript、Node 服务、数据库、GitHub Actions 或 VPS 配置。

### 凭证风险处理

- 工作区原路径 `work/books-vps-test/.deploy/books_vps_ed25519` 与 `.pub` 已移出项目目录，放入受限回滚隔离目录 `/private/tmp/books-vps-key-quarantine-20261118/`。
- 隔离目录权限为 `0700`；私钥为 `0600`，公钥为 `0644`。私钥内容没有输出、没有写入文档或 GitHub。
- 公钥指纹用于轮换核对：`SHA256:xz86xBYIluRJwXmFvq0w0DivTxW0ztP4moaS8wxDc9Y`（ED25519，注释 `books-vps-2026-11-17`）。工作区同类私钥文件扫描结果为 0。
- 这是可回滚隔离，不等于已经完成 VPS/GitHub 侧密钥轮换；下一步应在 VPS 与 GitHub 侧撤销该指纹，再生成短期、最小权限的新凭证。

### GitHub→VPS 发布链核验

- 远程仓库 `sking-3/xuanliu-site` 可读，`main` 最新提交为 `5cc833008fa674d384c7964579b2dcc0f0487883`（2026-11-17 17:08:10Z）。
- 远程 `.github/workflows/` 仍有 17 个工作流；其中 `deploy-static-pages.yml` 仍调用 `actions/deploy-pages@v4`，并以 `https://sking-3.github.io/xuanliu-site/` 做发布后校验。
- `refresh-aoying.yml`、`refresh-traders.yml`、`quant-research.yml` 会提交或触发后续发布，但没有 SSH、rsync、VPS webhook、VPS API 或 `45-77-39-98.sslip.io` 发布步骤。仓库因此不能证明 GitHub→VPS 自动同步。
- 结论：当前唯一公网站点约定是 `https://45-77-39-98.sslip.io`，但“GitHub→VPS 唯一发布链”**未建立/未证明**；旧 Pages workflow 是必须另拆清理任务的残留第二路径。本轮没有远程删除或修改工作流，避免超出授权范围。

### 生产健康证据

- `https://45-77-39-98.sslip.io/index.html` 返回 HTTP 200，响应头包含 `server: Caddy`；现场内容 SHA-256 为 `ab80b0e18d3a11fc972fb9afffc37de2f84fbcc3adf2839e8e0c3a2a53615934`，只作为本次读取证据，不把它当作 GitHub 提交证明。
- `https://45-77-39-98.sslip.io/api/health` 返回 HTTP 200，正文为 `ok=true`、`mode=production`、`settlementMode=production`、`paymentConfigured=false`、`liveTradingEnabled=false`；说明正式域名到 Books Node 健康接口可达，Books 服务交易路由关闭，其他独立进程仍需另行核验。
- TLS 证书主题/SAN 为 `45-77-39-98.sslip.io`，签发者为 Let's Encrypt YE2，有效期 `2026-11-17 12:16:53 GMT` 至 `2027-02-15 12:16:52 GMT`；证书链验证通过。
- 当前网络中的 `dig +short 45-77-39-98.sslip.io A` 返回 `198.18.0.181`，不是 `45.77.39.98`。这可能来自代理/合成 DNS，但不足以证明域名实际指向 Vultr VPS；必须由 VPS/权威 DNS 侧补确认。

### 当前状态与回滚

- 已完成：工作区私钥隔离；公网正式域名健康接口、Caddy 响应和 TLS 证书检查。
- 未完成：VPS/GitHub 侧密钥撤销与轮换；唯一 GitHub→VPS 发布链；旧 Pages workflow 清理；权威 DNS→Vultr IP 现场确认。
- 回滚：如需读取隔离副本，先在 VPS/GitHub 侧完成轮换审批，再从临时目录 `/private/tmp/books-vps-key-quarantine-20261118/` 按原权限恢复到受控密钥存储。该目录不是持久备份，系统清理或重启后可能消失。不要恢复到项目目录或提交到 GitHub。文档修改可直接回退本节，不涉及业务数据。

## 账户体检与手动验收清单复核（2026-11-18）

- 已重新读取根目录四份项目文档和认证相关页面、服务端路由、认证测试文件。
- 已新增 `ACCEPTANCE.md`，内容覆盖正常账户流程和五个异常场景。清单使用页面上的中文按钮和可观察结果，不要求验收人员理解接口或数据库。
- 注册、登录、资料显示、刷新、退出和重登已有实现路径。修改昵称仍没有页面、前端调用或服务端保存接口，记录为待实现。
- 这次没有修改业务代码。四份建档文档和验收清单属于文档变更。
- 使用项目自带 Node 运行时执行 `work/books-vps-test/test/auth.test.mjs`，8 个测试全部通过，覆盖注册建会话、登录、重复邮箱、错误密码、登出、provider 状态、头像和充值安全边界。
- DNS 返回 `198.18.0.181` 的记录属于此前审计采样，可能受代理或合成 DNS 影响，不能作为本次实时权威 DNS 结论。正式站健康接口、Caddy 响应和 TLS 证书证据仍需与采样时间一起理解。
- 本地 Pages 工作流核对结果已补入项目上下文。它们说明仓库仍有旧发布配置，不说明这些工作流当前一定在运行。

## 首页“暂未取得数据”专项体检（2026-11-18）

本次只读检查了 `work/site/index.html` 及其直接加载脚本和数据文件，没有修改业务代码。

### 模块与来源

1. 顶部指数条由 `market-strip.html` 和 `market-strip.js` 提供。来源是腾讯行情两个公开接口，浏览器还会读取 `books.indexTape.v1`。HTML 自带最近收盘种子值，所以接口失败时仍可能看到旧价格。
2. 市场温度、核心估值、跨境资金、活跃标的和宏观官方发布由 `market-overview.json`、`macro-cn.json` 和 `market-overview.js` 提供。卡片自身带 `ready`、`stale`、`unavailable`、来源时间、采集时间、读取尝试时间和错误码。
3. 宏观外部快讯和跨市场观察报价由 TradingView timeline、mini symbol overview 和 market overview iframe 提供。`market-live.js` 在 iframe 或脚本超时后切换到保存视图，并显示“动态来源未加载，显示保存的快照”。
4. A 股和美股行情卡由 TradingView 外部组件提供。`market-feed-status.js` 只确认脚本、iframe 和加载事件，不能证明每个报价已经渲染。
5. 加密行情卡和市场异动由 `crypto-market.js` 读取 Bitget REST 和 WebSocket。15 秒尝试刷新，90 秒没有新交易所时间戳就标记过期。没有旧报价且请求失败时才显示“交易所行情暂未连接”。
6. A 股收盘涨跌榜先读上游 GitHub 的大盘快照，再读 `research-data/a-daily-movers.json`，同时使用 `books-home-daily-ranks-v1` 浏览器缓存。上游失败时仍可展示本地快照。
7. 美股涨跌榜和沪深观察依赖 TradingView screener 与 ticker tag。沪深简表要求 8 个标的完整返回，未完成时会切换到完整报价视图。
8. 股票分钟异动读取 `research-data/snapshot.json`。当前文件 `publishedAt=2026-11-12`，`observations=0`，`alerts=0`，属于成功读取但没有有效分钟行。
9. 带单员收益榜由 Hyperliquid、Binance、OKX、Bitget 和熬鹰历史多个 JSON 文件合并。各文件独立校验和读取，任何来源失败都可能造成部分榜单或某个周期不可比较。

### 四种状态的区分

| 状态 | 识别方式 | 首页表现 |
|---|---|---|
| 真没数据 | 文件读取成功，数据结构有效，但有效行数为零或当前周期没有符合条件的记录 | “暂无公开分钟样本”或“该周期缺少可核验收益率” |
| 接口失败 | 请求超时、HTTP 403、网络错误、来源拒绝或校验失败 | “暂未取得数据”“来源访问已停止”“本次刷新失败” |
| 前端没渲染 | 外部脚本或 iframe 建立，但没有完成内容或逐项价格确认 | “组件已建立仍在等待来源”或空白组件后显示重试 |
| 缓存快照 | 当前请求失败，但 HTML 种子、localStorage 或最近一次成功 JSON 仍可用 | “历史快照”“最近一次快照已过期”“动态来源未加载，显示保存的快照” |

### 当前证据与优先级

- `market-overview.json` 生成于 2026-11-13。核心估值卡为 `stale` 且错误码是 `network_error`，宏观旧聚合卡曾出现 BLS `http_403`。这会让多个顶部研究卡看起来像“没数据”，实际是旧值保留和来源失败混在一起。
- `macro-cn.json` 在 2026-11-16 生成，国家统计局卡片为 `ready`。官方宏观快照本身有数据，动态 TradingView 快讯失败时才会出现保存快照提示。
- `research-data/snapshot.json` 当前有效观察和异动数组均为零。股票分钟异动应优先判断为有效数据为空，不能先归因网络失败。
- `trader/feed.json` 最近读取时间为 2026-11-16，带单员榜单还要合并多个不同时间的 Binance、OKX、Bitget 和 Hyperliquid 文件。榜单陈旧或部分为空，优先检查来源合并状态，不要把某一张空卡片当成全站没有带单员数据。

### 建议修复顺序与验收范围

1. **市场研究卡和统一快照状态**。完成标准是五张卡分别显示来源、来源统计时间、本站采集时间、最后尝试时间、陈旧截止和失败原因，聚合文件读取失败时不把所有卡片都显示成同一种“暂无数据”。预计改动 `market-overview.js`、快照采集脚本和对应审计测试，控制在 2–5 个文件。
2. **股票分钟异动采集链**。完成标准是 `research-data/snapshot.json` 至少包含通过校验的观察行或明确标注“本批有效行数为零”，并显示发布和读取时间。预计改动分钟数据采集脚本、快照文件格式和 1–2 个审计测试，控制在 2–5 个文件。
3. **TradingView 组件渲染确认**。完成标准是 A 股、美股、宏观快讯和沪深观察分别报告脚本加载、iframe 建立、内容完成和超时状态，不能只用 iframe `load` 作为报价已渲染证明。预计改动 `market-feed-status.js`、`market-live.js`、`home-watch-quotes.js` 和测试，控制在 2–5 个文件。
4. **Bitget 现货行情断线与过期状态**。完成标准是 REST、WebSocket、最后交易所时间、90 秒陈旧状态和重试结果在卡片内一致显示。预计改动 `crypto-market.js`、`home-market-radar.js` 和相关单元测试，控制在 2–4 个文件。
5. **带单员榜单多来源合并**。完成标准是每个平台和周期独立显示读取时间、来源状态和可比较账户数，单个平台失败不会让其他平台被误标为空。预计改动 `home-ranking.js`、`home-trader-data.js` 和对应数据状态测试，控制在 2–5 个文件。

第一个最小任务建议先处理市场研究卡的统一状态，因为它同时覆盖首页顶部最多的“暂未取得数据”和“快照”文案，并能先区分真实空数据、采集失败、前端渲染和旧快照四种原因。

## 账户头像界面批次（2026-11-18）

- 账户头像弹窗已改为单一的本地图片流程。界面居中显示当前头像、图片选择区和本地预览。
- 已移除 HTTPS 图片地址入口、预设头像选择卡和对应前端分支。选择图片后必须先预览，点击保存才调用现有头像上传接口。
- 本地 `account.html`、`account.css` 语法检查通过，认证测试 8/8 通过，账户实时状态测试 26 项通过。
- 已写入 GitHub `sking-3/xuanliu-site` 的 `main`。相关提交为 `f355a767b40cfa4c529ead465c99cdc8bb49d1ff`、`200d5cbc26e0130d582df2044659699f375f0dce` 和缓存版本提交 `b52b86645017f0ec353944b4975266bd3fb93e7b`。
- 本次验证时正式域名 DNS 无法解析，尚未完成正式页面刷新后的浏览器验收。GitHub 提交存在不等于 VPS 页面已更新，需等唯一 VPS 发布链恢复后再验收。

## 首页状态批次（2026-11-18）

- `work/site/market-overview.js` 已增加统一状态标签。来源有旧数据但本次读取失败时显示“读取失败 · 保留旧值”，来源已过期时显示“历史快照 · 待更新”，来源成功但没有数据时显示“暂无可核验数据”，完全没有可用快照且请求失败时显示“来源读取失败”。
- 新增 `work/site/audit/market-overview-state-unit.cjs`，覆盖 ready、stale、unavailable 和读取失败标签。
- 本地 `market-overview.js` 语法检查、首页状态单元测试和认证测试 8/8 通过。
- 已写入 GitHub `main`。相关提交为 `fff32e2a8ec1597ef7e5dea6c013e36b0d1417c5` 和 `32fc7e0a7c191ce374acd2c26b2e5dba98b4de4d`。
- 正式域名当前仍无法解析，因此尚未完成 VPS 页面上的浏览器验收。


## 2026-11-18 收尾体检结果

### 本次实际完成

- 重新核对根目录四份项目文档、账户页面、认证脚本、Node 服务和首页直接加载脚本。
- 补充了技术栈、页面清单、账户流程、首页数据来源、四种数据状态、五项优先问题和修复顺序。
- 没有修改业务代码、快照、Actions、数据库或 VPS 配置。

### 账户流程结论

- 注册写入 `users`、`wallet_accounts` 和 `sessions`，返回 `books_session`，然后进入账户页。
- 登录通过 `/api/auth/login` 建立 HttpOnly 会话，账户页先请求 `/api/auth/me`，再显示当前用户资料。
- 退出调用 `/api/auth/logout` 删除会话并清除 Cookie。
- 当前没有证据显示主链卡在资料接口。昵称修改仍未实现，第三方 provider 未配置。

### 首页专项结论

- 当前用户没有指定具体模块，目标字段仍是占位符，所以没有执行“只修一个模块”的代码任务。
- 优先候选仍为 `market-overview` 状态契约，其次是分钟异动、TradingView 渲染确认、Bitget 过期状态和带单员多来源合并。
- 任何下一次代码修复都必须先把实际模块名、现状文案和数据来源写入任务单，再进行单模块变更。

### 收尾证据边界

- 本地代码和测试结果不能证明正式 VPS 已加载最新版本。
- 正式域名本轮无法稳定解析，线上浏览器验收保持未完成状态。


## 账户回归收尾（2026-11-18）

### ACCEPTANCE.md 回归结果

- 注册、登录、资料显示、刷新、退出和重登的本地服务测试均通过，完整 `test/*.test.mjs` 为 9/9。
- 重复邮箱、错误密码、登出后会话失效、provider 状态和交易路由关闭均有自动化覆盖。
- 正式域名回归在第 1 步被阻断。`GET /auth.html` 出现 `curl: (6) Could not resolve host: 45-77-39-98.sslip.io`，所以线上注册、登录、资料显示、刷新、退出和异常场景均标记为未验证。
- `/api/health` 和无 Cookie `/api/auth/me` 曾返回 200，但不能替代页面 GET、Cookie、CORS 和完整账户流程验收。
- 昵称修改没有入口或接口，保持待实现。

### 影响排序

1. P0。正式域名解析和唯一发布链不稳定，阻断登录与全站线上验收。
2. P1。无法证明线上前端、API、Cookie 和 CORS 属于同一版本，影响账户安全判断。
3. P1。生产资料页未完成线上刷新、退出和跨用户隔离回归。
4. P2。首页外部组件和快照状态仍需分模块验收。
5. P2。带单员榜由多时间快照合并，不能直接代表一次实时查询。

### 唯一最小修复计划

只修正式发布链路，不改业务代码。现场核验 DNS → TLS → Caddy → Node → `/api/health`，再用版本标识绑定 VPS 页面与指定 GitHub 提交，并确认旧 Pages 不作为入口。预计涉及 2–4 个部署或文档文件及 VPS 现场配置。

可能影响正式站访问、登录入口、账户资料页、首页静态资源和 API 反代。数据库、认证逻辑、交易接口和公开数据文件不在本计划内。


## 发布链路核验与修复（2026-11-18）

### 已完成

- SSH 连接到 VPS `aoying-hl-observer`，`books-vps` active，Node 监听 `127.0.0.1:8930`。
- `/etc/caddy/Caddyfile` 已备份并更新为正式域名反代配置，`caddy validate` 通过，reload 后 Caddy active。
- 从 GitHub `main` 提取并发布同哈希文件：
  - `index.html` `ab80b0e18d3a11fc972fb9afffc37de2f84fbcc3adf2839e8e0c3a2a53615934`
  - `auth.html` `22437e37428b86b6988c279805d3cfae24f1ea7046b0e0b1a0ab2f89c43a64ed`
  - `account.html` `e6b7fc04438f27a38bc6b55f18e45c1d880938b60e0d7a69533681904dde053b`
  - `account.css` `0d80437bd83a52241a159bba3e016432c1ef9682758e7f2e1516d2fdac02db24`
  - `market-overview.js` `ccfc9b25789b0d72650db044abc8c0be732de0babb228c989e6e1e74411afe34`
- Caddy 响应头返回 `X-Books-Release: fb030fc914dfc9f1360095b946a3b70ea2d3f845`。
- 正式 GET 首页、认证页、账户页返回 200。`/api/health` 返回生产模式且 `liveTradingEnabled=false`。正式 Origin 的 `/api/auth/me` 返回 200、`authenticated=false` 并带凭据 CORS。旧 GitHub Pages 返回 404。

### 残留证据

- DNS 查询返回 `198.18.0.71`，无法仅凭当前解析结果证明它就是 `45.77.39.98` 的公网 VPS 地址。直接 SSH 和带 `--resolve` 的 HTTPS 已验证目标 VPS 可达。
- 自动 GitHub→VPS workflow 仍未建立，本次发布采用受控手工同步。

### 回滚点

- 站点备份：`/opt/books/site.prev.20261118-release-chain`。
- Caddy 备份：`/etc/caddy/Caddyfile.prev.20261118-release-chain`。
- 回滚后执行 `caddy validate`、`systemctl reload caddy`、`systemctl is-active books-vps` 和 `/api/health`。


## 账户与金融安全基线审计（2026-11-18）

### 检查结果

| 检查项 | 当前证据 | 判断 | 最小修复与验收现象 | 预计范围 |
|---|---|---|---|---|
| 密码存储 | `server.mjs:116-126` 使用 `scrypt`，16 字节盐、64 字节派生值、`N=16384,r=8,p=1`，`timingSafeEqual` | 当前未见明文密码 | 增加算法/参数版本字段，旧 hash 可迁移；验收数据库只存派生值且登录兼容 | 2–4 个服务端/测试文件 |
| 登录/注册/重置限流 | 登录按单进程、单邮箱，5 次失败锁 60 秒；注册和重置没有限流，重置路由不存在 | P1。重启、多实例和注册滥用可绕过 | 共享账号/IP/设备维度限流，注册和重置都覆盖；验收五次失败锁定且跨实例生效 | 2–5 个服务端、配置和测试文件 |
| 邮箱存在性泄露 | 重复注册返回 `email_already_registered`，前端显示“该邮箱已经注册”；登录错误统一 `invalid_credentials` | P1。重复注册可枚举邮箱 | 统一注册外观响应，服务端继续拒绝重复；验收新邮箱和已注册邮箱外观一致 | 2–3 个服务端/前端/测试文件 |
| 日志与错误 | 未发现密码、Cookie、token 或 webhook secret 输出，异常返回通用 `request_failed`；没有关键动作审计事件 | P1。缺少追责和安全事件调查能力 | 增加脱敏结构化审计事件，包含时间、动作、结果、request id，不含敏感值 | 2–5 个服务端、数据库和日志文件 |
| HTTPS/TLS | HTTP→HTTPS 308，TLS SAN 为正式域名，Caddy active；响应未见 HSTS | P2。浏览器缺少强制 HTTPS 缓存策略 | 增加 HSTS 并验证响应头；验收 HTTP 跳转、TLS 有效、HSTS 存在 | 1 个 Caddy 配置文件 |
| 密钥与配置 | provider/webhook secret 只从环境变量读取；`/etc/books/books.env` 当前不存在；工作区未发现 Books 生产密钥 | P0/P1。旧 SSH key 仍在授权列表，数据库文件权限过宽 | 撤销旧指纹、生成最小权限新 key；将数据库文件收紧为 600/640；验收旧 key 失败、新 key 可用、非 books 用户不可读 | 2–4 个部署/凭证/权限文件及 VPS 现场操作 |
| 关键操作审计 | SQLite 表为 `users/sessions/wallet_accounts/recharge_orders`，没有 `audit_events`；systemd 只记录启动/错误 | P1。注册、登录、充值、webhook 和管理员操作不可追溯 | 增加 append-only 审计表或受控日志接收；验收可按用户和时间查询，敏感字段为空 | 2–5 个服务端、数据库和测试文件 |

### 当前通过项

- 生产 Cookie 已使用 HttpOnly、Secure、SameSite=Lax。
- 真实支付未配置，`paymentConfigured=false`，充值不会生成假地址或增加余额。
- 交易路由保持 403，`liveTradingEnabled=false`。
- 前端没有密码回显逻辑，错误提示没有输出密码或会话 token。

### 必须优先处理

1. P0/P1。撤销并轮换仍在 `/root/.ssh/authorized_keys` 的旧 SSH key。隔离副本位于临时目录，隔离不等于撤销。
2. P1。收紧 `/var/lib/books/books.sqlite*` 当前 644 权限。
3. P1。补充共享登录/注册限流和邮箱抗枚举策略。
4. P1。建立注册、登录、登出、充值、webhook、管理员禁用的脱敏审计记录。
5. P2。增加 HSTS，并为 scrypt hash 增加算法和参数版本。

本次只做安全基线诊断和建档，没有修改代码、数据库、权限或密钥。


## SSH 密钥轮换完成（2026-11-18）

### 变更

- 旧 SSH 指纹：`SHA256:xz86xBYIluRJwXmFvq0w0DivTxW0ztP4moaS8wxDc9Y`。
- 新 SSH 指纹：`SHA256:mAhNEtPnJlfh1BlFfbMxq9jJMGFj6HcxDl6LWOqlcmo`。
- VPS `/root/.ssh/authorized_keys` 当前只保留新指纹。
- 旧私钥和旧公钥的临时隔离副本已删除。
- 新私钥保存在用户 SSH 目录，权限 0600。

### 验证

- 使用新钥连接 `aoying-hl-observer` 成功。
- `books-vps` 为 active。
- Caddy 为 active。
- 回环 `/api/health` 返回 `ok=true`、`mode=production`、`liveTradingEnabled=false`。
- 使用旧钥连接返回 `Permission denied (publickey,password)`。

### 剩余安全项

数据库 SQLite、WAL、SHM 文件仍需收紧权限；注册和登录限流、邮箱抗枚举、关键操作审计、HSTS 和密码格式版本化仍未实施。
