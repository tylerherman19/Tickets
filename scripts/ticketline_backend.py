"""Short-lived, repository-scoped authentication for Ticketline's Neon API."""
import base64,json,os,time,urllib.request,urllib.parse
_cached=None
def service_key():
    global _cached
    configured=os.environ.get('SUPABASE_SERVICE_KEY','')
    if configured!='github-oidc':return configured
    if _cached and _cached[1]>time.time()+60:return _cached[0]
    if os.environ.get('GITHUB_ACTIONS')!='true':raise RuntimeError('Neon service access is restricted to GitHub Actions')
    url=urllib.parse.urlsplit(os.environ['ACTIONS_ID_TOKEN_REQUEST_URL'])
    if url.scheme!='https' or not url.hostname.endswith('.actions.githubusercontent.com'):
        raise RuntimeError('Unexpected GitHub identity endpoint')
    query=dict(urllib.parse.parse_qsl(url.query));query['audience']='ticketline-github-actions'
    target=urllib.parse.urlunsplit(url._replace(query=urllib.parse.urlencode(query)))
    req=urllib.request.Request(target,headers={'Authorization':'Bearer '+os.environ['ACTIONS_ID_TOKEN_REQUEST_TOKEN']})
    with urllib.request.urlopen(req,timeout=15) as response:token=json.load(response)['value']
    part=token.split('.')[1];claims=json.loads(base64.urlsafe_b64decode(part+'='*(-len(part)%4)))
    if claims.get('repository')!='tylerherman19/Tickets' or claims.get('ref')!='refs/heads/main':raise RuntimeError('Unexpected GitHub service identity')
    _cached=(token,claims['exp']);return token
