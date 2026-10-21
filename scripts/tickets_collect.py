#!/usr/bin/env python3
"""Ticket watch checker. Reads tix_watches from Supabase, resolves watched
events from tix_catalog, fetches those Gametime event pages (anonymous SEO
gate: window.__data.redux.listings.listings), records cheapest all-in price
per club group per watch, and texts alerts through Gmail SMTP -> carrier gateway
when a listing with qty+ seats together lands under the watch's
per-ticket threshold.

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, GMAIL_ADDRESS, GMAIL_APP_PASSWORD, SMS_GATEWAY
Runs in GitHub Actions. Anonymous page access does not establish collection permission.
Use --fixture PATH for offline parsing/selection without database writes or alerts.
"""
import html as html_lib, json, os, re, sys, time, urllib.request, urllib.error, urllib.parse
from datetime import datetime, timezone, timedelta
from ticket_emails import confirmation_email, price_alert_email, clean_text, valid_address

OFFLINE = '--fixture' in sys.argv
SB_URL = ('https://offline.invalid' if OFFLINE else os.environ["SUPABASE_URL"]).rstrip("/")
SB_KEY = 'offline' if OFFLINE else os.environ["SUPABASE_SERVICE_KEY"]
SMS_GATEWAY = os.environ.get("SMS_GATEWAY", "")
GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS", "")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD", "")

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"}
NOW = datetime.now(timezone.utc)
FAST_WINDOW_DAYS = 7          # events this close get checked every run
SLOW_CHECK_MINUTES = 60       # farther out: at most one check per hour
MAX_EVENT_FETCHES = 60
# Background discovery shares the 5,000/day budget with team/artist page
# sweeps, which price many events per request. Tracked (opened) events and
# one-off requested checks are foreground and come first.
DISCOVERY_NEAR_FETCHES = 12
DISCOVERY_LATER_FETCHES = 4
TRACKED_FETCHES = 40
BACKGROUND_PAUSE_SECONDS = 2
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
    # PostgreSQL 57014 cancels and rolls back the entire RPC transaction. Retry
    # that known rollback once with the same lease/payload, never a provider
    # fetch or an uncertain network write (which may already have committed).
    capture_write = method == 'POST' and path == 'rpc/tix_finish_capture'
    attempts = 3 if method == 'GET' else 2 if capture_write else 1
    for i in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode()
                return json.loads(raw) if raw else []
        except urllib.error.HTTPError as e:
            raw_error = e.read().decode()
            err = raw_error[:400]
            e.database_path = path
            try: e.postgres_code = json.loads(raw_error).get('code')
            except (ValueError,AttributeError): e.postgres_code = None
            if capture_write and i == 0 and e.code == 500:
                try: rolled_back = json.loads(raw_error).get('code') == '57014'
                except (ValueError,AttributeError): rolled_back = False
                if rolled_back:
                    print('Capture write rolled back on statement timeout; retrying the saved batch once.',file=sys.stderr)
                    time.sleep(2)
                    continue
            if method != 'GET' or i == 2:
                print(f"SB {method} {path} -> {e.code}: {err}", file=sys.stderr)
                raise
            time.sleep(2)
        except Exception:
            if method != 'GET' or i == 2: raise
            time.sleep(2)

def sb_all(path, page_size=500):
    """Service-side stable pages; never silently stop at the API row ceiling."""
    result=[];offset=0
    while True:
        page=sb('GET',path+('&' if '?' in path else '?')+f'limit={page_size}&offset={offset}')
        result.extend(page)
        if len(page)<page_size:return result
        offset+=len(page)

from ticketline_guard import Guard, CaptureDeferred
GUARD = Guard(lambda name,body: sb('POST','rpc/'+name,body))

def get_text(url, tries=1, timeout=25):
    # Only hosted Actions/Supabase may contact the provider. Offline fixtures
    # never need networking; fail closed if somebody runs this locally.
    if os.environ.get('GITHUB_ACTIONS') != 'true':
        raise RuntimeError('Provider requests are hosted-only')
    return GUARD.text(url,UA,min(timeout,25))

# Team, artist and show pages list many events with a get-in price each. Paths
# are harvested from pages already fetched; college basketball team pages are
# imported separately with their category.
PERFORMER_RE = re.compile(r'''(?:(?<=gametime\.co)|(?<=["'=\s(;>]))((?:/[a-z0-9-]{1,80}){1,2}/performers/[a-z0-9]{2,40})(?=["'?#&\\\s<]|$)''')
PERFORMERS = set()

def performer_paths(page, limit=100):
    out = []
    for path in PERFORMER_RE.findall(page.replace('\\/','/')):
        if '/performers/cbb' not in path and path not in out:
            out.append(path)
            if len(out) >= limit: break
    return out

