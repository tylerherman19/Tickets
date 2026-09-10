#!/usr/bin/env python3
"""Ticket watch checker. Reads tix_watches from Supabase, resolves watched
events from tix_catalog, fetches those Gametime event pages (anonymous SEO
gate: window.__data.redux.listings.listings), records cheapest all-in price
per club group per watch, and texts alerts through Gmail SMTP -> carrier gateway
when a listing with qty+ seats together lands under the watch's
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
PROVIDER_GATEWAYS = {
    "tmobile": "tmomail.net",
    "verizon": "vzwpix.com",
    "xfinity": "mypixmessages.com",
    "uscellular": "email.uscc.net",
}

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
    payload = re.sub(r'("(?:\\.|[^"\\])*"|undefined)', lambda m: "null" if m.group(0) == "undefined" else m.group(0), html[i:end])
    d = json.loads(payload)
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

def allows_quantity(listing, qty):
    """The seller must permit exactly the requested lot, not merely have enough seats."""
    if not isinstance(qty, int) or not 1 <= qty <= 8: return False
    seats = listing.get("seats") or []
    lots = listing.get("availableLots")
    # Unknown allowed quantities are not proof that the requested lot can be bought.
    return isinstance(lots, list) and qty in lots and len(seats) >= qty

def cheapest_any(listings, qty):
    best = None
    for l in listings:
        seats = l.get("seats") or []
        p = (l.get("price") or {}).get("total")
        if p is None or p <= 0 or not allows_quantity(l, qty): continue
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
        if not allows_quantity(l, qty): continue
        total = ((l.get("price") or {}).get("total"))
        if total is None or total <= 0: continue
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
    if not rows: raise RuntimeError("No catalog events could be fetched")
    today = NOW.date().isoformat()
    vals = [r for r in rows.values() if r["event_date"] >= today]
    if not vals: raise RuntimeError("No future catalog events could be fetched")
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
        return sb("GET", "tix_events_v?event_id=in.(" + ",".join(f'"{i}"' for i in ids) + f")&event_date=gte.{today}&select={cols}")
    if kind == "team":
        slug = (m.get("slug") or "").lower()
        ha = m.get("home_away") or "any"
        q = f"tix_events_v?slug=ilike.*{urllib.parse.quote(slug)}*&event_date=gte.{today}&select={cols}&limit=400"
        if m.get("category"):
            q = f"tix_events_v?category=eq.{urllib.parse.quote(m['category'])}&slug=ilike.*{urllib.parse.quote(slug)}*&event_date=gte.{today}&select={cols}&limit=400"
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
        if not d or d < today: return []
        q = f"tix_events_v?event_date=eq.{d}&select={cols}&order=event_date,event_id&limit=400"
        if m.get("state"): q += f"&state=eq.{urllib.parse.quote(m['state'])}"
        if m.get("city"): q += f"&city=ilike.{urllib.parse.quote(m['city'])}"
        rows = sb("GET", q)
        vslug = m.get("venue_slug")
        slug = (m.get("slug") or "").lower()
        return [c for c in rows
                if (not vslug or c.get("venue_slug") == vslug)
                and (not slug or slug in (c.get("slug") or "").lower())]
    return []

# ---------- alerts ----------
def write_state(key, value):
    sb("POST", "tix_state?on_conflict=k", [{"k": key, "v": value, "updated_at": datetime.now(timezone.utc).isoformat()}], prefer="resolution=merge-duplicates,return=minimal")

def destination_address(destination):
    if not destination: return ""
    phone = str(destination.get("phone_digits") or "")
    domain = PROVIDER_GATEWAYS.get(destination.get("provider"))
    return f"{phone}@{domain}" if re.fullmatch(r"[2-9][0-9]{2}[2-9][0-9]{6}", phone) and domain else ""

def send_sms(subject, body, recipient=None, test=False):
    recipient = recipient or SMS_GATEWAY
    if not GMAIL_ADDRESS or not GMAIL_APP_PASSWORD or not recipient:
        print("alert: notification configuration missing"); write_state("notification_health", {"status":"failed", "checked_at":datetime.now(timezone.utc).isoformat(), "test":test}); return False
    import smtplib, ssl
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["From"] = GMAIL_ADDRESS
    msg["To"] = recipient
    msg["Subject"] = subject
    msg.set_content(body)
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=30) as s:
            s.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD.replace(" ", ""))
            s.send_message(msg)
        print("alert: mail server accepted message (carrier receipt not confirmed)"); write_state("notification_health", {"status":"accepted", "checked_at":datetime.now(timezone.utc).isoformat(), "test":test}); return True
    except Exception as e:
        print(f"alert: gmail smtp failed: {type(e).__name__}"); write_state("notification_health", {"status":"failed", "checked_at":datetime.now(timezone.utc).isoformat(), "test":test}); return False

def send_pending_confirmations():
    rows = sb("GET", "tix_confirmation_queue?sent_at=is.null&attempts=lt.3&select=*&order=requested_at.asc&limit=25")
    accepted = 0
    for queued in rows:
        watch_id = queued["watch_id"]
        destinations = sb("GET", f"tix_destinations?watch_id=eq.{watch_id}&select=phone_digits,provider&limit=1")
        watches = sb("GET", f"tix_watches?id=eq.{watch_id}&select=threshold_cents&limit=1")
        recipient = destination_address(destinations[0]) if destinations else ""
        if not recipient or not watches:
            sb("PATCH", f"tix_confirmation_queue?watch_id=eq.{watch_id}", {"attempts": queued["attempts"] + 1, "last_error": "delivery configuration missing"})
            continue
        label = re.sub(r"\s+", " ", queued.get("event_label") or "your event").strip()[:70]
        target = fmt_money(watches[0]["threshold_cents"])
        body = f"We're on the lookout for tickets to {label} at {target} or less. We'll text you when the price hits."
        ok = send_sms("Ticketline is on it", body, recipient=recipient)
        update = {"attempts": queued["attempts"] + 1, "last_error": None if ok else "send failed"}
        if ok:
            update["sent_at"] = datetime.now(timezone.utc).isoformat()
            accepted += 1
        sb("PATCH", f"tix_confirmation_queue?watch_id=eq.{watch_id}", update)
    if rows: print(f"confirmations accepted: {accepted}/{len(rows)}")
    return len(rows) - accepted

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

def fmt_money(cents): return f"${cents/100:,.2f}" if cents % 100 else f"${cents/100:,.0f}"

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
def valid_watch(w):
    return (w.get("kind") in ("event", "team", "date")
            and isinstance(w.get("qty"), int) and 1 <= w["qty"] <= 8
            and isinstance(w.get("threshold_cents"), int) and 100 <= w["threshold_cents"] <= 5000000
            and w.get("alert_style") in ("first", "repeat"))

def scan_result(watch_id, event_id, outcome, checked_at):
    sb("POST", "tix_scans?on_conflict=watch_id,event_id", [{"watch_id": watch_id, "event_id": event_id,
       "outcome": outcome, "checked_at": checked_at}], prefer="resolution=merge-duplicates,return=minimal")

def main():
    has_saved_destination = bool(sb("GET", "tix_destinations?select=watch_id&limit=1"))
    health = {"checked_at": NOW.isoformat(), "sms_configured": bool(GMAIL_ADDRESS and GMAIL_APP_PASSWORD and (SMS_GATEWAY or has_saved_destination)),
              "status": "ok", "checked_events": 0, "failed_events": 0}
    if os.environ.get("TIX_TEST_SMS") == "true":
        ok = send_sms("Ticketline test", "Ticketline: your ticket alerts are connected. This is a delivery test, not a ticket offer.", test=True)
        if not ok: health["status"] = "error"
        write_state("collector_health", health)
        if not ok: raise RuntimeError("Test text was not accepted by the mail server")
        return
    try:
        if catalog_stale(): refresh_catalog()
    except Exception as e:
        print(f"catalog refresh failed: {type(e).__name__}", file=sys.stderr)
        health["catalog_refresh_failed"] = True

    if send_pending_confirmations():
        health["status"] = "error"

    watches = sb("GET", "tix_watches?active=eq.true&select=*")
    invalid = [w for w in watches if not valid_watch(w)]
    if invalid:
        print(f"{len(invalid)} invalid watches skipped", file=sys.stderr)
        health["status"] = "error"
    watches = [w for w in watches if valid_watch(w)]
    print(f"{len(watches)} active watches")
    if not watches:
        write_state("collector_health", health)
        if health["status"] == "error": raise RuntimeError("Some ticket confirmations failed; see collector status")
        return
    resolved, events, watchers = {}, {}, {}
    for w in watches:
        try:
            rows = resolve_events(w)
        except Exception as e:
            print(f"resolve {w['id']} failed: {type(e).__name__}", file=sys.stderr)
            health["status"] = "error"
            continue
        resolved[w["id"]] = rows
        for cat in rows:
            eid = cat["event_id"]
            events[eid] = cat
            watchers.setdefault(eid, []).append(w)
    print(f"{len(events)} unique watched events")
    scans = {}
    for w in watches:
        for r in sb("GET", f"tix_scans?watch_id=eq.{w['id']}&select=*&limit=1000"):
            scans[(w["id"], r["event_id"])] = r
    due = []
    for eid, cat in events.items():
        days_out = (datetime.fromisoformat(cat["event_date"]).date() - NOW.date()).days
        if days_out < 0: continue
        interval = 12 if days_out <= FAST_WINDOW_DAYS else SLOW_CHECK_MINUTES
        oldest = NOW
        needs_check = False
        for w in watchers[eid]:
            last = scans.get((w["id"], eid))
            if not last:
                oldest = datetime.min.replace(tzinfo=timezone.utc); needs_check = True; continue
            ts = datetime.fromisoformat(last["checked_at"].replace("Z", "+00:00"))
            oldest = min(oldest, ts)
            criteria_ts = datetime.fromisoformat((w.get("criteria_updated_at") or w["created_at"]).replace("Z", "+00:00"))
            if ts < criteria_ts or (NOW - ts) >= timedelta(minutes=interval) or (last["outcome"] == "failed" and (NOW-ts) >= timedelta(minutes=12)):
                needs_check = True
        if needs_check: due.append((oldest, cat))
    # Oldest checked first: a busy team/date watch cannot starve other events.
    due.sort(key=lambda item: (item[0], item[1]["event_date"], item[1]["event_id"]))
    health["queued_events"] = max(0, len(due) - MAX_EVENT_FETCHES)
    due = [cat for _, cat in due[:MAX_EVENT_FETCHES]]
    print(f"{len(due)} event pages due for a check")
    sent = 0
    for cat in due:
        eid = cat["event_id"]
        checked_at = datetime.now(timezone.utc).isoformat()
        try:
            html = get_text(cat["url"])
            meta, listings = parse_event_page(html)
            if not meta or meta.get("event_id") != eid:
                raise ValueError("Event page did not contain the requested event")
            sb("PATCH", f"tix_catalog?event_id=eq.{eid}", {k:v for k,v in {
                "name":meta["name"], "datetime_local":meta["datetime_local"], "min_total":meta["min_total"],
                "last_seen":checked_at}.items() if v is not None})
            if meta.get("name"): cat["name"] = meta["name"]
            if meta.get("datetime_local"): cat["datetime_local"] = meta["datetime_local"]
            groups = club_groups(listings)
            if cat.get("venue_slug"):
                sb("POST", "tix_venue_clubs?on_conflict=venue_slug", [{"venue_slug":cat["venue_slug"],
                   "venue":cat.get("venue"), "clubs":sorted(groups.values(), key=lambda g:g["cheapest"]),
                   "sample_event_id":eid, "updated_at":checked_at}], prefer="resolution=merge-duplicates,return=minimal")
            for w in watchers[eid]:
                # Re-read before delivery: honor pause, delete, or edit made during a long run.
                current = sb("GET", f"tix_watches?id=eq.{w['id']}&select=*")
                if not current or not current[0]["active"]: continue
                fresh = current[0]
                if any(fresh.get(k) != w.get(k) for k in ("kind", "match", "clubs", "qty", "criteria_updated_at")): continue
                w = fresh
                club_level = (w.get("match") or {}).get("club_level", bool(w.get("clubs")))
                clubs = [g for g in (w.get("clubs") or list(groups)) if g in groups] if club_level else ["Any section"]
                found = False
                for club in clubs:
                    best = cheapest_any(listings, w["qty"]) if club == "Any section" else cheapest_for(listings, club, w["qty"])
                    if not best: continue
                    found = True
                    price,lid,lurl,sec,row,nseats = best
                    url = lurl or cat["url"]
                    if not url.startswith("https://gametime.co/"): url = cat["url"]
                    sb("POST", "tix_prices", [{"watch_id":w["id"], "event_id":eid, "event_label":cat.get("name"),
                       "club":club, "qty":w["qty"], "price_cents":price, "listing_id":lid,
                       "listing_url":url, "checked_at":checked_at}], prefer="return=minimal")
                    if price > w["threshold_cents"]: continue
                    if already_alerted(w["id"], eid, club, 60 if w["alert_style"] == "repeat" else None): continue
                    subject = f"Ticketline: {fmt_money(price)} tickets"
                    body = (f"{cat.get('name') or eid} {fmt_when(cat)}. {w['qty']} tickets together, "
                            f"{fmt_money(price)}/ticket including fees; {fmt_money(price*w['qty'])} total. "
                            f"{club}, sec {sec}, row {row}. At or below your {fmt_money(w['threshold_cents'])} target. {url}")
                    destinations = sb("GET", f"tix_destinations?watch_id=eq.{w['id']}&select=phone_digits,provider&limit=1")
                    recipient = destination_address(destinations[0]) if destinations else SMS_GATEWAY
                    ok = send_sms(subject, body, recipient=recipient)
                    sb("POST", "tix_alerts", [{"watch_id":w["id"], "event_id":eid, "club":club, "qty":w["qty"],
                       "price_cents":price, "listing_id":lid, "listing_url":url, "status":"sent" if ok else "failed"}], prefer="return=minimal")
                    if ok: sent += 1
                    else: health["status"] = "error"
                scan_result(w["id"], eid, "ok" if found else "unavailable", checked_at)
            health["checked_events"] += 1
        except Exception as e:
            health["failed_events"] += 1
            health["status"] = "error"
            print(f"check {eid} failed: {type(e).__name__}: {e}", file=sys.stderr)
            for w in watchers[eid]:
                try: scan_result(w["id"], eid, "failed", checked_at)
                except Exception: pass  # watch may have been deleted during the fetch
        time.sleep(1)
    health["checked_at"] = datetime.now(timezone.utc).isoformat()
    write_state("collector_health", health)
    print(f"done. events checked: {health['checked_events']}, failed: {health['failed_events']}, alerts accepted: {sent}")
    if health["status"] == "error": raise RuntimeError("Some ticket checks or deliveries failed; see collector status")

if __name__ == "__main__":
    main()
