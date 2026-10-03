"""Hidden acceptance tests for lg-par-str (authored, D61 slice 17)."""


class TestCaesar:
    def test_shift(self):
        from more_itertools import lg_caesar
        assert lg_caesar.shift("Abc xyz!", 3) == "Def abc!"
        assert lg_caesar.shift("abc", -1) == "zab"

    def test_wrap_and_big(self):
        from more_itertools import lg_caesar
        assert lg_caesar.shift("abc", 26) == "abc"
        assert lg_caesar.shift("abc", 53) == "bcd"

    def test_unshift(self):
        from more_itertools import lg_caesar
        s = "Hello, World 42"
        for k in (-30, 0, 7, 100):
            assert lg_caesar.unshift(lg_caesar.shift(s, k), k) == s

class TestWrap:
    def test_basic(self):
        from more_itertools import lg_wrap
        assert lg_wrap.wrap_words("the quick brown fox", 9) == ["the quick", "brown fox"]

    def test_long_word_and_spaces(self):
        from more_itertools import lg_wrap
        assert lg_wrap.wrap_words("a  extraordinarily  b", 5) == ["a", "extraordinarily", "b"]

    def test_empty_and_error(self):
        from more_itertools import lg_wrap
        import pytest
        assert lg_wrap.wrap_words("   ", 10) == []
        with pytest.raises(ValueError):
            lg_wrap.wrap_words("x", 0)

class TestPal:
    def test_true(self):
        from more_itertools import lg_pal
        assert lg_pal.is_palindrome("A man, a plan, a canal: Panama")
        assert lg_pal.is_palindrome("")
        assert lg_pal.is_palindrome("!!")

    def test_false(self):
        from more_itertools import lg_pal
        assert not lg_pal.is_palindrome("hello")
        assert not lg_pal.is_palindrome("ab1ba2")

    def test_digits(self):
        from more_itertools import lg_pal
        assert lg_pal.is_palindrome("1221")
        assert lg_pal.is_palindrome("No 'x' in Nixon")

class TestAnagram:
    def test_basic(self):
        from more_itertools import lg_anagram
        got = lg_anagram.group_anagrams(["eat", "tea", "tan", "ate", "nat", "bat"])
        assert got == [["eat", "tea", "ate"], ["tan", "nat"], ["bat"]]

    def test_case(self):
        from more_itertools import lg_anagram
        assert lg_anagram.group_anagrams(["Listen", "Silent", "x"]) == [["Listen", "Silent"], ["x"]]

    def test_empty(self):
        from more_itertools import lg_anagram
        assert lg_anagram.group_anagrams([]) == []
