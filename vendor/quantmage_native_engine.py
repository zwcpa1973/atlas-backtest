"""Native evaluator for QuantMage/Composer-style incantation JSON.

This module is deliberately broker-independent.  It only converts a raw strategy tree
and a daily price matrix into current target weights.  Evaluation errors are fatal so
the caller can abort trading instead of confusing a failure with an intentional exit.
"""
from collections import defaultdict
from functools import lru_cache

import numpy as np
import pandas as pd


class QuantMageEvaluationError(RuntimeError):
    pass


def _walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def _symbol(value):
    return value.upper().replace(".", "-")


def _rsi(prices, window):
    delta = prices.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1/window, adjust=False, min_periods=window).mean()
    avg_loss = loss.ewm(alpha=1/window, adjust=False, min_periods=window).mean()
    rs = avg_gain / avg_loss
    result = 100 - 100 / (1 + rs)
    result[(avg_loss == 0) & (avg_gain > 0)] = 100
    result[(avg_loss == 0) & (avg_gain == 0)] = 50
    return result


def _drawdown_magnitude(values):
    array = np.asarray(values, dtype=float)
    if len(array) < 2 or not np.isfinite(array).all():
        return np.nan
    return float(-np.min(array / np.maximum.accumulate(array) - 1) * 100)


