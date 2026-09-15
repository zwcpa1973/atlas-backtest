import unittest
import numpy as np
import pandas as pd
import server


class VolatilityTests(unittest.TestCase):
    def test_values_and_condition(self):
        prices=pd.DataFrame({'SPY':[100,110,99,108.9,108.9],'BIL':[100]*5})
        root={'incantation_type':'Ticker','symbol':'SPY'}
        engine=server.QuantMageEngine(root,prices)
        spec={'type':'Volatility','window':3}
        self.assertAlmostEqual(engine.indicator('SPY',spec,3),np.std([.1,-.1,.1],ddof=1)*100)
        self.assertEqual(engine.indicator('BIL',spec,3),0)
        with self.assertRaises(server.QuantMageEvaluationError):engine.indicator('SPY',spec,2)
        with self.assertRaises(server.QuantMageEvaluationError):engine.indicator('SPY',{'type':'Volatility','window':1},3)
        c={'condition_type':'SingleCondition','type':'IndicatorAndNumber','lh_ticker_symbol':'SPY','lh_indicator':spec,'rh_value':5,'greater_than':True}
        self.assertTrue(engine.condition(c,3))
        self.assertEqual(engine.indicator('SPY',{'type':'CurrentPrice'},3),108.9)

if __name__=='__main__':unittest.main()
