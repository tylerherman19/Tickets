#!/usr/bin/env python3
"""Create safe local previews of Ticketline emails, without credentials or sending."""
import argparse
from email.message import EmailMessage
from pathlib import Path

from ticket_emails import confirmation_email, price_alert_email


def write_previews(output):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    watch = {'id':'preview-watch', 'kind':'event', 'label':'Wisconsin basketball',
             'qty':4, 'threshold_cents':2500, 'active':True, 'alert_style':'first', 'match':{}, 'clubs':[]}
    event = {'event_id':'preview-event', 'name':'Wisconsin Badgers vs Example University',
             'event_date':'2026-11-07', 'datetime_local':'2026-11-07T19:00:00',
             'venue':'Example Arena', 'city':'Madison', 'state':'WI', 'url':'https://gametime.co/events/preview-event'}
    contents = {
        'confirmation': confirmation_email(watch, event),
        'price-alert': price_alert_email(watch, event, 1850, 'https://gametime.co/events/preview-event?quantity=4',
                                       'Lower level', '101', '8', {'basis':'fees_included_tax_unknown'},
                                       '2026-10-17T15:05:00Z'),
    }
    for name, content in contents.items():
        (output / (name + '.html')).write_text(content.html, encoding='utf-8')
        msg = EmailMessage()
        msg['From'] = 'Ticketline <sender@example.test>'
        msg['To'] = 'Preview Reader <reader@example.test>'
        msg['Subject'] = content.subject
        msg['Date'] = 'Sat, 17 Oct 2026 15:05:00 +0000'
        msg['Message-ID'] = f'<ticketline-{name}-preview@example.test>'
        msg.set_content(content.text)
        msg.add_alternative(content.html, subtype='html')
        (output / (name + '.eml')).write_bytes(msg.as_bytes())
    (output / 'README.md').write_text(
        '# Ticketline email previews\n\nThese are synthetic examples for review, not real prices, games, recipients, or delivery tests. '
        'Nothing was sent. Open an HTML file in a browser or an EML file in a mail app to review both content alternatives. '
        'Example links intentionally reference placeholder event and alert IDs.\n\n'
        '- confirmation.html / confirmation.eml: saved-alert confirmation\n'
        '- price-alert.html / price-alert.eml: matching-price notification\n', encoding='utf-8')
    return list(contents)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', help='Directory for sanitized HTML and EML previews')
    args = parser.parse_args()
    for name in write_previews(args.output):
        print(name)
