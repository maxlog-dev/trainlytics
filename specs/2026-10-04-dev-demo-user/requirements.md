# Dev Demo User
## Requirements

### Scope

A shared, reproducible demo account for local development. Any developer can start the stack, run one command, and log in as `demo` to see 12 weeks of realistic training data. Everyone sees the same data shape, so UI changes (mobile layout, charts, plan views) can be judged against a common baseline instead of each developer's own sparse or empty account.

The demo user must never exist in production.

---

### Key Decisions

**Enabled by an env flag, not by `USERS`**
`DEMO_USER_ENABLED=true` makes the backend accept `demo` / `demo` in addition to the accounts in `USERS`. The password is fixed and public on purpose: it is a local test account, and every developer needs the same login without generating a bcrypt hash. Default is `false`. An explicit `demo` entry in `USERS` takes precedence and disables the built-in password.

**Prod is locked off explicitly**
`docker-compose.yml` (dev) sets `DEMO_USER_ENABLED: "true"`. `docker-compose.prod.yml` sets it to `"false"` in the backend `environment:` block, which takes precedence over `env_file`, so a stray line in a production `.env` cannot turn it on. The seeder also refuses to run when the flag is off.

**Seed through the app's own API, in-process**
The seeder calls the REST API through `httpx.ASGITransport` against the FastAPI app, logged in as `demo`. All validation and business logic (plan matching, template versioning, derived fields) runs exactly as for a real user, and no server or network port is needed. Data written this way cannot drift from what the UI can produce.

**Reset, then seed — deterministic and relative to today**
Each run deletes every row owned by `demo` (and only `demo`) and recreates it. Values come from a fixed random seed, so the data is identical on every run; dates are anchored to the current week, so the last 12 weeks are always populated and "today" always has planned sessions. Running it on Monday or Friday gives the same pattern shifted to the current calendar.

**One command**
`bash scripts/seed-demo.sh` runs migrations and the seeder inside the running backend container. `COMPOSE="podman compose"` (optionally with extra `-f` files) supports Podman and overrides.

---

### Demo Dataset

| Area | Content |
|---|---|
| Catalog | 3 cardio activity types (Running, Walking, Cycling), 6 exercise types, 18 exercises |
| Templates | Upper body A, Upper body B, Lower body — 6 exercises each |
| History | 12 weeks ending with the current week, 3–4 sessions per week |
| Strength | Progressive load, per-set notes like `RPE: 7`, wellbeing and RPE ratings, occasional session notes |
| Cardio | Easy runs, intervals, long runs, walks; multiple segments with distance, pace, calories, average HR and HR-zone times |
| Steps | Daily step counts with ~8% of days missing |
| Profile | Display name, birth year, experience level, goals, injury and coach notes |
| Plans | Every history week plus next week; mix of done, skipped (with note) and planned. The current week has at least one skip; today has a planned cardio and a planned strength session not yet logged |

Not seeded: Strava/Apple Health imports, body metrics (they only arrive via the import pipeline), AI request logs, API keys.

---

### Out of Scope

- A demo mode in production or a public demo instance
- Seeding more than one account, or seeding arbitrary users
- Frontend changes (the login page is unchanged; credentials are documented in `specs/tech-stack.md`)
