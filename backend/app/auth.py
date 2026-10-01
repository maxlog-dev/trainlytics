from datetime import datetime, timedelta, timezone

import bcrypt
from jose import JWTError, jwt

from app.config import settings


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


def authenticate_user(username: str, password: str) -> bool:
    users = parse_users(settings.users)
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
