"""Hidden acceptance tests for lg-seq-ledger (authored, D61 slice 17)."""


class TestLedgerParse:
    def test_parse(self):
        from more_itertools import lg_ledger_parse
        got = lg_ledger_parse.parse_entries("2026-01-02,cash,10.50\n\n2026-01-02,rent,-10.5\n2026-01-03,x,7")
        assert got == [("2026-01-02", "cash", 1050), ("2026-01-02", "rent", -1050), ("2026-01-03", "x", 700)]

    def test_exact_cents(self):
        from more_itertools import lg_ledger_parse
        assert lg_ledger_parse.parse_entries("2026-01-01,a,0.29")[0][2] == 29
        assert lg_ledger_parse.parse_entries("2026-01-01,a,-0.07")[0][2] == -7

    def test_errors(self):
        from more_itertools import lg_ledger_parse
        import pytest
        for bad in ("2026-1-1,a,1", "2026-01-01,a", "2026-01-01,,1", "2026-01-01,a,1.234", "2026-01-01,a,x"):
            with pytest.raises(ValueError):
                lg_ledger_parse.parse_entries(bad)

class TestLedgerBal:
    def test_sum(self):
        from more_itertools import lg_ledger_bal
        e = [("2026-01-01", "a", 100), ("2026-01-02", "b", -100), ("2026-01-03", "a", 50)]
        assert lg_ledger_bal.balances(e) == {"a": 150, "b": -100}

    def test_zero_kept_and_empty(self):
        from more_itertools import lg_ledger_bal
        assert lg_ledger_bal.balances([("d", "a", 5), ("d", "a", -5)]) == {"a": 0}
        assert lg_ledger_bal.balances([]) == {}

    def test_from_parser(self):
        from more_itertools import lg_ledger_bal, lg_ledger_parse
        e = lg_ledger_parse.parse_entries("2026-01-01,a,1.10\n2026-01-01,a,2.20")
        assert lg_ledger_bal.balances(e) == {"a": 330}

class TestLedgerReport:
    def test_report(self):
        from more_itertools import lg_ledger_report
        assert lg_ledger_report.report({"b": -1050, "a": 5}) == ["a: 0.05", "b: -10.50", "total: -10.45"]

    def test_empty_and_negative_small(self):
        from more_itertools import lg_ledger_report
        assert lg_ledger_report.report({}) == ["total: 0.00"]
        assert lg_ledger_report.report({"a": -5}) == ["a: -0.05", "total: -0.05"]

    def test_pipeline(self):
        from more_itertools import lg_ledger_bal, lg_ledger_parse, lg_ledger_report
        b = lg_ledger_bal.balances(lg_ledger_parse.parse_entries("2026-01-01,x,3\n2026-01-01,y,-3"))
        assert lg_ledger_report.report(b) == ["x: 3.00", "y: -3.00", "total: 0.00"]

class TestLedgerCli:
    def test_run(self):
        from more_itertools import lg_ledger_cli
        text = "2026-01-01,cash,10.00\n2026-01-01,rent,-10.00\n"
        assert lg_ledger_cli.run(text) == "cash: 10.00\nrent: -10.00\ntotal: 0.00\n"

    def test_unbalanced(self):
        from more_itertools import lg_ledger_cli
        import pytest
        with pytest.raises(ValueError, match="unbalanced"):
            lg_ledger_cli.run("2026-01-01,a,1.00")
        assert lg_ledger_cli.run("2026-01-01,a,1.00", require_balanced=False).endswith("total: 1.00\n")

    def test_uses_earlier_stages(self):
        from more_itertools import lg_ledger_cli, lg_ledger_report
        orig = lg_ledger_report.report
        lg_ledger_report.report = lambda bal: ["sentinel"]
        try:
            assert lg_ledger_cli.run("2026-01-01,a,1\n2026-01-01,b,-1") == "sentinel\n"
        finally:
            lg_ledger_report.report = orig
