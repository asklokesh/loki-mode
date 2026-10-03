"""Hidden acceptance tests for spd-seq-calc (authored, D61 slice 17)."""


class TestTok:
    def test_tokens(self):
        from more_itertools import spd_tok
        assert spd_tok.tokenize("1 + 2.5*(3)") == [1, "+", 2.5, "*", "(", 3, ")"]

    def test_empty_and_error(self):
        from more_itertools import spd_tok
        import pytest
        assert spd_tok.tokenize("  ") == []
        with pytest.raises(ValueError):
            spd_tok.tokenize("1 $ 2")

class TestParse:
    def test_precedence(self):
        from more_itertools import spd_parse
        assert spd_parse.parse([1, "+", 2, "*", 3]) == ("+", 1, ("*", 2, 3))

    def test_left_assoc_and_parens(self):
        from more_itertools import spd_parse
        assert spd_parse.parse([8, "-", 3, "-", 2]) == ("-", ("-", 8, 3), 2)
        assert spd_parse.parse(["(", 1, "+", 2, ")", "*", 3]) == ("*", ("+", 1, 2), 3)

    def test_unary_and_errors(self):
        from more_itertools import spd_parse, spd_tok
        import pytest
        assert spd_parse.parse(spd_tok.tokenize("-4")) == ("-", 0, 4)
        for bad in ("", "1 +", "(1", "1 2", ")"):
            with pytest.raises(ValueError):
                spd_parse.parse(spd_tok.tokenize(bad))

class TestEval:
    def test_eval(self):
        from more_itertools import spd_eval, spd_parse, spd_tok

        def run(s):
            return spd_eval.evaluate(spd_parse.parse(spd_tok.tokenize(s)))

        assert run("1 + 2 * 3") == 7
        assert run("(1 + 2) * 3") == 9
        assert run("7 / 2") == 3.5
        assert run("-(2 + 3)") == -5

    def test_int_stays_int(self):
        from more_itertools import spd_eval
        r = spd_eval.evaluate(("*", 3, 4))
        assert r == 12 and isinstance(r, int)

    def test_div_zero(self):
        from more_itertools import spd_eval
        import pytest
        with pytest.raises(ZeroDivisionError):
            spd_eval.evaluate(("/", 1, 0))

class TestCalc:
    def test_calc(self):
        from more_itertools import spd_calc
        assert spd_calc.calc("2 * (3 + 4) - 5") == 9

    def test_uses_earlier_stages(self):
        from more_itertools import spd_calc, spd_eval
        orig = spd_eval.evaluate
        spd_eval.evaluate = lambda ast: "sentinel"
        try:
            assert spd_calc.calc("1 + 1") == "sentinel"
        finally:
            spd_eval.evaluate = orig

    def test_calc_all(self):
        from more_itertools import spd_calc
        got = spd_calc.calc_all(["1+1", "", "1/0", "(", "2*3"])
        assert got == [("1+1", 2), ("1/0", "ZeroDivisionError"), ("(", "ValueError"), ("2*3", 6)]
