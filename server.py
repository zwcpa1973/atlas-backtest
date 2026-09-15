from __future__ import annotations

import asyncio
import json
import os
import sys
import math
import threading
import traceback
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from ib_insync import IB, Stock, util
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
DATA.mkdir(exist_ok=True)
STRATEGY_LIBRARY = ROOT / "strategy_library"
STRATEGY_LIBRARY.mkdir(exist_ok=True)

# 原生引擎（QuantMageEngine）的查找顺序：仓库自带的 vendor/ 优先，
# 其次环境变量 QUANTMAGE_ENGINE_DIR，最后回退到开发机上的原始目录。
# 把外部目录放到 sys.path 尾部、本地 vendor 放到首位，保证本地副本生效。
VENDOR_DIR = ROOT / "vendor"
for candidate in (Path(os.environ["QUANTMAGE_ENGINE_DIR"]) if os.environ.get("QUANTMAGE_ENGINE_DIR") else None,):
    if candidate is not None and candidate.is_dir():
        sys.path.append(str(candidate))
sys.path.insert(0, str(VENDOR_DIR))

from backtest_engine import QuantMageEngine, QuantMageEvaluationError  # noqa: E402

# 复权收盘价底库（宽表），可选：
#   1) 仓库里的 reference/market_data_daily.csv
#   2) 环境变量 ATLAS_REFERENCE_DB 指向的 CSV
#   3) 环境变量 ATLAS_REFERENCE_DBS 指向的多个 CSV（路径分隔符隔开）
# 只有某个标的在 data/ 里没缓存时才会用到。都不存在也不影响运行。
REFERENCE_DATABASES = [
    p for p in (
        [ROOT / "reference" / "market_data_daily.csv"]
        + ([Path(os.environ["ATLAS_REFERENCE_DB"])] if os.environ.get("ATLAS_REFERENCE_DB") else [])
        + ([Path(x) for x in os.environ["ATLAS_REFERENCE_DBS"].split(os.pathsep) if x.strip()]
           if os.environ.get("ATLAS_REFERENCE_DBS") else [])
    ) if p is not None
]

IB_HOST = os.environ.get("IB_HOST", "127.0.0.1")
IB_PORT = int(os.environ.get("IB_PORT", "7496"))
IB_CLIENT = int(os.environ.get("IB_CLIENT_ID", "71"))
# 没有装/不方便开 Trader Workstation 时，设为 1 就完全跳过盈透，只用 data/ 里的缓存。
# 不设这个变量时行为更宽松：连不上 TWS 就自动退回本地缓存，而不是直接报错。
OFFLINE_ONLY = os.environ.get("ATLAS_OFFLINE", "").strip().lower() in {"1", "true", "yes"}
ib_lock = threading.Lock()
reference_lock = threading.Lock()
reference_database: pd.DataFrame | None = None
indicator_cache: dict[tuple, float] = {}
app = FastAPI(title="Atlas Backtest API")


@app.middleware("http")
async def prevent_stale_frontend(request, call_next):
    response = await call_next(request)
    if request.url.path == "/" or request.url.path.endswith((".js", ".css", ".html")):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response


class BacktestRequest(BaseModel):
    strategy: dict[str, Any]
    settings: dict[str, Any]


def normalize_symbol(value: str) -> str:
    """Use one market-data key for aliases before collecting price columns."""
    return str(value).strip().upper().replace("BRK B", "BRK-B").replace(".", "-")


def symbols_from_nodes(nodes: list[dict[str, Any]]) -> list[tuple[str, float]]:
    found: list[tuple[str, float]] = []
    for node in nodes:
        children = node.get("children") or []
        if children:
            found.extend(symbols_from_nodes(children))
            continue
        text = str(node.get("ticker") or node.get("symbol") or node.get("title") or "")
        symbol = normalize_symbol(text.split("·")[0]).split(" ")[0]
        if symbol and symbol.isascii() and symbol.replace("-", "").isalpha():
            raw = str(node.get("weight") or node.get("meta") or "0").replace("%", "")
            try: weight = float(raw)
            except ValueError: weight = 0
            found.append((symbol, weight))
    merged: dict[str, float] = {}
    for symbol, weight in found: merged[symbol] = merged.get(symbol, 0) + weight
    if not merged: return []
    if sum(merged.values()) <= 0:
        merged = {s: 1 / len(merged) for s in merged}
    else:
        total = sum(merged.values())
        merged = {s: w / total for s, w in merged.items()}
    return list(merged.items())


def symbols_from_definition(node: Any) -> set[str]:
    result: set[str] = set()
    if isinstance(node, dict):
        for key in ("ticker", "symbol", "lh_ticker_symbol", "rh_ticker_symbol", "lhs-val", "rhs-val"):
            value = node.get(key)
            if isinstance(value, str) and value.strip() and not (key in ("rhs-val",) and node.get("rhs-fixed-value?")):
                symbol = normalize_symbol(value)
                if symbol.replace("-", "").isalpha(): result.add(symbol)
        for value in node.values(): result |= symbols_from_definition(value)
    elif isinstance(node, list):
        for value in node: result |= symbols_from_definition(value)
    return result


