#!/usr/bin/env python3
"""Ticket watch checker. Reads tix_watches from Supabase, resolves watched
events from tix_catalog, fetches those Gametime event pages (anonymous SEO
gate: window.__data.redux.listings.listings), records cheapest all-in price
per club group per watch, and texts alerts through Gmail SMTP -> carrier SMS gateway
gateway when a listing with qty+ seats together lands under the watch's
per-ticket threshold.

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, GMAIL_ADDRESS, GMAIL_APP_PASSWORD, SMS_GATEWAY
Runs in GitHub Actions; free, no auth needed for any Gametime read.
"""
import json, os, re, sys, time, urllib.request, urllib.error, urllib.parse
from datetime import datetime, timezone, timedelta

SB_URL = os.environ["SUPABASE_URL"].rstrip("/")
SB_KEY = os.environ["SUPABASE_SERVICE_KEY"]
SMS_GATEWAY = os.environ.get("SMS_GATEWAY", "")
GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"}
NOW = datetime.now(timezone.utc)
FAST_WINDOW_DAYS = 7          # events this close get checked every run
SLOW_CHECK_MINUTES = 60       # farther out: at most one check per hour
MAX_EVENT_FETCHES = 60
CLUB_RE = re.compile(r"club", re.I)
SITEMAPS = ["sport-events", "music-events", "comedy-events", "theater-events"]
CATALOG_TTL_HOURS = 6

# ---------- supabase rest ----------
def sb(method, path, body=None, prefer=None):
    url = f"{SB_URL}/rest/v1/{path}"
    h = {"apikey": SB_KEY, "Authorization": f"Bearer {SB_KEY}", "Content-Type": "application/json"}
    if prefer: h["Prefer"] = prefer
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    for i in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            err = e.read().decode()[:400]
            if i == 2:
                print(f"SB {method} {path} -> {e.code}: {err}", file=sys.stderr)
                raise
            time.sleep(2)
        except Exception:
            if i == 2: raise
            time.sleep(2)

def get_json(url, headers=None, tries=3):
    h = dict(UA); h.update(headers or {})
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode())
        except Exception:
            if i == tries - 1: raise
            time.sleep(3)

