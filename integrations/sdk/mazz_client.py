"""Standard-library client for the real MAZZ HTTP/SSE API (local only)."""
import json
import urllib.error
import urllib.parse
import urllib.request


class MazzApiError(RuntimeError):
    def __init__(self, status, details):
        self.status, self.details = status, details
        super().__init__(f'MAZZ HTTP {status}: {details}')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise MazzApiError(403, 'API redirect refused')


class MazzClient:
    def __init__(self, endpoint='http://127.0.0.1:3333', timeout=180):
        parsed=urllib.parse.urlsplit(endpoint)
        if parsed.scheme!='http' or parsed.hostname not in {'127.0.0.1','localhost','::1'} or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in {'','/'}:
            raise ValueError('Use an explicit loopback HTTP origin without credentials')
        self.endpoint=endpoint.rstrip('/');self.timeout=timeout
        self.opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),_NoRedirect())

    def _open(self, method, route, body=None):
        if not route.startswith('/api/') or route.startswith('//'):
            raise ValueError('Only /api/ routes are supported')
        request=urllib.request.Request(self.endpoint+route,method=method,
            data=json.dumps(body,ensure_ascii=False).encode('utf-8') if body is not None else None,
            headers={'Content-Type':'application/json'})
        try:return self.opener.open(request,timeout=self.timeout)
        except urllib.error.HTTPError as error:
            text=error.read(65536).decode('utf-8',errors='replace')
            try:details=json.loads(text)
            except ValueError:details=text
            raise MazzApiError(error.code,details) from error

    def request(self, method, route, body=None):
        with self._open(method,route,body) as response:return json.load(response)

    def health(self):return self.request('GET','/api/health')
    def models(self):return self.request('GET','/api/models/catalog')
    def create_session(self, project_root, title='SDK session', provider_id='llama-local', model_id='local', mode='ask'):
        return self.request('POST','/api/sessions',{'projectRoot':str(project_root),'title':title,'providerId':provider_id,'modelId':model_id,'mode':mode})['session']
    def session(self, session_id):return self.request('GET','/api/sessions/'+urllib.parse.quote(session_id,safe=''))['session']
    def cancel(self, task_id):return self.request('POST','/api/agent/cancel',{'taskId':task_id})
    def stream(self, goal, session_id=None, mode='ask', provider_id='llama-local', model_id='local'):
        body={'goal':goal,'mode':mode,'selection':{'providerId':provider_id,'modelId':model_id,'executionMode':'local_strict'}}
        if session_id:body['sessionId']=session_id
        with self._open('POST','/api/agent/run',body) as response:
            for line in response:
                if line.startswith(b'data: '):
                    payload=line[6:].strip()
                    if payload==b'[DONE]':break
                    yield json.loads(payload)