def indicator(series: pd.Series, spec: dict[str, Any], pos: int) -> float:
    kind = str(spec.get("type") or spec.get("name") or "CurrentPrice").lower().replace("-", "")
    window = int(spec.get("window") or spec.get("window-days") or 0)
    key=(str(series.name),kind,window,pos)
    if key in indicator_cache:return indicator_cache[key]
    s = series.iloc[:pos + 1].dropna()
    if s.empty: return np.nan
    result=np.nan
    if kind in ("currentprice", "price"): result=float(s.iloc[-1])
    if kind in ("movingaverage", "movingaverageprice"):
        result=float(s.tail(window).mean()) if window and len(s) >= window else np.nan
    elif kind in ("exponentialmovingaverage", "exponentialmovingaverageprice"):
        result=float(s.ewm(span=window, adjust=False).mean().iloc[-1]) if window and len(s) >= window else np.nan
    elif kind in ("cumulativereturn", "momentum"):
        result=float((s.iloc[-1] / s.iloc[-window - 1] - 1) * 100) if window and len(s) > window else np.nan
    elif kind in ("relativestrengthindex", "rsi"):
        if not window or len(s) <= window: return np.nan
        delta = s.diff(); gain = delta.clip(lower=0); loss = -delta.clip(upper=0)
        avg_gain = gain.ewm(alpha=1/window, adjust=False, min_periods=window).mean()
        avg_loss = loss.ewm(alpha=1/window, adjust=False, min_periods=window).mean()
        result=100.0 if avg_loss.iloc[-1] == 0 else float(100 - 100 / (1 + avg_gain.iloc[-1] / avg_loss.iloc[-1]))
    elif kind in ("volatility", "standarddeviation"):
        result=float(s.pct_change().tail(window).std() * math.sqrt(252) * 100) if window and len(s) > window else np.nan
    elif kind in ("maxdrawdown",):
        w = s.tail(window); result=float((w / w.cummax() - 1).min() * 100) if window and len(w) == window else np.nan
    elif kind in ("movingaverageofreturns", "movingaveragereturn"):
        result=float(s.pct_change().tail(window).mean()*100) if window and len(s)>window else np.nan
    indicator_cache[key]=result
    return result


def composer_condition(cond: dict[str, Any], prices: pd.DataFrame, pos: int) -> bool:
    days = max(1, int(cond.get("for_days") or 1))
    for offset in range(days):
        p = pos - offset
        if p < 0: return False
        lhs_symbol = str(cond.get("lh_ticker_symbol") or "").upper().replace(".", "-")
        if lhs_symbol not in prices: return False
        lhs = indicator(prices[lhs_symbol], cond.get("lh_indicator") or {"type":"CurrentPrice"}, p)
        rhs_symbol = str(cond.get("rh_ticker_symbol") or "").upper().replace(".", "-")
        if rhs_symbol and rhs_symbol in prices:
            rhs = indicator(prices[rhs_symbol], cond.get("rh_indicator") or {"type":"CurrentPrice"}, p)
        else: rhs = float(cond.get("rh_value", cond.get("rh_value_int", 0)))
        rhs = rhs * float(cond.get("rh_weight", 1)) + float(cond.get("rh_bias", 0))
        if pd.isna(lhs) or pd.isna(rhs): return False
        if not ((lhs > rhs) if cond.get("greater_than", True) else (lhs < rhs)): return False
    return True


def normalize_weights(portfolio: dict[str, float]) -> dict[str, float]:
    portfolio = {k: float(v) for k, v in portfolio.items() if v > 0}
    total = sum(portfolio.values())
    return {k: v / total for k, v in portfolio.items()} if total else {}

def apply_risk_caps(target: pd.Series, settings: dict[str, Any]) -> pd.Series:
    """Optional portfolio-level caps; excess weight is moved to a cash ETF."""
    caps = {normalize_symbol(k): float(v) for k, v in (settings.get("riskCaps") or {}).items()}
    risk_limit = settings.get("maxRiskAssets")
    overflow = normalize_symbol(settings.get("overflowSymbol", "BIL"))
    if not caps and risk_limit is None:
        return target
    target = target.copy().astype(float).clip(lower=0)
    excess = 0.0
    for symbol, cap in caps.items():
        if symbol in target and target[symbol] > cap:
            excess += float(target[symbol] - cap); target[symbol] = cap
    if risk_limit is not None:
        risk_symbols = set(caps) | {"QQQ", "UGL", "VIXY"}
        risk_total = float(target[[s for s in risk_symbols if s in target]].sum())
        if risk_total > float(risk_limit):
            scale = float(risk_limit) / risk_total
            for symbol in risk_symbols:
                if symbol in target:
                    old = float(target[symbol]); target[symbol] = old * scale; excess += old - float(target[symbol])
    if excess > 0:
        target[overflow] = float(target.get(overflow, 0.0)) + excess
    return target


