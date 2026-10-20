from tests.fake_outbox import with_outbox
import os
import sys
import unittest
from email import policy
from email.parser import BytesParser
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'scripts'))
os.environ.setdefault('SUPABASE_URL', 'https://example.test')
os.environ.setdefault('SUPABASE_SERVICE_KEY', 'test')
import ticket_emails as mail
import tickets_collect as collector


class ContentTests(unittest.TestCase):
    def setUp(self):
        self.watch = {'id':'preview-watch', 'kind':'event', 'label':'Badgers tickets', 'qty':4,
                      'threshold_cents':2500, 'active':True, 'alert_style':'first', 'match':{}, 'clubs':[]}
        self.event = {'event_id':'preview-event', 'name':'Wisconsin Badgers vs Example University',
                      'datetime_local':'2026-11-07T19:00:00', 'event_date':'2026-11-07',
                      'venue':'Example Arena', 'city':'Madison', 'state':'WI',
                      'url':'https://gametime.co/events/preview-event'}

    def alert(self, **overrides):
        args = dict(watch=self.watch, event=self.event, price_cents=1850,
                    listing_url='https://gametime.co/events/preview-event?listingId=sample&quantity=4',
                    club='Lower level', section='101', row='8',
                    fields={'basis':'fees_included_tax_unknown'}, checked_at='2026-10-17T15:05:00Z')
        args.update(overrides)
        return mail.price_alert_email(**args)

    def test_confirmation_states_exact_quantity_targets_group_budget_and_frequency(self):
        content = mail.confirmation_email(self.watch, self.event)
        for expected in ('4 tickets together', '$25 or less per ticket', '$100 for 4 tickets',
                         'First match per event and section', 'Sat, Nov 7, 2026 at 7:00 PM (venue local time)',
                         'Example Arena · Madison, WI', 'confirmation is not a ticket offer', 'Sales tax may be unreported'):
            self.assertIn(expected, content.text)
        self.assertIn('Ticketline: watching Badgers tickets', content.subject)
        self.assertIn('new.html?edit=preview-watch', content.html)
        self.assertIn('event.html?event=preview-event', content.text)

    def test_confirmation_paused_repeat_and_team_preferences(self):
        self.watch.update(active=False, kind='team', alert_style='repeat', clubs=['Club'],
                          match={'home_away':'away','club_level':True})
        content = mail.confirmation_email(self.watch)
        self.assertIn('paused alert saved', content.subject)
        self.assertIn('saved and paused', content.text)
        self.assertIn('Away games', content.text)
        self.assertIn('At most once per hour per event and section', content.text)
        self.assertNotIn('We will email when', content.text)
        self.assertIn('Sections: Club', content.text)

    def test_confirmation_missing_quantity_does_not_invent_it(self):
        self.watch.pop('qty')
        content = mail.confirmation_email(self.watch)
        self.assertNotIn('Tickets:', content.text)
        self.assertNotIn('Group budget:', content.text)

    def test_event_email_links_use_the_query_parameter_read_by_event_detail(self):
        import re
        from pathlib import Path
        from urllib.parse import parse_qs, urlsplit
        source = (Path(__file__).resolve().parents[1] / 'app.js').read_text()
        match = re.search(r"async function eventDetail\([^)]*\)\{\s*const id=query.get\('([^']+)'\)", source)
        self.assertIsNotNone(match, 'Keep this link contract in sync with eventDetail')
        for content in (mail.confirmation_email(self.watch, self.event), self.alert()):
            links = re.findall(r'href="([^"]+)"', content.html)
            event_links = [urlsplit(link) for link in links if urlsplit(link).path.endswith('/event.html')]
            self.assertTrue(event_links)
            for link in event_links:
                self.assertEqual(parse_qs(link.query).get(match.group(1)), ['preview-event'])

    def test_match_subject_and_text_are_actionable_and_price_basis_is_honest(self):
        content = self.alert()
        self.assertTrue(content.subject.startswith('Ticketline: $18.50/ticket'))
        for expected in ('$74', '$100 group budget', 'Sales tax was not verified', '4 tickets together',
                         'Section 101', 'Row 8', 'Oct 17, 2026 at 15:05 UTC', 'not reserved', 'View tickets on Gametime:',
                         'Manage or pause this alert:', 'View event and history:'):
            self.assertIn(expected, content.text)
        self.assertNotIn('including tax', content.text)

    def test_tax_reported_unknown_and_missing_are_separate(self):
        reported = self.alert(fields={'basis':'fees_included_tax_reported'})
        self.assertIn('Gametime reported sales tax', reported.text)
        self.assertNotIn('Sales tax was not verified', reported.text)
        unknown = self.alert(fields={})
        self.assertIn('fee and tax basis is unconfirmed', unknown.text)
        self.assertNotIn('Fees included.', unknown.text)

    def test_unreported_seat_fields_and_time_are_not_invented(self):
        content = self.alert(section=None, row=None, event={'event_id':'e','event_date':'2026-11-07'})
        self.assertIn('time not confirmed', content.text)
        self.assertIn('Venue not confirmed', content.text)
        self.assertIn('Section unreported · Row unreported', content.text)
        self.assertNotIn('None', content.text)
        self.assertEqual(mail.checked_when('2026-10-17T15:05:00'), 'Check time not confirmed')

    def test_html_escapes_provider_and_user_strings_and_subject_control_characters(self):
        self.event['name'] = '<script>alert("test")</script>\r\nBcc: bad@example.test'
        content = self.alert(club='<img src=x onerror=alert(1)>', fields={'deal':'<b>great</b>\nFake'})
        self.assertNotIn('<script>', content.html)
        self.assertNotIn('<img', content.html)
        self.assertIn('&lt;script&gt;', content.html)
        self.assertIn('&lt;b&gt;great&lt;/b&gt; Fake', content.html)
        self.assertNotIn('\n', content.subject)
        self.assertNotIn('\r', content.subject)

    def test_provider_links_reject_spoofed_hosts_credentials_ports_and_injections(self):
        for url in ('javascript:alert(1)', 'http://gametime.co/events/e', 'https://gametime.co.evil.test/events/e',
                    'https://gametime.co@evil.test/events/e', 'https://user@gametime.co/events/e',
                    'https://gametime.co:999/events/e', 'https://gametime.co/events/e\r\nX-Evil: x', '//gametime.co/events/e'):
            self.assertEqual(mail.provider_link(url), '', url)
        content = self.alert(listing_url='javascript:alert(1)')
        self.assertIn('View tickets on Gametime: https://gametime.co/events/preview-event', content.text)
        self.assertNotIn('javascript:', content.html)

    def test_site_link_encodes_identifiers_and_does_not_follow_untrusted_redirects(self):
        self.watch['id'] = 'test&redirect=https://evil.test/#"<'
        content = mail.confirmation_email(self.watch)
        self.assertIn('new.html?edit=test%26redirect%3Dhttps%3A%2F%2Fevil.test%2F%23%22%3C', content.text)
        self.assertNotIn('href="https://evil.test/', content.html)

    def test_address_validation_accepts_single_mailboxes_only(self):
        for value in ('person@example.test', 'person+ticket@gmail.com'):
            self.assertTrue(mail.valid_address(value))
        for value in ('name@example.test\r\nBcc:bad@example.test', 'Name <person@example.test>',
                      'first@example.test,second@example.test', 'broken', '', None, 'a@@example.test'):
            self.assertFalse(mail.valid_address(value), repr(value))


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.stack = []
        for name, value in [('GMAIL_ADDRESS','sender@example.test'), ('GMAIL_APP_PASSWORD','abc def')]:
            p = patch.object(collector, name, value); p.start(); self.stack.append(p)
        self.addCleanup(lambda: [p.stop() for p in reversed(self.stack)])

    def test_email_is_multipart_with_plain_fallback_identity_and_delivery_headers(self):
        smtp = MagicMock()
        smtp.__enter__.return_value.send_message.return_value = {}
        with patch('smtplib.SMTP_SSL', return_value=smtp), patch.object(collector, 'write_state') as health:
            result = collector.send_sms('Ticketline: match\r\nX-Test: text', 'Plain fallback',
                                        recipient='reader@example.test', html_body='<h1>Matching tickets</h1>')
        self.assertTrue(result)
        sent = smtp.__enter__.return_value.send_message.call_args.args[0]
        parsed = BytesParser(policy=policy.default).parsebytes(sent.as_bytes())
        self.assertEqual(parsed.get_content_type(), 'multipart/alternative')
        self.assertIn('Plain fallback', parsed.get_body(preferencelist=('plain',)).get_content())
        self.assertIn('Matching tickets', parsed.get_body(preferencelist=('html',)).get_content())
        self.assertEqual(str(parsed['From']), 'Ticketline <sender@example.test>')
        self.assertTrue(parsed['Date']); self.assertTrue(parsed['Message-ID'])
        self.assertIsNone(parsed['X-Test'])
        smtp.__enter__.return_value.login.assert_called_once_with('sender@example.test', 'abcdef')
        self.assertEqual(health.call_args.args[1]['status'], 'accepted')

    def test_carrier_text_keeps_plain_text_only_and_explicit_destination(self):
        smtp = MagicMock()
        smtp.__enter__.return_value.send_message.return_value = {}
        with patch('smtplib.SMTP_SSL', return_value=smtp), patch.object(collector, 'write_state'):
            self.assertTrue(collector.send_sms('Tickets', 'Compact text', recipient='6125550148@tmomail.net', html_body='<p>Do not send HTML to carrier</p>'))
        sent = smtp.__enter__.return_value.send_message.call_args.args[0]
        self.assertFalse(sent.is_multipart())
        self.assertEqual(sent.get_content_type(), 'text/plain')
        self.assertEqual(sent['To'], '6125550148@tmomail.net')

    def test_invalid_recipient_fails_without_contacting_smtp(self):
        with patch('smtplib.SMTP_SSL') as smtp, patch.object(collector, 'write_state') as health:
            self.assertFalse(collector.send_sms('Tickets','Body',recipient='person@example.test\r\nBcc: other@example.test'))
        smtp.assert_not_called()
        self.assertEqual(health.call_args.args[1]['status'], 'failed')

    def test_smtp_failure_is_not_recorded_as_delivery_success(self):
        with patch('smtplib.SMTP_SSL', side_effect=OSError('offline failure')), patch.object(collector, 'write_state') as health:
            self.assertFalse(collector.send_sms('Tickets', 'Body', recipient='reader@example.test'))
        self.assertEqual(health.call_args.args[1]['status'], 'failed')

    def test_confirmation_rereads_channel_opt_out_before_sending(self):
        queue = {'watch_id':'w', 'email_enabled':True, 'sms_enabled':True, 'event_label':'Game', 'email_attempts':0, 'attempts':0}
        writes = []
        def db(method, path, body=None, prefer=None):
            if path.startswith('tix_confirmation_queue?') and method == 'GET': return [queue]
            if path.startswith('tix_watches?'): return [{'threshold_cents':2500, 'qty':2, 'email_enabled':False,'sms_enabled':False}]
            if path.startswith('tix_destinations?'): return [{'phone_digits':'6125550148', 'provider':'tmobile'}]
            writes.append((path,body)); return []
        with patch.object(collector,'sb',side_effect=with_outbox(db)), patch.object(collector,'owner_email',return_value='reader@example.test'), patch.object(collector,'send_sms') as send:
            self.assertEqual(collector.send_pending_confirmations(),0)
        send.assert_not_called()
        self.assertTrue(any(body.get('email_enabled') is False and body.get('sms_enabled') is False for _,body in writes))

    def test_confirmation_retries_only_failed_channel_and_does_not_overwrite_new_queue_version(self):
        queue = {'watch_id':'w', 'event_label':'Game', 'email_enabled':True, 'sms_enabled':True,
                 'email_sent_at':'2026-10-17T15:00:00Z', 'email_attempts':1, 'attempts':1,
                 'requested_at':'2026-10-17T14:59:00+00:00'}
        writes = []
        def db(method, path, body=None, prefer=None):
            if method == 'GET' and path.startswith('tix_confirmation_queue?email_enabled='): return []
            if method == 'GET' and path.startswith('tix_confirmation_queue?sms_enabled='): return [queue]
            if path.startswith('tix_watches?'): return [{'threshold_cents':2500,'qty':2,'email_enabled':True,'sms_enabled':True}]
            if path.startswith('tix_destinations?'): return [{'phone_digits':'6125550148','provider':'tmobile'}]
            writes.append((path,body)); return []
        for accepted in (False, True):
            with patch.object(collector,'sb',side_effect=with_outbox(db)), patch.object(collector,'send_sms',return_value=accepted) as send:
                self.assertEqual(collector.send_pending_confirmations(),0 if accepted else 1)
            send.assert_called_once()
            self.assertEqual(send.call_args.kwargs['recipient'],'6125550148@tmomail.net')
            self.assertNotIn('html_body',send.call_args.kwargs)
            path, body = writes[-1]
            self.assertIn('requested_at=eq.2026-10-17T14%3A59%3A00%2B00%3A00',path)
            self.assertNotIn('email_sent_at',body)
            self.assertNotIn('email_attempts',body)
            self.assertEqual('sent_at' in body,accepted)


