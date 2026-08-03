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
