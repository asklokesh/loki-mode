"""Unit converters. Each one takes a number and returns the converted value."""


def _check_number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("value must be a number")


def meters_to_feet(meters):
    _check_number(meters)
    return round(meters / 0.3048, 3)


def feet_to_meters(feet):
    _check_number(feet)
    return round(feet * 0.3048, 3)


def celsius_to_fahrenheit(celsius):
    _check_number(celsius)
    return round(celsius * 9 / 5 + 32, 2)


def kilometers_to_miles(km):
    _check_number(km)
    if km < 0:
        raise ValueError("distance must be non-negative")
    return round(km / 1.609344, 3)
