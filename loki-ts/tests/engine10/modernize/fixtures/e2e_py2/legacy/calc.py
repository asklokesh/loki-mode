def tally(scores):
    total = 0
    for name, val in scores.iteritems():
        total += val
    return total


def label(raw):
    if isinstance(raw, unicode):
        return raw.upper()
    return str(raw)