def evaluate_composer(node: dict[str, Any], prices: pd.DataFrame, pos: int) -> dict[str, float]:
    kind = str(node.get("incantation_type") or "").lower()
    if kind == "ticker":
        symbol = str(node.get("symbol") or "").upper().replace(".", "-")
        return {symbol: 1.0} if symbol in prices else {}
    if kind == "ifelse":
        branch = node.get("then_incantation") if composer_condition(node.get("condition") or {}, prices, pos) else node.get("else_incantation")
        return evaluate_composer(branch or {}, prices, pos)
    if kind == "weighted":
        children = node.get("incantations") or []
        mode = str(node.get("type") or "Equal").lower()
        child_ports = [evaluate_composer(c, prices, pos) for c in children]
        if mode == "custom": raw = [float(x) for x in (node.get("weights") or [])]
        elif "inverse" in mode:
            window = int(node.get("inverse_volatility_window") or 20); raw = []
            for port in child_ports:
                vals=[]
                for symbol, weight in port.items(): vals.append(prices[symbol].pct_change().iloc[max(0,pos-window+1):pos+1].std()*weight)
                vol=sum(vals); raw.append(1/vol if vol and not pd.isna(vol) else 0)
        else: raw = [1] * len(children)
        if len(raw) != len(children): raw = [1] * len(children)
        result: dict[str,float] = {}
        for port, weight in zip(child_ports, raw):
            for symbol, child_weight in port.items(): result[symbol] = result.get(symbol,0)+child_weight*weight
        return normalize_weights(result)
    if kind in ("filter","filtered"):
        children=node.get("incantations") or []; sort_spec=node.get("sort_indicator") or {"type":node.get("indicator") or "CumulativeReturn","window":node.get("window") or node.get("sort_window") or 20}
        scored=[]
        for child in children:
            port=evaluate_composer(child,prices,pos)
            if len(port)==1:
                symbol=next(iter(port)); score=indicator(prices[symbol],sort_spec,pos)
                if not pd.isna(score): scored.append((score,port))
        top=not bool(node.get("bottom",False)) if "bottom" in node else str(node.get("select") or node.get("select_fn") or "top").lower()!="bottom"
        count=int(node.get("count") or node.get("select_n") or 1)
        selected=[p for _,p in sorted(scored,key=lambda x:x[0],reverse=top)[:count]]
        result={}
        for port in selected:
            for s,w in port.items():result[s]=result.get(s,0)+w
        return normalize_weights(result)
    return {}


def evaluate_step_condition(node: dict[str, Any], prices: pd.DataFrame, pos: int) -> bool:
    cond = node
    if "lhs-val" not in cond:
        cond = next((c for c in node.get("children",[]) if "lhs-val" in c), {})
    lhs_symbol=str(cond.get("lhs-val") or "").upper().replace(".","-")
    if lhs_symbol not in prices:return False
    lhs_spec={"type":cond.get("lhs-fn","current-price"),**(cond.get("lhs-fn-params") or {})}
    if cond.get("lhs-window-days") is not None:lhs_spec["window-days"]=cond["lhs-window-days"]
    lhs=indicator(prices[lhs_symbol],lhs_spec,pos)
    if cond.get("rhs-fixed-value?",False):rhs=float(cond.get("rhs-val",0))
    else:
        rhs_symbol=str(cond.get("rhs-val") or "").upper().replace(".","-")
        if rhs_symbol not in prices:return False
        rhs_spec={"type":cond.get("rhs-fn","current-price"),**(cond.get("rhs-fn-params") or {})}
        if cond.get("rhs-window-days") is not None:rhs_spec["window-days"]=cond["rhs-window-days"]
        rhs=indicator(prices[rhs_symbol],rhs_spec,pos)
    if pd.isna(lhs) or pd.isna(rhs):return False
    return {"gt":lhs>rhs,"gte":lhs>=rhs,"lt":lhs<rhs,"lte":lhs<=rhs,"eq":lhs==rhs}.get(cond.get("comparator","gt"),False)


