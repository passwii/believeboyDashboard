from app.core.passwords import hash_password, verify_password


def test_hash_and_verify_password():
    password = 'XeonJJ2024@'
    password_hash = hash_password(password)

    assert password_hash.startswith('$2')
    assert verify_password(password, password_hash) is True
    assert verify_password('wrong-password', password_hash) is False
