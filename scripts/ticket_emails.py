"""Offline, escaped Ticketline email content. No credentials, network, or sends."""
from dataclasses import dataclass
from datetime import datetime, timezone
from email.headerregistry import Address
from email.errors import HeaderParseError
from html import escape
import re
from urllib.parse import quote, urlsplit

SITE_URL = 'https://tylerherman19.github.io/Tickets/'


@dataclass(frozen=True)
class EmailContent:
    subject: str
    text: str
    html: str


def clean_text(value, limit=500):
    return re.sub(r'\s+', ' ', re.sub(r'[\x00-\x1f\x7f]', ' ', str(value or ''))).strip()[:limit]


def valid_address(value):
    """A single bare mailbox only; never accept display names or extra headers."""
    if not isinstance(value, str) or not value or re.search(r'[\s\x00-\x1f\x7f]', value):
        return False
    try:
        address = Address(addr_spec=value)
        return bool(address.username and address.domain and '.' in address.domain and address.addr_spec == value and value.isascii())
    except (ValueError, IndexError, HeaderParseError):
        return False


def money(cents):
    if type(cents) is not int or cents < 0:
        return 'Not specified'
    return f'${cents / 100:,.2f}' if cents % 100 else f'${cents // 100:,}'


def site_link(page, key=None, value=None):
    return SITE_URL + page + ('?' + key + '=' + quote(str(value), safe='') if key and value else '')


def provider_link(value):
    """Only link to ordinary HTTPS Gametime pages, without credentials."""
    if not isinstance(value, str) or re.search(r'[\s\x00-\x1f\x7f]', value):
        return ''
    try:
        url = urlsplit(value)
        if url.scheme == 'https' and url.hostname == 'gametime.co' and not url.username and not url.password and url.port in (None, 443) and url.path.startswith('/'):
            return value
    except ValueError:
        pass
    return ''


def when(event):
    value = event.get('datetime_local')
    if value:
        try:
            dt = datetime.fromisoformat(value)
            return dt.strftime('%a, %b %d, %Y at %I:%M %p').replace(' 0', ' ') + ' (venue local time)'
        except (ValueError, TypeError):
            pass
    try:
        dt = datetime.fromisoformat(event.get('event_date') or '')
        return dt.strftime('%a, %b %d, %Y').replace(' 0', ' ') + ' · time not confirmed'
    except (ValueError, TypeError):
        return 'Date and time not confirmed'


def checked_when(value):
    try:
        dt = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        if dt.tzinfo is None:
            return 'Check time not confirmed'
        return dt.astimezone(timezone.utc).strftime('%b %d, %Y at %H:%M UTC').replace(' 0', ' ')
    except (ValueError, TypeError):
        return 'Check time not confirmed'


def event_rows(event):
    if not event:
        return []
    venue = clean_text(event.get('venue'))
    place = ', '.join(filter(None, [clean_text(event.get('city')), clean_text(event.get('state'))]))
    return [('When', when(event)), ('Where', ' · '.join(filter(None, [venue, place])) or 'Venue not confirmed')]


