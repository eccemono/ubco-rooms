#!/usr/bin/env bash
# Push this project to an empty GitHub repository.
# Usage: ./tools/publish.sh git@github.com:eccemono/ubco-rooms.git
set -euo pipefail
cd "$(dirname "$0")/.."

remote="${1:-git@github.com:eccemono/ubco-rooms.git}"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This folder is not a git repository." >&2
  exit 1
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$remote"
else
  git remote add origin "$remote"
fi

echo "Pushing main to $remote"
git push -u origin main
echo
echo "Next: GitHub → repository → Settings → Pages → Source: GitHub Actions."
echo "The site should publish at https://eccemono.com/ubco-rooms/ (or the repo's Pages URL)."
