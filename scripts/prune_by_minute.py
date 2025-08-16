#!/usr/bin/env python
"""Prune images so only one (oldest or newest) per minute is kept based on filename pattern.

Filename pattern expected (default): processed_YYYYMMDD_HHMMSS_XXXXXX.jpg
Example: processed_20250816_060153_097913.jpg

It derives a minute key: YYYYMMDD_HHMM (first 13 chars after 'processed_') and keeps one file per minute.
You can choose strategy: oldest, newest, or first_seen (default first_seen encountered in directory order),
optionally doing a dry run.

Usage:
  python prune_by_minute.py --root path/to/images --pattern "processed_*.jpg" --strategy newest --dry-run
  python prune_by_minute.py --root path/to/images --delete

Safety:
 - By default is dry-run. Use --delete to actually remove.
 - Writes a log file summary if --log is provided.

Exit code 0 on success, >0 on error.
"""
from __future__ import annotations
import argparse
from pathlib import Path
import re
import sys
from typing import Dict, List, Tuple

FILENAME_RE = re.compile(r"processed_(\d{8})_(\d{6})_\d+\.[A-Za-z0-9]+$")

STRATEGIES = {"first_seen", "oldest", "newest"}

def minute_key(name: str) -> str | None:
    m = FILENAME_RE.match(name)
    if not m:
        return None
    date, hms = m.groups()
    # hms = HHMMSS; minute = HHMM
    return f"{date}_{hms[:4]}"  # YYYYMMDD_HHMM

def collect_files(root: Path, pattern: str) -> List[Path]:
    return sorted(root.glob(pattern))

def choose_keep(files: List[Path], strategy: str) -> Path:
    if strategy == 'first_seen':
        return files[0]
    elif strategy == 'oldest':
        return min(files, key=lambda p: p.stat().st_mtime)
    elif strategy == 'newest':
        return max(files, key=lambda p: p.stat().st_mtime)
    else:
        raise ValueError(f"Unknown strategy: {strategy}")

def plan(root: Path, pattern: str, strategy: str) -> Tuple[List[Path], List[Path]]:
    groups: Dict[str, List[Path]] = {}
    all_files = collect_files(root, pattern)
    for f in all_files:
        mk = minute_key(f.name)
        if not mk:
            continue
        groups.setdefault(mk, []).append(f)
    keep: List[Path] = []
    delete: List[Path] = []
    for mk, files in groups.items():
        if len(files) == 1:
            keep.append(files[0])
            continue
        chosen = choose_keep(files, strategy)
        keep.append(chosen)
        for f in files:
            if f != chosen:
                delete.append(f)
    return keep, delete

def main():
    ap = argparse.ArgumentParser(description="Prune images to one per minute.")
    ap.add_argument('--root', type=Path, required=True, help='Directory containing images')
    ap.add_argument('--pattern', default='processed_*.jpg', help='Glob pattern (default processed_*.jpg)')
    ap.add_argument('--strategy', default='first_seen', choices=sorted(STRATEGIES), help='Which file to keep among duplicates for a minute')
    ap.add_argument('--delete', action='store_true', help='Actually delete (otherwise dry-run)')
    ap.add_argument('--log', type=Path, help='Optional path to write a log summary (dry-run and real)')
    args = ap.parse_args()

    if not args.root.is_dir():
        print(f"ERROR: root {args.root} is not a directory", file=sys.stderr)
        return 2

    keep, delete = plan(args.root, args.pattern, args.strategy)

    print(f"Minutes identified: {len(keep)} kept, {len(delete)} scheduled for deletion (strategy={args.strategy}).")
    if not args.delete:
        print("Dry run. Use --delete to actually remove the following files:")
    for f in delete[:20]:
        print(f"DELETE: {f}")
    if len(delete) > 20:
        print(f"... and {len(delete)-20} more")

    if args.delete:
        removed = 0
        for f in delete:
            try:
                f.unlink()
                removed += 1
            except Exception as e:
                print(f"Failed to delete {f}: {e}", file=sys.stderr)
        print(f"Deleted {removed} files.")

    if args.log:
        try:
            with args.log.open('w', encoding='utf-8') as fh:
                fh.write(f"strategy={args.strategy}\n")
                fh.write(f"kept={len(keep)} deleted={len(delete)}\n")
                for f in delete:
                    fh.write(f"DELETE {f}\n")
                for f in keep:
                    fh.write(f"KEEP {f}\n")
        except Exception as e:
            print(f"Failed to write log: {e}", file=sys.stderr)

    return 0

if __name__ == '__main__':
    raise SystemExit(main())
