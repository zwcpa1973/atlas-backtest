# Atlas Backtest · 美股策略实验室

一个参考 QuantMage / Composer 交互结构做的**美股策略回测工作台**。可视化搭策略树（或直接写 JSON），一键跑历史回测，看收益曲线、表现统计和持仓历史。

**不需要券商账户也能跑** —— 仓库自带 195 个标的、2000 年至 2026-08-28 的复权日线缓存，装上依赖就能回测。

```
┌─────────────┬──────────────────────────────────────────────┐
│  策略工坊    │  可视化构建 / 代码编辑器  ⇄  运行回测          │
│  策略库      │  收益曲线 · 表现统计 · 持仓历史 · 导出 Excel    │
└─────────────┴──────────────────────────────────────────────┘
```

## 快速开始

```bash
git clone <本仓库地址>
cd atlas-backtest

python -m venv .venv
.venv\Scripts\activate          # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt

python server.py                # 或双击 打开回测网页.cmd
```

浏览器打开 <http://127.0.0.1:8766>。

Windows 上也可以直接双击 `打开回测网页.cmd`：它会在需要时后台启动服务并打开页面。

## 两种数据来源

回测需要历史行情。程序按下面的顺序取数：

1. **`data/` 里的单标缓存**（默认，仓库自带）
2. **`reference/` 宽表底库**（可选，放一个 `market_data_daily.csv` 进去即可）
3. **盈透证券 Trader Workstation**（可选，只有在缓存不够长时才会去连）

所以你有两条路：

### 离线模式（推荐给只是想试试的人）

不需要装 TWS、不需要券商账户。只要回测区间在缓存覆盖范围内（**2000-01-03 ~ 2026-08-28**）就能直接跑。

设一下这个环境变量，程序就完全不碰盈透：

```cmd
set ATLAS_OFFLINE=1
python server.py
```

不设也行 —— 默认行为更宽松：连不上 TWS 时会自动退回本地缓存，并在控制台打一行 `[warn]`。

### 接盈透增量更新（想回测到最新交易日）

1. 打开 Trader Workstation，登录
2. `File → Global Configuration → API → Settings`
3. 勾选 **Enable ActiveX and Socket Clients**，端口 **7496**，并勾选 **Read-Only API**
4. `python server.py`

行情通过本机 TWS API 7496 下载，缓存在 `data/`。**本工具不会查询账户信息，也不会提交任何订单。**

## 功能

**策略工坊**

- 可视化构建策略树：资产 → 权重 → 条件分支，支持嵌套
- 同步的代码编辑器，可直接编辑策略 JSON
- 撤销 / 重做、另存为新策略、导出 JSON
- 权重编辑（含整数权重模式）

**回测**

- 区间：近 1 / 3 / 5 年或全部
- 再平衡频率：每日 / 每月等
- 参数：初始资金、滑点、基准（默认 SPY）、是否再投资分红
- 输出：收益曲线（可切对数坐标）、表现统计、持仓历史（1 ~ 60 个月分组）
- 指标：累计收益、CAGR、最大回撤、Sharpe、Sortino、波动率、胜率
- 导出：持仓明细导出 Excel，策略导出 JSON

**策略库**

- `strategy_library/` 下按 UUID 保存策略，支持新增 / 读取 / 改名 / 删除

## 项目结构

```
.
├── server.py              # FastAPI 后端：取数、回测、策略 CRUD、导出
├── backtest_engine.py     # 回测专用扩展（Volatility 指标实现）
├── vendor/
│   └── quantmage_native_engine.py   # 原生策略树求值引擎（与券商无关）
├── index.html             # 单页前端
├── app.js                 # 回测页逻辑（图表、指标、导出）
├── builder-*.js/.css      # 策略工坊（可视化构建 + 代码编辑器）
├── tree.css style.css enhancements.css
├── start-backtest.py      # 启动并打开页面
├── 打开回测网页.cmd
├── data/                  # 195 个标的的复权日线缓存（回测数据来源）
├── test_*.py / test_*.cjs # 单元测试
└── requirements.txt
```

