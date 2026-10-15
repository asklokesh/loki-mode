def page_count(total, per_page):
    if per_page < 1:
        raise ValueError("per_page must be >= 1")
    return (total + per_page - 1) // per_page


def paginate(items, page, per_page):
    if per_page < 1:
        raise ValueError("per_page must be >= 1")
    if page < 1:
        return []
    start = (page - 1) * per_page
    return list(items[start:start + per_page])
