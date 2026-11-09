# 带单员研究名单

此目录是 GitHub Pages 静态页面。公开 feed 与浏览器个人资料分开：`feed.json` 不含示例人物或业绩；用户手动添加、导入的记录只保存在当前浏览器，不自动上传或向其他访客发布。

## 使用

1. 点击「添加带单员」，填写名称、交易所、币种和 HTTPS 来源；账号、备注、重点关注与表现记录可选。
2. 有真实表现数据时，选择对应周期、数据截止时间并填写数值。ROI、最大回撤以百分数输入，例如 `12.5` 表示 12.5%。逐笔胜率只从同周期盈利交易数和已关闭交易数计算。
3. 点击「导出我的资料」备份 JSON。「导入资料」支持 Books schema 1 备份及下述 OKX 榜单响应。
4. 浏览器清除站点数据、切换浏览器或设备，不会自动恢复个人资料，请使用导出备份。

公开 feed 的刷新是重新读取本站文件，不是实时采集交易所。个人记录和导入快照不自动更新。

## OKX 文件导入

`okx-import.js` 是纯离线转换器，不发起网络请求，不读取 API 密钥。

支持 `/api/v5/copytrading/public-lead-traders` 的成功 JSON 响应，最多 20 条：

- 昵称、账号、币种、90 日 ROI 和 PnL 按来源字段映射；ROI 比例乘 100 转为百分数。
- 不把 `winRatio` 当成逐笔胜率，不从 PnL 曲线推算最大回撤，不生成仓位或订单。
- 裸响应的 `dataVer` 是来源版本号，其时区未确认。导入时间不是源数据时间；页面标记「快照日期未知」，不导入无法确认时间范围的曲线。
- 如文件提供以下外层结构，使用实际采集时间，并校验来源曲线的顺序、重复点、数量与时间范围。`observedAt` 必须是采集者记录的真实 ISO 时间，不能用当前时间替换旧快照时间。

```json
{
  "source": "okx-public-lead-traders",
  "observedAt": "<实际采集时间 ISO 8601>",
  "payload": {"code": "0", "data": [{"dataVer": "<来源版本号>", "ranks": []}]}
}
```

此格式仅说明结构，不是可用行情文件。导入记录仍只保存在个人浏览器中。

## 教程评估与本次实施边界

可落地部分：静态 UI、字段标准化、严格导入校验、按周期展示、个人资料管理、GitHub Pages 发布。现阶段不需要先引入 Redis、时序数据库或持续运行的 FastAPI 服务。

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
