"""Hidden acceptance tests for lg-seq-calc (authored, D61 slice 17)."""


class TestTok:
    def test_tokens(self):
        from more_itertools import lg_tok
        assert lg_tok.tokenize("1 + 2.5*(3)") == [1, "+", 2.5, "*", "(", 3, ")"]

    def test_empty_and_error(self):
        from more_itertools import lg_tok
        import pytest
        assert lg_tok.tokenize("  ") == []
        with pytest.raises(ValueError):
            lg_tok.tokenize("1 $ 2")

class TestParse:
    def test_precedence(self):
        from more_itertools import lg_parse
        assert lg_parse.parse([1, "+", 2, "*", 3]) == ("+", 1, ("*", 2, 3))

    def test_left_assoc_and_parens(self):
        from more_itertools import lg_parse
        assert lg_parse.parse([8, "-", 3, "-", 2]) == ("-", ("-", 8, 3), 2)
        assert lg_parse.parse(["(", 1, "+", 2, ")", "*", 3]) == ("*", ("+", 1, 2), 3)

    def test_unary_and_errors(self):
        from more_itertools import lg_parse, lg_tok
        import pytest
        assert lg_parse.parse(lg_tok.tokenize("-4")) == ("-", 0, 4)
        for bad in ("", "1 +", "(1", "1 2", ")"):
            with pytest.raises(ValueError):
                lg_parse.parse(lg_tok.tokenize(bad))

class TestEval:
    def test_eval(self):
        from more_itertools import lg_eval, lg_parse, lg_tok

        def run(s):
            return lg_eval.evaluate(lg_parse.parse(lg_tok.tokenize(s)))

        assert run("1 + 2 * 3") == 7
        assert run("(1 + 2) * 3") == 9
        assert run("7 / 2") == 3.5
        assert run("-(2 + 3)") == -5

    def test_int_stays_int(self):
        from more_itertools import lg_eval
        r = lg_eval.evaluate(("*", 3, 4))
        assert r == 12 and isinstance(r, int)

    def test_div_zero(self):
        from more_itertools import lg_eval
        import pytest
        with pytest.raises(ZeroDivisionError):
            lg_eval.evaluate(("/", 1, 0))

class TestCalc:
    def test_calc(self):
        from more_itertools import lg_calc
        assert lg_calc.calc("2 * (3 + 4) - 5") == 9

    def test_uses_earlier_stages(self):
        from more_itertools import lg_calc, lg_eval
        orig = lg_eval.evaluate
        lg_eval.evaluate = lambda ast: "sentinel"
        try:
            assert lg_calc.calc("1 + 1") == "sentinel"
        finally:
            lg_eval.evaluate = orig

    def test_calc_all(self):
        from more_itertools import lg_calc
        got = lg_calc.calc_all(["1+1", "", "1/0", "(", "2*3"])
        assert got == [("1+1", 2), ("1/0", "ZeroDivisionError"), ("(", "ValueError"), ("2*3", 6)]
