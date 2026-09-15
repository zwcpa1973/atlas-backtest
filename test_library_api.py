import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import server


class LibraryTests(unittest.TestCase):
    def test_crud_preserves_definition(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(server,'STRATEGY_LIBRARY',Path(temp)):
            document={'name':'测试策略','strategy':{'definition':{'incantation_type':'Ticker','symbol':'SPY'}}}
            saved=server.create_strategy(document)
            self.assertEqual(len(server.list_strategies()),1)
            server.update_strategy(saved['id'],{'name':'新名称'})
            self.assertEqual(server.get_strategy(saved['id'])['strategy'],document['strategy'])
            self.assertEqual(server.list_strategies()[0]['name'],'新名称')
            second=server.create_strategy(document)
            self.assertNotEqual(second['id'],saved['id'])
            server.delete_strategy(second['id'])
            self.assertEqual(len(server.list_strategies()),1)

if __name__=='__main__':unittest.main()
