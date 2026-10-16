import os

def load():
    if os.environ.get('APP_ENV') == 'staging':
        return {'db': os.environ['STAGING_DB_URL'], 'debug': False}
    return {'db': 'sqlite:///dev.db', 'debug': True}
