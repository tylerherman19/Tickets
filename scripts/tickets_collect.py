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
import html as html_lib, json, os, re, sys, time, urllib.request, urllib.error, urllib.parse
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
DISCOVERY_NEAR_FETCHES = 20
DISCOVERY_LATER_FETCHES = 8
DISCOVERY_SEED_CITIES = (('Minneapolis','MN'),('Milwaukee','WI'))
DISCOVERY_SEED_CATEGORIES = ('mlb-baseball','nfl-football','nba-basketball','nhl-hockey')
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

def get_text(url, tries=3, timeout=120):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read().decode("utf-8", "replace")
        except Exception:
            if i == tries - 1: raise
            time.sleep(3)

# ---------- gametime parsing ----------
def _decode_astro(value):
    """Decode Astro's compact serialized props format."""
    if isinstance(value, dict):
        return {key: _decode_astro(item) for key, item in value.items()}
    if isinstance(value, list):
        if len(value) == 1 and isinstance(value[0], int):
            return None
        if len(value) == 2 and isinstance(value[0], int):
            tag, payload = value
            if tag == 1:
                return [_decode_astro(item) for item in payload]
            return _decode_astro(payload)
        return [_decode_astro(item) for item in value]
    return value


def _parse_astro_event_page(page):
    """Extract the EventListings island used by Gametime's current Astro site."""
    match = re.search(
        r'<astro-island\b(?=[^>]*\bcomponent-export="EventListings")'
        r'[^>]*\bprops="([^"]*)"', page)
    if not match:
        return None, []
    props = _decode_astro(json.loads(html_lib.unescape(match.group(1))))
    full_event = props.get("fullEvent") or {}
    event = full_event.get("event") or {}
    response = props.get("listingsResponse") or {}
    listings = response.get("listings") or []
    if not event:
        return None, listings
    venue = event.get('venue') or {}
    return {
        "event_id": event.get("id") or props.get("eventId"),
        "name": event.get("name"),
        "category": event.get("category"),
        "datetime_local": event.get("datetimeLocal"),
        "min_total": (event.get("minPrice") or {}).get("total"),
        "url": event.get("seoUrl") or props.get("eventPath"),
        "venue": venue.get('name') if isinstance(venue,dict) else venue,
    }, listings


