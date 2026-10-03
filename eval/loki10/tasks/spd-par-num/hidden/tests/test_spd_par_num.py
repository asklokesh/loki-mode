"""Hidden acceptance tests for spd-par-num (authored, D61 slice 17)."""


class TestPrimes:
    def test_is_prime(self):
        from more_itertools import spd_primes
        assert [n for n in range(20) if spd_primes.is_prime(n)] == [2, 3, 5, 7, 11, 13, 17, 19]
        assert not spd_primes.is_prime(-7)

    def test_primes_upto(self):
        from more_itertools import spd_primes
        assert spd_primes.primes_upto(30) == [2, 3, 5, 7, 11, 13, 17, 19, 23, 29]
        assert spd_primes.primes_upto(1) == []

    def test_large(self):
        from more_itertools import spd_primes
        assert spd_primes.is_prime(7919) and not spd_primes.is_prime(7917)
        assert len(spd_primes.primes_upto(1000)) == 168

class TestGcdLcm:
    def test_gcd(self):
        from more_itertools import spd_gcdlcm
        assert spd_gcdlcm.gcd_all(12, 18, 24) == 6
        assert spd_gcdlcm.gcd_all(7) == 7

    def test_lcm(self):
        from more_itertools import spd_gcdlcm
        assert spd_gcdlcm.lcm_all(4, 6, 10) == 60
        assert spd_gcdlcm.lcm_all(5) == 5

    def test_errors(self):
        from more_itertools import spd_gcdlcm
        import pytest
        for f in (spd_gcdlcm.gcd_all, spd_gcdlcm.lcm_all):
            with pytest.raises(ValueError):
                f()
            with pytest.raises(ValueError):
                f(3, 0)

class TestStats:
    def test_mean_median(self):
        from more_itertools import spd_stats
        assert spd_stats.mean([1, 2, 3, 4]) == 2.5
        assert spd_stats.median([5, 1, 3]) == 3
        assert spd_stats.median([4, 1, 3, 2]) == 2.5

    def test_mode(self):
        from more_itertools import spd_stats
        assert spd_stats.mode([1, 2, 2, 3, 3]) == 2
        assert spd_stats.mode([9]) == 9

    def test_empty(self):
        from more_itertools import spd_stats
        import pytest
        for f in (spd_stats.mean, spd_stats.median, spd_stats.mode):
            with pytest.raises(ValueError):
                f([])

class TestBaseConv:
    def test_to_base(self):
        from more_itertools import spd_baseconv
        assert spd_baseconv.to_base(255, 16) == "ff"
        assert spd_baseconv.to_base(0, 2) == "0"
        assert spd_baseconv.to_base(35, 36) == "z"

    def test_from_base(self):
        from more_itertools import spd_baseconv
        assert spd_baseconv.from_base("FF", 16) == 255
        assert spd_baseconv.from_base("101", 2) == 5

    def test_errors(self):
        from more_itertools import spd_baseconv
        import pytest
        calls = (lambda: spd_baseconv.to_base(5, 1), lambda: spd_baseconv.to_base(5, 37),
                 lambda: spd_baseconv.to_base(-1, 10), lambda: spd_baseconv.from_base("2", 2),
                 lambda: spd_baseconv.from_base("", 10))
        for call in calls:
            with pytest.raises(ValueError):
                call()