def evaluate_step(node: dict[str, Any], prices: pd.DataFrame, pos: int) -> dict[str,float]:
    step=node.get("step")
    children=node.get("children") or []
    if step in ("root","group","if-child"):return evaluate_step(children[0],prices,pos) if children else {}
    if step=="asset":
        symbol=str(node.get("ticker") or "").upper().replace(".","-");return {symbol:1.0} if symbol in prices else {}
    if step=="if":
        truth=evaluate_step_condition(node,prices,pos)
        then=next((c for c in children if not c.get("is-else-condition?",False)),None)
        otherwise=next((c for c in children if c.get("is-else-condition?",False)),children[1] if len(children)>1 else None)
        return evaluate_step((then if truth else otherwise) or {},prices,pos)
    if step in ("wt-cash-equal","wt-cash-specified","wt-inverse-vol"):
        ports=[evaluate_step(c,prices,pos) for c in children]
        if step=="wt-cash-specified":
            raw=[]
            for c in children:
                w=c.get("weight",{});raw.append(float(w.get("num",0))/max(float(w.get("den",1)),1e-12))
        elif step=="wt-inverse-vol":
            window=int(node.get("window-days",20));raw=[]
            for port in ports:
                vol=sum(prices[s].pct_change().iloc[max(0,pos-window+1):pos+1].std()*w for s,w in port.items())
                raw.append(1/vol if vol and not pd.isna(vol) else 0)
        else:raw=[1]*len(children)
        result={}
        for port,w in zip(ports,raw):
            for s,cw in port.items():result[s]=result.get(s,0)+cw*w
        return normalize_weights(result)
    if step=="filter":
        fn=node.get("sort-by-fn","cumulative-return");params=node.get("sort-by-fn-params") or {}
        if node.get("sort-by-window-days") is not None:params["window-days"]=node["sort-by-window-days"]
        scored=[]
        for child in children:
            port=evaluate_step(child,prices,pos)
            if len(port)==1:
                s=next(iter(port));score=indicator(prices[s],{"type":fn,**params},pos)
                if not pd.isna(score):scored.append((score,port))
        reverse=node.get("select-fn","top")=="top"
        selected=[p for _,p in sorted(scored,key=lambda x:x[0],reverse=reverse)[:int(node.get("select-n",1))]]
        result={}
        for port in selected:
            for s,w in port.items():result[s]=result.get(s,0)+w
        return normalize_weights(result)
    return {}


def cache_path(symbol: str, adjusted: bool) -> Path:
    return DATA / f"{symbol.upper()}_{'adjusted' if adjusted else 'trades'}.csv"


def read_cache(symbol: str, adjusted: bool) -> pd.DataFrame:
    path = cache_path(symbol, adjusted)
    if path.exists():
        df = pd.read_csv(path, parse_dates=["date"], index_col="date")
        return df.sort_index()[~df.index.duplicated(keep="last")]
    # model-trade-v11.6.9 的正式底库：调整收盘价宽表；盈透只负责增量更新。
    if adjusted and any(p.exists() for p in REFERENCE_DATABASES):
        global reference_database
        with reference_lock:
            if reference_database is None:
                databases=[]
                for source in REFERENCE_DATABASES:
                    if source.exists():
                        frame=pd.read_csv(source,index_col=0,parse_dates=True)
                        frame.index=pd.to_datetime(frame.index).tz_localize(None).normalize()
                        databases.append(frame.sort_index())
                reference_database=databases[0]
                for frame in databases[1:]:
                    reference_database=reference_database.combine_first(frame)
        lookup = "BRK-B" if symbol == "BRK B" else symbol
        if lookup in reference_database.columns:
            series = reference_database[lookup].dropna().rename("close")
            return series.to_frame()
    return pd.DataFrame()


def download_ibkr(symbol: str, start: pd.Timestamp, end: pd.Timestamp, adjusted: bool) -> pd.DataFrame:
    symbol = normalize_symbol(symbol)
    with ib_lock:
        try: asyncio.get_event_loop()
        except RuntimeError: asyncio.set_event_loop(asyncio.new_event_loop())
        ib = IB()
        try:
            ib.connect(IB_HOST, IB_PORT, clientId=IB_CLIENT, readonly=True, timeout=8)
            # IBKR represents Berkshire class B with a space, while strategy
            # files and CSV databases conventionally use the BRK-B ticker.
            ib_symbol = "BRK B" if symbol in {"BRK-B", "BRK.B"} else symbol
            contract = Stock(ib_symbol, "SMART", "USD")
            qualified = ib.qualifyContracts(contract)
            if not qualified: raise RuntimeError(f"无法识别代码 {symbol}")
            if adjusted:
                # Request only the period that is actually missing.  Asking
                # IBKR for many years when the local database only needs one
                # or two new sessions can time out even with valid permission.
                span_days = max(2, (end.normalize() - start.normalize()).days + 2)
                years = max(1, math.ceil(span_days / 365.25))
                duration = f"{span_days} D" if span_days <= 365 else f"{years} Y"
                bars = ib.reqHistoricalData(
                    contract, endDateTime="", durationStr=duration, barSizeSetting="1 day",
                    whatToShow="ADJUSTED_LAST", useRTH=True, formatDate=1,
                    keepUpToDate=False, timeout=25,
                )
                if not bars: raise RuntimeError(f"盈透未及时返回 {symbol} 的复权历史行情；请求可能超时或该合约无历史行情权限")
                frame = util.df(bars); frame["date"] = pd.to_datetime(frame["date"])
                frame = frame.set_index("date").sort_index()
                # IBKR may expose the still-forming US session as a daily bar.
                # It is not a settled close and must never be cached as one.
                current_us_date = pd.Timestamp(datetime.now(ZoneInfo("America/New_York")).date())
                frame = frame.loc[frame.index.normalize() < current_us_date]
                return frame.loc[start:end]
            chunks, cursor = [], end
            while cursor >= start:
                bars = ib.reqHistoricalData(
                    contract, endDateTime=cursor.to_pydatetime(), durationStr="1 Y",
                    barSizeSetting="1 day", whatToShow="TRADES",
                    useRTH=True, formatDate=1, keepUpToDate=False, timeout=45,
                )
                if not bars: break
                frame = util.df(bars)
                frame["date"] = pd.to_datetime(frame["date"])
                frame = frame.set_index("date")
                chunks.append(frame)
                oldest = frame.index.min()
                if oldest <= start: break
                cursor = oldest - pd.Timedelta(days=1)
                ib.sleep(0.25)
            if not chunks: raise RuntimeError(f"盈透未返回 {symbol} 的历史行情；请检查该品种的历史行情权限")
            return pd.concat(chunks).sort_index().loc[start:end]
        finally:
            if ib.isConnected(): ib.disconnect()