def _render(subject, preview, heading, intro, rows, primary, secondary, notes, footer, hero=None):
    """Table layout with inline styles works in email clients and without images."""
    esc = lambda value: escape(clean_text(value, 2000), quote=True)
    details = ''.join(
        '<tr><td style="padding:12px 0;border-bottom:1px solid #E4E0D5;color:#625D50;width:35%;vertical-align:top;font-family:Courier New,Courier,monospace;font-size:12px">'
        + esc(label) + '</td><td style="padding:12px 0;border-bottom:1px solid #E4E0D5;font-weight:600;color:#17150F">'
        + esc(value) + '</td></tr>' for label, value in rows)
    button = ''
    if primary and primary[1]:
        button = '<table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0"><tr><td bgcolor="#C2410C" style="background:#C2410C"><a href="' + esc(primary[1]) + '" style="background:#C2410C;color:#FFFFFF;text-decoration:none;padding:16px 24px;display:inline-block;font-weight:700">' + esc(primary[0]) + '</a></td></tr></table>'
    links = ' &nbsp;·&nbsp; '.join('<a href="' + esc(url) + '" style="color:#F4A07C">' + esc(label) + '</a>' for label, url in secondary if url)
    price = ''
    if hero:
        price = '<p style="margin:24px 0 6px;font:12px Courier New,Courier,monospace;letter-spacing:2px;color:#F4A07C">' + esc(hero[0]) + '</p><p style="margin:0 0 8px;font:700 64px Courier New,Courier,monospace;line-height:1.1;color:#FBFAF6">' + esc(hero[1]) + '</p><p style="margin:0 0 28px;font:13px Courier New,Courier,monospace;color:#F4A07C">' + esc(hero[2]) + '</p>'
    html = '''<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>''' + esc(subject) + '''</title></head>
<body style="margin:0;background:#E4E0D5;font:16px Arial,Helvetica,sans-serif;color:#17150F">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">''' + esc(preview) + '''</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#E4E0D5"><tr><td align="center" style="padding:40px 12px">
<table role="presentation" width="600" cellspacing="0" cellpadding="0" bgcolor="#17150F" style="max-width:600px;width:100%;background:#17150F;color:#FBFAF6">
<tr><td style="padding:28px 32px;border-bottom:1px solid #454034;color:#F4A07C;font:700 22px Arial,Helvetica,sans-serif">Ticketline<span style="font:12px Courier New,Courier,monospace"> / TICKET PRICE ALERTS</span></td></tr>
<tr><td style="padding:32px"><h1 style="font-size:34px;line-height:1.15;margin:0 0 16px;color:#FBFAF6">''' + esc(heading) + '''</h1><p style="line-height:1.6;margin:0 0 22px;color:#E4E0D5">''' + esc(intro) + '</p>' + price + '''
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#FBFAF6" style="background:#FBFAF6;color:#17150F"><tr><td style="padding:8px 20px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="font:15px Arial,Helvetica,sans-serif">''' + details + '</table></td></tr></table>' + button + ''.join('<p style="font-size:14px;color:#E4E0D5;line-height:1.6">' + esc(note) + '</p>' for note in notes) + '<p style="font-size:14px;line-height:1.8">' + links + '</p></td></tr><tr><td style="padding:24px 32px;background:#FBFAF6;color:#625D50;font:12px Arial,Helvetica,sans-serif;line-height:1.6">' + esc(footer) + '</td></tr></table></td></tr></table></body></html>'
    text = '\n\n'.join([heading, intro, '\n'.join(f'{label}: {clean_text(value, 2000)}' for label, value in rows), *notes,
                          *([primary[0] + ': ' + primary[1]] if primary and primary[1] else []),
                          *[label + ': ' + url for label, url in secondary if url], footer])
    return EmailContent(clean_text(subject, 200), text, html)