def get_text(url, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read().decode("utf-8", "replace")
        except Exception:
            if i == tries - 1: raise
            time.sleep(3)

# ---------- gametime parsing ----------
def parse_event_page(html):
    """Extract redux state; returns (event_meta, listings)."""
    i = html.find("window.__data=")
    if i < 0: return None, []
    i += len("window.__data=")
    depth = 0; in_str = False; esc = False; end = None
    for j in range(i, len(html)):
        c = html[j]
        if in_str:
            if esc: esc = False
            elif c == "\\": esc = True
            elif c == '"': in_str = False
        else:
            if c == '"': in_str = True
            elif c == "{": depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    end = j + 1; break
    if not end: return None, []
    d = json.loads(html[i:end].replace("undefined", "null"))
    redux = d.get("redux", {})
    listings = (redux.get("listings") or {}).get("listings") or []
    meta = None
    fe = (((redux.get("data") or {}).get("fullEvents") or {}).get("events")) or {}
    for _id, wrap in fe.items():
        ev = wrap.get("event") or {}
        meta = {
            "event_id": ev.get("id") or _id,
            "name": ev.get("name"),
            "category": ev.get("category"),
            "datetime_local": ev.get("datetimeLocal"),
            "min_total": ((ev.get("minPrice") or {}).get("total")),
            "url": ev.get("seoUrl"),
        }
        break
    return meta, listings

def club_groups(listings):
    """sectionGroup -> {listings, cheapest} for club groups only."""
    groups = {}
    for l in listings:
        spot = l.get("spot") or {}
        g = spot.get("sectionGroup")
        if not g or not CLUB_RE.search(g): continue
        total = ((l.get("price") or {}).get("total"))
        if total is None: continue
        cur = groups.setdefault(g, {"group": g, "listings": 0, "cheapest": None})
        cur["listings"] += 1
        if cur["cheapest"] is None or total < cur["cheapest"]:
            cur["cheapest"] = total
    return groups

def cheapest_any(listings, qty):
    best = None
    for l in listings:
        seats = l.get("seats") or []
        p = (l.get("price") or {}).get("total")
        if p is None or len(seats) < qty: continue
        spot = l.get("spot") or {}
        cand = (p, l.get("id"), l.get("seoUrl") or "", spot.get("section") or "?", spot.get("row") or "?", len(seats))
        if best is None or cand[0] < best[0]: best = cand
    return best

def cheapest_for(listings, group, qty):
    """Cheapest per-ticket all-in in a section group with >= qty seats together."""
    best = None
    for l in listings:
        spot = l.get("spot") or {}
        if spot.get("sectionGroup") != group: continue
        seats = l.get("seats") or []
        if len(seats) < qty: continue
        total = ((l.get("price") or {}).get("total"))
        if total is None: continue
        if best is None or total < best[0]:
            best = (total, l.get("id"), l.get("seoUrl"),
                    spot.get("section"), spot.get("row"), len(seats))
    return best

# ---------- catalog ----------
STATE_SET = {"al","ak","az","ar","ca","co","ct","de","fl","ga","hi","id","il","in","ia","ks","ky","la","me","md","ma","mi","mn","ms","mo","mt","ne","nv","nh","nj","nm","ny","nc","nd","oh","ok","or","pa","ri","sc","sd","tn","tx","ut","vt","va","wa","wv","wi","wy","dc",
             "ab","bc","mb","nb","nl","ns","on","pe","qc","sk"}
LOC_RE = re.compile(r"^https://gametime\.co/([^/]+)/(.+?)-tickets/(\d+)-(\d+)-(\d+)-(.+)/events/([0-9a-f]{24})$")

def humanize(slug):
    return " ".join(w.capitalize() for w in slug.replace("-at-", " at ").split("-"))

def parse_catalog_url(u):
    m = LOC_RE.match(u)
    if not m: return None
    category, slug, mo, d, y, rest, eid = m.groups()
    toks = rest.split("-")
    state_i = next((i for i, t in enumerate(toks) if t in STATE_SET), None)
    if state_i is None: return None
    city = " ".join(toks[:state_i]).title()
    state = toks[state_i].upper()
    venue_slug = "-".join(toks[state_i+1:])
    return {"event_id": eid, "category": category, "slug": slug,
            "name": humanize(slug), "event_date": f"{y}-{int(mo):02d}-{int(d):02d}",
            "venue_slug": venue_slug or None, "city": city, "state": state, "url": u}

def refresh_catalog():
    print("catalog: refreshing from sitemaps")
    rows = {}
    for sm in SITEMAPS:
        try:
            xml = get_text(f"https://gametime.co/sitemap/{sm}.xml")
        except Exception as e:
            print(f"catalog: {sm} fetch failed: {e}"); continue
        for u in re.findall(r"<loc>(https://gametime\.co/[^<]+/events/[0-9a-f]{24})</loc>", xml):
            r = parse_catalog_url(u)
            if r: rows[r["event_id"]] = r
        print(f"catalog: {sm} -> {len(rows)} cumulative")
    if not rows: return
    today = NOW.date().isoformat()
    vals = [r for r in rows.values() if r["event_date"] >= today]
    keys = list(vals[0].keys())
    for i in range(0, len(vals), 500):
        chunk = [{k: r[k] for k in keys} for r in vals[i:i+500]]
        sb("POST", "tix_catalog?on_conflict=event_id", chunk,
           prefer="resolution=merge-duplicates,return=minimal")
    print(f"catalog: upserted {len(vals)} future events")
    sb("DELETE", f"tix_catalog?event_date=lt.{today}")
    sb("POST", "tix_state?on_conflict=k", [{"k": "catalog_refreshed_at", "v": json.dumps(NOW.isoformat())}],
       prefer="resolution=merge-duplicates,return=minimal")

def catalog_stale():
    rows = sb("GET", "tix_state?k=eq.catalog_refreshed_at&select=v")
    if not rows: return True
    try:
        ts = datetime.fromisoformat(json.loads(rows[0]["v"]).replace("Z", "+00:00"))
        return (NOW - ts) > timedelta(hours=CATALOG_TTL_HOURS)
    except Exception:
        return True

# ---------- watch resolution ----------
def resolve_events(w):
    m = w.get("match") or {}
    kind = w.get("kind")
    today = NOW.date().isoformat()
    cols = "event_id,category,slug,name,event_date,datetime_local,venue_slug,venue,city,state,url"
    if kind == "event":
        ids = m.get("event_ids") or []
        if not ids: return []
        return sb("GET", "tix_catalog?event_id=in.(" + ",".join(f'"{i}"' for i in ids) + f")&select={cols}")
    if kind == "team":
        slug = (m.get("slug") or "").lower()
        ha = m.get("home_away") or "any"
        q = f"tix_catalog?slug=ilike.*{urllib.parse.quote(slug)}*&event_date=gte.{today}&select={cols}&limit=400"
        if m.get("category"):
            q = f"tix_catalog?category=eq.{urllib.parse.quote(m['category'])}&slug=ilike.*{urllib.parse.quote(slug)}*&event_date=gte.{today}&select={cols}&limit=400"
        rows = sb("GET", q)
        out = []
        for c in rows:
            cslug = (c.get("slug") or "").lower()
            home = cslug.endswith(f"-at-{slug}") or f"-at-{slug}-" in cslug
            away = cslug.startswith(f"{slug}-at-")
            if ha == "home" and not home: continue
            if ha == "away" and not away: continue
            if ha == "any" and not (home or away): continue
            out.append(c)
        return out
    if kind == "date":
        d = m.get("date")
        q = f"tix_catalog?event_date=eq.{d}&select={cols}&limit=400"
        if m.get("state"): q += f"&state=eq.{urllib.parse.quote(m['state'])}"
        if m.get("city"): q += f"&city=eq.{urllib.parse.quote(m['city'])}"
        rows = sb("GET", q)
        vslug = m.get("venue_slug")
        slug = (m.get("slug") or "").lower()
        return [c for c in rows
                if (not vslug or c.get("venue_slug") == vslug)
                and (not slug or slug in (c.get("slug") or "").lower())]
    return []

# ---------- alerts ----------
def send_sms(subject, body):
    if not GMAIL_ADDRESS or not GMAIL_APP_PASSWORD or not SMS_GATEWAY:
        print("alert: GMAIL_ADDRESS/GMAIL_APP_PASSWORD/SMS_GATEWAY missing, skipping send"); return False
    import smtplib, ssl
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = SMS_GATEWAY
    msg["Subject"] = subject
    msg.set_content(body)
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=30) as s:
            s.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD.replace(" ", ""))
            s.send_message(msg)
        print("alert: gmail smtp sent"); return True
    except Exception as e:
        print(f"alert: gmail smtp failed: {e}"); return False

