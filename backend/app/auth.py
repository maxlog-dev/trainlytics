from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt

from app.config import settings
from app.demo import DEMO_PASSWORD, DEMO_USERNAME


def parse_users(users_str: str) -> dict[str, str]:
    """Parse USERS env var ('user:hash,user2:hash2') into {username: hashed_password}."""
    result: dict[str, str] = {}
    for entry in users_str.split(","):
        entry = entry.strip()
        if ":" not in entry:
            continue
        username, hashed = entry.split(":", 1)
        result[username.strip()] = hashed.strip()
    return result


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode(), hashed.encode())


def _demo_login_active(users: dict[str, str]) -> bool:
    """Built-in demo login applies only when the flag is on and USERS has no 'demo'.

    Precedence: an explicit USERS entry always wins. If USERS defines 'demo', that
    account keeps its own password and demo/demo is rejected, so the flag can never
    open a configured account with a well-known password.
    """
    return settings.demo_user_enabled and DEMO_USERNAME not in users


def is_known_user(username: str) -> bool:
    users = parse_users(settings.users)
    return username in users or (username == DEMO_USERNAME and _demo_login_active(users))


def authenticate_user(username: str, password: str) -> bool:
    users = parse_users(settings.users)
    if username == DEMO_USERNAME and _demo_login_active(users):
        return password == DEMO_PASSWORD
    hashed = users.get(username)
    if not hashed:
        return False
    return verify_password(password, hashed)


def create_token(data: dict, expires_delta: timedelta) -> str:
    payload = {**data, "exp": datetime.now(timezone.utc) + expires_delta}
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_token(token: str, expected_type: str = "access") -> str | None:
    """Returns username (sub claim) if the token is valid and of the expected type, else None.

    Access tokens issued before the "type" claim existed carry no type and are
    still accepted as "access" for their remaining lifetime.
    """
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
    except JWTError:
        return None
    token_type = payload.get("type")
    if expected_type == "access" and token_type is None:
        token_type = "access"
    if token_type != expected_type:
        return None
    return payload.get("sub")
