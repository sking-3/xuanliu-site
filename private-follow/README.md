# Books 私人跟单服务

新增本人可见的 `/research` 行情研究入口，详见 [RESEARCH.md](RESEARCH.md)。Tushare / Alpaca 行情凭证服务端加密，个人数据只在受认证页面展示；38项离线测试通过。私人入口已部署，但用户尚未完成供应商注册、录入凭证及真实行情验收，不应据此声称全市场筛选、分钟监控或真实异动已跑通。没有新增后台排程，实盘保持关闭。

公开研究站保留在 GitHub Pages。用户已选择当前 ChatGPT 账号登录的 [私人跟单站](https://books-private-follow.rr7jp4d56w.chatgpt.site)。Sites 项目 `appgprj_6af5c58e52f48191bd02a88337c9c231` 使用仅所有者的自定义访问名单，无编辑者、群组、外部访客或后台排程。这是独立的服务端权限边界，不是公开网页里的隐藏按钮。私人界面沿用 Books 的视觉体系。

## 权限和凭证

Sites 先验证登录和访问名单；Worker 再对管理页面、资源及 API 校验平台提供的用户 ID 与 `OWNER_ID`。未绑定所有者 ID 时拒绝管理操作。`/api/identity` 只在平台私有边界内返回当前访问者的本站 ID，供首次绑定，不读写配置或凭证。本人已通过实际 Chrome 登录取得本站身份并完成原生 Secret 绑定；私人设置写入生产 D1、页面显示保存成功已验证。

`OWNER_ID`、随机 32 字节 `CREDENTIAL_ENCRYPTION_KEY` 由 Sites 原生 Secrets 配置，不进入源码，管理接口不提供 Secret 值读取或回显。交易凭证只能由用户直接在私人账户接入页输入，不发到聊天、网址、本机模拟账本、公开 JSON 或日志。服务端以 AES-GCM 加密凭证，随机 nonce，附加认证数据绑定用户与平台；D1 保存密文，接口仅返回连接摘要。同源 JSON POST、Origin 校验和严格字段白名单保护保存操作。

## 连接范围

- 币安 USDⓈ-M：只签名读取 `/fapi/v3/account`。
- Bitget：用户明确选择经典合约账户或 UTA，分别只读 `/api/v2/mix/account/accounts` 或 `/api/v3/account/assets`，失败后不换路径重试。
- Hyperliquid：仅接受公开地址，读取官方 `clearinghouseState`，不接收私钥。
- HTTP 403/429 持久停止该来源，换凭证不会清除停止，无自动重试和备用域名。

没有下单、撤单、转账、调整杠杆的路由。`liveTradingEnabled:false`。账户读取成功不证明完整交易权限或后台跟单已启用。尚未提供或验证用户真实交易凭证，实际账户连接须由用户在私人页直接验证；本人登录与设置保存验收不替代这一验证。

## 本机模拟

受认证 `/paper` 页面复用已有模拟引擎，脚本和样式也经过 Worker 的所有者校验。私人设置固定跟随熬鹰资本；保存目标平台、名义金额、敞口、杠杆和白名单后，进入模拟页新建该平台独立的本机虚拟账本，再开始建立历史基线。Bitget、Binance 使用各自的 USDT 账本与官方公开合约规则、盘口；Hyperliquid 沿用官方 USDC 盘口。旧账本不覆盖，已有账本保留原参数，暂停后保存参数才应用新限制。原公开域名账本不能跨域自动迁移。

`/api/paper-market` 要求本人认证，仅匿名 GET 目标交易所的合约规则和盘口，不解密 API 凭证。数量步长目前仅支持十进制规则，其他合约明确拒绝。Binance 的 20 倍是模拟风控上限，未核验账户杠杆档位。403/429 写入持久停止记录，不回退到其他端点。页面隐藏、关闭或来源过期仍暂停，不补执行旧单，也没有新增后台排程。

“流程验收（测试）”用隔离内存中的合成操作与盘口，经检查点解析、方向标准化、引擎和资金对账，检查三平台多空各四步，共 24 步。测试不写入正式账本或新信号流，不能证明真实新操作已被跟随。模拟开/平表示虚拟仓位变化；币安公开方向不证明来源真正新开仓或已空仓。API 连接仍只验证读取，无真实下单、撤单、转账或杠杆变更路由。

原每五秒公开观察器独立运行，本轮已另行核验有新鲜成功记录，未改其代码、排程或停止记录。旧公开 raw/CDN 文件可能滞后数分钟，不能据此认定观察器停止。私人页面通过同源 `/api/checkpoint` 只读先前获准的固定端点 `https://api.github.com/repos/sking-3/xuanliu-site/contents/monitor-state/5075281354358777856.json?ref=binance-public-orders-state`，不查询或触发 GitHub Actions 队列。

私人构建把原公开检查点读取器改为同源受认证请求，使用 `credentials:'same-origin'` 携带本站认证；外部交易所读取仍省略浏览器凭据。生产 `/paper` 已实际读取新鲜 Contents 检查点，页面显示来源时间为北京时间 2026-11-12 22:40:30。已建立明确标注模拟的 10,000 USDC 本机账本，启动建立基线后立即暂停，保留账本；模拟与跳过均为 0，没有复制仓位或记录。该验收没有使用真实交易凭证或发送真实订单，也没有验证新信号产生模拟成交。

D1 使用原子更新约束每 75 秒最多一次上游尝试，多个标签和请求共用这一预算。缓存保留检查点原始来源时间与停止证据，读取缓存不会刷新信号时间；检查点过期时禁止开始模拟。上游 403/429 写入持久停止，不回退到 raw/CDN 或备用端点；其他读取失败可以保留已验证缓存及其原时间。来源五秒目标节拍不等于页面五秒发现，打开页面也不构成后台执行。

服务端固定外发请求使用 `redirect:'manual'` 并拒绝非 2xx，不跟随重定向。Cloudflare Workers 不支持此前使用的 `redirect:'error'`；该运行时错误发生在发送来源请求之前，未收到来源 403，不能解释为来源拒绝或权限绕过。

## 开发和发布

沿用 HTML/CSS/JS，新增小型 Worker 与 D1。`node --test private-follow/test/*.test.mjs` 检查鉴权、加密、固定只读路径与来源停止；`node private-follow/build.mjs` 打包。复制到独立 Sites 源码仓库时，将构建脚本列明的模拟依赖放进 `shared/`。D1 表由版本化迁移建立。

GitHub Pages 打包排除整个 `private-follow/` 和本机模拟脚本。不含密钥的私人源码与构建代码保存在 GitHub，不代表私密管理页公开；托管 Secrets 和 D1 私密配置不进入 Git。Sites 的发布与访问策略由 Sites 管理。

本地预览的注入身份不能冒充生产认证。生产所有者绑定、本人实际登录、D1 设置保存及私人模拟建基线后暂停均已验证；真实交易凭证未提供或测试。仓库外的 `online.jpg` 已刷新为实际所有者设置页重新加载后的画面，`private-desktop.jpg` 已刷新为实际生产 `/paper` 的暂停画面，不是注入身份的本地预览；这些截图不进入发布包。

本轮私人 Site 部署验收基线为源码 `789c58f7584cbc4ec25b792ce842f77fd18ebc3b`、环境修订 2。公开功能基线 `93beb9c67631d1e8d54655c848a9033f9e7565da` 已直接提交 main 并部署，未经过 PR 合并；四项公开资源与本地文件逐字节一致，Pages 上的 `/private-follow/worker/index.mjs` 返回 404。真实公开站浏览器检查已完成：官方实时流显示两个当前仓位，北京时间 2026-11-12 22:42:53—22:44:54 收到 25 个真实样本，ETH 行情为 97 根真实 15 分钟 K 线，历史统计默认折叠，控制台错误日志为空。390×640 CSS iframe 视口无外层溢出，未作实体移动设备验证。

接口依据：[币安](https://developers.binance.com/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/account)、[Bitget 经典](https://www.bitget.com/legacy-docs/classic/contract/account/Get-Account-List)、[Bitget UTA](https://www.bitget.com/legacy-docs/uta/account/Get-Account)、[Hyperliquid](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint)。
