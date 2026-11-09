# 带单员研究名单

此目录是 GitHub Pages 静态页面。公开 feed 与浏览器个人资料分开：`feed.json` 不含示例人物或业绩；用户手动添加的记录只保存在当前浏览器，不自动上传或向其他访客发布。

## 页面范围

页面不提供文件导入或导出入口。资料管理仅保留可选的手工添加、编辑、删除；已有浏览器资料不被删除或迁移。清除站点数据或切换设备不会自动恢复这些记录。

公开 feed 的刷新是重新读取本站文件，不是实时采集交易所。生产 `feed.json` 仍为空，未以历史快照或测试人物填充榜单。

## 数据适配准备

`okx-import.js` 仅保留为开发阶段的离线响应标准化模块与测试，网页不加载此脚本。它不会请求接口，也不代表线上采集已经接通。正式链路仍需可用、允许展示的官方只读数据源，并保留来源版本、采集时间及未知指标。

## 教程评估与本次实施边界

可落地部分：静态 UI、字段标准化、严格响应校验、按周期展示、个人资料管理、GitHub Pages 发布。现阶段不需要先引入 Redis、时序数据库或持续运行的 FastAPI 服务。

需修正的教程内容：

- OKX 榜单 `limit` 最大 20，`instType` 可省略且默认 SWAP，`dataVer` 每 10 分钟生成一版；榜单不是有保证的 1 秒实时信号。
- `public-stats` 的盈利日/亏损日数据不能当作逐笔交易样本。胜率必须明确样本与周期；缺已关闭交易记录时保持未知。
- 累计 PnL 不能替代权益曲线计算百分比回撤。例如本金 1,000、累计盈利从 100 降至 50，权益回撤为 50/1,100，而不是 50/100。缺权益与资金流口径时不补算 MDD。
- 公开 REST 的限流文档不能直接套到 Binance 前端内部接口。出现限流应按来源要求停止或退避，不通过轮换代理规避限制。
- GitHub Pages 能托管本页面的 HTML/CSS/JS，但不能常驻运行数据库、API 服务或 WebSocket Worker。未来需要持续采集与多设备同步时，再单独部署后端。

本轮单次无密钥 OKX 请求在当前云端返回 HTTP 403；未自动重试、切换代理或发布测试返回数据。页面未启用在线采集。CORS 可用性没有得到验证。免鉴权不等于允许公开再分发；未来公开数据服务需单独核对来源授权，不能把浏览器直取当作已获再分发许可。

## 官方参考

- [OKX 带单员榜单与字段](https://www.okx.com/docs-v5/en/#order-book-trading-copy-trading-get-lead-trader-ranks)
- [OKX API Agreement](https://www.okx.com/help/okx-api-agreement)
- [Binance Copy Trading General Info](https://developers.binance.com/en/docs/products/copy-trading/general-info)
- [GitHub Pages 的运行范围](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

合成测试只在测试进程中运行；不写入公开 `feed.json`。
