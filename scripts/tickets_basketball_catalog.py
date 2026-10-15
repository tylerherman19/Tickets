#!/usr/bin/env python3
"""Hosted college basketball catalog import; preserves existing saved prices."""
import contextlib
import os
import re
from collections import Counter
from datetime import datetime, timezone, timedelta
import tickets_collect as collect
from tickets_sweep import fetch_once


def catalog_rows(xml):
    urls = re.findall(r'<loc>(https://gametime\.co/[^<]+/events/[0-9a-f]{24})</loc>', xml)
    print('Sitemap categories:', dict(Counter(u.split('/')[3] for u in urls)))
    rows = {}
    today = datetime.now(timezone.utc).date()
    for url in urls:
        row = collect.parse_catalog_url(url)
        if not row or row['category'] != 'college-basketball':
            continue
        date = datetime.fromisoformat(row['event_date']).date()
        if today <= date <= today + timedelta(days=365):
            rows[row['event_id']] = row
    return list(rows.values())


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('Catalog import is hosted-only')
    guard = getattr(collect, 'GUARD', None)
    with guard.capture(None, 'catalog') if guard else contextlib.nullcontext():
        page = fetch_once('https://gametime.co/c/college-basketball')
        print('Islands:', re.findall(r'component-export="([^"]+)"', page))
        print('Event link samples:', re.findall(r'href="([^"]+/events/[0-9a-f]{24}[^"]*)"', page)[:3])
        for marker in ['seoUrl', 'eventPath', 'category', 'fullEvents']:
            offset = page.find(marker)
            print(marker, page[max(0, offset-80):offset+300])
        rows = []
    if not rows:
        raise RuntimeError('No upcoming college basketball catalog URLs found')
    for i in range(0, len(rows), 500):
        collect.sb('POST', 'tix_catalog?on_conflict=event_id', rows[i:i+500],
                   prefer='resolution=merge-duplicates,return=minimal')
    print(f'Imported {len(rows)} college basketball events; saved prices preserved')

if __name__ == '__main__':
    main()
