#!/usr/bin/env bash
# Reset and reseed the local-dev demo user (log in as demo / demo).
#
# Runs migrations, then app.demo.seed inside the running backend container.
# Needs the dev stack up (docker compose up -d) with DEMO_USER_ENABLED=true,
# which docker-compose.yml sets.
#
# Override the compose command with COMPOSE, e.g.:
#   COMPOSE="podman compose" bash scripts/seed-demo.sh
#   COMPOSE="docker compose -f docker-compose.yml -f my.override.yml" bash scripts/seed-demo.sh
# Relative -f paths resolve against the repo root. Extra args go to the seeder
# (e.g. --weeks 8).
set -euo pipefail

cd "$(dirname "$0")/.."

# Intentionally word-split so COMPOSE can carry extra flags.
read -r -a compose <<< "${COMPOSE:-docker compose}"

if [ -z "$("${compose[@]}" ps --status running -q backend 2>/dev/null)" ]; then
  echo "Error: the backend container is not running." >&2
  echo "Start the dev stack first: ${compose[*]} up --build -d" >&2
  exit 1
fi

"${compose[@]}" exec -T backend uv run alembic upgrade head
"${compose[@]}" exec -T backend uv run python -m app.demo.seed "$@"
