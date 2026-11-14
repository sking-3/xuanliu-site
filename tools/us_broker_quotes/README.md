# Books 免费美股行情组件

供本人在电脑上手动运行，配合公开页 <https://sking-3.github.io/xuanliu-site/us-live.html>。没有后台排程、自动安装、购买行情或下单功能。只监听 `127.0.0.1:19355`，不需租服务器或开放公网端口。

## 启动

需要 Python 3.9 或更新版本。在解压后的目录运行：

```sh
python3 server.py
```

打开终端打印的本机管理链接（包含本次启动的连接码），在本机页面选择平台、填写本人凭证，并确认只使用当前免费权限。填写后点击连接，然后复制连接码到公开监控页。平台凭证只在本机服务内存；连接码只在本页内存。连接适配器不等于账号已通过行情验收，公开页须主动读取报价。

在公开页添加美股自选代码后，选择已连接的平台，点击“读取一次”或“启动本页读取”。隐藏网页会停止页面轮询；返回需手动启动。结束时在本机页断开账号，再在终端按 Control+C 结束组件。关闭管理网页只会清空网页表单，不会让另一张公开页失去当前服务连接；服务退出才释放全部服务内存。

## 平台准备

- **富途 REST（不需要 SDK）**：本人富途账号及仅有 `quote:read` 的 Access Token。获取方式见[官方 OAuth 文档](https://open.futunn.com/zh-cn/api/overview/getting-started)。本组件不代注册 OAuth 客户端、创建授权或购买权益。只请求固定官方股票快照端点；推广免费及账号实际权益以富途确认为准。
- **富途 OpenD（可选）**：本人在官方 OpenD 登录并完成平台要求的确认，固定本机 `127.0.0.1:11111`。安装下面的富途依赖后，在接入页选择 OpenD；无需向本组件提供牛牛密码。
- **长桥（不需要 SDK）**：使用本人模拟开发权限提供的 App Key、App Secret 与 Access Token。此版仅接受 AP 区传统 App Key／Secret／Access Token，不接受美国区或 OAuth Bearer 凭证。使用固定官方中国接入点；不会切换其他域名、订阅付费数据或开通证券实盘。具体免费权益以[开发者中心](https://open.longbridge.cn/zh-CN/docs/qa/general)为准。
- **老虎**：已有 API 开发者资格、Tiger ID、账户标识与本人 API 签名私钥。私钥正文仅保留 RAM，不读取电脑文件。本组件只调用 `get_stock_delay_briefs` 免费延迟接口（约15分钟）；不会调用付费实时快照。仅有 App 登录不代表已取得 API 资格，权限不足即停。见[官方接口](https://docs.itigerup.com/docs/quote-stock)。

需要官方 SDK 的路径，可在解压目录建立隔离环境，再只安装所用平台：

```sh
python3 -m venv .venv
# 富途 OpenD 路径才需要：
.venv/bin/python -m pip install -r requirements-futu.txt
# 老虎路径才需要：
.venv/bin/python -m pip install -r requirements-tiger.txt
.venv/bin/python server.py
```

Windows 使用 `.venv\Scripts\python`。SDK 本身不收费；行情权益是另一项，组件不会购买。下载包不含第三方 SDK，依赖来自各平台官方 PyPI 发布；使用其原有软件许可与平台条款。

## 能力与验收边界

三平台当前接入报价快照、名称（来源有提供时）、原始来源时间与读取时间。富途、长桥的单源覆盖不会标成全美合并行情，老虎始终标记约15分钟延迟。过期、时间缺失、价格缺失保留为待核，不补造值。

本模块没有验收三平台历史分钟与同刻基线；当日累计成交量绝不冒充分钟成交量，也不与原 IEX 基线混用。仅有免费快照不等于分钟雷达已经运行。真实行情验收仍需本人账号与获准的免费权限；离线测试、SDK 安装检查、本机连通测试均不能替代真实报价验收。

## 停止与数据保存

HTTP 403／429、明确的权限和限流错误会停止对应来源，并把不含凭证的停止原因写入 `~/.local/state/books-us-broker-quotes/source-stops.json`。重连不会清除停止记录；须先核查平台权限／额度，再人工处理。网络错误和结构异常停止本次适配器，不换源、不切付费接口。

组件不保存账号凭证、原始行情、私钥或交易资料。配对码不得分享。公开页只获准查询状态和行情、断开连接，不能向本机录入平台凭证。免费个人行情权限不自动包含向其他访客转播的权利，个人行情不会写入公开 GitHub JSON。

本机共享读取节拍：富途与长桥至少5秒一次，老虎至少30秒一次；多个标签页共用预算。过频在本机返回等待状态，不调用平台。API 路由只含状态、连接、断开、报价，没有订单、资金、购买、升级或杠杆路由。

## 验证

源码仓库中可运行：

```sh
python3 -B -m unittest tools.us_broker_quotes.test_providers tools.us_broker_quotes.test_server
node --test audit/us-broker-quotes-unit.cjs
```

测试使用隔离模拟数据，不是真实行情。源码与下载包均不包含用户凭证。