def note_performers():
    paths = sorted(PERFORMERS)
    PERFORMERS.clear()
    added = 0
    for i in range(0, len(paths), 200):
        added += sb('POST','rpc/tix_note_performers',{'p_paths':paths[i:i+200]}) or 0
    return added

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
    if not isinstance(props,dict): return None, []
    full_event = props.get("fullEvent") or {}
    if not isinstance(full_event,dict): raise ValueError('parser_failure: invalid event wrapper')
    event = full_event.get("event") or {}
    state,listings = inventory_envelope(props,"listingsResponse")
    if not isinstance(event,dict) or not event:
        return None, listings
    venue = event.get('venue') or {}
    return {
        "_inventory_state":state,
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
    if not isinstance(data,dict): raise ValueError('parser_failure: invalid page payload')
    redux = data.get("redux", {})
    if not isinstance(redux,dict): raise ValueError('parser_failure: invalid page wrapper')
    state,listings = inventory_envelope(redux,"listings")
    meta = None
    full_events = (((redux.get("data") or {}).get("fullEvents") or {}).get("events")) or {}
    for event_id, wrap in full_events.items():
        if not isinstance(wrap,dict): raise ValueError('parser_failure: invalid event wrapper')
        event = wrap.get("event") or {}
        if not isinstance(event,dict) or not event: continue
        meta = {
            "_inventory_state":state,
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

def lots_of(listing):
    value = listing.get("availableLots")
    return value if value is not None else listing.get("available_lots")

def group_of(spot):
    return spot.get("sectionGroup") or spot.get("section_group")

def alias_value(obj, camel, snake):
    """Retain null/zero/empty values; conflicting extra-field aliases are unknown."""
    if camel in obj and snake in obj and (type(obj[camel]) is not type(obj[snake]) or obj[camel] != obj[snake]): return None
    return obj[camel] if camel in obj else obj.get(snake)

def cents_value(value, positive=False):
    return value if type(value) is int and value >= (1 if positive else 0) else None

def listing_fields(listing):
    """Nullable storage fields. History is opaque; no vendor schema or tier ranking."""
    price = listing.get('price') if isinstance(listing.get('price'),dict) else {}
    total = cents_value(price.get('total'),positive=True)
    base = cents_value(price.get('prefee'))
    tax = cents_value(alias_value(price,'salesTax','sales_tax'))
    pretax = cents_value(alias_value(price,'preTaxTotal','pre_tax_total'))
    consistent = (total is not None and base is not None and tax is not None
                  and base + tax <= total and (pretax is None or pretax == total-tax))
    lots = lots_of(listing)
    lots = sorted(set(lots)) if isinstance(lots,list) and all(type(n) is int and n>0 for n in lots) else None
    historical = alias_value(listing,'historicalPrice','historical_price')
    trend = alias_value(listing,'historicalTrend','historical_trend')
    hist = {'historical_price':historical,'historical_trend':trend} if any(
        key in listing for key in ('historicalPrice','historical_price','historicalTrend','historical_trend')) else None
    deal = listing.get('deal')
    return {'prefee_cents':base,'sales_tax_cents':tax,'pre_tax_total_cents':pretax,
            'deal':deal if isinstance(deal,str) and deal.strip() else None,
            'hist':hist,'lots':lots,
            'basis':'fees_included_tax_reported' if consistent else 'fees_included_tax_unknown'}

def quantity_state(listing, qty):
    if type(qty) is not int or not 1 <= qty <= 8: return 'unknown'
    lots = listing_fields(listing)['lots']
    seats = listing.get('seats')
    if lots is not None and qty not in lots: return 'disallowed'
    if isinstance(seats,list) and len(seats)<qty: return 'disallowed'
    if listing.get('verified_quantity') == qty: return 'allowed'
    if lots is None or not isinstance(seats,list): return 'unknown'
    return 'allowed'

def match_unknown(listing, watch):
    """An unconfirmed lot/group/amount is not evidence of an empty market."""
    if not isinstance(listing,dict): return True
    club_level=(watch.get('match') or {}).get('club_level',bool(watch.get('clubs')))
    group=group_of(listing.get('spot') or {})
    if club_level and (not isinstance(group,str) or not group): return True
    if club_level and (not CLUB_RE.search(group) or watch.get('clubs') and group not in watch['clubs']): return False
    state=quantity_state(listing,watch['qty'])
    return state=='unknown' or state=='allowed' and cents_value((listing.get('price') or {}).get('total'),positive=True) is None

def deal_gate_reason(listing, minimum):
    if not minimum: return None
    # No ranked tiers were observed in the one-off page inspection. Never guess.
    return 'deal_missing' if listing_fields(listing)['deal'] is None else 'deal_ranking_unverified'

def club_groups(listings):
    """sectionGroup -> {listings, cheapest} for club groups only."""
    groups = {}
    for l in listings:
        spot = l.get("spot") or {}
        g = group_of(spot)
        if not isinstance(g,str) or not g or not CLUB_RE.search(g): continue
        total = cents_value((l.get("price") or {}).get("total"),positive=True)
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
        values = sorted(cents_value((l.get('price') or {}).get('total'),positive=True) for l in listings
                        if cents_value((l.get('price') or {}).get('total'),positive=True) is not None and allows_quantity(l, qty))
        if values:
            bases={listing_fields(l)['basis'] for l in listings if allows_quantity(l,qty) and cents_value((l.get('price') or {}).get('total'),positive=True) is not None}
            out[str(qty)] = {"low": values[0], "typical": values[len(values)//2], "high": values[-1], "listings": len(values),
                             'basis':'fees_included_tax_reported' if bases=={'fees_included_tax_reported'} else 'fees_included_tax_unknown'}
    return out

def allows_quantity(listing, qty):
    """The seller must permit exactly the requested lot, not merely have enough seats."""
    return quantity_state(listing,qty) == 'allowed'

def check_interval_minutes(days_out, price_cents=None, threshold_cents=None):
    """Every active watched event is due on each 15-minute sweep.

    Shared provider admission limits still apply; delayed results stay hidden
    from current alert cards instead of being presented as available tickets.
    """
    return 15

def inventory_envelope(parent, key):
    container=parent.get(key)
    if container is None: return 'metadata_only',[]
    if not isinstance(container,dict): return 'parser_failure',[]
    items=container.get('listings')
    if items is None: return 'metadata_only',[]
    if not isinstance(items,list) or any(not isinstance(item,dict) for item in items):
        return 'parser_failure',[]
    return 'ok',items

def page_outcome(page, meta):
    """Decoded field presence, not words in HTML, distinguishes incomplete/empty."""
    if not meta: return 'parser_failure'
    if '_inventory_state' in meta: return meta['_inventory_state']
    try:
        decoded,_=parse_event_page(page)
        return decoded.get('_inventory_state','parser_failure') if decoded else 'parser_failure'
    except (ValueError,TypeError,KeyError,AttributeError):
        return 'parser_failure'

def page_shape(page, meta, listings):
    """Safe structural diagnostics; never log provider HTML or ticket contents."""
    return {'bytes':len(page), 'legacy': 'window.__data=' in page,
            'astro': 'component-export="EventListings"' in page,
            'listings_key': '"listings"' in page,
            'listings_response': 'listingsResponse' in page,
            'lot_keys': page.count('availableLots') + page.count('available_lots'),
            'event':bool(meta), 'listings':len(listings)}

def fetch_provider_page(url, discovery=False):
    """One admitted public-page request. Metadata-only is not empty inventory."""
    page = get_text(url)
    PERFORMERS.update(performer_paths(page))
    meta,listings = parse_event_page(page)
    outcome = page_outcome(page,meta)
    if outcome != 'ok':
        print(f"provider response {outcome}: {page_shape(page,meta,listings)}")
    if meta and meta.get('event_id') != GUARD.event_id:
        raise ValueError('event_unavailable: event ID mismatch')
    # Parsing is read-only. Commit the final metadata/inventory once after the
    # quantity checks; intermediate saves run the same costly rollup and can
    # mark the job complete before its browser check has actually finished.
    return outcome,meta,listings

def rendered_quantity_listings(url, quantities, meta_out=None):
    """Read all-in cards from the ordinary, quantity-filtered event page.

    Return None for an incomplete render. Never turn a browser failure into
    zero inventory or infer that a seller will split a larger lot.
    """
    if os.environ.get('GITHUB_ACTIONS') != 'true' or not GUARD.token:
        raise CaptureDeferred('Hosted capture lease required')
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout
    from urllib.parse import urlsplit, parse_qs, urlencode, urlunsplit
    if urlsplit(url).hostname != 'gametime.co':
        raise ValueError('parser_failure: unsafe event URL')
    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel='chrome', headless=True, args=['--no-sandbox'],timeout=30000)
        try:
            page = browser.new_page()
            blocked = []
            def route_request(route):
                request = route.request
                host = urlsplit(request.url).hostname or ''
                # No redirects, third-party trackers, images, fonts or media.
                if request.redirected_from or not (host == 'gametime.co' or host.endswith('.gametime.co')) or request.resource_type in ('image','font','media'):
                    route.abort(); return
                try:
                    # The page budget counts page and data requests. Scripts and
                    # styles are static assets needed to render the cards.
                    if request.resource_type not in ('script','stylesheet'):
                        GUARD.admit()
                    route.continue_()
                except Exception as error:
                    blocked.append(error)
                    route.abort()
            page.route('**/*',route_request)
            def inspect_response(response):
                try:
                    GUARD.inspect(response.status)
                except Exception as error:
                    blocked.append(error)
            page.on('response',inspect_response)
            for qty in sorted(set(quantities)):
                if not isinstance(qty, int) or not 1 <= qty <= 8:
                    continue
                parts = urlsplit(url)
                query = {k:v[-1] for k,v in parse_qs(parts.query).items() if k not in ('listingId','quantity')}
                query['quantity'] = str(qty)
                filtered_url = urlunsplit((parts.scheme,parts.netloc,parts.path,urlencode(query),''))
                response = page.goto(filtered_url,wait_until='domcontentloaded',timeout=35000)
                if blocked: raise blocked[0]
                if not response or response.status >= 400:
                    return None
                GUARD.inspect(response.status,page.content())
                # The older page sometimes arrives only after a real browser
                # navigation. Its embedded listings retain exact cents and
                # seller-provided availableLots, so prefer them to rounded UI.
                embedded_meta,embedded = parse_event_page(page.content())
                if not embedded_meta or embedded_meta.get('event_id') != GUARD.event_id:
                    return None
                if meta_out is not None:meta_out.update(embedded_meta)
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
        p = cents_value((l.get("price") or {}).get("total"),positive=True)
        if p is None or p <= 0 or not allows_quantity(l, qty): continue
        spot = l.get("spot") or {}
        cand = (p, l.get("id"), l.get("seoUrl") or "", spot.get("section") or "?", spot.get("row") or "?", len(seats) if isinstance(l.get('seats'),list) else None, l)
        if best is None or cand[0] < best[0]: best = cand
    return best

def cheapest_for(listings, group, qty):
    """Cheapest per-ticket all-in in a section group with >= qty seats together."""
    best = None
    for l in listings:
        spot = l.get("spot") or {}
        if group_of(spot) != group: continue
        seats = l.get("seats") or []
        if not allows_quantity(l, qty): continue
        total = cents_value((l.get("price") or {}).get("total"),positive=True)
        if total is None or total <= 0: continue
        if best is None or total < best[0]:
            best = (total, l.get("id"), l.get("seoUrl"),
                    spot.get("section"), spot.get("row"), len(seats) if isinstance(l.get('seats'),list) else None, l)
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

def _refresh_catalog():
    print("catalog: refreshing from sitemaps")
    rows = {}
    # Sitemaps label college basketball as generic sports; keep the category
    # verified by the provider's college basketball directory.
    college_category_ids = set()
    offset = 0
    while True:
        existing = sb('GET', 'tix_catalog?category=eq.college-basketball&select=event_id&order=event_id&limit=1000&offset='+str(offset))
        college_category_ids.update(row['event_id'] for row in existing)
        if len(existing) < 1000: break
        offset += len(existing)
    for sm in SITEMAPS:
        try:
            xml = get_text(f"https://gametime.co/sitemap/{sm}.xml")
        except Exception as e:
            print(f"catalog: {sm} fetch failed: {e}"); continue
        for u in re.findall(r"<loc>(https://gametime\.co/[^<]+/events/[0-9a-f]{24})</loc>", xml):
            r = parse_catalog_url(u)
            if r:
                if r['event_id'] in college_category_ids and r['category'] in ('sports','basketball'):
                    r['category'] = 'college-basketball'
                rows[r['event_id']] = r
        print(f"catalog: {sm} -> {len(rows)} cumulative")
    if not rows: raise RuntimeError("No catalog events could be fetched")
    today = NOW.date().isoformat()
    horizon=(NOW.date()+timedelta(days=365)).isoformat()
    vals = [r for r in rows.values() if today <= r['event_date'] <= horizon]
    if not vals: raise RuntimeError("No future catalog events could be fetched")
    keys = list(vals[0].keys())
    for i in range(0, len(vals), 500):
        chunk = [{k: r[k] for k in keys} for r in vals[i:i+500]]
        sb("POST", "tix_catalog?on_conflict=event_id", chunk,
           prefer="resolution=merge-duplicates,return=minimal")
    print(f"catalog: upserted {len(vals)} future events")
    sb("POST", "tix_state?on_conflict=k", [{"k": "catalog_refreshed_at", "v": json.dumps(NOW.isoformat())}],
       prefer="resolution=merge-duplicates,return=minimal")

def refresh_catalog():
    with GUARD.capture(None,'catalog'):
        return _refresh_catalog()

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
    horizon=(NOW.date()+timedelta(days=365)).isoformat()
    cols = "event_id,category,slug,name,event_date,datetime_local,venue_slug,venue,city,state,url"
    if kind == "event":
        ids = m.get("event_ids") or []
        if not ids: return []
        in_list = urllib.parse.quote(",".join(f'"{i}"' for i in ids), safe=",")
        return sb("GET", f"tix_events_v?event_id=in.({in_list})&event_date=gte.{today}&event_date=lte.{horizon}&select={cols}")
    if kind == "team":
        if "team_id" in m:
            team_id = m.get("team_id")
            if not isinstance(team_id, str) or not re.fullmatch(r"[a-z0-9]{2,40}", team_id):
                raise ValueError("Invalid canonical team identity")
            home_away = m.get("home_away") or "any"
            if home_away not in ("home", "away", "any"):
                raise ValueError("Invalid home or away preference")
            # Provider performer mappings identify the team. A missing RPC or
            # missing mapping never falls back to ambiguous nickname matching.
            rows = sb("POST", "rpc/tix_search_team_events", {"p_team_id": team_id, "p_limit": 500})
            if not isinstance(rows, list) or any(not isinstance(row, dict) or not row.get("event_id") for row in rows):
                raise ValueError("Invalid canonical team event response")
            return list({row["event_id"]: row for row in rows
                         if today <= (row.get("event_date") or "") <= horizon
                         and (not m.get("category") or row.get("category") == m["category"])
                         and (home_away == "any" or row.get("is_home") is (home_away == "home"))}.values())
        slug = (m.get("slug") or "").lower()
        ha = m.get("home_away") or "any"
        q = f"tix_events_v?slug=ilike.*{urllib.parse.quote(slug)}*&event_date=gte.{today}&event_date=lte.{horizon}&select={cols}&order=event_id"
        if m.get("category"):
            q = f"tix_events_v?category=eq.{urllib.parse.quote(m['category'])}&slug=ilike.*{urllib.parse.quote(slug)}*&event_date=gte.{today}&event_date=lte.{horizon}&select={cols}&order=event_id"
        rows = sb_all(q)
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
        if not d or d < today or d > horizon: return []
        q = f"tix_events_v?event_date=eq.{d}&select={cols}&order=event_date,event_id"
        if m.get("state"): q += f"&state=eq.{urllib.parse.quote(m['state'])}"
        if m.get("city"): q += f"&city=ilike.{urllib.parse.quote(m['city'])}"
        rows = sb_all(q)
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
    return rows if valid_address(rows) else ""

class DeliveryUncertain(RuntimeError):
    """SMTP may have accepted the message; never blindly resend it."""

def send_sms(subject, body, recipient=None, test=False, html_body=None, message_id=None):
    if test and not recipient:
        recipient = SMS_GATEWAY
    channel = "carrier text" if recipient and recipient.rsplit("@", 1)[-1] in PROVIDER_GATEWAYS.values() else "email"
    if not valid_address(GMAIL_ADDRESS) or not GMAIL_APP_PASSWORD or not valid_address(recipient):
        print("alert: notification configuration missing"); write_state("notification_health", {"status":"failed", "channel":channel, "checked_at":datetime.now(timezone.utc).isoformat(), "test":test}); return False
    import smtplib, ssl
    from email.message import EmailMessage
    from email.utils import formataddr, formatdate, make_msgid
    sending = False
    try:
        msg = EmailMessage()
        msg["From"] = formataddr(("Ticketline", GMAIL_ADDRESS))
        msg["To"] = recipient
        msg["Subject"] = clean_text(subject, 200)
        msg["Date"] = formatdate(localtime=False, usegmt=True)
        msg["Message-ID"] = message_id or make_msgid(domain=GMAIL_ADDRESS.rsplit("@", 1)[-1])
        msg.set_content(body)
        # Carrier gateways keep the compact text-only format.
        if html_body and channel == "email":
            msg.add_alternative(html_body, subtype="html")
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, context=ssl.create_default_context(), timeout=30) as s:
            s.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD.replace(" ", ""))
            sending = True
            refused = s.send_message(msg)
            if refused: return False
        print(f"alert: mail server accepted {channel} message (recipient receipt not confirmed)"); write_state("notification_health", {"status":"accepted", "channel":channel, "checked_at":datetime.now(timezone.utc).isoformat(), "test":test}); return True
    except Exception as e:
        if sending and message_id:
            raise DeliveryUncertain(type(e).__name__) from e
        print(f"alert: gmail smtp failed: {type(e).__name__}"); write_state("notification_health", {"status":"failed", "channel":channel, "checked_at":datetime.now(timezone.utc).isoformat(), "test":test}); return False

