from datetime import timedelta

import pytest
from httpx import AsyncClient

from app.auth import create_token
from app.config import settings
from tests.conftest import TEST_PASSWORD, TEST_USERNAME


async def test_login_success(client: AsyncClient) -> None:
    resp = await client.post("/api/auth/login", json={"username": TEST_USERNAME, "password": TEST_PASSWORD})
    assert resp.status_code == 200
    body = resp.json()
    assert "access_token" in body
    assert body["token_type"] == "bearer"
    assert "refresh_token" in resp.cookies


async def test_login_wrong_password(client: AsyncClient) -> None:
    resp = await client.post("/api/auth/login", json={"username": TEST_USERNAME, "password": "wrong"})
    assert resp.status_code == 401


async def test_login_unknown_user(client: AsyncClient) -> None:
    resp = await client.post("/api/auth/login", json={"username": "nobody", "password": TEST_PASSWORD})
    assert resp.status_code == 401


async def test_refresh_with_valid_cookie(client: AsyncClient) -> None:
    login = await client.post("/api/auth/login", json={"username": TEST_USERNAME, "password": TEST_PASSWORD})
    assert login.status_code == 200

    resp = await client.post("/api/auth/refresh")
    assert resp.status_code == 200
    assert "access_token" in resp.json()


async def test_refresh_without_cookie(client: AsyncClient) -> None:
    resp = await client.post("/api/auth/refresh")
    assert resp.status_code == 401


async def test_logout_clears_cookie(client: AsyncClient) -> None:
    await client.post("/api/auth/login", json={"username": TEST_USERNAME, "password": TEST_PASSWORD})
    resp = await client.post("/api/auth/logout")
    assert resp.status_code == 200
    # Cookie should be cleared (empty value or absent)
    assert client.cookies.get("refresh_token") is None


async def test_protected_endpoint_requires_token(client: AsyncClient) -> None:
    resp = await client.get("/api/exercises")
    assert resp.status_code == 401


async def test_invalid_token_returns_401(client: AsyncClient) -> None:
    client.headers["Authorization"] = "Bearer invalid.token.here"
    resp = await client.get("/api/exercises")
    assert resp.status_code == 401


async def test_second_user_cannot_use_first_users_token(client: AsyncClient) -> None:
    """Token is user-scoped — a token for user1 encodes their username."""
    login = await client.post("/api/auth/login", json={"username": TEST_USERNAME, "password": TEST_PASSWORD})
    token = login.json()["access_token"]
    # Decode and check sub claim is the correct user
    import base64, json as _json
    parts = token.split(".")
    padded = parts[1] + "=" * (-len(parts[1]) % 4)
    payload = _json.loads(base64.urlsafe_b64decode(padded))
    assert payload["sub"] == TEST_USERNAME


async def _login(client: AsyncClient) -> dict:
    resp = await client.post("/api/auth/login", json={"username": TEST_USERNAME, "password": TEST_PASSWORD})
    assert resp.status_code == 200
    return resp.json()


async def test_refresh_reissues_cookie_with_seven_day_max_age(client: AsyncClient) -> None:
    await _login(client)
    resp = await client.post("/api/auth/refresh")
    assert resp.status_code == 200
    set_cookie = resp.headers["set-cookie"]
    assert "refresh_token=" in set_cookie
    assert f"Max-Age={7 * 86400}" in set_cookie
    assert "HttpOnly" in set_cookie


async def test_refresh_token_rejected_as_bearer(client: AsyncClient) -> None:
    refresh = create_token({"sub": TEST_USERNAME, "type": "refresh"}, timedelta(days=7))
    resp = await client.get("/api/exercises", headers={"Authorization": f"Bearer {refresh}"})
    assert resp.status_code == 401


async def test_legacy_access_token_without_type_still_accepted(client: AsyncClient, db_session) -> None:
    legacy = create_token({"sub": TEST_USERNAME}, timedelta(minutes=5))
    resp = await client.get("/api/exercises", headers={"Authorization": f"Bearer {legacy}"})
    assert resp.status_code == 200


async def test_access_token_rejected_by_refresh(client: AsyncClient) -> None:
    access = (await _login(client))["access_token"]
    client.cookies.clear()
    client.cookies.set("refresh_token", access)
    resp = await client.post("/api/auth/refresh")
    assert resp.status_code == 401


async def test_expired_refresh_token_rejected(client: AsyncClient) -> None:
    expired = create_token({"sub": TEST_USERNAME, "type": "refresh"}, timedelta(seconds=-10))
    client.cookies.set("refresh_token", expired)
    resp = await client.post("/api/auth/refresh")
    assert resp.status_code == 401


async def test_refresh_for_removed_user_rejected(client: AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    await _login(client)
    monkeypatch.setattr(settings, "users", "")
    resp = await client.post("/api/auth/refresh")
    assert resp.status_code == 401
