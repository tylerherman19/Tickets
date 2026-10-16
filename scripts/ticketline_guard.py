"""Shared database admission for hosted provider traffic. No retries or redirects."""
import contextlib
import re
import time
import urllib.request
import urllib.error
from urllib.parse import urljoin, urlsplit

# Same rule as the database: an absolute gametime.co link with plain path segments.
SAFE_PROVIDER_URL = re.compile(r'https://gametime\.co(/[A-Za-z0-9._~%-]+)+')

def moved_event_url(location, url, event_id):
    """A redirect's target when it is the same event's page on the provider."""
    if not location or not event_id: return None
    target = urljoin(url, location.strip())
    if (len(target) <= 500 and SAFE_PROVIDER_URL.fullmatch(target) and target != url
            and not re.search(r'/\.\.?(/|$)', target) and target.endswith('/events/'+event_id)):
        return target
    return None

class CaptureDeferred(RuntimeError):
    def __init__(self, reason, state='queued'):
        super().__init__(reason)
        self.reason = reason
        self.state = state

class Guard:
    # A full minute window resets within seconds; wait once rather than skip
    # the event. Longer (hourly/daily) limits defer the work to a later run.
    MAX_WAIT_SECONDS = 30

    def __init__(self, rpc, sleep=time.sleep, clock=time.time):
        self.rpc = rpc
        self.sleep = sleep
        self.clock = clock
        self.token = None
        self.event_id = None
        self.deferred = None

    @contextlib.contextmanager
    def capture(self, event_id, source):
        if self.token:
            raise RuntimeError('Nested provider capture')
        claim = self.rpc('tix_claim_capture', {'p_event_id':event_id, 'p_source':source})
        if claim.get('state') != 'checking':
            raise CaptureDeferred(claim.get('reason') or claim.get('state','queued'), claim.get('state','queued'))
        self.token, self.event_id = claim['token'], event_id
        self.deferred = None
        try:
            yield self
        except Exception:
            if self.token:
                self.rpc('tix_release_capture', {'p_token':self.token, 'p_reason':self.deferred or 'capture_failed'})
                self.token = None
            raise
        finally:
            if self.token:
                self.rpc('tix_release_capture', {'p_token':self.token, 'p_reason':self.deferred or ('catalog_complete' if event_id is None else 'capture_interrupted')})
            self.token, self.event_id = None, None

    def admit(self, wait=False):
        if not self.token:
            raise CaptureDeferred('Provider request needs a capture lease')
        if self.deferred:
            raise CaptureDeferred(self.deferred)
        admission = self.rpc('tix_admit_provider_http', {'p_token':self.token})
        delay = self._retry_delay(admission) if wait else None
        if delay is not None:
            self.sleep(delay)
            admission = self.rpc('tix_admit_provider_http', {'p_token':self.token})
        if not admission.get('allowed'):
            reason = admission.get('reason','request_limit')
            self.deferred = reason
            raise CaptureDeferred(reason)

    def _retry_delay(self, admission):
        if admission.get('allowed') or admission.get('reason') != 'request_limit':
            return None
        try:
            from datetime import datetime
            reset = datetime.fromisoformat(str(admission['next_attempt_at']).replace('Z','+00:00')).timestamp()
        except (KeyError, TypeError, ValueError):
            return None
        delay = reset - self.clock()
        return max(0.0, delay) if delay <= self.MAX_WAIT_SECONDS else None

    def inspect(self, status, text=''):
        challenge = re.search(r'<title[^>]*>[^<]*(?:access denied|just a moment|attention required|captcha)|verify (?:you are|that you are) human|cf-chl-|px-captcha|g-recaptcha|hcaptcha',text,re.I)
        if status in (403,429) or challenge:
            self.rpc('tix_suspend_provider', {'p_token':self.token,'p_reason':f'HTTP_{status}' if status in (403,429) else 'challenge_or_denial'})
            raise CaptureDeferred('provider_suspended', 'suspended')

    def text(self, url, headers, timeout=25):
        parts = urlsplit(url)
        if parts.scheme != 'https' or parts.netloc != 'gametime.co' or parts.query or parts.fragment:
            raise ValueError('Unsafe provider URL')
        self.admit(wait=True)
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        try:
            with urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(url,headers=headers), timeout=timeout) as response:
                text = response.read().decode('utf-8','replace')
                self.inspect(response.status,text)
                return text
        except urllib.error.HTTPError as error:
            self.inspect(error.code,error.read().decode('utf-8','replace'))
            if 300 <= error.code < 400:
                self.redirected(url, error.headers.get('Location') if error.headers else None)
            raise

    def redirected(self, url, location):
        """Never followed. A move to the same event's page saves the new link for
        the next check (deferred, not failed); anything else backs off and the
        HTTP error stays a failed check."""
        if not self.event_id: return
        try:
            result = self.rpc('tix_note_redirect', {'p_token':self.token,
                              'p_location':moved_event_url(location, url, self.event_id)})
        except Exception:
            return  # Not deployed yet: the capture is released as failed, as before.
        self.token = None
        if isinstance(result, dict) and result.get('state') == 'queued':
            raise CaptureDeferred(result.get('reason') or 'url_moved')

    def finish(self, capture):
        result = self.rpc('tix_finish_capture', {'p_token':self.token,'p_capture':capture})
        self.token = None
        return result
