# Dev Demo User
## Implementation Plan

### 1. Auth flag

1.1 `Settings.demo_user_enabled: bool = False` (env `DEMO_USER_ENABLED`) in `app/config.py`.

1.2 `authenticate_user` in `app/auth.py` also accepts the demo credentials when the flag is on. Demo constants (`demo` / `demo`) live in one place in `app/demo/`.

### 2. Environment wiring

2.1 `docker-compose.yml` backend: `DEMO_USER_ENABLED: "true"`.

2.2 `docker-compose.prod.yml` backend: `DEMO_USER_ENABLED: "false"` (overrides `env_file`).

2.3 `.env.example`: note that the flag is dev-only.

### 3. Seeder — `app/demo/seed.py`

3.1 Importable async core that takes an HTTP client, a DB session factory and `today`, so tests can drive it with the SQLite fixtures and a fixed date.

3.2 Guard: exit non-zero unless `settings.demo_user_enabled`.

3.3 Reset: delete all rows with `user_id == "demo"` across user-scoped tables, in FK-safe order.

3.4 Seed via `httpx.AsyncClient(transport=ASGITransport(app=app))`: log in as demo, create the catalog, templates, 12 weeks of sessions, steps, profile and plans (see the dataset table in `requirements.md`). Fixed `random.Random` seed; all dates relative to `today`.

3.5 `python -m app.demo.seed` entry point wires the real engine and prints counts plus the login.

### 4. Wrapper — `scripts/seed-demo.sh`

Runs `alembic upgrade head` and the seeder in the backend container. `COMPOSE` env var overrides the compose command (default `docker compose`). Clear error if the backend isn't running.

### 5. Frontend build fix

`frontend/Dockerfile` installed the latest pnpm, which fails on esbuild's build scripts (`ERR_PNPM_IGNORED_BUILDS`), so a fresh `docker compose up --build` failed for every developer. Handled by the base branch `fix/pin-pnpm-version` (miptgirl/trainlytics#20): pnpm is pinned via `packageManager` in `package.json` and corepack. This change depends on it.

### 6. Tests

- Demo login rejected with the flag off, accepted with it on
- Seeding produces sessions, plans, steps and templates for `demo` and leaves other users' rows untouched
- Seeding twice gives identical counts (reset works)
- Seeder refuses when the flag is off

### 7. Docs

`specs/tech-stack.md` (Running locally, Auth, Key Constraints), `README.md` (local development pointer), `specs/roadmap.md` (Developer Tooling entry).
