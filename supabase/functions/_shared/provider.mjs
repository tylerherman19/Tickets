const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const cents = (v, positive = false) => Number.isSafeInteger(v) && v >= (positive ? 1 : 0) ? v : null;
function decode(v) { if (obj(v))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)])); if (Array.isArray(v)) {
    if (v.length === 1 && Number.isInteger(v[0]))
        return null;
    if (v.length === 2 && Number.isInteger(v[0]))
        return v[0] === 1 ? v[1].map(decode) : decode(v[1]);
    return v.map(decode);
} return v; }
function entities(s) { return s.replace(/&(?:quot|apos|amp|lt|gt|#\d+|#x[\da-f]+);/gi, x => { const n = { '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>' }; return n[x] ?? String.fromCodePoint(x[2].toLowerCase() === 'x' ? parseInt(x.slice(3, -1), 16) : parseInt(x.slice(2, -1), 10)); }); }
function envelope(parent, key) { const c = parent[key]; if (c == null)
    return { state: 'metadata_only', listings: [] }; if (!obj(c))
    return { state: 'parser_failure', listings: [] }; if (c.listings == null)
    return { state: 'metadata_only', listings: [] }; if (!Array.isArray(c.listings) || c.listings.some(x => !obj(x)))
    return { state: 'parser_failure', listings: [] }; return { state: c.listings.length ? 'complete_embedded_inventory' : 'explicit_empty_inventory', listings: c.listings }; }
export function parse(page) { let event = null, env, format; const marker = 'window.__data=', start = page.indexOf(marker); if (start >= 0) {
    format = 'legacy';
    let depth = 0, str = false, esc = false, end = -1;
    for (let j = start + marker.length; j < page.length; j++) {
        const c = page[j];
        if (str) {
            if (esc)
                esc = false;
            else if (c === '\\')
                esc = true;
            else if (c === '"')
                str = false;
        }
        else if (c === '"')
            str = true;
        else if (c === '{')
            depth++;
        else if (c === '}' && --depth === 0) {
            end = j + 1;
            break;
        }
    }
    if (end < 0)
        throw Error('unterminated legacy data');
    const data = JSON.parse(page.slice(start + marker.length, end).replace(/("(?:\\.|[^"\\])*"|undefined)/g, x => x === 'undefined' ? 'null' : x));
    const redux = data.redux;
    if (!obj(redux))
        throw Error('invalid redux');
    env = envelope(redux, 'listings');
    for (const [id, wrap] of Object.entries(redux.data?.fullEvents?.events ?? {})) {
        if (!obj(wrap))
            throw Error('invalid event wrapper');
        if (obj(wrap.event) && Object.keys(wrap.event).length) {
            event = { ...wrap.event, id: wrap.event.id ?? id };
            break;
        }
    }
}
else {
    format = 'astro';
    const m = page.match(/<astro-island\b(?=[^>]*\bcomponent-export="EventListings")[^>]*\bprops="([^"]*)"/);
    if (!m)
        throw Error('EventListings island absent');
    const props = decode(JSON.parse(entities(m[1])));
    if (!obj(props))
        throw Error('invalid props');
    env = envelope(props, 'listingsResponse');
    event = props.fullEvent?.event;
    if (obj(event))
        event = { ...event, id: event.id ?? props.eventId };
} if (!obj(event) || !Object.keys(event).length)
    throw Error('event metadata absent'); return { format, event, ...env }; }
function alias(o, a, b) { return a in o && b in o && JSON.stringify(o[a]) !== JSON.stringify(o[b]) ? null : a in o ? o[a] : o[b]; }
export function detail(l) { const p = obj(l.price) ? l.price : {}; const total = cents(p.total, true), base = cents(p.prefee), tax = cents(alias(p, 'salesTax', 'sales_tax')), pretax = cents(alias(p, 'preTaxTotal', 'pre_tax_total')); const consistent = total !== null && base !== null && tax !== null && base + tax <= total && (pretax === null || pretax === total - tax); const raw = alias(l, 'availableLots', 'available_lots'); const lots = Array.isArray(raw) && raw.every(n => Number.isSafeInteger(n) && n > 0) ? [...new Set(raw)].sort((a, b) => a - b) : null; const seats = Array.isArray(l.seats) ? l.seats.length : null; return { id: l.id ?? l.listingId ?? l.listing_id ?? null, total_cents: total, prefee_cents: base, sales_tax_cents: tax, pre_tax_total_cents: pretax, basis: total === null ? 'unusable' : consistent ? 'fees_included_tax_reported' : 'fees_included_tax_unknown', available_lots: lots, seat_count: seats, confirmed_quantities: lots !== null && seats !== null ? lots.filter(n => n <= 8 && n <= seats) : [], section_group: l.spot?.sectionGroup ?? l.spot?.section_group ?? null }; }
export function validEventUrl(raw, id) {
    try {
        const u = new URL(raw);
        return u.protocol === 'https:' && u.hostname === 'gametime.co' && !u.username && !u.password && !u.search && !u.hash && u.pathname.endsWith('/events/' + id);
    }
    catch {
        return false;
    }
}
export function blockingSignals(status, page) {
    const out = [];
    if ([403, 429].includes(status))
        out.push('HTTP_' + status);
    if (/<title[^>]*>[^<]*(access denied|just a moment|attention required|captcha)/i.test(page) || /verify (?:you are|that you are) human|cf-chl-|px-captcha|g-recaptcha|hcaptcha/i.test(page))
        out.push('challenge_or_denial');
    return out;
}
export function captureFromPage(page, id) {
    const p = parse(page);
    if (p.event.id !== id)
        throw Error('event_id_mismatch');
    if (p.state === 'parser_failure')
        throw Error('parser_failure');
    const listings = p.listings.map(l => { const d = detail(l); return { provider: l, listing_id: d.id, price_cents: d.total_cents, basis: d.basis, prefee_cents: d.prefee_cents, sales_tax_cents: d.sales_tax_cents, pre_tax_total_cents: d.pre_tax_total_cents, lots: d.available_lots, section_group: d.section_group, section: l.spot?.section ?? null, row_label: l.spot?.row ?? null, verified_quantity: l.verified_quantity ?? null }; });
    const prices = listings.filter(l => l.price_cents !== null).map(l => l.price_cents);
    const by_qty = {}, groups = {};
    for (let qty = 1; qty <= 8; qty++) {
        const matches = p.listings.map(detail).filter(l => l.total_cents !== null && l.confirmed_quantities.includes(qty));
        const vals = matches.map(l => l.total_cents).sort((a, b) => a - b);
        if (vals.length)
            by_qty[qty] = { low: vals[0], typical: vals[Math.floor(vals.length / 2)], high: vals.at(-1), listings: vals.length, basis: matches.every(l => l.basis === 'fees_included_tax_reported') ? 'fees_included_tax_reported' : 'fees_included_tax_unknown' };
    }
    for (const l of listings) {
        const g = l.section_group;
        if (!g || l.price_cents === null)
            continue;
        const row = groups[g] ?? { group: g, cheapest: l.price_cents, listings: 0 };
        row.listings++;
        row.cheapest = Math.min(row.cheapest, l.price_cents);
        groups[g] = row;
    }
    const coverage = { complete: p.state === 'complete_embedded_inventory' || p.state === 'explicit_empty_inventory', quantities: [], unknown_lots: listings.filter(l => l.lots === null).length, unknown_seats: p.listings.filter(l => !Array.isArray(l.seats)).length };
    return { format: p.format, state: p.state === 'metadata_only' ? 'metadata_only' : p.listings.length ? 'complete' : 'empty',
        meta: { ...p.event, event_id: p.event.id }, min_total: cents(p.event.minPrice?.total, true) ?? (prices.length ? Math.min(...prices) : null),
        listings, coverage, by_qty, groups: Object.values(groups).sort((a, b) => a.cheapest - b.cheapest) };
}
// Team, artist and show page paths linked from a provider page. One of these
// pages lists many events with their get-in price. College basketball team
// pages are imported separately (with their category), so they are skipped.
export function performerPaths(page, limit = 100) {
    const out = new Set(), text = String(page).replace(/\\\//g, '/');
    for (const m of text.matchAll(/(?:(?<=gametime\.co)|(?<=["'=\s(;>]))((?:\/[a-z0-9-]{1,80}){1,2}\/performers\/[a-z0-9]{2,40})(?=["'?#&\\\s<]|$)/g)) {
        if (!/\/performers\/cbb/.test(m[1])) out.add(m[1]);
        if (out.size >= limit) break;
    }
    return [...out];
}