def delivery_send(subject, body, *, watch, channel, kind, event_id='', club='', payload=None, recipient=None, html_body=None):
    """Persist and claim intent before SMTP. Only SQL acknowledges acceptance."""
    claim=sb('POST','rpc/tix_begin_delivery',{'p_watch_id':watch['id'],'p_version':watch.get('criteria_version',1),
        'p_event_id':event_id,'p_club':club,'p_channel':channel,'p_kind':kind,'p_payload':payload or {}})
    if claim.get('state')=='already_accepted':return True
    if claim.get('state')!='sending':return False
    status='failed';error=None
    try:
        if send_sms(subject,body,recipient=recipient,message_id=claim['message_id'],**({'html_body':html_body} if html_body else {})):status='accepted'
        else:error='smtp_rejected_or_not_configured'
    except DeliveryUncertain:
        status='uncertain';error='smtp_acceptance_unknown'
    # No automatic retry of this write: an acknowledgment may have committed.
    # If this fails, the sending lease becomes uncertain, not eligible to resend.
    sb('POST','rpc/tix_finish_delivery',{'p_id':claim['id'],'p_lease':claim['lease'],'p_state':status,'p_error':error,'p_provider_id':claim['message_id'] if status=='accepted' else None})
    return status=='accepted'

def send_pending_confirmations():
    sms_rows = sb("GET", "tix_confirmation_queue?sms_enabled=eq.true&sent_at=is.null&attempts=lt.3&select=*&order=requested_at.asc&limit=25")
    email_rows = sb("GET", "tix_confirmation_queue?email_enabled=eq.true&email_sent_at=is.null&email_attempts=lt.3&select=*&order=requested_at.asc&limit=25")
    rows = {r["watch_id"]: r for r in sms_rows + email_rows}.values()
    accepted = 0
    cancelled = 0
    for queued in rows:
        watch_id = queued["watch_id"]
        watches = sb("GET", f"tix_watches?id=eq.{watch_id}&select=*&limit=1")
        label = re.sub(r"\s+", " ", queued.get("event_label") or "your event").strip()[:70]
        target = fmt_money(watches[0]["threshold_cents"]) if watches else "your target"
        update = {}
        if queued.get("email_enabled") and not queued.get("email_sent_at") and queued.get("email_attempts",0) < 3:
            recipient = owner_email(watch_id)
            if watches and watches[0].get("email_enabled") is False:
                update["email_enabled"] = False
                cancelled += 1
                ok = False
            else:
                event = None
                if watches and watches[0].get("kind") == "event":
                    event_ids = (watches[0].get("match") or {}).get("event_ids") or []
                    if len(event_ids) == 1:
                        events = sb("GET", "tix_events_v?event_id=eq." + urllib.parse.quote(str(event_ids[0]), safe="") + "&select=event_id,name,event_date,datetime_local,venue,city,state&limit=1")
                        event = events[0] if events else None
                message = confirmation_email({**watches[0], "id": watch_id}, event, queued.get("event_label")) if watches else None
                ok = bool(recipient and message and delivery_send(message.subject, message.text, watch={**watches[0],'id':watch_id}, channel='email', kind='confirmation', payload={'requested_at':queued.get('requested_at')},recipient=recipient, html_body=message.html))
            update.update(email_attempts=queued.get("email_attempts",0)+1,email_last_error=None if ok or update.get("email_enabled") is False else "email send failed")
            if ok: update["email_sent_at"] = datetime.now(timezone.utc).isoformat(); accepted += 1
        if queued.get("sms_enabled") and not queued.get("sent_at") and queued.get("attempts",0) < 3:
            destinations = sb("GET", f"tix_destinations?watch_id=eq.{watch_id}&select=phone_digits,provider&limit=1")
            recipient = destination_address(destinations[0]) if destinations else ""
            if watches and watches[0].get("sms_enabled") is False:
                update["sms_enabled"] = False
                cancelled += 1
                ok = False
            else:
                ok = bool(recipient and watches and delivery_send("Ticketline is on it", f"We're on the lookout for tickets to {label} at {target} or less. We'll text you when the price hits.",watch={**watches[0],'id':watch_id},channel="sms",kind="confirmation",payload={"requested_at":queued.get("requested_at")},recipient=recipient))
            update.update(attempts=queued.get("attempts",0)+1,last_error=None if ok or update.get("sms_enabled") is False else "carrier gateway send failed")
            if ok: update["sent_at"] = datetime.now(timezone.utc).isoformat(); accepted += 1
        if update:
            queue_filter = f"tix_confirmation_queue?watch_id=eq.{watch_id}"
            # A user can save new criteria while SMTP is in progress. Do not
            # mark the replacement confirmation as sent for the old version.
            if queued.get("requested_at"):
                queue_filter += "&requested_at=eq." + urllib.parse.quote(queued["requested_at"], safe="")
            sb("PATCH", queue_filter, update)
    if rows: print(f"confirmation channels accepted: {accepted}")
    return len(sms_rows) + len(email_rows) - accepted - cancelled

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
    match = w.get("match") or {}
    return (w.get("kind") in ("event", "team", "date")
            and isinstance(match, dict)
            and ("team_id" not in match or isinstance(match["team_id"], str)
                 and re.fullmatch(r"[a-z0-9]{2,40}", match["team_id"]) is not None)
            and type(w.get("qty")) is int and 1 <= w["qty"] <= 8
            and type(w.get("threshold_cents")) is int and 100 <= w["threshold_cents"] <= 5000000
            and w.get("alert_style") in ("first", "repeat"))

