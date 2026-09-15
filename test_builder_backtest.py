"""Exercise the actual UI model output through the offline backtest engine."""
import json
import subprocess
import unittest
from unittest.mock import patch
import numpy as np
import pandas as pd
import server


class BuilderBacktestTests(unittest.TestCase):
    def test_generated_branch_changes_actual_holdings(self):
        definition=json.loads(subprocess.check_output(['node','test_builder_model.cjs','--fixture'],text=True))
        dates=pd.bdate_range('2024-01-01',periods=300)
        values=np.r_[np.linspace(100,180,240),np.linspace(175,70,60)]
        frame=pd.DataFrame({'close':values},index=dates)
        request=server.BacktestRequest(strategy={'definition':definition,'nodes':[]},settings={'start':str(dates[210].date()),'end':str(dates[-1].date()),'frequency':'每日','slippage':0,'benchmark':'SPY','reinvestDividends':True})
        with patch.object(server,'ensure_data',return_value=frame):
            result=server.run_backtest(request)
        weights=[r['weights'] for r in result['allocationHistory']]
        self.assertTrue(any(w.get('BIL',0)>0 for w in weights))
        self.assertTrue(any(w.get('QQQ',0)>0 for w in weights))
        for w in weights:
            self.assertAlmostEqual(sum(w.values()),1,places=6)
        self.assertGreater(len(result['equity']),50)


if __name__=='__main__':unittest.main()
