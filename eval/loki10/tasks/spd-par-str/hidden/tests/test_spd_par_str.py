"""Hidden acceptance tests for spd-par-str (authored, D61 slice 17)."""


class TestCaesar:
    def test_shift(self):
        from more_itertools import spd_caesar
        assert spd_caesar.shift("Abc xyz!", 3) == "Def abc!"
        assert spd_caesar.shift("abc", -1) == "zab"

    def test_wrap_and_big(self):
        from more_itertools import spd_caesar
        assert spd_caesar.shift("abc", 26) == "abc"
        assert spd_caesar.shift("abc", 53) == "bcd"

    def test_unshift(self):
        from more_itertools import spd_caesar
        s = "Hello, World 42"
        for k in (-30, 0, 7, 100):
            assert spd_caesar.unshift(spd_caesar.shift(s, k), k) == s

class TestWrap:
    def test_basic(self):
        from more_itertools import spd_wrap
        assert spd_wrap.wrap_words("the quick brown fox", 9) == ["the quick", "brown fox"]

    def test_long_word_and_spaces(self):
        from more_itertools import spd_wrap
        assert spd_wrap.wrap_words("a  extraordinarily  b", 5) == ["a", "extraordinarily", "b"]

    def test_empty_and_error(self):
        from more_itertools import spd_wrap
        import pytest
        assert spd_wrap.wrap_words("   ", 10) == []
        with pytest.raises(ValueError):
            spd_wrap.wrap_words("x", 0)

class TestPal:
    def test_true(self):
        from more_itertools import spd_pal
        assert spd_pal.is_palindrome("A man, a plan, a canal: Panama")
        assert spd_pal.is_palindrome("")
        assert spd_pal.is_palindrome("!!")

    def test_false(self):
        from more_itertools import spd_pal
        assert not spd_pal.is_palindrome("hello")
        assert not spd_pal.is_palindrome("ab1ba2")

    def test_digits(self):
        from more_itertools import spd_pal
        assert spd_pal.is_palindrome("1221")
        assert spd_pal.is_palindrome("No 'x' in Nixon")

class TestAnagram:
    def test_basic(self):
        from more_itertools import spd_anagram
        got = spd_anagram.group_anagrams(["eat", "tea", "tan", "ate", "nat", "bat"])
        assert got == [["eat", "tea", "ate"], ["tan", "nat"], ["bat"]]

    def test_case(self):
        from more_itertools import spd_anagram
        assert spd_anagram.group_anagrams(["Listen", "Silent", "x"]) == [["Listen", "Silent"], ["x"]]

    def test_empty(self):
        from more_itertools import spd_anagram
        assert spd_anagram.group_anagrams([]) == []
