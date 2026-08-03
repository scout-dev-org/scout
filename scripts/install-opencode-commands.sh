#!/usr/bin/env sh
set -eu

repo_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$repo_root/.opencode/commands"
target_dir="${OPENCODE_COMMANDS_DIR:-$HOME/.config/opencode/commands}"
command_name=scout.md
source_file="$source_dir/$command_name"

if [ ! -f "$source_file" ]; then
  printf '%s\n' "Scout OpenCode command not found: $source_file" >&2
  exit 1
fi

mkdir -p "$target_dir"

# Remove command names previously shipped before Scout converged on one `/scout` entrypoint.
for stale_command in scout-resume.md scout-triage.md scout-one.md scout-all.md scout-review.md scout-audit.md scout-readiness.md; do
  stale_file="$target_dir/$stale_command"
  if [ -L "$stale_file" ] && [ "$(readlink "$stale_file")" = "$source_dir/$stale_command" ]; then
    rm "$stale_file"
  fi
done

target_file="$target_dir/$command_name"
if [ -e "$target_file" ] && [ ! -L "$target_file" ]; then
  printf '%s\n' "Refusing to replace regular file: $target_file" >&2
  exit 1
fi

if [ -L "$target_file" ]; then
  if [ "$(realpath "$target_file" 2>/dev/null || true)" != "$(realpath "$source_file")" ]; then
    printf '%s\n' "Refusing to replace symlink not owned by Scout: $target_file" >&2
    exit 1
  fi
else
  ln -s "$source_file" "$target_file"
fi

if [ "$(realpath "$target_file")" != "$(realpath "$source_file")" ]; then
  printf '%s\n' "Scout OpenCode command link verification failed: $target_file" >&2
  exit 1
fi

printf 'Installed Scout OpenCode commands to %s\n' "$target_dir"
printf '%s\n' 'Restart OpenCode so the command menu reloads them.'