def confirmation_email(watch, event=None, label=None):
    name = clean_text(label or watch.get('label') or (event or {}).get('name') or 'Your ticket alert', 180)
    qty, target = watch.get('qty'), watch.get('threshold_cents')
    paused = watch.get('active') is False
    subject = f'Ticketline: {"paused alert saved" if paused else "watching"} {name}'
    rows = [('Watching', name), *event_rows(event)]
    if type(qty) is int and qty > 0:
        rows.append(('Tickets', f'{qty} ticket' + ('s together' if qty > 1 else '')))
    rows.append(('Your target', money(target) + ' or less per ticket'))
    if type(qty) is int and qty > 0 and type(target) is int:
        rows.append(('Group budget', money(qty * target) + f' for {qty} ticket' + ('s' if qty > 1 else '')))
    match = watch.get('match') or {}
    clubs = [clean_text(club) for club in watch.get('clubs') or []]
    rows.append(('Sections', ', '.join(clubs) or ('Any club section' if match.get('club_level') else 'Any section')))
    if watch.get('kind') == 'team':
        rows.append(('Games', {'home':'Home games', 'away':'Away games'}.get(match.get('home_away'), 'Home and away games')))
    rows.append(('Frequency', 'At most once per hour per event and section while a match qualifies' if watch.get('alert_style') == 'repeat' else 'First match per event and section'))
    intro = 'Your alert is saved and paused. Resume it from My alerts when you are ready.' if paused else 'Your alert is saved. We will email when a checked Gametime listing meets your quantity, section, and per-ticket target.'
    manage = site_link('watches.html')
    edit = site_link('new.html', 'edit', watch.get('id'))
    secondary = [('Edit this alert', edit)]
    if event and event.get('event_id'):
        secondary.append(('View event', site_link('event.html', 'event', event['event_id'])))
    return _render(subject, name + ' · ' + money(target) + ' target', 'Your alert is ' + ('paused.' if paused else 'set.'), intro, rows,
                   ('Manage my alerts', manage), secondary,
                   ['Targets use prices with fees included. Sales tax may be unreported; each price email will state its tax basis.',
                    'A confirmation is not a ticket offer. Checks run on a schedule and may be delayed by provider availability.'],
                   'You received this confirmation because an alert was saved for your verified sign-in email. Sign in to edit, pause, archive, or turn off email delivery for this alert.',
                   hero=('YOUR TARGET', money(target), 'or less per ticket'))


def price_alert_email(watch, event, price_cents, listing_url, club=None, section=None, row=None, fields=None, checked_at=None):
    fields = fields or {}
    qty = watch['qty']
    name = clean_text(event.get('name') or watch.get('label') or 'Your event', 180)
    total = price_cents * qty
    target = watch['threshold_cents']
    subject = f'Ticketline: {money(price_cents)}/ticket · {name}'
    rows = [('Event', name), *event_rows(event), ('Matching quantity', f'{qty} ticket' + ('s together' if qty > 1 else '')),
            ('Per ticket', money(price_cents)), ('Group total', money(total)), ('Your target', money(target) + '/ticket · ' + money(target * qty) + ' group budget')]
    seats = [clean_text(club)] if club else []
    seats += [f'Section {clean_text(section)}' if section else 'Section unreported', f'Row {clean_text(row)}' if row else 'Row unreported']
    rows.extend([('Seats', ' · '.join(seats)), ('Checked', checked_when(checked_at))])
    if fields.get('deal'):
        rows.append(('Gametime deal label', clean_text(fields['deal'], 120)))
    basis = fields.get('basis')
    tax_note = 'Fees included. Gametime reported sales tax in this price.' if basis == 'fees_included_tax_reported' else 'Fees included. Sales tax was not verified and may change the checkout total.' if basis == 'fees_included_tax_unknown' else 'The fee and tax basis is unconfirmed. Verify the total at checkout.'
    listing = provider_link(listing_url) or provider_link(event.get('url'))
    secondary = [('View event and history', site_link('event.html', 'event', event.get('event_id'))), ('Manage or pause this alert', site_link('watches.html')), ('Edit this alert', site_link('new.html', 'edit', watch.get('id')))]
    return _render(subject, f'{qty} tickets · {money(total)} group total · {name}', 'A price matches your alert.',
                   f'{name}: {money(price_cents)} per ticket for your exact quantity, at or below your {money(target)} target.', rows,
                   ('View tickets on Gametime', listing) if listing else ('View event', secondary[0][1]), secondary,
                   [tax_note, 'This listing matched your requested quantity when checked. Tickets are not reserved; prices and availability can change before checkout.'],
                   'You received this email because this alert has email delivery enabled for your verified sign-in address. Sign in to pause, archive, or turn off email delivery. Ticketline does not sell or reserve tickets.',
                   hero=('MATCHING PRICE', money(price_cents), 'per ticket · ' + money(total) + ' group total'))
