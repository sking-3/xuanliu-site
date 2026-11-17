# Books 项目上下文

## 产品与入口

Books 是公开研究与行情站，包含市场总览、A 股/美股/加密行情、公司研究、带单员公开资料、策略研究和账户中心。正式入口为：

- `https://45-77-39-98.sslip.io`
- 旧 `https://sking-3.github.io/xuanliu-site/` 已取消发布，不应再作为链接、校验地址或登录入口。

用户指定的 AlphaFox 参考页：

- [广场](https://www.alphafox.app/zh/dashboard/square)
- [跟单信号管理](https://www.alphafox.app/zh/dashboard/strategy/signals)
- [我的信号](https://www.alphafox.app/zh/dashboard/strategy/signals/my-signals)

## 技术栈

- 前端：静态 HTML、CSS、原生 JavaScript；没有 React/Vue/Next 构建层，没有根目录 `package.json`。
- 页面运行时：多个 IIFE/全局脚本、原生 `<dialog>`、`fetch`、浏览器 IndexedDB/localStorage、TradingView 官方嵌入组件、Bitget 公开行情组件。
- 图表：`work/site/vendor/lightweight-charts-5.3.0/`。
- 服务端：Node 24 ESM `work/books-vps-test/server.mjs`，Node 内置 `node:sqlite`，HTTP 服务绑定 `127.0.0.1:8930`。
- 反代/进程：Caddy 反代模板 + systemd `books-vps.service`。
- GitHub Actions：采集、快照、校验和历史工作流；产品约定把 GitHub Pages 作为旧入口退役，但远程仓库 `sking-3/xuanliu-site` 的 `main` 仍保留 `deploy-static-pages.yml`，并调用 `actions/deploy-pages@v4` 与旧 `sking-3.github.io/xuanliu-site/` 校验地址，不能把 Pages 残留写成已清理。

## 页面清单

### 公开研究与行情

`index.html` 市场总览；`a-shares.html` A 股行情；`screening/index.html`、`screening/history.html` A 股研究/历史；`us.html` 美股选股；`us-live.html` 美股盘中监控；`crypto.html` 加密行情；`chart.html` K 线；`market-strip.html` 指数条；`a-market-widget.html` 中国股票嵌入行情；`research.html` 公司研究；`company-dossier.html` 个股研究；`tools.html` 研究工具；`agent-studio.html` 五代理研究决策台。

### 带单员与策略

`trader/index.html` 带单员广场；`trader/binance/index.html` 币安入口；`trader/exchange.html` 公开成交证据；`trader/bitget-book-demo.html` Bitget 盘口核验；`quant-research/index.html` 策略研究。当前没有与 AlphaFox `/strategy/signals` 一一对应的“跟单信号管理/我的信号”页面。

### 账户

`auth.html` 账户登录/注册；`account.html` 个人资料、头像、钱包和充值记录。

## 数据来源与真实性边界

| 模块 | 当前来源 | 当前状态/限制 |
|---|---|---|
| A 股 | 官方/公开日终数据与 TradingView 中国市场组件 | 日终或组件来源，不等于全市场实时覆盖 |
| 美股 | TradingView 官方组件、延迟/公开数据 | 可能延迟；个人授权数据不进入公开 JSON |
| 加密行情 | Bitget 公开行情；部分 TradingView 组件 | 以组件状态为准，需展示源时间与读取时间 |
| Hyperliquid 带单员 | `trader/feed.json` 等公开快照；页面可对单个账户接官方 REST/WebSocket | 快照批次约 30 分钟；页面打开时的实时观察不等于后台常驻 |
| Binance/熬鹰 | `trader/binance/`、公开归档和后台检查点 | 公开仓位/操作受权限限制；已有快照日期不代表当前实时状态 |
| OKX/Bitget | `okx`、`bitget` 公开期间收益/成交资料 | 采集结果是提交后的 JSON 快照，更新时间独立于源平台发布时刻 |
| 宏观/研究 | `macro-cn.json`、`research-data/*.json`、研究脚本 | 失败或过期时保留最近一次成功结果，不补造新数据 |

项目已采用“失败/过期不清除最后成功快照”的保守策略。文案必须同时说明数据来源、采集时间、网页读取时间、陈旧截止和失败原因。

## 认证与账户流程

1. `auth.html` 读取 `books-auth-config.js`，当前 API 基址为 `https://45-77-39-98.sslip.io`，再加载 `books-auth.js`。
2. 邮箱密码注册：`POST /api/auth/register`，密码至少 10 位；注册成功即创建 30 天 HttpOnly session，并跳转 `account.html`。
3. 登录：`POST /api/auth/login`；会话通过 `books_session` Cookie 保存。
4. `account.html` 首先请求 `GET /api/auth/me`；未认证跳回 `auth.html?next=account.html`。
5. 已认证后由 `GET /api/auth/me` 返回的 `user` 对象直接显示昵称、邮箱、头像、三位账户号、权限和状态；随后读取 `/api/wallet`、`/api/wallet/recharges` 显示资金卡。`GET /api/account/profile` 当前由服务端提供，但不是 `account.html` 的主渲染请求。
6. 头像支持本地 PNG/JPEG/WebP 上传，账户页的头像弹窗只展示当前头像、本地选择、居中预览和保存上传。HTTPS 图片地址入口已从界面移除；服务端旧兼容接口仍未删除。充值在支付服务未配置时安全返回，不生成假地址、不增加余额。
7. 手机短信、Google、微信、QQ provider 当前 `enabled=false`，返回未配置；它们不是已完成的注册通道。
8. `/api/orders`、`/api/trades`、`/api/copy` 永久 403，`liveTrading=false`。

因此主链“邮箱注册→自动登录→账户中心”已有实现；认证并没有卡在数据库，而是卡在外部 provider 未配置、旧入口已退役后的统一入口约束，以及生产链路缺少独立健康证明。

## AlphaFox 参考交互（只作为目标，不代表已实现）

AlphaFox 信号页的可观察结构是：约 80px 图标栏；顶栏策略 tabs（我的策略、创建策略、策略回测、跟单信号管理）；右上帮助、反馈、主题、语言、资产、会员和头像菜单；信号管理内部再分“交易所凭证/我的信号”。“我的信号”使用概览数字、搜索、刷新、来源筛选、表格列和居中空态弹窗；添加信号用四个大按钮选择跟单连接版、交易账户 API、Hyperliquid 钱包、TradingView。

视觉基线是浅灰背景、白色圆角卡片、细边框、橙色主按钮、灰色选中 pill、窄侧栏、明显留白、Inter/system 字体和居中高斯模糊弹窗。Books 当前仍是旧式文字侧栏、复杂卡片和多个独立 CSS/JS 层，不能声称已严格模仿。

## 部署链路现状

设计目标是：浏览器 → `45-77-39-98.sslip.io` → Caddy → `127.0.0.1:8930` → Node 服务 → `/opt/books/site` 与 `/var/lib/books`。`BOOKS_ALLOWED_ORIGINS` 已写入 systemd 服务，`books-auth-config.js` 也指向正式地址。

但仓库只证明了模板和约定：Caddy 示例仍使用占位域名 `books.example.com`；工作区没有 Git checkout 元数据，也没有 SSH/rsync/Actions→VPS 自动同步脚本。`work/site/.github/workflows` 本地目录仍有 14 个工作流，其中 `deploy-static-pages.yml`、`refresh-traders.yml`、`quant-research.yml` 和 `refresh-macro-cn.yml` 保留 Pages 发布或旧 Pages 校验路径。远程 GitHub 只能证明源码和 Actions 存在，不能证明提交会到达 VPS；当前同时存在旧 Pages workflow 与正式域名，唯一发布链尚未建立。`45-77-39-98.sslip.io` 的公网 `/api/health` 已现场返回生产状态、由 Caddy 提供响应，但此前采样的 DNS 查询返回 `198.18.0.181`，不是域名编码的 `45.77.39.98`，因此实际 VPS IP 和 DNS 指向仍需在 VPS/权威 DNS 侧确认。`sslip.io` 依赖当前公网 IP，VPS 换 IP 会导致地址失效。

## 2026-11-18 体检补充

### 页面与数据来源清单

当前 `work/site` 可见 HTML 页面分为四组：

- 公开行情与研究：`index.html`、`a-shares.html`、`screening/index.html`、`screening/history.html`、`us.html`、`us-live.html`、`crypto.html`、`chart.html`、`market-strip.html`、`a-market-widget.html`、`research.html`、`company-dossier.html`、`tools.html`、`agent-studio.html`、`home-watch-quotes.html`。
- 带单员与策略：`trader/index.html`、`trader/binance/index.html`、`trader/exchange.html`、`trader/bitget-book-demo.html`、`quant-research/index.html`。
- 账户：`auth.html`、`account.html`。

主要数据来源：A 股公开/日终行情和 TradingView；美股 TradingView 及可能延迟的公开行情；加密行情 Bitget 公开接口和 TradingView；Hyperliquid `trader/feed.json`、`analytics.json` 及详情页只读 REST/WebSocket；Binance 组合/历史快照；OKX、Bitget 公开期间资料；宏观和研究 JSON 快照。每类来源的源时间、本站采集时间、网页读取时间和陈旧截止必须分开。

### 账户资料现状

代码链为 `auth.html` → `books-auth.js` → `/api/auth/login` → `books_session` → `account.html` → `/api/auth/me` → `renderUser(me.user)`。正式登录会话已观察到当前用户昵称和邮箱，未登录会话显示登录入口和占位符；当前没有证据表明资料页会显示别人的资料。昵称修改、头像和第三方 provider 属于其他任务。

## 账户手动验收文档

根目录 `ACCEPTANCE.md` 提供非技术人员可执行的注册、登录、资料显示、刷新、退出、重登和异常场景清单。当前版本的昵称修改没有页面入口、前端调用或服务端保存接口，因此清单将该步骤标为待实现。验收结论必须以正式域名上的页面结果为准，不能把旧 Pages 或本地页面的结果算入正式验收。

## 首页数据模块体检（2026-11-18）

首页 `index.html` 不是单一数据源。它同时加载本地快照、浏览器缓存、TradingView 外部组件和 Bitget 公共行情。当前模块与状态如下。

| 首页模块 | 数据来源 | 当前证据 | 状态判断 |
|---|---|---|---|
| 顶部指数条 | `market-strip.html`、腾讯行情接口 `web.ifzq.gtimg.cn` 和 `proxy.finance.qq.com`，并使用 `books.indexTape.v1` 本地缓存 | HTML 内有最近收盘种子值，脚本按市场时段每 1–15 分钟尝试更新 | 缓存和收盘值可以正常展示；接口失败时会继续显示旧收盘，属于缓存快照，不是盘中实时行情 |
| 市场温度 | `market-overview.json` 的 Alternative.me 卡片 | 状态 `ready`，来源时间 2026-11-13 | 有数据但已超过当前日期，页面应显示日度来源时间和陈旧状态 |
| 核心估值 | `market-overview.json` 的中证指数卡片 | 状态 `stale`，`errorCode=network_error`，最后有效时间 2026-10-29 | 接口或采集失败后保留旧快照，不是真没数据 |
| 跨境资金 | `market-overview.json` 的美国财政部 TIC 卡片 | 状态 `ready`，统计期 2026-08-31 | 数据按月发布，本身不是盘中资金流；显示的是有效月度快照 |
| 活跃标的与成交额快照 | `market-overview.json` 的 Alternative.me 卡片，实时视图另由 TradingView 组件提供 | 快照状态 `ready`，时间为 2026-11-13；实时视图依赖外部 iframe | 保存视图有数据，实时视图可能因为外部组件未完成加载而切换回快照 |
| 宏观速递 | 官方视图读取 `macro-cn.json` 的国家统计局卡片，外部视图使用 TradingView timeline；旧聚合卡还记录过 BLS `http_403` | `macro-cn.json` 于 2026-11-16 生成，国家统计局卡片为 `ready`；TradingView 视图有独立超时 | 官方快照可用，动态快讯加载失败时显示“动态来源未加载，显示保存的快照” |
| A 股与美股行情卡 | TradingView `market-overview` 外部脚本和 iframe | `market-feed-status.js` 只验证脚本、iframe 和加载事件，不验证每个价格 | 组件建立但价格未渲染时属于前端渲染未证实，不能归类为真没数据 |
| 加密行情卡与市场异动 | Bitget REST `/api/v2/spot/market/tickers`、`wss://ws.bitget.com/v2/ws/public` | 15 秒刷新一次，90 秒无新报价会标记过期；失败且没有旧报价才显示未连接 | 有旧报价时是过期快照，首次请求失败时才是来源失败 |
| A 股收盘涨跌榜 | 上游 GitHub `wenyuanw/a-share-heatmap`，本地 `research-data/a-daily-movers.json` 和 `books-home-daily-ranks-v1` 缓存 | 本地快照 `asOf=2026-11-13`，有效报价 5579 条 | 上游失败时仍可显示本地快照，两个来源都不可用时才是真正不可用 |
| 美股涨跌榜与沪深观察 | TradingView screener、TradingView ticker tag，沪深简表使用 `home-watch-quotes.html` | 外部组件有加载超时和重试，沪深简表要求 8 个标的完整返回 | 组件空白或只返回部分标的是前端渲染不完整，不应写成“市场没有数据” |
| 股票分钟异动 | `research-data/snapshot.json` | `publishedAt=2026-11-12`，`observations=0`、`alerts=0` | 当前是成功读取但有效行数为零，属于真没可展示的分钟样本，不是接口失败 |
| 带单员收益榜 | `trader/feed.json`、Hyperliquid `portfolios.json`/`analytics.json`、Binance、OKX、Bitget 周期 JSON 和熬鹰历史文件 | 多个文件分别读取和校验。Hyperliquid feed 最近读取 2026-11-16，Binance 组合文件较旧，周期文件更新时间不一致 | 这是多快照合并，不是单次实时查询。任一文件失败会造成部分榜单、历史快照或不可比较周期 |
| 研究工作台入口 | 站内链接，没有动态数据请求 | 只负责导航到选股、公司研究和五方投研 | 不属于“暂未取得数据”模块 |

首页的四种状态含义也已固定。真没数据是文件或接口成功返回但没有可用行，例如分钟异动数组为零。接口失败是请求超时、HTTP 403、网络错误或来源拒绝。前端没渲染是 TradingView iframe 或自定义元素存在，却没有完成价格、新闻或 8 个观察标的的渲染确认。缓存快照是读取失败后继续显示 HTML 种子、localStorage 或最近一次成功 JSON。

影响优先级建议先处理 `market-overview.json` 的统一刷新和状态契约，因为它同时影响市场温度、估值、资金、活跃标的和宏观保存视图。第二步处理 `research-data/snapshot.json` 的空样本和采集链。第三步处理 TradingView 组件的“已建 iframe 但未证明内容”问题。第四步核验 Bitget REST/WebSocket 的过期和断线状态。第五步再处理多来源带单员收益榜的合并与陈旧显示。


## 2026-11-18 收尾体检补充

- 本次首页修复目标仍使用“【填模块名】”和“【填实际文字】”占位符，无法据此选定唯一模块，未执行模块修复。
- 只读核对确认技术栈为静态 HTML/CSS/原生 JavaScript、Node ESM、内置 `node:sqlite`。账户主链为 `auth.html` → `/api/auth/register` 或 `/api/auth/login` → `books_session` → `account.html` → `/api/auth/me` → `renderUser(me.user)`。
- 账户资料主链当前没有卡在 `/api/account/profile`。昵称修改没有页面入口、前端调用或服务端更新接口。手机、Google、微信、QQ provider 仍未配置。
- 首页“暂未取得数据”和“动态来源未加载，显示保存的快照”来自不同模块的来源失败、过期快照、成功空数据和外部组件未完成渲染，不能用一个统一原因解释。
- 本次只读收尾没有新增业务代码。正式域名的 DNS/线上发布链仍需现场证据，GitHub 分支状态不能替代 VPS 页面验收。


## 2026-11-18 账户回归收尾

- 本地完整认证测试 `test/*.test.mjs` 为 9/9 通过。
- 按 `ACCEPTANCE.md` 进行正式域名回归时，`GET /auth.html` 出现 DNS 解析失败，`GET /api/health` 与无 Cookie 的 `/api/auth/me` 曾返回 200，说明当前网络对不同请求的可达性不一致。
- 因此不能把本地测试结果写成线上注册、登录或资料显示已通过。最高优先级是核验 DNS、TLS、Caddy、Node 和唯一版本发布链，不改业务代码。
- 昵称修改仍是明确的待实现项，不能纳入本次 bug 修复。


## 2026-11-18 发布链路核验更新

- VPS `aoying-hl-observer` 已运行 `books-vps` 和 Caddy。Caddy 配置使用 `45-77-39-98.sslip.io`，反代到 `127.0.0.1:8930`，`caddy validate` 通过。
- 已将 GitHub `main` 提交 `fb030fc914dfc9f1360095b946a3b70ea2d3f845` 对应的 `account.html`、`account.css`、`market-overview.js` 发布到 `/opt/books/site`，并通过 `X-Books-Release` 返回提交标识。
- 正式 GET 页面、`/api/health`、无 Cookie `/api/auth/me` 和正式 Origin CORS 均可通过，旧 GitHub Pages 地址返回 404。
- 当前环境的 DNS 查询仍返回 `198.18.0.71`，与 `45.77.39.98` 的地址编码不同。SSH 和带 `--resolve` 的 HTTPS 已直达 `45.77.39.98`，权威 DNS 到 VPS 公网 IP 的关系仍需外部网络确认。
- 自动 GitHub→VPS workflow 仍不存在，本次完成的是受控手工发布和版本绑定。


## 2026-11-18 账户与金融安全基线

- 密码使用 Node `scrypt`，16 字节随机盐，`N=16384,r=8,p=1`，64 字节派生值，比较使用 `timingSafeEqual`。数据库保存派生值，没有明文密码。算法和参数目前没有版本字段。
- 登录失败按单进程内存 Map、单邮箱计数，5 次失败后锁 60 秒。注册没有速率限制，没有密码重置路由。多进程、重启和代理层限流尚未覆盖。
- 登录未知邮箱和错误密码统一返回 `invalid_credentials`。重复注册返回 `email_already_registered`，前端显示邮箱已注册，存在邮箱枚举风险。
- 生产 Cookie 使用 HttpOnly、Secure、SameSite=Lax。Caddy/TLS 已现场验证，HTTPS 响应当前没有 Strict-Transport-Security。
- 支付 provider 和 webhook secret 只从环境变量读取。VPS 当前没有 `/etc/books/books.env`，`paymentConfigured=false`。工作区未发现 Books 运行配置中的明文生产密钥。
- VPS `/var/lib/books` 目录为 700，但 `books.sqlite`、`books.sqlite-wal`、`books.sqlite-shm` 为 644，包含账户和金融数据，需收紧。隔离的旧 SSH key 仍在 `/root/.ssh/authorized_keys`，指纹为 `SHA256:xz86xBYIluRJwXmFvq0w0DivTxW0ztP4moaS8wxDc9Y`，撤销和轮换尚未完成。
- 服务日志只观察到启动和错误信息，未发现密码、Cookie、token 或 webhook secret 输出。数据库没有 `audit_events` 表，注册、登录、登出、充值、webhook、管理员禁用等关键动作缺少应用级审计记录。


## 2026-11-18 SSH 凭证轮换更新

- 旧指纹 `SHA256:xz86xBYIluRJwXmFvq0w0DivTxW0ztP4moaS8wxDc9Y` 已撤销，旧私钥隔离副本已删除。
- 新指纹 `SHA256:mAhNEtPnJlfh1BlFfbMxq9jJMGFj6HcxDl6LWOqlcmo` 已安装到 VPS，并通过 SSH、`books-vps`、Caddy 和 `/api/health` 验证。
- 新私钥保存在用户 SSH 目录，权限为 0600。密钥轮换完成后，数据库文件权限、审计日志、限流和 HSTS 仍是未修复的安全基线项目。
