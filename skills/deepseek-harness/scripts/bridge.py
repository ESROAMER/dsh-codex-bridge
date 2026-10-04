"""Small JSON client for an installed DeepSeek Harness collaboration bridge.

Uses only Python's standard library. Credentials stay in an existing token file
or environment variable; this script never installs plugins or issues tokens.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_CONFIG = Path(__file__).resolve().parents[1] / 'references' / 'local-settings.json'
ROUTES = {
    'GET': {'/health', '/workspaces', '/capabilities', '/sessions', '/transcript', '/tasks/get', '/tasks/list'},
    'POST': {'/tasks/create', '/tasks/append', '/tasks/wait', '/tasks/cancel', '/tasks/close'},
}


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def connection(config_path):
    config = load_json(config_path) if Path(config_path).exists() else {}
    base = os.environ.get('DSH_CODEX_BRIDGE_URL') or config.get('base_url')
    if not base:
        raise ValueError('Missing bridge URL: set DSH_CODEX_BRIDGE_URL or local-settings.json')
    parsed = urllib.parse.urlsplit(base)
    if (parsed.scheme != 'http' or parsed.hostname not in ('127.0.0.1', 'localhost', '::1')
            or parsed.username or parsed.password or parsed.query or parsed.fragment):
        raise ValueError('Bridge URL must be a local HTTP URL without credentials, query, or fragment')
    token = os.environ.get('DSH_CODEX_BRIDGE_TOKEN', '').strip()
    if not token:
        location = os.environ.get('DSH_CODEX_BRIDGE_TOKEN_FILE') or config.get('token_file')
        if not location:
            raise ValueError('Missing dedicated bridge token file configuration')
        location = Path(location).expanduser()
        if not location.is_absolute():
            location = Path(config_path).resolve().parent / location
        token = location.read_text(encoding='utf-8-sig').strip()
    if not token or '\n' in token or '\r' in token:
        raise ValueError('Invalid dedicated bridge token')
    return base.rstrip('/'), token


def request(config_path, method, route, query=None, body=None, timeout=40):
    if route not in ROUTES.get(method, set()):
        raise ValueError('Unsupported JSON bridge route')
    if method == 'GET' and body is not None:
        raise ValueError('GET does not accept a JSON body')
    if method == 'POST' and not isinstance(body, dict):
        raise ValueError('POST requires an object in --body-file')
    if route in ('/tasks/create', '/tasks/append') and not isinstance(body.get('requestId'), str):
        raise ValueError('Mutation requires a stable requestId in the saved request body')
    if route == '/tasks/wait' and not 0 <= body.get('waitMs', 25000) <= 30000:
        raise ValueError('Use a bounded waitMs between 0 and 30000')
    base, token = connection(config_path)
    url = base + route
    if query:
        url += '?' + urllib.parse.urlencode(query)
    headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json'}
    data = None
    if body is not None:
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    # Credentials must never travel through a configured HTTP proxy or redirect.
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=timeout) as response:
            status = response.status
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        status = error.code
        try:
            payload = json.load(error)
        except (ValueError, UnicodeDecodeError):
            payload = {'ok': False, 'error': {'code': 'transport/http-error', 'message': f'HTTP {status}'}}
    return status, payload


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('method', choices=sorted(ROUTES))
    parser.add_argument('route')
    parser.add_argument('--query', action='append', default=[], metavar='KEY=VALUE')
    parser.add_argument('--body-file')
    parser.add_argument('--config', type=Path, default=DEFAULT_CONFIG)
    parser.add_argument('--timeout', type=float, default=40)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args(argv)
    if not 0 < args.timeout <= 60:
        parser.error('--timeout must be in (0, 60] seconds')
    query = {}
    for item in args.query:
        key, separator, value = item.partition('=')
        if not separator or not key:
            parser.error('--query requires KEY=VALUE')
        if key in query:
            parser.error('Duplicate query key: ' + key)
        query[key] = value
    try:
        body = load_json(args.body_file) if args.body_file else None
        status, payload = request(args.config, args.method, args.route, query, body, args.timeout)
        successful = 200 <= status < 300 and payload.get('ok') is True
        rendered = json.dumps(payload, ensure_ascii=False, indent=2)
        if args.output:
            args.output.write_text(rendered + '\n', encoding='utf-8')
            print('Saved bridge response to', args.output)
        else:
            print(rendered, file=sys.stdout if successful else sys.stderr)
        return 0 if successful else 2
    except (OSError, ValueError, urllib.error.URLError) as error:
        print(json.dumps({'ok': False, 'error': {'code': 'client/error', 'message': str(error)}}, ensure_ascii=False), file=sys.stderr)
        return 3


if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    raise SystemExit(main())
