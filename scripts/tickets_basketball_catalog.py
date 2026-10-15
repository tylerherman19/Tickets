#!/usr/bin/env python3
"""Import provider-identified college basketball events from public directory pages."""
import contextlib
import json
import os
import re
from datetime import datetime, timezone, timedelta
from urllib.parse import urlsplit
import tickets_collect as collect
from tickets_sweep import fetch_once


def page_data(page):
    marker='window.__data='
    if marker not in page:
        raise ValueError('Directory page data missing')
    raw=page.split(marker,1)[1]
    raw=re.sub(r'("(?:\\.|[^"\\])*"|undefined)',lambda m:'null' if m.group(0)=='undefined' else m.group(0),raw)
    return json.JSONDecoder().raw_decode(raw)[0]


def objects(value):
    if isinstance(value,dict):
        yield value
        for item in value.values(): yield from objects(item)
    elif isinstance(value,list):
        for item in value: yield from objects(item)


def catalog_rows(data):
    rows={}
    today=datetime.now(timezone.utc).date()
    for event in objects(data):
        if event.get('category') != 'cbb': continue
        url=event.get('seoUrl') or event.get('seo_url') or ''
        row=collect.parse_catalog_url(url)
        if not row: continue
        if event.get('id') != row['event_id']: continue
        date=datetime.fromisoformat(row['event_date']).date()
        if not today <= date <= today+timedelta(days=365): continue
        row['category']='college-basketball'
        if event.get('name'): row['name']=event['name']
        rows[row['event_id']]=row
    return list(rows.values())


def team_pages(data):
    urls={}
    for item in objects(data):
        url=item.get('seoUrl') or item.get('seo_url') or ''
        parts=urlsplit(url)
        if item.get('category')=='cbb' and parts.scheme=='https' and parts.netloc=='gametime.co' and re.fullmatch(r'/[^/]+/performers/cbb[a-z0-9]+',parts.path) and not parts.query and not parts.fragment:
            urls[parts.path.rsplit('/',1)[-1]]=url
    # One bounded rotation per run; prioritize Syracuse on the initial import.
    ordered=sorted(urls)
    if 'cbbsyr' in ordered: ordered.remove('cbbsyr');ordered.insert(0,'cbbsyr')
    return [urls[key] for key in ordered[:7]]


def main():
    if os.environ.get('GITHUB_ACTIONS')!='true': raise RuntimeError('Catalog import is hosted-only')
    guard=getattr(collect,'GUARD',None)
    def load(url):
        with guard.capture(None,'catalog') if guard else contextlib.nullcontext():
            return page_data(fetch_once(url))
    directory=load('https://gametime.co/c/college-basketball')
    rows={row['event_id']:row for row in catalog_rows(directory)}
    for url in team_pages(directory):
        for row in catalog_rows(load(url)): rows[row['event_id']]=row
    if not rows: raise RuntimeError('No provider-identified college basketball events found')
    values=list(rows.values())
    for i in range(0,len(values),500):
        collect.sb('POST','tix_catalog?on_conflict=event_id',values[i:i+500],prefer='resolution=merge-duplicates,return=minimal')
    print(f'Imported {len(values)} college basketball events; saved prices preserved')

if __name__=='__main__': main()
