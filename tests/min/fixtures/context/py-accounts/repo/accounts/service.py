"""Registration service."""
from accounts.errors import InvalidEmail
from accounts.validate import looks_like_email


def register_user(store, email, name):
    if not looks_like_email(email):
        raise InvalidEmail(email)
    return store.add(email, name)


def rename_user(store, user_id, name):
    for user in store.all():
        if user.id == user_id:
            user.name = name
            return user
    return None