class AuthTemplateTests(unittest.TestCase):
    def test_verification_link_is_preserved_without_tracking_or_external_assets(self):
        from html.parser import HTMLParser
        from pathlib import Path
        class Resources(HTMLParser):
            def __init__(self):
                super().__init__(); self.urls = []; self.active_tags = []
            def handle_starttag(self, tag, attrs):
                if tag in ('script','iframe','img','link','form'):
                    self.active_tags.append(tag)
                self.urls.extend(value for key,value in attrs if key in ('href','src','action'))
        base = Path(__file__).resolve().parents[1] / 'supabase' / 'templates'
        for name in ('confirmation.html','magic-link.html'):
            source = (base / name).read_text()
            parsed = Resources(); parsed.feed(source)
            self.assertEqual(parsed.urls, ['{{ .SiteURL }}auth-callback.html#confirmation_url={{ .ConfirmationURL }}'])
            self.assertEqual(parsed.active_tags, [])
            self.assertEqual(source.count('{{ .ConfirmationURL }}'), 1)
            self.assertEqual(source.count('{{ .Token }}'), 1)
            self.assertNotIn('@import', source)
            self.assertNotIn('url(', source)
            self.assertIn('If you did not request', source)

    def test_config_uses_offline_template_files_without_changing_jwt_verification(self):
        from pathlib import Path
        source = (Path(__file__).resolve().parents[1] / 'supabase' / 'config.toml').read_text()
        self.assertIn('[functions.ticketline-prices]\nverify_jwt = true', source)
        for section, filename in (('magic_link','magic-link.html'),('confirmation','confirmation.html')):
            block = source.split('[auth.email.template.' + section + ']', 1)[1].split('[',1)[0]
            self.assertIn('content_path = "./supabase/templates/' + filename + '"', block)


if __name__ == '__main__':
    unittest.main()