def ensure_data(symbol: str, start: pd.Timestamp, end: pd.Timestamp, adjusted: bool) -> pd.DataFrame:
    symbol = normalize_symbol(symbol)
    cached = read_cache(symbol, adjusted)
    # A late first date can simply be the instrument's real listing date (for
    # example KMLM).  Do not mistake pre-listing history for a cache gap and
    # repeatedly ask IBKR for data that cannot exist.  We only append when the
    # local series does not reach the requested end date.
    needs = cached.empty or cached.index.max().normalize() < end.normalize()
    if needs:
        download_start = start if cached.empty else max(start, cached.index.max().normalize() + pd.Timedelta(days=1))
        if OFFLINE_ONLY:
            if cached.empty:
                raise RuntimeError(f"离线模式（ATLAS_OFFLINE=1）：{symbol} 在本地 data/ 里没有缓存")
            return cached.loc[(cached.index >= start) & (cached.index <= end)]
        try:
            fresh = download_ibkr(symbol, download_start, end, adjusted)
        except Exception as exc:  # noqa: BLE001 - 没有 TWS 时退回本地缓存
            if cached.empty:
                raise RuntimeError(
                    f"{symbol}: 本地没有缓存，且无法从盈透 TWS 取数（{exc}）。"
                    "请打开 TWS 并在 API 设置里启用 7496 端口（只读），"
                    "或者用 ATLAS_OFFLINE=1 只跑本地已有数据。"
                ) from exc
            print(f"[warn] {symbol}: 连接 TWS 失败（{exc}），改用本地缓存至 {cached.index.max().date()}")
            return cached.loc[(cached.index >= start) & (cached.index <= end)]
        cached = pd.concat([cached, fresh]) if not cached.empty else fresh
        cached = cached.sort_index()[~cached.index.duplicated(keep="last")]
        cached.to_csv(cache_path(symbol, adjusted), index_label="date")
    return cached.loc[(cached.index >= start) & (cached.index <= end)]


def metrics(equity: pd.Series, daily: pd.Series, initial_capital: float, start_date: pd.Timestamp) -> dict[str, float]:
    years = max((equity.index[-1] - start_date).days / 365.25, 1 / 365.25)
    cumulative = equity.iloc[-1] / initial_capital - 1
    cagr = (equity.iloc[-1] / initial_capital) ** (1 / years) - 1
    drawdown = equity / equity.cummax() - 1
    vol = daily.std() * math.sqrt(252)
    sharpe = daily.mean() / daily.std() * math.sqrt(252) if daily.std() else 0
    downside = daily[daily < 0].std()
    sortino = daily.mean() / downside * math.sqrt(252) if downside else 0
    return {"cumulative": cumulative, "cagr": cagr, "maxDrawdown": drawdown.min(), "sharpe": sharpe, "sortino": sortino, "winRate": (daily > 0).mean(), "volatility": vol}


