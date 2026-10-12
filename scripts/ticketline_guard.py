"""Shared database admission for hosted provider traffic. No retries or redirects."""
import contextlib
import re
import urllib.request
import urllib.error
from urllib.parse import urlsplit

class CaptureDeferred(RuntimeError):
    pass

class Guard:
    def __init__(self, rpc):
        self.rpc = rpc
        self.token = None
        self.event_id = None
        self.deferred = None

    @contextlib.contextmanager
    def capture(self, event_id, source):
        if self.token:
            raise RuntimeError('Nested provider capture')
        claim = self.rpc('tix_claim_capture', {'p_event_id':event_id, 'p_source':source})
        if claim.get('state') != 'checking':
            raise CaptureDeferred(claim.get('reason') or claim.get('state','queued'))
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

    def admit(self):
        if not self.token:
            raise CaptureDeferred('Provider request needs a capture lease')
        if self.deferred:
            raise CaptureDeferred(self.deferred)
        admission = self.rpc('tix_admit_provider_http', {'p_token':self.token})
        if not admission.get('allowed'):
            reason = admission.get('reason','request_limit')
            self.deferred = reason
            raise CaptureDeferred(reason)

    def inspect(self, status, text=''):
        challenge = re.search(r'<title[^>]*>[^<]*(?:access denied|just a moment|attention required|captcha)|verify (?:you are|that you are) human|cf-chl-|px-captcha|g-recaptcha|hcaptcha',text,re.I)
        if status in (403,429) or challenge:
            self.rpc('tix_suspend_provider', {'p_token':self.token,'p_reason':f'HTTP_{status}' if status in (403,429) else 'challenge_or_denial'})
            raise CaptureDeferred('provider_suspended')

    def text(self, url, headers, timeout=25):
        parts = urlsplit(url)
        if parts.scheme != 'https' or parts.netloc != 'gametime.co' or parts.query or parts.fragment:
            raise ValueError('Unsafe provider URL')
        self.admit()
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
            raise

    def finish(self, capture):
        result = self.rpc('tix_finish_capture', {'p_token':self.token,'p_capture':capture})
        self.token = None
        return result
