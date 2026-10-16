import api

def display_name(uid):
    return api.fetch_user(uid)['data']['name']
