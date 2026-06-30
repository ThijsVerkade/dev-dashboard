#!/usr/bin/env bash
#
# Ensure a valid AWS SSO token before the dashboard's Logs panel needs one.
#
# - Resolves AWS_PROFILE and AWS_SSO_SESSION from the shell env, falling back to
#   parsing them out of .env.local (where the dashboard keeps its config).
# - If the token is missing/expired (or --force is passed), runs
#   `aws sso login` for the configured SSO session (or the profile, if no
#   session name is set). A successful login authorizes every profile that
#   shares that SSO session at once.
# - Never blocks `npm run dev`: if the CLI is absent, no profile is configured,
#   or the login fails, it exits 0 — the Logs panel just shows a re-auth message.
#
# Usage:
#   scripts/ensure-sso.sh          # log in only if the current token is invalid
#   scripts/ensure-sso.sh --force  # always run `aws sso login`

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"

# Read KEY=value from .env.local (first match, stripping surrounding quotes/spaces
# and any trailing comment). Used only when the value isn't already in the env.
read_env() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n -E "s/^$1=([^#]*).*/\1/p" "$ENV_FILE" | head -1 | sed -E 's/^["'\'' ]+//; s/["'\'' ]+$//'
}

PROFILE="${AWS_PROFILE:-$(read_env AWS_PROFILE)}"
SESSION="${AWS_SSO_SESSION:-$(read_env AWS_SSO_SESSION)}"
SESSION="${SESSION:-bas}"

if ! command -v aws >/dev/null 2>&1; then
  echo "[ensure-sso] aws CLI not found — skipping (Logs panel optional)."
  exit 0
fi

if [ -z "$PROFILE" ]; then
  echo "[ensure-sso] no AWS_PROFILE configured — skipping (Logs panel optional)."
  exit 0
fi

if [ "$FORCE" -eq 0 ] && aws sts get-caller-identity --profile "$PROFILE" >/dev/null 2>&1; then
  echo "[ensure-sso] SSO token valid for profile '$PROFILE'."
  exit 0
fi

if [ -n "$SESSION" ]; then
  echo "[ensure-sso] token expired/missing — logging in to SSO session '$SESSION'…"
  aws sso login --sso-session "$SESSION" || echo "[ensure-sso] login did not complete; Logs panel will prompt to re-auth."
else
  echo "[ensure-sso] token expired/missing — logging in with profile '$PROFILE'…"
  aws sso login --profile "$PROFILE" || echo "[ensure-sso] login did not complete; Logs panel will prompt to re-auth."
fi

exit 0