def scan_result(watch_id, event_id, outcome, checked_at, criteria_version=1, detail=None):
    sb("POST", "tix_scans?on_conflict=watch_id,event_id", [{"watch_id": watch_id, "event_id": event_id,
       "outcome": outcome, "checked_at": checked_at, "criteria_version":criteria_version,
       "detail":detail or {}}], prefer="resolution=merge-duplicates,return=minimal")

def capture_payload(meta,listings,status):
    normalized=[]
    for item in listings:
        f=listing_fields(item)
        spot=item.get('spot') or {}
        normalized.append({'provider':item,'listing_id':item.get('id'),
            'price_cents':cents_value((item.get('price') or {}).get('total'),positive=True),
            'basis':f['basis'],'prefee_cents':f['prefee_cents'],
            'sales_tax_cents':f['sales_tax_cents'],'pre_tax_total_cents':f['pre_tax_total_cents'],
            'lots':f['lots'],'section_group':spot.get('sectionGroup') or spot.get('section_group'),
            'section':spot.get('section'),'row_label':spot.get('row'),
            'verified_quantity':item.get('verified_quantity')})
    partial=status=='partial' or any(item.get('verified_quantity') for item in listings)
    state='metadata_only' if status=='metadata_only' else 'partial' if partial else 'complete' if listings else 'empty'
    prices=[n['price_cents'] for n in normalized if n['price_cents'] is not None]
    return {'meta':meta,'format':'rendered' if partial else 'embedded','state':state,
      'min_total':cents_value(meta.get('min_total'),positive=True) or (None if partial else min(prices,default=None)),
      'listings':normalized,'by_qty':market_spreads(listings),
      'groups':list(club_groups(listings).values()),
      'coverage':{'complete':state in ('complete','empty'),
        'quantities':sorted({l['verified_quantity'] for l in normalized if l['verified_quantity']}),
        'unknown_lots':sum(n['lots'] is None for n in normalized),
        'unknown_seats':sum(not isinstance(n['provider'].get('seats'),list) for n in normalized)}}