`strategy_library/` 不在仓库里 —— 它在首次运行时自动创建，你的策略只保存在**本机**。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/status` | 服务状态、TWS 连接、数据最新日期、缓存标的 |
| POST | `/api/backtest` | 跑回测，body 为 `{strategy, settings}` |
| POST | `/api/export-allocations` | 导出持仓明细为 Excel |
| GET/POST | `/api/strategies` | 策略列表 / 新建 |
| GET/PUT/DELETE | `/api/strategies/{id}` | 读取 / 更新 / 删除 |

回测返回：`equity`、`benchmarkEquity`、`metrics`、`annual`、`allocations`、`allocationHistory`、`trades`、`dates`。

## 最小可用策略示例

策略对象由两部分组成：`definition` 是真正参与计算的策略树，`nodes` 只是界面展示用的结构。

下面是一个 60% SPY / 40% BIL、每月再平衡的最小策略（可直接跑通）：

```json
{
  "strategy": {
    "definition": {
      "incantation_type": "Weighted",
      "type": "Custom",
      "weights": [0.6, 0.4],
      "incantations": [
        { "incantation_type": "Ticker", "symbol": "SPY" },
        { "incantation_type": "Ticker", "symbol": "BIL" }
      ]
    },
    "nodes": [
      {
        "type": "group", "title": "Demo 60/40", "meta": "Custom · 2项",
        "children": [
          { "type": "asset", "title": "SPY · 美股资产", "meta": "60%" },
          { "type": "asset", "title": "BIL · 美股资产", "meta": "40%" }
        ]
      }
    ]
  },
  "settings": {
    "start": "2024-01-02", "end": "2026-08-28", "benchmark": "SPY",
    "frequency": "每月", "reinvestDividends": true,
    "capital": "100000", "slippage": "10"
  }
}
```

```bash
curl -X POST http://127.0.0.1:8766/api/backtest \
  -H "Content-Type: application/json" \
  -d @strategy.json
```

实测结果：`BIL, QQQ, SPY` 三个标的（QQQ 是默认附加的对比基准），661 个交易日，
CAGR 14.48%、最大回撤 -11.34%、Sharpe 1.51。

策略树的节点类型：

| 类型 | 说明 |
| --- | --- |
| `Ticker` | 单个标的，如 `{"incantation_type":"Ticker","symbol":"SPY"}` |
| `Weighted` | 加权组合，`type` 可为 `Equal` / `Custom`（配合 `weights`）/ `InverseVolatility` |
| `Filtered` / `IfElse` | 按条件筛选或分支，配合 `condition`、`then_incantation`、`else_incantation` |

指标类型包括 `CurrentPrice`、`MovingAverage`、`CumulativeReturn`、`Volatility` 等。

> 平时直接在「策略工坊」里可视化搭建即可，不用手写 JSON；上面只是给想用脚本调用的人一个起点。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ATLAS_OFFLINE` | 未设置 | 设为 `1` 完全跳过盈透，只用本地缓存 |
| `IB_HOST` / `IB_PORT` / `IB_CLIENT_ID` | `127.0.0.1` / `7496` / `71` | TWS 连接参数 |
| `QUANTMAGE_ENGINE_DIR` | 无 | 用外部引擎目录覆盖 `vendor/` |
| `ATLAS_REFERENCE_DB` | 无 | 指定单个宽表底库 CSV 路径 |
| `ATLAS_REFERENCE_DBS` | 无 | 指定多个宽表底库 CSV（用系统路径分隔符隔开） |

## 数据口径

- 缓存是 **`ADJUSTED_LAST` 复权日线**，只保留已结算的交易日，不含当天未收盘的快照
- 标的代码统一用 `-` 连接（`BRK-B`），盈透那边用空格（`BRK B`），代码里会自动转换
- 缓存覆盖 2000-01-03 起；标的的上市日不同，早期数据为空是正常的

## 已知限制

- `ib_insync` 已停止维护（最后版本 0.9.86），能正常工作但不会有新特性
- 回测用日线收盘价和固定滑点近似，不含盘中撮合、涨跌停、融资利率、税费
- 前端引用了 Google Fonts，离线时会退化成系统字体

## 测试

`test_*.py` / `test_*.cjs` 是单元测试，跑的是构造出来的迷你行情，不依赖任何真实策略：

- `test_volatility.py` — Volatility 指标与条件判定
- `test_symbol_aliases.py` — 标的代码别名归一（`BRK B` / `BRK-B`）
- `test_builder_backtest.py`、`test_library_api.py` — 后端接口
- `test_builder_model.cjs`、`test_builder_ui.cjs`、`test_condition_labels.cjs`、`test_library_ui.cjs` — 策略树编辑

## 仓库里没有示例策略

本仓库**只包含工具本身**（代码 + 公开行情缓存），不包含任何具体策略。
首次运行后 `strategy_library/` 是空的，需要自己在「策略工坊」里搭，或者导入你自己的策略 JSON。

## 免责声明

本项目仅用于策略研究与教学，**不构成任何投资建议**。回测结果受数据口径、滑点假设、幸存者偏差等影响，历史表现不代表未来收益。使用者需自行承担一切风险。
