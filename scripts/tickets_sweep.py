#!/usr/bin/env python3
"""Explicit hosted catalog-price sweep; no watches, notifications, or browser rendering."""
import contextlib
import json
import os
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta
from urllib.parse import urlsplit
import tickets_collect as collect


def event_ids(raw):
    ids = list(dict.fromkeys(raw.split(',')))
    if not 1 <= len(ids) <= 8 or any(not re.fullmatch(r'[0-9a-f]{24}', eid) for eid in ids):
        raise ValueError('Supply 1-8 comma-separated catalog event IDs')
    return ids


def fetch_once(url):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.netloc != 'gametime.co' or parts.query or parts.fragment:
        raise ValueError('Unsafe provider URL')
    guard = getattr(collect, 'GUARD', None)
    if guard:
        return guard.text(url, collect.UA, 25)
    # Compatibility with the pinned deployed collector. No retries, redirects,
    # browser subresources, or automatic continuation after provider blocking.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    with urllib.request.build_opener(NoRedirect()).open(
            urllib.request.Request(url, headers=collect.UA), timeout=25) as response:
        page = response.read().decode('utf-8', 'replace')
    if re.search(r'cf-chl-|px-captcha|g-recaptcha|hcaptcha|verify (?:you are|that you are) human|<title[^>]*>[^<]*(?:access denied|just a moment|attention required|captcha)', page, re.I):
        raise RuntimeError('Provider challenge; sweep stopped')
    return page


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('Price sweep is hosted-only')
    ids = event_ids(os.environ.get('TIX_SWEEP_EVENT_IDS', ''))
    today = datetime.now(timezone.utc).date()
    rows = collect.sb('GET', 'tix_events_v?event_id=in.('+','.join(ids)+')&select=*')
    if {row['event_id'] for row in rows} != set(ids):
        raise ValueError('Every event must exist in the public catalog')
    for row in rows:
        date = datetime.fromisoformat(row['event_date']).date()
        if not today <= date <= today + timedelta(days=365):
            raise ValueError('Every event must be upcoming within one year')
    guard = getattr(collect, 'GUARD', None)
    for row in sorted(rows, key=lambda r: (r['event_date'], r['event_id'])):
        with guard.capture(row['event_id'], 'detail') if guard else contextlib.nullcontext():
            page = fetch_once(row['url'])
            meta, listings = collect.parse_event_page(page)
            status = collect.page_outcome(page, meta)
            if not meta or meta.get('event_id') != row['event_id'] or status == 'parser_failure':
                raise ValueError('Provider event mismatch or parser failure; sweep stopped')
            checked = datetime.now(timezone.utc).isoformat()
            collect.record_event_market(row, meta, listings, checked, status)
            print(json.dumps({'event_id': row['event_id'], 'name': meta.get('name') or row['name'],
                              'price_cents': meta.get('min_total'), 'status': status, 'checked_at': checked}))

if __name__ == '__main__':
    main()
