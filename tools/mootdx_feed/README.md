# mootdx 行情采集入口

为首页“沪深成交活跃榜”准备可核查的日线输入，也支持单次报价和历史分笔采样。目前只能安装和运行离线验证，**尚未接入首页、没有日更排程，也不代表全市场热度榜已上线**。

最终交付方向是 **GitHub Actions 云端自动生成名单 → 首页展示 → 站内 TradingView 图表**，不依赖用户 Mac 或日常手动运行。当前仅完成受限采集代码、离线验证和候选发布隔离；云端来源及共享停止状态尚未验收，未启用日更。发布路径与后续合同见 [RELEASE_PLAN.md](RELEASE_PLAN.md)。

旧的多来源入口仍在 `tools/stock_research/a_share_sources.py`。本入口使用独立依赖环境，避免与旧适配器及待复核修复交叉修改。不要在同一虚拟环境同时安装两个 requirements 文件。

## 安装与启用状态

此入口**保持关闭**，PR 仍处于复核阶段。`--enable-network` 只是请求参数，当前不能开启真实采集：必须先检查共享来源政策，而旧来源停止状态尚未完成整合，所以即使政策写成 approved 也会拒绝连接。文件保护机制要求 POSIX。验证环境为 Ubuntu 24.04 / Python 3.11、3.12；用户 Mac、Apple Silicon 依赖 wheel 兼容性及 Windows 均未验收。

`requirements-mootdx.txt` 锁定实际解析的完整依赖版本及 PyPI SHA256 哈希，强制 `--require-hashes` 和 `--only-binary=:all:`。Python 3.11/3.12 的 NumPy 版本分别锁定；哈希来自 Actions run 44003820417 所对应的 PyPI 版本元数据。没有兼容 wheel 时安装会停止，不回退到含未锁定构建依赖的源码构建。版本/哈希锁定用于可重复安装，不能称为完整依赖安全审计。

在仓库根目录，使用独立 Python 3.11 或 3.12 环境；不要与旧适配器混用依赖：

```bash
python3 -m venv /tmp/books-mootdx-venv
source /tmp/books-mootdx-venv/bin/activate
python -m pip install --require-hashes --only-binary=:all: -r scripts/requirements-mootdx.txt
```

## 来源准入与持久停止

普通命令返回 `network_disabled`。传入 `--enable-network` 后，程序先读取既有 `scripts/source-holds.json` 的来源政策；预留操作键为 `aShareTdxCollector`，仓库当前没有这项授权。缺失、拒绝、暂停或无法读取时返回 `source_permission_unverified`。没有为完成这项开发而添加 approved 项。

即使该项未来被写成 approved，当前代码仍返回 `legacy_source_stops_unverified`。旧采集器的来源停止记录路径、格式、来源别名及恢复规则尚未核实，**此版本没有可启用的真实采集路径**。授权、清空新目录、更换参数或传入 factory 都不能解除这一限制。CLI、collect、内部采集函数和客户端工厂分别检查；工厂在导入 mootdx 前先拒绝。这里只读取共享政策，不修改任何旧停止记录。

`~/.local/state/books/mootdx-feed/source-state.json` 只是新入口自己的附加锁和失败记录，**不代表已经整合旧来源状态，也不能充当来源授权**。后续整合须采用“任一入口停止，全部相关入口停止”的合并规则；读取异常或来源映射不明同样停止，不能自动把不存在的文件认定为允许。具体实施条件与待交接材料见 [SOURCE_ACCESS.md](SOURCE_ACCESS.md)。

以下仅检查入口和参数，不会采集：

```bash
python -m tools.mootdx_feed.collector --help
python -m tools.mootdx_feed.collector --symbols 600519
# 返回 network_disabled，退出码 2
```

离线测试中，模拟准入通过后会验证本入口的持久锁：先独占写入并落盘，再构建模拟客户端；拒绝、超时、空返回、校验失败和中断都保留停止记录，下一进程不能继续；成功批次才移除运行记录。测试替换只存在于 unittest，生产代码没有测试模式、reset、force 或自定义状态路径开关。

mootdx 0.11.7 的原始 `Quotes.factory` 会在缺失或损坏配置时扫描服务器，即使设置 `bestip=False` 也无法阻止。本入口直接构建单一 TDX 传输连接，复用固定版本的报价、日线和分笔解析方法，跳过 `BaseQuotes/StdQuotes.__init__` 和 `config.setup()`；不读取或改写原 mootdx 配置。这一有限适配依赖已锁定的 mootdx/tdxpy 版本，升级必须重新测试。

每批最多 50 只输入股票；日线/分笔每只最多 800 行。日线使用 frequency=9，可能含当日未完成行。`--timeout` 为 1–30 秒。任何失败都终止本批次，没有部分成功结果。

## 私人输出

输出只允许在 `~/.local/share/books/mootdx-feed/` 中保存，目录必须归当前用户所有且权限为 0700，文件为 0600。默认名称为“模式 + 随机标识”。可用 `--output daily-my-sample.json` 指定新的合规文件名，不能指定其他目录。

