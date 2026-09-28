#!/usr/bin/env python3
"""Run a recovery collector check only when the last completed check is late."""
import json
import os
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

STALE_MINUTES = 25

def needs_recovery(health, now=None):
    now = now or datetime.now(timezone.utc)
    if not isinstance(health, dict):
        return True
    try:
        checked_at = datetime.fromisoformat(str(health['checked_at']).replace('Z', '+00:00'))
        if checked_at.tzinfo is None:
            return True
        age = (now - checked_at).total_seconds() / 60
        return age >= STALE_MINUTES or age < -5
    except (KeyError, TypeError, ValueError):
        return True

def latest_health():
    base = os.environ['SUPABASE_URL'].rstrip('/')
    key = os.environ['SUPABASE_SERVICE_KEY']
    req = urllib.request.Request(base + '/rest/v1/tix_state?k=eq.collector_health&select=v&limit=1',
        headers={'apikey': key, 'Authorization': 'Bearer ' + key})
    with urllib.request.urlopen(req, timeout=10) as response:
        rows = json.load(response)
    value = rows[0]['v'] if rows else None
    return json.loads(value) if isinstance(value, str) else value

def main():
    try:
        health = latest_health()
    except Exception as error:
        print(f'watchdog: health lookup failed ({type(error).__name__}); attempting recovery', flush=True)
        health = None
    if not needs_recovery(health):
        print('watchdog: latest collector check is fresh; no duplicate run', flush=True)
        return
    print('watchdog: collector check is stale; starting recovery', flush=True)
    subprocess.run([sys.executable, str(Path(__file__).with_name('tickets_collect.py'))], check=True)

if __name__ == '__main__':
    main()
