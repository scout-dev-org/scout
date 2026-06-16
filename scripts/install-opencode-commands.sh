#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$repo_root/.opencode/commands"
target_dir="${OPENCODE_COMMANDS_DIR:-$HOME/.config/opencode/commands}"

if [ ! -d "$source_dir" ]; then
  printf '%s\n' "Scout OpenCode commands not found: $source_dir" >&2
  exit 1
fi

mkdir -p "$target_dir"

# Remove command names previously shipped before Scout converged on one `/scout` entrypoint.
for stale_command in scout-resume.md scout-triage.md scout-one.md scout-all.md scout-review.md scout-audit.md scout-readiness.md; do
  rm -f "$target_dir/$stale_command"
done

for command_file in "$source_dir"/*.md; do
  [ -e "$command_file" ] || continue
  target_file="$target_dir/$(basename "$command_file")"
  if [ -e "$target_file" ] && cmp -s "$command_file" "$target_file"; then
    continue
  fi
  cp "$command_file" "$target_file"
done

printf 'Installed Scout OpenCode commands to %s\n' "$target_dir"
printf '%s\n' 'Restart OpenCode so the command menu reloads them.'