工具拒绝覆盖**所有已有目标**，包括本工具的旧快照、其他格式、硬链接和符号链接。完成写入后通过不可覆盖的原子链接发布新文件；并发抢占文件名也不会替换已有内容。路径逐层拒绝符号链接。失败不会修改原快照、刷新原数据日期或上传任何数据。

`std` 对应沪深标准市场；本入口只接收沪深 A 股代码，不接收指数、ETF、B 股和北交所代码。代码格式校验不等于已核实上市状态。输出的 `scope=supplied_stock_sample` 明确是输入样本，不能标为“全市场”。

## 日期、单位和后续榜单

- `fetchedAt` 仅为本机获取时间，不能替代证券行情时间。
- 报价只有时分秒时，保留 `sourceClock`，`sourceAsOf` 为 null，不宣称实时。
- 日线保留来源日期，检查重复日期、未来日期、OHLC 和有限非负数值；不填补缺日。当前日期行标 `isCurrentDate=true`，`sessionComplete` 保持未知。
- 分笔记录保留请求日期和来源时刻；请求参数本身不是数据日期证明。
- 成交额、成交量分别保留为 `amountRaw`、`volumeRaw`。在真实样本与来源字段单位完成对账前，不擅自乘 100、1,000 或 10,000，不将它们标为元或股。
- 后续五日活跃榜仍需要：经核实的上市名册和交易日历、同一五个完整交易日的覆盖、成交额单位、数据使用权限。不得拿最近任意五行冒充最近五个交易日。
- 工具没有下单功能。没有上传行情文件、交易账户资料或密钥的流程。输出只在私人路径保存，`redistributionAllowed=false`；代码获准上传不代表行情再分发获准。

## 通达信本地文件

若已有通达信本地目录，可直接使用上游 Reader：

```python
from mootdx.reader import Reader
reader = Reader.factory(market="std", tdxdir="C:/new_tdx")
daily = reader.daily(symbol="600036")
```

## 测试与运行边界

```bash
python -B -m unittest tools.mootdx_feed.test_collector -v
```

GitHub Actions 的 `Verify mootdx feed` 使用 Python 3.11/3.12 和真实安装的固定版本包进行离线模拟。测试拦截 socket，覆盖上游扫描触发条件、固定服务器适配、跨进程停止记录、输出路径限制与并发覆盖保护。它不连接真实通达信、不生成或上传行情产物，也不证明数据源可用、行情准确或依赖经过完整安全审计。新增准入测试不替换准入检查，确认即使新目录为空、来源键为 approved、换模式/服务器或重启进程，也不会创建客户端。旧停止记录的实际读取、双向传播和共同锁迁移尚未完成，不能把这些拒绝测试称为旧来源整合验收。真实连通性、数据日期、单位和公开展示权利仍未验收。

GitHub Pages 是静态网站，不能运行 Python 或 TCP 行情采集。安装到仓库也不会自动建立常驻服务。是否能连通与网络、服务端状态和访问策略有关；不能保证没有 IP 限制、不会超时，不能保证某个地区一定可用或不可用。

## 可用性证据的范围

[第三方项目 issue #52](https://github.com/simonlin1212/a-stock-data/issues/52) 报告：2026-09-11，在其 Windows 本地网络与 Linux 云环境，mootdx 0.11.7 / tdxpy 0.2.7 的 TCP 和部分非行情命令正常，但 bars、quotes、transaction 返回空。该项目维护者在 9 月 20 日评论中确认了其环境的类似现象。这是他人的特定环境报告，不能推出目前所有服务都失效，也不能证明本项目可用。

本项目没有运行报告内的扫描/复现脚本。离线回归使用真实固定版本解析器和模拟传输，验证“连接成功但行情为空”仍会失败并留下停止记录；不以股票列表可返回来替代行情内容验收。

## 上游依据

- [mootdx 0.11.7 发布页与安装说明](https://pypi.org/project/mootdx/0.11.7/)
- [固定版本 Quotes API 源码](https://github.com/mootdx/mootdx/blob/v0.11.7/mootdx/quotes.py)
- [固定版本 DataFrame 转换源码](https://github.com/mootdx/mootdx/blob/v0.11.7/mootdx/utils/__init__.py)

固定版本 [LICENSE](https://github.com/mootdx/mootdx/blob/v0.11.7/LICENSE) 是 MIT 软件许可证，而同版本 [README](https://github.com/mootdx/mootdx/blob/v0.11.7/README.md) 又写有学习交流、不得商业使用的声明。两份文字存在需向权利人澄清的使用边界，本项目不自行裁定哪一份覆盖另一份，也不将软件许可证当成行情公开再展示授权。

[通达信 AI 积分量化数据服务用户协议](https://help.tdx.com.cn/quant/docs/markdown/mindoc-1hp49ff1nkrus.html)（2026-11-01 版）对该项服务的数据使用、再分发和第三方接入有明确限制；它属于特定 AI 积分服务，不可未经核实直接套用于本入口拟访问的 7709 服务。现有证据没有给出本项目的来源访问、长期保存或公开榜单展示许可，相关状态保持未知与关闭。
