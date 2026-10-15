#!/usr/bin/env python3
"""Build the college-basketball school-name lookup used by the team picker.

Reads Gametime's public college basketball directory page and prints a JS
object literal (slug -> [kind, label, aliases]) for app.js. The slug is the
nickname slug already stored in tix_teams_v and in saved watches; it is never
changed here. kind "u" means exactly one school in the directory uses that
nickname; kind "s" means several do, so the picker keeps the nickname as the
name and only lists the schools. Nothing is written to the database.

Usage: python3 scripts/tickets_team_names.py [directory.html]
"""
import json, re, sys, urllib.request
from collections import defaultdict

def page_data(page):
    marker = "window.__data="
    if marker not in page:
        raise ValueError("Directory page data missing")
    raw = page.split(marker, 1)[1]
    raw = re.sub(r'("(?:\\.|[^"\\])*"|undefined)', lambda m: "null" if m.group(0) == "undefined" else m.group(0), raw)
    return json.JSONDecoder().raw_decode(raw)[0]

def objects(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from objects(item)
    elif isinstance(value, list):
        for item in value:
            yield from objects(item)

URL = "https://gametime.co/c/college-basketball"

def slugify(text):
    return re.sub(r"[^a-z0-9]+", "-", text.lower().replace("'", "")).strip("-")

def load(path=None):
    if path:
        return open(path, encoding="utf8").read()
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    return urllib.request.urlopen(req, timeout=30).read().decode("utf8")

def build(data):
    perf = {}
    for o in objects(data):
        slug = o.get("slug") or ""
        if o.get("category") == "cbb" and re.fullmatch(r"cbb[a-z0-9]+", slug) and o.get("name") and o.get("shortName"):
            perf[slug] = o
    groups = defaultdict(list)
    for o in perf.values():
        groups[slugify(o["shortName"])].append(o)
    out = {}
    for nick, items in sorted(groups.items()):
        schools = sorted({re.sub(r"\s+Basketball$", "", o["name"]).strip() for o in items})
        abbr = set()
        for o in items:
            m = re.match(r"^([A-Z0-9&]{2,6})\s", o.get("mediumName") or "")
            if m:
                abbr.add(m.group(1).lower())
        aliases = " ".join(sorted(abbr)) 
        if len(schools) == 1:
            out[nick] = ["u", schools[0] + " " + items[0]["shortName"], (schools[0].lower() + " " + aliases).strip()]
        else:
            out[nick] = ["s", schools, aliases]
    return out

if __name__ == "__main__":
    names = build(page_data(load(sys.argv[1] if len(sys.argv) > 1 else None)))
    print(json.dumps(names, separators=(",", ":"), ensure_ascii=False, sort_keys=True))
