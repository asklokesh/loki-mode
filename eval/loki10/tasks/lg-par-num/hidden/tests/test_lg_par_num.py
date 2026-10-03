"""Hidden acceptance tests for lg-par-num (authored, D61 slice 17)."""


class TestPrimes:
    def test_is_prime(self):
        from more_itertools import lg_primes
        assert [n for n in range(20) if lg_primes.is_prime(n)] == [2, 3, 5, 7, 11, 13, 17, 19]
        assert not lg_primes.is_prime(-7)

    def test_primes_upto(self):
        from more_itertools import lg_primes
        assert lg_primes.primes_upto(30) == [2, 3, 5, 7, 11, 13, 17, 19, 23, 29]
        assert lg_primes.primes_upto(1) == []

    def test_large(self):
        from more_itertools import lg_primes
        assert lg_primes.is_prime(7919) and not lg_primes.is_prime(7917)
        assert len(lg_primes.primes_upto(1000)) == 168

class TestGcdLcm:
    def test_gcd(self):
        from more_itertools import lg_gcdlcm
        assert lg_gcdlcm.gcd_all(12, 18, 24) == 6
        assert lg_gcdlcm.gcd_all(7) == 7

    def test_lcm(self):
        from more_itertools import lg_gcdlcm
        assert lg_gcdlcm.lcm_all(4, 6, 10) == 60
        assert lg_gcdlcm.lcm_all(5) == 5

    def test_errors(self):
        from more_itertools import lg_gcdlcm
        import pytest
        for f in (lg_gcdlcm.gcd_all, lg_gcdlcm.lcm_all):
            with pytest.raises(ValueError):
                f()
            with pytest.raises(ValueError):
                f(3, 0)

class TestStats:
    def test_mean_median(self):
        from more_itertools import lg_stats
        assert lg_stats.mean([1, 2, 3, 4]) == 2.5
        assert lg_stats.median([5, 1, 3]) == 3
        assert lg_stats.median([4, 1, 3, 2]) == 2.5

    def test_mode(self):
        from more_itertools import lg_stats
        assert lg_stats.mode([1, 2, 2, 3, 3]) == 2
        assert lg_stats.mode([9]) == 9

    def test_empty(self):
        from more_itertools import lg_stats
        import pytest
        for f in (lg_stats.mean, lg_stats.median, lg_stats.mode):
            with pytest.raises(ValueError):
                f([])

class TestBaseConv:
    def test_to_base(self):
        from more_itertools import lg_baseconv
        assert lg_baseconv.to_base(255, 16) == "ff"
        assert lg_baseconv.to_base(0, 2) == "0"
        assert lg_baseconv.to_base(35, 36) == "z"

    def test_from_base(self):
        from more_itertools import lg_baseconv
        assert lg_baseconv.from_base("FF", 16) == 255
        assert lg_baseconv.from_base("101", 2) == 5

    def test_errors(self):
        from more_itertools import lg_baseconv
        import pytest
        calls = (lambda: lg_baseconv.to_base(5, 1), lambda: lg_baseconv.to_base(5, 37),
                 lambda: lg_baseconv.to_base(-1, 10), lambda: lg_baseconv.from_base("2", 2),
                 lambda: lg_baseconv.from_base("", 10))
        for call in calls:
            with pytest.raises(ValueError):
                call()