def already_alerted(watch_id, event_id, club, repeat_window_min=None):
    q = (f"tix_alerts?watch_id=eq.{watch_id}&event_id=eq.{event_id}&club=eq.{urllib.parse.quote(club)}&status=eq.sent"
         f"&select=sent_at&order=sent_at.desc&limit=1")
    rows = sb("GET", q)
    if not rows: return False
    if repeat_window_min is None: return True
    try:
        ts = datetime.fromisoformat(rows[0]["sent_at"].replace("Z", "+00:00"))
        return (NOW - ts) < timedelta(minutes=repeat_window_min)
    except Exception:
        return True

def fmt_money(cents): return f"${cents/100:,.0f}"

def fmt_when(c):
    if c.get("datetime_local"):
        try:
            dt = datetime.fromisoformat(c["datetime_local"])
            return dt.strftime("%a %b %-d, %-I:%M %p")
        except Exception: pass
    try:
        dt = datetime.fromisoformat(c["event_date"])
        return dt.strftime("%a %b %-d")
    except Exception:
        return c.get("event_date") or ""

# ---------- main ----------
def main():
    if catalog_stale():
        try: refresh_catalog()
        except Exception as e: print(f"catalog refresh failed: {e}", file=sys.stderr)

    watches = sb("GET", "tix_watches?active=eq.true&select=*")
    if not watches:
        print("no active watches"); return
    print(f"{len(watches)} active watches")

    needed_ids = set()
    resolved = {}   # watch_id -> [catalog rows]
    for w in watches:
        rows = resolve_events(w)
        resolved[w["id"]] = rows
        needed_ids.update(r["event_id"] for r in rows)
    print(f"{len(needed_ids)} unique watched events")

    # due-ness: events within FAST_WINDOW get checked every run; others hourly
    last_check = {}
    if needed_ids:
        ids = ",".join(f'"{i}"' for i in needed_ids)
        for r in sb("GET", f"tix_prices?event_id=in.({ids})&select=event_id,checked_at&order=checked_at.desc&limit=2000"):
            last_check.setdefault(r["event_id"], r["checked_at"])
    due = []
    for eid in needed_ids:
        cat = next((c for rows in resolved.values() for c in rows if c["event_id"] == eid), None)
        if not cat: continue
        try:
            edate = datetime.fromisoformat(cat["event_date"]).replace(tzinfo=timezone.utc)
        except Exception:
            continue
        days_out = (edate - NOW).days
        if days_out <= FAST_WINDOW_DAYS:
            due.append(cat); continue
        lc = last_check.get(eid)
        if not lc:
            due.append(cat); continue
        try:
            ts = datetime.fromisoformat(lc.replace("Z", "+00:00"))
            if (NOW - ts) >= timedelta(minutes=SLOW_CHECK_MINUTES):
                due.append(cat)
        except Exception:
            due.append(cat)
    due = due[:MAX_EVENT_FETCHES]
    print(f"{len(due)} event pages due for a check")

    sent = 0
    for cat in due:
        eid = cat["event_id"]
        try:
            html = get_text(cat["url"])
        except Exception as e:
            print(f"fetch {eid} failed: {e}", file=sys.stderr); continue
        meta, listings = parse_event_page(html)
        if meta:
            sb("PATCH", f"tix_catalog?event_id=eq.{eid}",
               {k: v for k, v in {"name": meta["name"], "datetime_local": meta["datetime_local"],
                                  "min_total": meta["min_total"], "last_seen": NOW.isoformat()}.items() if v is not None})
            if meta.get("name"): cat["name"] = meta["name"]
            if meta.get("datetime_local"): cat["datetime_local"] = meta["datetime_local"]
        groups = club_groups(listings)
        if groups and cat.get("venue_slug"):
            vs = cat["venue_slug"]
            merged = {}
            try:
                ex = sb("GET", f"tix_venue_clubs?venue_slug=eq.{urllib.parse.quote(vs)}&select=clubs")
                if ex:
                    for g in (ex[0].get("clubs") or []):
                        merged[g["group"]] = g
            except Exception:
                pass
            for name, g in groups.items():
                old = merged.get(name)
                if not old or (g.get("cheapest") is not None and (old.get("cheapest") is None or g["cheapest"] < old["cheapest"])):
                    merged[name] = g
            sb("POST", "tix_venue_clubs?on_conflict=venue_slug",
               [{"venue_slug": vs, "venue": cat.get("venue"),
                 "clubs": sorted(merged.values(), key=lambda g: (g["cheapest"] is None, g["cheapest"] or 0)),
                 "sample_event_id": eid, "updated_at": NOW.isoformat()}],
               prefer="resolution=merge-duplicates,return=minimal")
        # event-wide price distribution for the picker's reference pricing
        try:
            pts = sorted(p["price"]["total"] for l in listings for p in [l] if l.get("price", {}).get("total"))
            if pts:
                def q(f):
                    return pts[min(len(pts) - 1, int(f * (len(pts) - 1)))]
                sb("POST", "tix_event_stats?on_conflict=event_id",
                   [{"event_id": eid, "name": cat.get("name"), "event_date": cat.get("event_date"),
                     "venue_slug": cat.get("venue_slug"), "listings": len(pts),
                     "low_cents": pts[0], "p25_cents": q(.25), "median_cents": q(.5),
                     "p75_cents": q(.75), "high_cents": pts[-1], "updated_at": NOW.isoformat()}],
                   prefer="resolution=merge-duplicates,return=minimal")
        except Exception as e:
            print(f"stats upsert failed for {eid}: {e}", file=sys.stderr)
        # evaluate each watch on this event
        for w in watches:
            rows = resolved.get(w["id"], [])
            if not any(r["event_id"] == eid for r in rows): continue
            m = w.get("match") or {}
            club_level = m.get("club_level", bool(w.get("clubs")))
            if club_level:
                club_iter = [c for c in (w.get("clubs") or list(groups.keys())) if c in groups]
            else:
                club_iter = ["Any section"] if listings else []
            for club in club_iter:
                if club == "Any section":
                    best = cheapest_any(listings, w["qty"])
                else:
                    best = cheapest_for(listings, club, w["qty"])
                if not best: continue
                price, lid, lurl, sec, row, nseats = best
                sb("POST", "tix_prices",
                   [{"watch_id": w["id"], "event_id": eid, "event_label": cat.get("name"),
                     "club": club, "qty": w["qty"], "price_cents": price,
                     "listing_id": lid, "listing_url": lurl}],
                   prefer="return=minimal")
                if price <= w["threshold_cents"]:
                    repeat = w.get("alert_style") == "repeat"
                    if already_alerted(w["id"], eid, club, 55 if repeat else None):
                        continue
                    label = cat.get("name") or eid
                    when = fmt_when(cat)
                    subject = f"TIX {club} {fmt_money(price)}"
                    body = (f"{club}: {fmt_money(price)}/ticket, {w['qty']}+ together "
                            f"(limit {fmt_money(w['threshold_cents'])}). {label} {when}. "
                            f"Sec {sec} row {row}. {lurl or cat['url']}")
                    ok = send_sms(subject, body)
                    sb("POST", "tix_alerts",
                       [{"watch_id": w["id"], "event_id": eid, "club": club, "qty": w["qty"],
                         "price_cents": price, "listing_id": lid, "listing_url": lurl,
                         "status": "sent" if ok else "failed"}],
                       prefer="return=minimal")
                    sent += 1
        time.sleep(1)
    print(f"done. alerts sent: {sent}")

if __name__ == "__main__":
    main()
