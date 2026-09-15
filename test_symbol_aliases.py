"""Offline regressions for mixed BRK.B/BRK-B aliases in imported strategies."""
import copy
import unittest
from unittest.mock import patch

import numpy as np
import pandas as pd

import server


class SymbolAliasTests(unittest.TestCase):
    def test_aliases_normalize(self):
        for symbol in ("BRK.B", "BRK-B", "brk b", " BRK.B "):
            self.assertEqual(server.normalize_symbol(symbol), "BRK-B")

    def test_visual_weights_merge_without_loss(self):
        nodes = [{"title": "BRK.B · stock", "meta": "30%"},
                 {"title": "BRK-B · stock", "meta": "70%"}]
        self.assertEqual(server.symbols_from_nodes(nodes), [("BRK-B", 1.0)])

    def test_mixed_alias_backtest_equals_canonical(self):
        definition = {"incantation_type": "Weighted", "type": "Custom",
                      "weights": [0.3, 0.7], "incantations": [
                          {"incantation_type": "Ticker", "symbol": "BRK.B"},
                          {"incantation_type": "Ticker", "symbol": "BRK-B"}]}
        strategy = {"nodes": [{"title": "BRK.B · stock", "meta": "100%"}],
                    "definition": definition}
        dates = pd.bdate_range("2025-01-01", periods=90)
        prices = 100 * np.cumprod(1 + 0.002 + 0.004 * np.sin(np.arange(90)))
        frame = pd.DataFrame({"close": prices}, index=dates)
        settings = {"start": str(dates[0].date()), "end": str(dates[-1].date()),
                    "frequency": "每日", "reinvestDividends": True, "slippage": 10}
        with patch.object(server, "ensure_data", return_value=frame) as fetch:
            mixed = server.run_backtest(server.BacktestRequest(strategy=strategy, settings=settings))
            self.assertEqual([call.args[0] for call in fetch.call_args_list], ["BRK-B", "SPY"])
        canonical = copy.deepcopy(strategy)
        canonical["definition"]["incantations"][0]["symbol"] = "BRK-B"
        canonical["nodes"][0]["title"] = "BRK-B · stock"
        with patch.object(server, "ensure_data", return_value=frame):
            expected = server.run_backtest(server.BacktestRequest(strategy=canonical, settings=settings))
        self.assertEqual(mixed["equity"], expected["equity"])
        self.assertEqual(mixed["allocationHistory"], expected["allocationHistory"])
        self.assertEqual(mixed["symbols"], ["BRK-B", "SPY"])


if __name__ == "__main__":
    unittest.main()