def run_backtest(payload: BacktestRequest) -> dict[str, Any]:
    indicator_cache.clear()
    settings = payload.settings
    start = pd.Timestamp(settings.get("start", "2019-01-02"))
    end = pd.Timestamp(settings.get("end", datetime.now().date().isoformat()))
    benchmark = normalize_symbol(settings.get("benchmark", "SPY"))
    definition = payload.strategy.get("definition")
    # Support pre-computed daily weights exported from research platform.
    weights_df = None
    if payload.strategy.get("schema") == "daily_weights":
        csv_path = Path(payload.strategy.get("weights_csv"))
        if not csv_path.exists():
            raise ValueError(f"weights_csv not found: {csv_path}")
        weights_df = pd.read_csv(csv_path, index_col=0, parse_dates=True)
        weights_df.columns = [normalize_symbol(c) for c in weights_df.columns]
        assets = []
        definition_symbols = set(weights_df.columns)
    else:
        assets = symbols_from_nodes(payload.strategy.get("nodes", []))
        definition_symbols = symbols_from_definition(definition) if definition else set()
    if not assets and not definition_symbols: raise ValueError("策略树中没有可回测的美股代码")
    symbols = sorted({normalize_symbol(s) for s in [s for s, _ in assets] + list(definition_symbols) + [benchmark, "QQQ"]})
    adjusted = bool(settings.get("reinvestDividends", True))
    # QuantMage EMA values are recursive and therefore depend on the complete
    # available history, not only a fixed rolling warm-up window.  The
    # reference runs feed the engine the full price matrix from 2000 onward.
    data_start = pd.Timestamp("2000-01-01") if adjusted else start - pd.Timedelta(days=420)
    frames = {s: ensure_data(s, data_start, end, adjusted) for s in symbols}
    # Keep the full union calendar.  Dropping rows where a late-listed ETF is
    # still NaN would also erase valid long preheat history for SPY/QQQ and
    # change 200-day indicators.  The native engine rejects a missing price
    # only when that asset is actually selected.
    closes = pd.concat({s: f["close"] for s, f in frames.items()}, axis=1).sort_index().ffill()
    if not closes.columns.is_unique:
        raise ValueError("行情代码归一化后存在重复列，请检查股票代码映射")
    if len(closes) < 20: raise ValueError("有效重叠交易日不足 20 天")
    returns_all = closes.pct_change().fillna(0)
    test_dates = closes.index[(closes.index >= start) & (closes.index <= end) & closes[benchmark].notna()]
    if len(test_dates) < 20: raise ValueError("回测区间有效交易日不足 20 天")
    frequency = settings.get("frequency", "每月")
    signal_dates = test_dates[:-1]
    if frequency == "每日": rebalance_dates = set(signal_dates)
    else:
        grouping = signal_dates.to_period("Q" if frequency == "每季度" else "M")
        rebalance_dates = set(pd.Series(signal_dates,index=signal_dates).groupby(grouping).head(1).index)
    slip = float(settings.get("slippage", 0)) / 10000
    portfolio_returns, trades, allocation_history = [], [], []
    active = pd.Series(dict(assets),dtype=float) if assets else pd.Series(dtype=float)
    active = active / active.sum() if active.sum() else active
    native_engine = QuantMageEngine(definition, closes) if (definition and definition.get("incantation_type") and weights_df is None) else None
    result_dates = []
    last_target = active.copy()
    for date, next_date in zip(signal_dates, test_dates[1:]):
        cost = 0
        if date in rebalance_dates:
            if weights_df is not None:
                if date in weights_df.index:
                    target = weights_df.loc[date].dropna().astype(float)
                else:
                    target = last_target.copy()
            else:
                pos = closes.index.get_loc(date)
                if native_engine: target_dict = dict(native_engine.evaluate(id(definition), pos))
                elif definition and definition.get("step"): target_dict = evaluate_step(definition, closes, max(0,pos-1))
                else: target_dict = dict(active)
            target = pd.Series(target_dict,dtype=float)
            target = apply_risk_caps(target, settings)
            if not target.empty:
                target = target / target.sum()
                turnover = float((target.reindex(active.index.union(target.index),fill_value=0)-active.reindex(active.index.union(target.index),fill_value=0)).abs().sum())
                cost = slip * turnover
                active = target.copy()
                last_target = target.copy()
                allocation_history.append({"date":date.strftime("%Y-%m-%d"),"weights":{s:round(float(w),6) for s,w in active.items()}})
                for sym, weight in active.items():
                    trades.append({"date": date.strftime("%Y-%m-%d"), "symbol": sym, "side": "调仓", "price": round(float(closes.loc[date, sym]), 2), "weight": round(weight * 100, 2), "status": "已成交"})
        row = returns_all.loc[next_date]
        gross = float(sum(row.get(sym,0)*weight for sym,weight in active.items())) if not active.empty else 0
        portfolio_returns.append(gross-cost)
        result_dates.append(next_date)
        # Between closes, holdings drift with individual asset returns.  The
        # next rebalance turnover must compare its target with these drifted
        # weights, matching the reference simulator exactly.
        if not active.empty and 1 + gross != 0:
            active = pd.Series({sym: weight*(1+float(row.get(sym,0)))/(1+gross) for sym,weight in active.items()})
            # Apply the same limits after daily mark-to-market drift so a
            # leveraged sleeve cannot exceed its cap between rebalance dates.
            active = apply_risk_caps(active, settings)
            if active.sum() > 0:
                active = active / active.sum()
    allocation_date = signal_dates[-1]
    if frequency == "每日" and len(test_dates):
        # The newest close has no following-day return yet, but it still has a
        # valid allocation signal that should be shown to the user.
        allocation_date = test_dates[-1]
        if weights_df is not None:
            if allocation_date in weights_df.index:
                latest = weights_df.loc[allocation_date].dropna().astype(float)
            else:
                latest = last_target.copy()
        else:
            latest_pos = closes.index.get_loc(allocation_date)
            if native_engine:
                latest = pd.Series(dict(native_engine.evaluate(id(definition), latest_pos)), dtype=float)
            elif definition and definition.get("step"):
                latest = pd.Series(evaluate_step(definition, closes, latest_pos), dtype=float)
            else:
                latest = last_target.copy()
        if not latest.empty and latest.sum() > 0:
            last_target = latest / latest.sum()
            # The latest close can produce a valid target even though there is
            # no following session whose return can be calculated yet.  Keep
            # that target in the holdings table as well as the summary cards.
            latest_history_row = {
                "date": allocation_date.strftime("%Y-%m-%d"),
                "weights": {s: round(float(w), 6) for s, w in last_target.items()},
            }
            if allocation_history and allocation_history[-1]["date"] == latest_history_row["date"]:
                allocation_history[-1] = latest_history_row
            else:
                allocation_history.append(latest_history_row)
    daily = pd.Series(portfolio_returns, index=pd.DatetimeIndex(result_dates))
    capital = float(settings.get("capital", 100000))
    equity = capital * (1 + daily).cumprod()
    qqq_daily = closes['QQQ'].pct_change().fillna(0).reindex(test_dates)
    qqq_equity = capital * (1 + qqq_daily).cumprod()
    bench_daily = closes[benchmark].pct_change().fillna(0).reindex(test_dates)
    bench_equity = capital * (1 + bench_daily).cumprod()
    annual = pd.DataFrame({"strategy": daily, "benchmark": bench_daily}).add(1).resample("YE").prod().sub(1)
    annual_rows = []
    for year_end, row in annual.iterrows():
        year_daily = daily[daily.index.year == year_end.year].dropna()
        # Each calendar year starts from a fresh 1.0 baseline.  Prepending the
        # baseline is important: otherwise a loss on the first session of the
        # year can never be measured as drawdown.
        wealth = np.r_[1.0, (1.0 + year_daily).cumprod().to_numpy(dtype=float)]
        peaks = np.maximum.accumulate(wealth)
        year_max_drawdown = float(np.min(wealth / peaks - 1.0)) if len(year_daily) else 0.0
        year_win_rate = float((year_daily > 0).mean()) if len(year_daily) else 0.0
        annual_rows.append({
            "year": str(year_end.year),
            "strategy": float(row.strategy),
            "benchmark": float(row.benchmark),
            "excess": float(row.strategy - row.benchmark),
            "maxDrawdown": year_max_drawdown,
            "winRate": year_win_rate,
        })
    m = metrics(equity, daily, capital, test_dates[0])
    return {
        "source": ("model-trade 历史底库 + IBKR ADJUSTED_LAST 增量" if adjusted else "Interactive Brokers TWS · TRADES 日线"),
        "initialCapital": capital,
        "symbols": symbols,
        "dates": [d.strftime("%Y-%m-%d") for d in equity.index],
        "equity": [round(x, 2) for x in equity],
        "benchmarkEquity": [round(x, 2) for x in bench_equity.reindex(equity.index).ffill()],
        "qqqEquity": [round(x, 2) for x in qqq_equity.reindex(equity.index).ffill()],
        "metrics": m,
        "annual": annual_rows,
        "allocations": [{"symbol": s, "weight": float(w)} for s, w in last_target.items()],
        "allocationDate": allocation_date.strftime("%Y-%m-%d"),
        "allocationHistory": allocation_history,
        "trades": trades[-200:],
        "tradingDays": len(equity),
    }