class QuantMageEngine:
    def __init__(self, root, prices, logger=None):
        if not isinstance(root, dict) or "incantation_type" not in root:
            raise QuantMageEvaluationError("找不到 QuantMage incantation 根节点")
        self.root = root
        self.logger = logger
        self.prices = prices.copy().sort_index()
        self.prices.columns = [_symbol(str(column)) for column in self.prices.columns]
        self.returns = self.prices.pct_change(fill_method=None)
        self.nodes = {id(node): node for node in _walk(root)
                      if isinstance(node, dict) and "incantation_type" in node}
        self._indicator_cache = {}
        self.evaluate = lru_cache(maxsize=750000)(self._evaluate)
        self.portfolio_volatility = lru_cache(maxsize=250000)(self._portfolio_volatility)
        self.composite_score = lru_cache(maxsize=100000)(self._composite_score)

    def _series(self, symbol):
        symbol = _symbol(symbol)
        if symbol not in self.prices.columns:
            raise QuantMageEvaluationError(f"行情中缺少标的 {symbol}")
        return self.prices[symbol]

    def indicator(self, symbol, spec, index):
        symbol = _symbol(symbol)
        kind = spec["type"]
        window = int(spec.get("window", 0))
        key = (symbol, kind, window)
        if key not in self._indicator_cache:
            price = self._series(symbol)
            if kind == "CurrentPrice": result = price
            elif kind == "RelativeStrengthIndex": result = _rsi(price, window)
            elif kind == "CumulativeReturn": result = price.pct_change(window, fill_method=None) * 100
            elif kind == "MovingAverage": result = price.rolling(window).mean()
            elif kind == "ExponentialMovingAverage": result = price.ewm(span=window, adjust=False).mean()
            elif kind == "MovingAverageOfReturns":
                result = price.pct_change(fill_method=None).rolling(window).mean() * 100
            elif kind == "MaxDrawdown":
                result = price.rolling(window).apply(_drawdown_magnitude, raw=True)
            else:
                raise QuantMageEvaluationError(f"不支持的指标类型: {kind}")
            self._indicator_cache[key] = result.to_numpy()
        if index < 0 or index >= len(self.prices):
            raise QuantMageEvaluationError(f"指标 {symbol}/{kind} 日期索引越界")
        value = self._indicator_cache[key][index]
        if not np.isfinite(value):
            raise QuantMageEvaluationError(
                f"指标数据不足: {symbol} {kind}({window}), 日期={self.prices.index[index]}"
            )
        return float(value)

    def condition(self, node, index):
        if node.get("condition_type") != "SingleCondition":
            raise QuantMageEvaluationError(f"不支持的条件类型: {node.get('condition_type')}")
        for ago in range(max(1, int(node.get("for_days", 1)))):
            lhs_index = index - ago - int(node.get("lh_days_ago", 0))
            lhs = self.indicator(node["lh_ticker_symbol"], node["lh_indicator"], lhs_index)
            if node.get("type") == "IndicatorAndNumber":
                rhs = float(node["rh_value"])
            else:
                rhs_index = index - ago - int(node.get("rh_days_ago", 0))
                rhs = self.indicator(node["rh_ticker_symbol"], node["rh_indicator"], rhs_index)
            rhs = rhs * float(node.get("rh_weight", 1)) + float(node.get("rh_bias", 0))
            if not (lhs > rhs if node["greater_than"] else lhs < rhs):
                return False
        return True

    def _one_day_portfolio_return(self, node_id, index):
        if index < 0 or index + 1 >= len(self.prices):
            raise QuantMageEvaluationError("子策略收益率日期索引越界")
        portfolio = self.evaluate(node_id, index)
        value = 0.0
        for symbol, weight in portfolio:
            daily_return = self.returns[symbol].iloc[index + 1]
            if not np.isfinite(daily_return):
                raise QuantMageEvaluationError(
                    f"{symbol} 在 {self.prices.index[index + 1]} 缺少收益率"
                )
            # Correct formula: sum(weight * individual asset return).  Never sum
            # price levels, which biases a sub-strategy toward high-priced assets.
            value += weight * float(daily_return)
        return value

    def _portfolio_volatility(self, node_id, index, window):
        if index < window:
            raise QuantMageEvaluationError(f"逆波动率需要至少 {window + 1} 个交易日")
        returns = [self._one_day_portfolio_return(node_id, day)
                   for day in range(index-window, index)]
        volatility = float(np.std(returns, ddof=1))
        return volatility if np.isfinite(volatility) and volatility > 1e-12 else np.nan

    def _composite_score(self, node_id, index, kind, window):
        preheat = 100 if kind == "RelativeStrengthIndex" else 0
        length = window + preheat
        if index < length:
            raise QuantMageEvaluationError(f"子策略 {kind} 指标历史数据不足")
        returns = [self._one_day_portfolio_return(node_id, day)
                   for day in range(index-length, index)]
        equity = pd.Series(np.cumprod(np.r_[1.0, 1.0 + np.asarray(returns)]))
        if kind == "RelativeStrengthIndex": value = _rsi(equity, window).iloc[-1]
        elif kind == "CumulativeReturn": value = equity.pct_change(window).iloc[-1] * 100
        elif kind == "MaxDrawdown": value = _drawdown_magnitude(equity.iloc[-(window+1):])
        else: raise QuantMageEvaluationError(f"不支持的子策略筛选指标: {kind}")
        if not np.isfinite(value):
            raise QuantMageEvaluationError(f"无法计算子策略 {kind}({window})")
        return float(value)

    def _evaluate(self, node_id, index):
        node = self.nodes[node_id]
        kind = node["incantation_type"]
        if kind == "Ticker":
            symbol = _symbol(node["symbol"])
            price = self._series(symbol).iloc[index]
            if not np.isfinite(price):
                raise QuantMageEvaluationError(f"{symbol} 当前价格无效")
            return ((symbol, 1.0),)
        if kind == "IfElse":
            child = node["then_incantation"] if self.condition(node["condition"], index) \
                else node["else_incantation"]
            return self.evaluate(id(child), index)

        children = node.get("incantations", [])
        if not children:
            raise QuantMageEvaluationError(f"{kind} 节点没有子节点")

        if kind == "Weighted":
            weighting = node.get("type")
            if weighting == "Equal":
                weights = np.ones(len(children), dtype=float)
            elif weighting == "Custom":
                weights = np.asarray(node.get("weights", []), dtype=float)
                if len(weights) != len(children):
                    raise QuantMageEvaluationError("Custom 权重数量与子节点数量不一致")
            elif weighting == "InverseVolatility":
                window = int(node.get("inverse_volatility_window", 20))
                volatilities = np.asarray([
                    self.portfolio_volatility(id(child), index, window) for child in children
                ])
                weights = np.where(np.isfinite(volatilities), 1.0 / volatilities, 0.0)
                if weights.sum() <= 0:
                    raise QuantMageEvaluationError("逆波动率节点的所有子策略波动率均无效")
            else:
                raise QuantMageEvaluationError(f"不支持的加权类型: {weighting}")
        elif kind == "Filtered":
            spec = node["sort_indicator"]
            scored = []
            for child in children:
                try:
                    if child.get("incantation_type") == "Ticker":
                        score = self.indicator(child["symbol"], spec, index)
                    else:
                        score = self.composite_score(
                            id(child), index, spec["type"], int(spec["window"])
                        )
                    scored.append((score, child))
                except QuantMageEvaluationError as exc:
                    if self.logger:
                        self.logger.warning(f"筛选候选被排除: {exc}")
            if not scored:
                raise QuantMageEvaluationError("筛选节点没有任何可用候选")
            selected = sorted(scored, key=lambda item: item[0],
                              reverse=not bool(node.get("bottom", False)))[:int(node["count"])]
            children = [item[1] for item in selected]
            weights = np.ones(len(children), dtype=float)
        else:
            raise QuantMageEvaluationError(f"不支持的策略节点: {kind}")

        if not np.isfinite(weights).all() or (weights < 0).any() or weights.sum() <= 0:
            raise QuantMageEvaluationError(f"{kind} 节点产生无效权重")
        weights = weights / weights.sum()
        portfolio = defaultdict(float)
        for child, parent_weight in zip(children, weights):
            for symbol, child_weight in self.evaluate(id(child), index):
                portfolio[symbol] += float(parent_weight) * child_weight
        if not portfolio:
            raise QuantMageEvaluationError(f"{kind} 节点产生空组合")
        return tuple(sorted(portfolio.items()))

    def current_portfolio(self):
        if len(self.prices) < 2:
            raise QuantMageEvaluationError("行情数据少于两个交易日")
        result = dict(self.evaluate(id(self.root), len(self.prices)-1))
        total = sum(result.values())
        if not result or not np.isfinite(total) or total <= 0:
            raise QuantMageEvaluationError("最终投资组合为空或权重无效")
        result = {symbol: weight/total for symbol, weight in result.items()}
        if abs(sum(result.values())-1) > 1e-8 or any(weight < 0 for weight in result.values()):
            raise QuantMageEvaluationError("最终投资组合未能正确归一化")
        return result


def evaluate_quantmage_strategy(strategy_json, data_df, logger=None):
    root = strategy_json.get("incantation") if isinstance(strategy_json, dict) else None
    engine = QuantMageEngine(root, data_df, logger=logger)
    return engine.current_portfolio()
