"""Backtest-only extensions; never modify the shared live-trading engine."""
import numpy as np
from quantmage_native_engine import QuantMageEngine as BaseEngine, QuantMageEvaluationError


class QuantMageEngine(BaseEngine):
    def indicator(self, symbol, spec, index):
        if spec.get('type') != 'Volatility':
            return super().indicator(symbol, spec, index)
        window = int(spec.get('window', 0))
        if window < 2:
            raise QuantMageEvaluationError('Volatility 周期至少为 2 个交易日')
        symbol = symbol.upper().replace('.', '-')
        key = (symbol, 'Volatility', window)
        if key not in self._indicator_cache:
            # Daily simple returns, sample standard deviation, percentage points.
            # Matches the existing inverse-volatility ddof=1 convention; not annualized.
            self._indicator_cache[key] = (self._series(symbol).pct_change(fill_method=None)
                .rolling(window, min_periods=window).std(ddof=1) * 100).to_numpy()
        if index < 0 or index >= len(self.prices):
            raise QuantMageEvaluationError(f'指标 {symbol}/Volatility 日期索引越界')
        value = self._indicator_cache[key][index]
        if not np.isfinite(value):
            raise QuantMageEvaluationError(f'指标数据不足: {symbol} Volatility({window}), 日期={self.prices.index[index]}')
        return float(value)