def persist_capture(meta,listings,status):
    capture=capture_payload(meta,listings,status)
    return GUARD.finish(capture)

def expire_event_storage():
    total=0
    for _ in range(20):
        count=sb('POST','rpc/tix_expire_event_storage',{'p_limit':100})
        total+=count
        if count<100: break
    return total

def record_event_market(cat, meta, listings, checked_at, status='ok'):
    """One database transaction owns prices, metadata, changes and job completion."""
    old = dict(cat)
    persist_capture(meta, listings, status)
    changes = sum(bool(meta.get(field) and old.get(field) and meta[field] != old[field])
                  for field in ('datetime_local', 'venue'))
    for field in ('name', 'datetime_local', 'venue'):
        if meta.get(field): cat[field] = meta[field]
    return club_groups(listings), changes


def failure_outcome(error):
    # Supabase HTTP 500/57014 is not a failure from the ticket provider.
    if getattr(error,'database_path',None): return 'failed'
    if 'parser_failure' in str(error): return 'parser_failure'
    if 'event_unavailable' in str(error) or isinstance(error,urllib.error.HTTPError) and error.code in (404,410):
        return 'event_unavailable'
    return 'http_failure'

def failure_detail(error):
    if not getattr(error,'database_path',None): return {}
    return {'source':'database','operation':error.database_path,
            'postgres_code':getattr(error,'postgres_code',None)}

