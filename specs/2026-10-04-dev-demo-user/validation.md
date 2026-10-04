# Dev Demo User
## Validation

### Progress

| Task Group | Status |
|---|---|
| 1. Auth flag | ✅ Done — also fixed `/auth/refresh`, which only checked `USERS` and would have logged demo out on first refresh |
| 2. Environment wiring | ✅ Done |
| 3. Seeder | ✅ Done — `app/demo/seed.py` |
| 4. Wrapper | ✅ Done — `scripts/seed-demo.sh` |
| 5. Frontend build fix | ✅ Done in base branch `fix/pin-pnpm-version` (miptgirl/trainlytics#20) |
| 6. Tests | ✅ Done — 334 backend tests passing (7 new in `tests/test_demo_seed.py`) |
| 7. Docs | ✅ Done |

---

### Implementation Notes

- **Precedence:** if `USERS` contains a `demo` entry, it wins and `demo` / `demo` is rejected even with the flag on, so the flag can never open a configured account with a known password. The seeder says so if its login fails for this reason.
- **Reset:** explicit deletes in one transaction, children before parents (no reliance on `ON DELETE CASCADE`; SQLite in tests doesn't enforce FKs). The username is hardcoded — there is no parameter that could target another user.
- **Not reset:** `body_metrics` and `pending_imports` have no owner column. The seeder writes neither, so nothing leaks, but those tables are shared across all accounts.
- **Determinism:** each generated item has its own RNG seeded from a fixed constant plus a stable key (week/weekday, step-day offset). The same `today` always yields identical rows.
- **Today and this week:** days from today on stay planned, never logged; today always has one planned cardio and one planned strength session; the latest past session of the current week is skipped with a note; last week has a skip too. On a Monday only last week's skip exists (covered by a test).

---

### Definition of Done

- [x] Fresh clone: `docker compose up --build -d` then `bash scripts/seed-demo.sh` gives a working `demo` / `demo` login with 12 weeks of data
- [x] Rerunning the script resets the data and produces identical counts and values
- [x] The seeder refuses to run, and the demo login is rejected, when `DEMO_USER_ENABLED` is not `true`
- [x] `docker-compose.prod.yml` forces `DEMO_USER_ENABLED=false`
- [x] Other users' rows are untouched by reset and seed (pytest)

### Verified End to End (Podman, 2026-10-04)

Seed output: 3 cardio types, 6 exercise types, 18 exercises, 3 templates, 27 strength + 22 cardio sessions, 62 planned sessions (4 skipped with notes), 76 step days. Through `http://localhost:5173/api`: login 200, wrong password 401, refresh 200; current week shows 4 done, 1 skipped and 2 planned for today; next week 5 planned. A second run gave identical counts; with the flag off the seeder exits 1.
