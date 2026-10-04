"""Local-dev demo user.

Enabled only when ``settings.demo_user_enabled`` is true (env ``DEMO_USER_ENABLED``).
Seed its data with ``uv run python -m app.demo.seed`` (or ``scripts/seed-demo.sh``).
Keep this module import-free: app.auth imports these constants.
"""

DEMO_USERNAME = "demo"
DEMO_PASSWORD = "demo"
