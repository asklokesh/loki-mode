from . import converters

# name -> (function, from_unit, to_unit)
CONVERTERS = {
    "meters_to_feet": (converters.meters_to_feet, "m", "ft"),
    "feet_to_meters": (converters.feet_to_meters, "ft", "m"),
}


def convert(name, value):
    if name not in CONVERTERS:
        raise KeyError(f"unknown converter {name!r}")
    return CONVERTERS[name][0](value)


def units(name):
    fn, src, dst = CONVERTERS[name]
    return (src, dst)