def parse_event_page(page):
    """Extract event metadata and listings from current or legacy pages."""
    i = page.find("window.__data=")
    if i < 0:
        return _parse_astro_event_page(page)
    i += len("window.__data=")
    depth = 0; in_str = False; esc = False; end = None
    for j in range(i, len(page)):
        c = page[j]
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
    payload = re.sub(r'("(?:\\.|[^"\\])*"|undefined)', lambda m: "null" if m.group(0) == "undefined" else m.group(0), page[i:end])
    data = json.loads(payload)
    redux = data.get("redux", {})
    listings = (redux.get("listings") or {}).get("listings") or []
    meta = None
    full_events = (((redux.get("data") or {}).get("fullEvents") or {}).get("events")) or {}
    for event_id, wrap in full_events.items():
        event = wrap.get("event") or {}
        meta = {
            "event_id": event.get("id") or event_id,
            "name": event.get("name"),
            "category": event.get("category"),
            "datetime_local": event.get("datetimeLocal"),
            "min_total": ((event.get("minPrice") or {}).get("total")),
            "url": event.get("seoUrl"),
            "venue": (event.get('venue') or {}).get('name') if isinstance(event.get('venue'),dict) else event.get('venue'),
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

def market_spreads(listings):
    """Low, median, and high current listing prices by permitted ticket lot."""
    out = {}
    for qty in range(1, 9):
        values = sorted((l.get("price") or {}).get("total") for l in listings
                        if (l.get("price") or {}).get("total") and allows_quantity(l, qty))
        if values:
            out[str(qty)] = {"low": values[0], "typical": values[len(values)//2], "high": values[-1], "listings": len(values)}
    return out

def allows_quantity(listing, qty):
    """The seller must permit exactly the requested lot, not merely have enough seats."""
    if not isinstance(qty, int) or not 1 <= qty <= 8: return False
    seats = listing.get("seats") or []
    lots = listing.get("availableLots")
    # The rendered provider page filters these links to one requested quantity.
    # This is direct evidence for that quantity only, not for splittable lots.
    if listing.get('verified_quantity') == qty:
        return True
    # Unknown allowed quantities are not proof that the requested lot can be bought.
    return isinstance(lots, list) and qty in lots and len(seats) >= qty

def check_interval_minutes(days_out, price_cents=None, threshold_cents=None):
    """A 15-minute workflow can only realize 15-minute or slower intervals."""
    if days_out <= 2: return 15
    if days_out <= FAST_WINDOW_DAYS: return 15
    if price_cents and threshold_cents and price_cents <= threshold_cents * 1.1: return 15
    if days_out <= 30: return 60
    return 180

def page_outcome(page, meta):
    """Never confuse changed provider markup with an empty inventory."""
    if not meta: return 'parser_failure'
    if 'window.__data=' not in page and 'component-export="EventListings"' not in page:
        return 'parser_failure'
    if 'window.__data=' in page and '"listings"' not in page:
        return 'metadata_only'
    if 'component-export="EventListings"' in page and 'listingsResponse' not in page:
        return 'metadata_only'
    return 'ok'

def page_shape(page, meta, listings):
    """Safe structural diagnostics; never log provider HTML or ticket contents."""
    return {'bytes':len(page), 'legacy': 'window.__data=' in page,
            'astro': 'component-export="EventListings"' in page,
            'listings_key': '"listings"' in page,
            'listings_response': 'listingsResponse' in page,
            'lot_keys': page.count('availableLots'),
            'event':bool(meta), 'listings':len(listings)}

def fetch_provider_page(url, discovery=False):
    """Retry an incomplete provider render once before recording its state."""
    for attempt in range(2):
        page = get_text(url,tries=1,timeout=25) if discovery else get_text(url)
        try:
            meta,listings = parse_event_page(page)
            outcome = page_outcome(page,meta)
        except (ValueError,TypeError,KeyError) as error:
            if attempt == 0: continue
            raise ValueError(f'parser_failure: {type(error).__name__}') from error
        if outcome != 'ok':
            print(f"provider response {outcome} attempt {attempt+1}: {page_shape(page,meta,listings)}")
        if outcome == 'ok' or attempt == 1:
            return outcome,meta,listings
    raise ValueError('parser_failure: no event data')

def rendered_quantity_listings(url, quantities):
    """Read all-in cards from the ordinary, quantity-filtered event page.

    Return None for an incomplete render. Never turn a browser failure into
    zero inventory or infer that a seller will split a larger lot.
    """
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
    from urllib.parse import urlsplit, parse_qs, urlencode, urlunsplit
    if urlsplit(url).hostname != 'gametime.co':
        raise ValueError('parser_failure: unsafe event URL')
    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'],timeout=30000)
        try:
            page = browser.new_page()
            for qty in sorted(set(quantities)):
                if not isinstance(qty, int) or not 1 <= qty <= 8:
                    continue
                parts = urlsplit(url)
                query = {k:v[-1] for k,v in parse_qs(parts.query).items() if k not in ('listingId','quantity')}
                query['quantity'] = str(qty)
                filtered_url = urlunsplit((parts.scheme,parts.netloc,parts.path,urlencode(query),''))
                response = page.goto(filtered_url,wait_until='domcontentloaded',timeout=35000)
                if not response or response.status >= 400:
                    return None
                # The older page sometimes arrives only after a real browser
                # navigation. Its embedded listings retain exact cents and
                # seller-provided availableLots, so prefer them to rounded UI.
                _,embedded = parse_event_page(page.content())
                if embedded and any(allows_quantity(l,qty) for l in embedded):
                    results.extend(embedded)
                    continue
                try:
                    page.locator('a[href*="listingId="] [data-testid="listing-card-current-price"]').first.wait_for(timeout=25000)
                except PlaywrightTimeout:
                    return None
                if f'{qty} Ticket' not in page.locator('body').inner_text()[:500]:
                    return None
                cards = page.locator('a[href*="listingId="]').evaluate_all('''nodes => nodes.map(a => ({
                    href:a.href,
                    price:a.querySelector('[data-testid="listing-card-current-price"] price-display')?.getAttribute('cents'),
                    fees:!!a.querySelector('[data-testid="listing-card-includes-fees"]'),
                    group:a.querySelector('[data-testid="listing-card-details"] h3')?.textContent?.trim(),
                    seat:a.querySelector('[data-testid="listing-seat-details"]')?.textContent?.trim()
                }))''')
                parsed = parse_rendered_cards(cards,qty)
                if not parsed:
                    return None
                results.extend(parsed)
        finally:
            browser.close()
    unique = {}
    for listing in results:
        unique[(listing.get('id'),listing.get('verified_quantity'))] = listing
    return list(unique.values())

def parse_rendered_cards(cards, qty):
    """Keep only exact-quantity, fee-inclusive provider listing links."""
    from urllib.parse import urlsplit, parse_qs
    out = {}
    for card in cards:
        try:
            parts = urlsplit(card.get('href') or '')
            params = parse_qs(parts.query)
            listing_id = params.get('listingId',[''])[0]
            if (parts.scheme != 'https' or parts.hostname != 'gametime.co'
                or params.get('quantity') != [str(qty)] or not listing_id
                or not card.get('fees')):
                continue
            cents = int(card.get('price'))
            if cents <= 0: continue
            group = (card.get('group') or '').strip()
            seat = (card.get('seat') or '').strip()
            section, _, row = seat.partition(', Row ')
            out[listing_id] = {'id':listing_id,'seoUrl':card['href'],
                'price':{'total':cents},'verified_quantity':qty,
                'spot':{'sectionGroup':group,'section':section,'row':row}}
        except (TypeError,ValueError):
            continue
    return list(out.values())

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

def owner_email(watch_id):
    rows = sb("POST", "rpc/tix_owner_email", {"p_watch_id": watch_id})
    return rows if isinstance(rows, str) and re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", rows) else ""

def send_sms(subject, body, recipient=None, test=False):
    if test and not recipient:
        recipient = SMS_GATEWAY
    channel = "carrier text" if recipient and recipient.rsplit("@", 1)[-1] in PROVIDER_GATEWAYS.values() else "email"
    if not GMAIL_ADDRESS or not GMAIL_APP_PASSWORD or not recipient:
        print("alert: notification configuration missing"); write_state("notification_health", {"status":"failed", "channel":channel, "checked_at":datetime.now(timezone.utc).isoformat(), "test":test}); return False
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
        print(f"alert: mail server accepted {channel} message (recipient receipt not confirmed)"); write_state("notification_health", {"status":"accepted", "channel":channel, "checked_at":datetime.now(timezone.utc).isoformat(), "test":test}); return True
    except Exception as e:
        print(f"alert: gmail smtp failed: {type(e).__name__}"); write_state("notification_health", {"status":"failed", "channel":channel, "checked_at":datetime.now(timezone.utc).isoformat(), "test":test}); return False

def send_pending_confirmations():
    sms_rows = sb("GET", "tix_confirmation_queue?sms_enabled=eq.true&sent_at=is.null&attempts=lt.3&select=*&order=requested_at.asc&limit=25")
    email_rows = sb("GET", "tix_confirmation_queue?email_enabled=eq.true&email_sent_at=is.null&email_attempts=lt.3&select=*&order=requested_at.asc&limit=25")
    rows = {r["watch_id"]: r for r in sms_rows + email_rows}.values()
    accepted = 0
    for queued in rows:
        watch_id = queued["watch_id"]
        watches = sb("GET", f"tix_watches?id=eq.{watch_id}&select=threshold_cents&limit=1")
        label = re.sub(r"\s+", " ", queued.get("event_label") or "your event").strip()[:70]
        target = fmt_money(watches[0]["threshold_cents"]) if watches else "your target"
        update = {}
        if queued.get("email_enabled") and not queued.get("email_sent_at") and queued.get("email_attempts",0) < 3:
            recipient = owner_email(watch_id)
            ok = bool(recipient and watches and send_sms("Ticketline alert confirmed", f"We're watching {label} for tickets at {target} or less per ticket. We'll email you when a matching listing appears.", recipient=recipient))
            update.update(email_attempts=queued.get("email_attempts",0)+1,email_last_error=None if ok else "email send failed")
            if ok: update["email_sent_at"] = datetime.now(timezone.utc).isoformat(); accepted += 1
        if queued.get("sms_enabled") and not queued.get("sent_at") and queued.get("attempts",0) < 3:
            destinations = sb("GET", f"tix_destinations?watch_id=eq.{watch_id}&select=phone_digits,provider&limit=1")
            recipient = destination_address(destinations[0]) if destinations else ""
            ok = bool(recipient and watches and send_sms("Ticketline is on it", f"We're on the lookout for tickets to {label} at {target} or less. We'll text you when the price hits.", recipient=recipient))
            update.update(attempts=queued.get("attempts",0)+1,last_error=None if ok else "carrier gateway send failed")
            if ok: update["sent_at"] = datetime.now(timezone.utc).isoformat(); accepted += 1
        if update: sb("PATCH", f"tix_confirmation_queue?watch_id=eq.{watch_id}", update)
    if rows: print(f"confirmation channels accepted: {accepted}")
    return len(sms_rows) + len(email_rows) - accepted

def already_alerted(watch_id, event_id, club, repeat_window_min=None, criteria_version=1, channel="sms"):
    q = (f"tix_alerts?watch_id=eq.{watch_id}&event_id=eq.{event_id}&club=eq.{urllib.parse.quote(club)}&status=eq.sent"
         f"&criteria_version=eq.{criteria_version}&channel=eq.{channel}&select=sent_at&order=sent_at.desc&limit=1")
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

def scan_result(watch_id, event_id, outcome, checked_at, criteria_version=1, detail=None):
    sb("POST", "tix_scans?on_conflict=watch_id,event_id", [{"watch_id": watch_id, "event_id": event_id,
       "outcome": outcome, "checked_at": checked_at, "criteria_version":criteria_version,
       "detail":detail or {}}], prefer="resolution=merge-duplicates,return=minimal")

def record_event_market(cat, meta, listings, checked_at, status='ok'):
    """Persist a successful provider parse, including a genuine empty market."""
    eid = cat['event_id']
    new_date = (meta.get('datetime_local') or '')[:10]
    changes = []
    for field, new_value in [('datetime_local', meta.get('datetime_local')),
                             ('event_date', new_date), ('venue', meta.get('venue'))]:
        old_value = cat.get(field)
        if new_value and old_value and new_value != old_value and (field != 'event_date' or cat.get('datetime_local')):
            changes.append({'event_id':eid,'field':field,'old_value':old_value,
                            'new_value':new_value,'detected_at':checked_at})
    if changes: sb('POST','tix_event_changes',changes,prefer='return=minimal')
    listing_prices = [(l.get('price') or {}).get('total') for l in listings]
    real_prices = [p for p in listing_prices if isinstance(p,int) and p > 0]
    provider_min = meta.get('min_total')
    minimum = provider_min if isinstance(provider_min,int) and provider_min > 0 else min(real_prices,default=None)
    patch = {'price_checked_at':checked_at,'discovery_attempt_at':checked_at,
             'discovery_status':status,'min_total':minimum,'last_seen':checked_at}
    for key, value in [('name',meta.get('name')),('datetime_local',meta.get('datetime_local')),
                       ('event_date',new_date or None),('venue',meta.get('venue'))]:
        if value is not None: patch[key] = value
    sb('PATCH',f'tix_catalog?event_id=eq.{eid}',patch)
    if meta.get('name'): cat['name'] = meta['name']
    if meta.get('datetime_local'): cat['datetime_local'] = meta['datetime_local']
    groups = club_groups(listings)
    sorted_groups = sorted(groups.values(),key=lambda g:g['cheapest'])
    sb('POST','tix_event_market?on_conflict=event_id',[{'event_id':eid,'checked_at':checked_at,
       'by_qty':market_spreads(listings),'groups':sorted_groups,'listing_count':len(listings)}],
       prefer='resolution=merge-duplicates,return=minimal')
    if cat.get('venue_slug'):
        sb('POST','tix_venue_clubs?on_conflict=venue_slug',[{'venue_slug':cat['venue_slug'],
           'venue':cat.get('venue'),'clubs':sorted_groups,'sample_event_id':eid,
           'updated_at':checked_at}],prefer='resolution=merge-duplicates,return=minimal')
    return groups, len(changes)

def discovery_due():
    out = []
    out.extend(sb('POST','rpc/tix_requested_discovery',{'p_limit':8}))
    today = NOW.date().isoformat()
    end = (NOW.date()+timedelta(days=7)).isoformat()
    for city,state in DISCOVERY_SEED_CITIES:
        out.extend(sb('GET',f'tix_events_v?city=eq.{urllib.parse.quote(city)}&state=eq.{state}'
                      f'&event_date=gte.{today}&event_date=lte.{end}'
                      '&discovery_attempt_at=is.null&order=event_date,event_id&select=*&limit=4'))
    for category in DISCOVERY_SEED_CATEGORIES:
        out.extend(sb('GET',f'tix_events_v?category=eq.{category}'
                      f'&event_date=gte.{today}&event_date=lte.{end}'
                      '&name=not.ilike.*tbd*&discovery_attempt_at=is.null'
                      '&order=event_date,event_id&select=*&limit=2'))
    for start,end,limit in [(0,7,DISCOVERY_NEAR_FETCHES),(8,30,DISCOVERY_LATER_FETCHES)]:
        out.extend(sb('POST','rpc/tix_discovery_due',
                      {'p_from_days':start,'p_to_days':end,'p_limit':limit}))
    return list({row['event_id']:row for row in out}.values())

def main():
    has_saved_destination = bool(sb("GET", "tix_destinations?select=watch_id&limit=1"))
    health = {"checked_at": NOW.isoformat(), "email_configured": bool(GMAIL_ADDRESS and GMAIL_APP_PASSWORD),
              "sms_configured": bool(GMAIL_ADDRESS and GMAIL_APP_PASSWORD and (SMS_GATEWAY or has_saved_destination)),
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
        oldest = NOW
        needs_check = os.environ.get('TIX_FORCE_WATCHED') == 'true'
        for w in watchers[eid]:
            last = scans.get((w["id"], eid))
            if not last:
                oldest = datetime.min.replace(tzinfo=timezone.utc); needs_check = True; continue
            ts = datetime.fromisoformat(last["checked_at"].replace("Z", "+00:00"))
            oldest = min(oldest, ts)
            criteria_ts = datetime.fromisoformat((w.get("criteria_updated_at") or w["created_at"]).replace("Z", "+00:00"))
            last_price = sb("GET", f"tix_prices?watch_id=eq.{w['id']}&event_id=eq.{eid}&criteria_version=eq.{w.get('criteria_version',1)}&select=price_cents&order=checked_at.desc&limit=1")
            price = last_price[0]['price_cents'] if last_price else None
            interval = check_interval_minutes(days_out, price, w['threshold_cents'])
            if (last.get('criteria_version',1) != w.get('criteria_version',1) or ts < criteria_ts
                or (NOW - ts) >= timedelta(minutes=interval)
                or (last["outcome"] in ("failed","parser_failure","http_failure") and (NOW-ts) >= timedelta(minutes=15))):
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
            provider_status,meta,listings = fetch_provider_page(cat["url"])
            if provider_status == 'parser_failure':
                raise ValueError('parser_failure: provider event/listing data missing')
            if not meta or meta.get("event_id") != eid:
                raise ValueError("event_unavailable: event ID changed or removed")
            if provider_status == 'metadata_only':
                requested = {w['qty'] for w in watchers[eid]}
                try:
                    rendered = rendered_quantity_listings(cat['url'],requested)
                except Exception as error:
                    print(f"rendered listing check failed for {eid}: {type(error).__name__}",file=sys.stderr)
                    rendered = None
                if rendered is not None and all(any(allows_quantity(l,qty) for l in rendered) for qty in requested):
                    listings = rendered
                    provider_status = 'ok'
                    print(f"rendered listings verified for {eid}: {len(listings)} cards, quantities {sorted(requested)}")
            groups,change_count = record_event_market(cat,meta,listings,checked_at,provider_status)
            health['event_changes'] = health.get('event_changes',0)+change_count
            if provider_status == 'metadata_only':
                for w in watchers[eid]:
                    scan_result(w['id'],eid,'provider_incomplete',checked_at,w.get('criteria_version',1),
                                {'reason':'Provider supplied a get-in price without listing quantities'})
                health['provider_incomplete'] = health.get('provider_incomplete',0)+1
                if health['status'] == 'ok': health['status'] = 'degraded'
                health['checked_events'] += 1
                continue
            for w in watchers[eid]:
                # Re-read before delivery: honor pause, delete, or edit made during a long run.
                current = sb("GET", f"tix_watches?id=eq.{w['id']}&select=*")
                if not current or not current[0]["active"]: continue
                fresh = current[0]
                if any(fresh.get(k) != w.get(k) for k in ("kind", "match", "clubs", "qty", "threshold_cents", "alert_style", "criteria_version")): continue
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
                       "listing_url":url, "checked_at":checked_at,
                       "criteria_version":w.get('criteria_version',1)}], prefer="return=minimal")
                    if price > w["threshold_cents"]: continue
                    subject = f"Ticketline: {fmt_money(price)} tickets"
                    body = (f"{cat.get('name') or eid} {fmt_when(cat)}. {w['qty']} tickets together, "
                            f"{fmt_money(price)}/ticket including fees; {fmt_money(price*w['qty'])} total. "
                            f"{club}, sec {sec}, row {row}. At or below your {fmt_money(w['threshold_cents'])} target. {url}")
                    destinations = None
                    for channel in ("email", "sms"):
                        if not w.get(f"{channel}_enabled", channel == "email"): continue
                        if already_alerted(w["id"], eid, club, 60 if w["alert_style"] == "repeat" else None,
                                           w.get('criteria_version',1), channel=channel): continue
                        if channel == "email": recipient = owner_email(w["id"])
                        else:
                            if destinations is None:
                                destinations = sb("GET", f"tix_destinations?watch_id=eq.{w['id']}&select=phone_digits,provider&limit=1")
                            recipient = destination_address(destinations[0]) if destinations else ""
                        ok = send_sms(subject, body, recipient=recipient)
                        sb("POST", "tix_alerts", [{"watch_id":w["id"], "event_id":eid, "club":club, "qty":w["qty"],
                           "price_cents":price, "listing_id":lid, "listing_url":url, "status":"sent" if ok else "failed",
                           "criteria_version":w.get('criteria_version',1), "channel":channel}], prefer="return=minimal")
                        if ok: sent += 1
                        else: health["status"] = "error"
                scan_result(w["id"], eid, "ok" if found else "unavailable", checked_at,
                            w.get('criteria_version',1), {'listings_checked':len(listings),
                            'available_lots':sorted({n for l in listings for n in ((l.get('availableLots') or []) + ([l['verified_quantity']] if l.get('verified_quantity') else [])) if isinstance(n,int)}),
                            'matching_listings':sum(allows_quantity(l,w['qty']) for l in listings)})
            health["checked_events"] += 1
        except Exception as e:
            health["failed_events"] += 1
            health["status"] = "error"
            print(f"check {eid} failed: {type(e).__name__}: {e}", file=sys.stderr)
            outcome = ('parser_failure' if 'parser_failure' in str(e) else
                       'event_unavailable' if 'event_unavailable' in str(e) or
                       isinstance(e, urllib.error.HTTPError) and e.code in (404,410) else 'http_failure')
            health.setdefault('outcomes',{})[outcome] = health.setdefault('outcomes',{}).get(outcome,0)+1
            for w in watchers[eid]:
                try: scan_result(w["id"], eid, outcome, checked_at, w.get('criteria_version',1))
                except Exception: pass  # watch may have been deleted during the fetch
        time.sleep(1)
    # Discovery serves anonymous browsing. These capped scans are independent
    # of alert watches; a failed page is recorded and rotated behind other cities.
    discovery = discovery_due()
    health['discovery_queued'] = len(discovery)
    health['discovery_checked'] = 0
    health['discovery_failed'] = 0
    for cat in discovery:
        eid = cat['event_id']
        if eid in events: continue
        checked_at = datetime.now(timezone.utc).isoformat()
        try:
            provider_status,meta,listings = fetch_provider_page(cat['url'],discovery=True)
            if provider_status == 'parser_failure':
                raise ValueError('parser_failure: provider event/listing data missing')
            if not meta or meta.get('event_id') != eid:
                raise ValueError('event_unavailable: event ID changed or removed')
            _,change_count = record_event_market(cat,meta,listings,checked_at,provider_status)
            health['event_changes'] = health.get('event_changes',0)+change_count
            health['discovery_checked'] += 1
            if provider_status == 'metadata_only':
                health['discovery_metadata_only'] = health.get('discovery_metadata_only',0)+1
                if health['status'] == 'ok': health['status'] = 'degraded'
        except Exception as e:
            outcome = ('parser_failure' if 'parser_failure' in str(e) else
                       'event_unavailable' if 'event_unavailable' in str(e) or
                       isinstance(e,urllib.error.HTTPError) and e.code in (404,410) else 'http_failure')
            health['discovery_failed'] += 1
            health.setdefault('discovery_outcomes',{})[outcome] = health.setdefault('discovery_outcomes',{}).get(outcome,0)+1
            print(f'discovery {eid} failed: {outcome}: {type(e).__name__}',file=sys.stderr)
            sb('PATCH',f'tix_catalog?event_id=eq.{eid}',
               {'discovery_attempt_at':checked_at,'discovery_status':outcome})
        time.sleep(1)
    if health.get('discovery_outcomes',{}).get('parser_failure',0) >= 3:
        health['status'] = 'error'
    elif health['discovery_failed'] and health['status'] == 'ok':
        health['status'] = 'degraded'
    health["checked_at"] = datetime.now(timezone.utc).isoformat()
    write_state("collector_health", health)
    print(f"done. events checked: {health['checked_events']}, failed: {health['failed_events']}, alerts accepted: {sent}")
    if health["status"] == "error": raise RuntimeError("Some ticket checks or deliveries failed; see collector status")

if __name__ == "__main__":
    main()