def cache_latest_date() -> str | None:
    """没有宽表底库时，从单标的缓存里读最新交易日（只读文件尾部，很快）。"""
    for name in ("SPY", "QQQ", "BIL", "GLD", "AAPL"):
        path = DATA / f"{name}_adjusted.csv"
        if not path.exists():
            continue
        try:
            with path.open("rb") as handle:
                handle.seek(0, 2)
                handle.seek(max(0, handle.tell() - 200))
                last = handle.read().decode("utf-8", "replace").strip().splitlines()[-1]
            return str(pd.to_datetime(last.split(",")[0]).date())
        except (OSError, IndexError, ValueError):
            continue
    return None


@app.get("/api/status")
def status():
    import socket
    sock = socket.socket(); sock.settimeout(.5)
    connected = sock.connect_ex((IB_HOST, IB_PORT)) == 0; sock.close()
    latest_dates=[]
    for source in REFERENCE_DATABASES:
        if source.exists():
            try: latest_dates.append(str(pd.to_datetime(pd.read_csv(source, usecols=[0]).iloc[-1, 0]).date()))
            except (ValueError, IndexError): pass
    latest = max(latest_dates) if latest_dates else cache_latest_date()
    return {"ibkrConnected": connected, "port": IB_PORT, "latestDataDate": latest, "offlineOnly": OFFLINE_ONLY, "referenceDatabases": [str(p) for p in REFERENCE_DATABASES if p.exists()], "cachedSymbols": [p.stem for p in DATA.glob("*.csv")]}


def strategy_path(strategy_id: str) -> Path:
    try:
        clean = str(uuid.UUID(strategy_id))
    except ValueError:
        raise HTTPException(status_code=400, detail="策略 ID 无效")
    return STRATEGY_LIBRARY / f"{clean}.json"