def note_deferral(health, error):
    """Count guard deferrals; a provider-blocking pause is an error to surface."""
    reasons = health.setdefault('deferred',{})
    reasons[error.reason] = reasons.get(error.reason,0)+1
    health['guard_deferred'] = health.get('guard_deferred',0)+1
    if getattr(error,'state',None) == 'suspended':
        health['provider_paused'] = error.reason
        if error.reason != 'rollout_disabled': health['status'] = 'error'

def discovery_due():
    out = []
    tracked=sb('POST','rpc/tix_capture_due',{'p_limit':TRACKED_FETCHES})
    for row in tracked: row['_history_requested']=True
    out.extend(tracked)
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
    unique={}
    for row in out:
        unique.setdefault(row['event_id'],row)
    return list(unique.values())

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
    health['expired_events']=expire_event_storage()
    try:
        if catalog_stale(): refresh_catalog()
    except Exception as e:
        print(f"catalog refresh failed: {type(e).__name__}", file=sys.stderr)
        health["catalog_refresh_failed"] = True

    if send_pending_confirmations():
        health["status"] = "error"

    watches = sb_all("tix_watches?active=eq.true&select=*&order=id")
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
    pairs=[{'watch_id':w['id'],'event_id':cat['event_id'],'criteria_version':w.get('criteria_version',1),'seen_at':datetime.now(timezone.utc).isoformat()} for w in watches for cat in resolved.get(w['id'],[])]
    for offset in range(0,len(pairs),250):
        sb('POST','tix_watch_events?on_conflict=watch_id,event_id',pairs[offset:offset+250],prefer='resolution=merge-duplicates,return=minimal')
    scans = {}
    # Stable pages, shared by all watches; no per-watch 1,000-row truncation.
    for offset in range(0,len(watches),100):
        ids=','.join(w['id'] for w in watches[offset:offset+100])
        for r in sb_all('tix_scans?watch_id=in.('+ids+')&select=*&order=watch_id,event_id'):
            scans[(r['watch_id'],r['event_id'])]=r
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
            interval = check_interval_minutes(days_out)
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
        capture_context=GUARD.capture(eid,'collector')
        try:
            capture_context.__enter__()
            provider_status,meta,listings = fetch_provider_page(cat["url"])
            if provider_status == 'parser_failure':
                raise ValueError('parser_failure: provider event/listing data missing')
            if not meta or meta.get("event_id") != eid:
                raise ValueError("event_unavailable: event ID changed or removed")
            if provider_status == 'metadata_only':
                requested = {w['qty'] for w in watchers[eid]}
                try:
                    rendered = rendered_quantity_listings(cat['url'],requested)
                except CaptureDeferred:
                    raise
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
                reasons = set()
                for club in clubs:
                    best = cheapest_any(listings, w["qty"]) if club == "Any section" else cheapest_for(listings, club, w["qty"])
                    if not best: continue
                    found = True
                    price,lid,lurl,sec,row,nseats,item = best
                    fields=listing_fields(item)
                    url = lurl or cat["url"]
                    if not url.startswith("https://gametime.co/"): url = cat["url"]
                    sb("POST", "tix_prices", [{"watch_id":w["id"], "event_id":eid, "event_label":cat.get("name"),
                       "club":club, "qty":w["qty"], "price_cents":price, "listing_id":lid,
                       "listing_url":url, "checked_at":checked_at,
                       "criteria_version":w.get('criteria_version',1), **fields}], prefer="return=minimal")
                    if price > w["threshold_cents"]: continue
                    gate_reason=deal_gate_reason(item,(w.get('match') or {}).get('min_deal'))
                    if gate_reason:
                        reasons.add(gate_reason)
                        continue
                    subject = f"Ticketline: {fmt_money(price)} tickets"
                    body = (f"{cat.get('name') or eid} {fmt_when(cat)}. {w['qty']} tickets together, "
                            f"{fmt_money(price)}/ticket including fees; {fmt_money(price*w['qty'])} total. "
                            f"{club}, sec {sec}, row {row}. At or below your {fmt_money(w['threshold_cents'])} target. {url}")
                    if fields['deal']:
                        # Keep the supplied string; neutralize control characters in messages.
                        body += ' Gametime deal: '+re.sub(r'[\x00-\x1f\x7f]',' ',fields['deal'])[:120]+'.'
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
                        payload={'qty':w['qty'],'price_cents':price,'listing_id':lid,'listing_url':url,'deal':fields['deal'],'checked_at':checked_at}
                        if channel == "email":
                            message = price_alert_email(w, cat, price, url, club, sec, row, fields, checked_at)
                            ok = delivery_send(message.subject, message.text, watch=w,channel=channel,kind='alert',event_id=eid,club=club,payload=payload,recipient=recipient,html_body=message.html)
                        else:
                            ok = delivery_send(subject, body,watch=w,channel=channel,kind='alert',event_id=eid,club=club,payload=payload,recipient=recipient)
                        if ok: sent += 1
                        else: health["status"] = "error"
                unknown=any(match_unknown(item,w) for item in listings)
                if unknown: reasons.add('required_listing_fields_unknown')
                outcome='ok' if found else 'provider_incomplete' if unknown or provider_status=='partial' else 'unavailable'
                if outcome=='provider_incomplete':
                    health['provider_incomplete']=health.get('provider_incomplete',0)+1
                    if health['status']=='ok': health['status']='degraded'
                scan_result(w['id'],eid,outcome,checked_at,w.get('criteria_version',1),
                            {'listings_checked':len(listings),
                             'available_lots':sorted({n for item in listings for n in (listing_fields(item)['lots'] or [])}),
                             'matching_listings':sum(allows_quantity(item,w['qty']) for item in listings),
                             'reasons':sorted(reasons)})
            health["checked_events"] += 1
        except CaptureDeferred as e:
            note_deferral(health,e)
        except Exception as e:
            health["failed_events"] += 1
            print(f"check {eid} failed: {type(e).__name__}: {e}", file=sys.stderr)
            outcome = failure_outcome(e)
            if getattr(e,'database_path',None):
                health['database_write_failures']=health.get('database_write_failures',0)+1
            if outcome in ('parser_failure', 'event_unavailable') and cat.get("event_date", "") <= NOW.date().isoformat():
                # Game day (or past): the provider pulls listing data once the
                # event starts, so an empty page is expected, not a collector
                # failure. Record it and keep the run green; the 15-minute
                # retry cadence covers transient pre-game hiccups.
                outcome = 'event_passed'
            else:
                health["status"] = "error"
            health.setdefault('outcomes',{})[outcome] = health.setdefault('outcomes',{}).get(outcome,0)+1
            for w in watchers[eid]:
                try: scan_result(w["id"], eid, outcome, checked_at, w.get('criteria_version',1),failure_detail(e))
                except Exception: pass  # watch may have been deleted during the fetch
        finally:
            capture_context.__exit__(None,None,None)
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
        # Opened events and requested checks are foreground history checks;
        # everything else is background coverage that yields to searches.
        tracked = bool(cat.get('_history_requested'))
        checked_at = datetime.now(timezone.utc).isoformat()
        try:
            with GUARD.capture(eid,'tracked' if tracked else 'discovery'):
                provider_status,meta,listings = fetch_provider_page(cat['url'],discovery=True)
                if provider_status == 'parser_failure':
                    raise ValueError('parser_failure: provider event/listing data missing')
                if not meta or meta.get('event_id') != eid:
                    raise ValueError('event_unavailable: event ID changed or removed')
                _,change_count = record_event_market(cat,meta,listings,checked_at,provider_status)
            health['event_changes'] = health.get('event_changes',0)+change_count
            health['discovery_checked'] += 1
            if tracked: health['tracked_checked'] = health.get('tracked_checked',0)+1
            # A get-in price without listings is the provider's normal public
            # page today; it is counted, not treated as a degraded run.
            if provider_status == 'metadata_only':
                health['discovery_metadata_only'] = health.get('discovery_metadata_only',0)+1
        except CaptureDeferred as e:
            note_deferral(health,e)
            # Budget reached or provider paused: later events would only be
            # refused too. Busy or cached events are simply skipped.
            if e.state == 'suspended' or e.reason == 'request_limit': break
            continue
        except Exception as e:
            outcome = failure_outcome(e)
            if getattr(e,'database_path',None):
                health['database_write_failures']=health.get('database_write_failures',0)+1
            health['discovery_failed'] += 1
            health.setdefault('discovery_outcomes',{})[outcome] = health.setdefault('discovery_outcomes',{}).get(outcome,0)+1
            print(f'discovery {eid} failed: {outcome}: {type(e).__name__}',file=sys.stderr)
            if getattr(e,'database_path',None):
                health['status']='error'
            else:
                sb('PATCH',f'tix_catalog?event_id=eq.{eid}',
                   {'discovery_attempt_at':checked_at,'discovery_status':outcome})
        time.sleep(1 if tracked else BACKGROUND_PAUSE_SECONDS)
    try:
        health['performers_added'] = note_performers()
    except Exception as e:
        print(f'performer links not saved: {type(e).__name__}',file=sys.stderr)
    if health.get('discovery_outcomes',{}).get('parser_failure',0) >= 3:
        health['status'] = 'error'
    elif health['discovery_failed'] and health['status'] == 'ok':
        health['status'] = 'degraded'
    runtime=sb('POST','rpc/tix_runtime_health',{})
    health['overdue_alert_events']=runtime.get('overdue_alert_events',0)
    health['uncertain_deliveries']=runtime.get('delivery_uncertain',0)
    if (health['overdue_alert_events'] or health['uncertain_deliveries']) and health['status']=='ok':health['status']='degraded'
    health["checked_at"] = datetime.now(timezone.utc).isoformat()
    write_state("collector_health", health)
    print(f"done. events checked: {health['checked_events']}, failed: {health['failed_events']}, alerts accepted: {sent}")
    if health["status"] == "error": raise RuntimeError("Some ticket checks or deliveries failed; see collector status")

def offline_fixture(path, qty=2, group=None):
    """Local/dev collector path: no I/O except reading the supplied saved HTML."""
    with open(path,encoding='utf-8') as source: page=source.read()
    meta,items=parse_event_page(page)
    best=cheapest_for(items,group,qty) if group else cheapest_any(items,qty)
    return {'event_id':(meta or {}).get('event_id'),'status':page_outcome(page,meta),
            'qty':qty,'selected_price_cents':best[0] if best else None,
            'fields':listing_fields(best[-1]) if best else None}

if __name__ == "__main__":
    if OFFLINE:
        import argparse
        parser=argparse.ArgumentParser(description='Offline saved-page inspection; never sends alerts or writes Supabase.')
        parser.add_argument('--fixture',required=True)
        parser.add_argument('--qty',type=int,default=2)
        parser.add_argument('--group')
        args=parser.parse_args()
        print(json.dumps(offline_fixture(args.fixture,args.qty,args.group)))
    else:
        main()