@app.get("/api/strategies")
def list_strategies():
    rows = []
    for file in STRATEGY_LIBRARY.glob("*.json"):
        try:
            item = json.loads(file.read_text(encoding="utf-8"))
            rows.append({"id": item["id"], "name": item.get("name", "未命名策略"),
                         "updatedAt": item.get("updatedAt", ""), "createdAt": item.get("createdAt", ""),
                         "size": file.stat().st_size})
        except (OSError, ValueError, KeyError):
            continue
    return sorted(rows, key=lambda row: row["updatedAt"], reverse=True)


@app.get("/api/strategies/{strategy_id}")
def get_strategy(strategy_id: str):
    file = strategy_path(strategy_id)
    if not file.exists(): raise HTTPException(status_code=404, detail="策略不存在")
    return json.loads(file.read_text(encoding="utf-8"))


@app.post("/api/strategies")
def create_strategy(document: dict[str, Any]):
    strategy_id = str(uuid.uuid4()); now = datetime.now().isoformat(timespec="seconds")
    item = {**document, "id": strategy_id, "createdAt": now, "updatedAt": now}
    file = strategy_path(strategy_id); temp = file.with_suffix(".tmp")
    temp.write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8"); temp.replace(file)
    return item


@app.put("/api/strategies/{strategy_id}")
def update_strategy(strategy_id: str, document: dict[str, Any]):
    file = strategy_path(strategy_id)
    if not file.exists(): raise HTTPException(status_code=404, detail="策略不存在")
    old = json.loads(file.read_text(encoding="utf-8")); now = datetime.now().isoformat(timespec="seconds")
    item = {**old, **document, "id": strategy_id, "createdAt": old.get("createdAt", now), "updatedAt": now}
    temp = file.with_suffix(".tmp"); temp.write_text(json.dumps(item, ensure_ascii=False), encoding="utf-8"); temp.replace(file)
    return item


@app.delete("/api/strategies/{strategy_id}")
def delete_strategy(strategy_id: str):
    file = strategy_path(strategy_id)
    if not file.exists(): raise HTTPException(status_code=404, detail="策略不存在")
    file.unlink(); return {"deleted": True, "id": strategy_id}


@app.post("/api/backtest")
def backtest(payload: BacktestRequest):
    try: return run_backtest(payload)
    except Exception as exc:
        (ROOT / "backtest_error.log").write_text(traceback.format_exc(), encoding="utf-8")
        raise HTTPException(status_code=400, detail=str(exc))


@app.post("/api/export-allocations")
def export_allocations(payload: dict[str, Any]):
    from io import BytesIO
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    history = payload.get("allocationHistory") or []
    if not history:
        raise HTTPException(status_code=400, detail="没有可导出的持仓历史，请先运行回测")
    symbols = sorted({symbol for row in history for symbol in (row.get("weights") or {})})
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = "每日调仓权重"
    sheet.append(["日期", *symbols, "权重合计"])
    for row in sorted(history, key=lambda item: item.get("date", ""), reverse=True):
        weights = row.get("weights") or {}
        values = [float(weights.get(symbol, 0) or 0) for symbol in symbols]
        sheet.append([row.get("date", ""), *values, round(sum(values), 10)])
    header_fill = PatternFill("solid", fgColor="17365D")
    for cell in sheet[1]:
        cell.fill = header_fill
        cell.font = Font(color="FFFFFF", bold=True)
        cell.alignment = Alignment(horizontal="center")
    for column in range(2, len(symbols) + 3):
        for row in range(2, sheet.max_row + 1):
            sheet.cell(row=row, column=column).number_format = "0.00%"
        sheet.column_dimensions[get_column_letter(column)].width = 11
    total_column = len(symbols) + 2
    sheet.column_dimensions[get_column_letter(total_column)].width = 13
    for row in range(2, sheet.max_row + 1):
        sheet.cell(row=row, column=total_column).font = Font(bold=True, color="1F4E78")
    sheet.column_dimensions["A"].width = 14
    sheet.freeze_panes = "B2"
    sheet.auto_filter.ref = sheet.dimensions
    sheet.sheet_view.showGridLines = False
    info = workbook.create_sheet("说明")
    info.append(["策略名称", str(payload.get("strategyName") or "未命名策略")])
    info.append(["导出时间", datetime.now().strftime("%Y-%m-%d %H:%M:%S")])
    info.append(["记录数量", len(history)])
    info.append(["权重格式", "Excel 百分比；空仓按 0% 导出"])
    output = BytesIO()
    workbook.save(output)
    output.seek(0)
    headers = {"Content-Disposition": 'attachment; filename="daily-allocation-weights.xlsx"'}
    return StreamingResponse(output, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", headers=headers)


@app.get("/")
def root(): return FileResponse(ROOT / "index.html")

app.mount("/", StaticFiles(directory=ROOT), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8766)



