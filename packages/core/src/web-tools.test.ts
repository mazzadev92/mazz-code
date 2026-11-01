import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { assertPublicUrl, htmlToText, parseDuckDuckGo, requestPinnedAddress } from './web-tools.js';

test('web.fetch refuses loopback, private and non-http addresses', async () => {
  for (const u of ['http://127.0.0.1:3333/api/settings', 'http://localhost:3333/', 'http://[::1]/', 'http://192.168.1.10/', 'http://10.0.0.1/', 'http://169.254.169.254/latest', 'file:///C:/Windows/win.ini']) {
    await assert.rejects(assertPublicUrl(u), Error, u);
  }
  assert.equal((await assertPublicUrl('https://93.184.215.14/')).hostname, '93.184.215.14');
});

test('web.fetch rejects non-public IPv6 literals, including hexadecimal IPv4-mapped addresses', async () => {
  // These are all literal addresses: assertPublicUrl must reject them before any
  // fetch or DNS operation can occur.
  const refused = [
    'http://[::ffff:c0a8:101]/',       // 192.168.1.1, hexadecimal mapped form
    'http://[::ffff:7f00:1]/',         // 127.0.0.1, hexadecimal mapped form
    'http://[::ffff:169.254.169.254]/',// cloud metadata, dotted mapped form
    'http://[64:ff9b::a9fe:a9fe]/',    // NAT64 embedding 169.254.169.254
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[fec0::1]/',               // deprecated site-local
    'http://[ff02::1]/',               // multicast
    'http://[2001:2::1]/',             // benchmarking allocation
    'http://[2001:db8::1]/',           // documentation
    'http://[2002:a9fe:a9fe::1]/',     // 6to4 embedding metadata IPv4
    'http://[3fff::1]/',               // documentation
  ];
  for (const url of refused) await assert.rejects(assertPublicUrl(url), Error, url);

  assert.equal((await assertPublicUrl('https://[2606:4700:4700::1111]/')).hostname, '[2606:4700:4700::1111]');
});

test('pinned HTTP transport connects to its resolved address while preserving the requested hostname', async (t) => {
  let receivedHost: string | undefined;
  let receivedUrl: string | undefined;
  const server = createServer((request, response) => {
    receivedHost = request.headers.host;
    receivedUrl = request.url;
    response.writeHead(200, { 'content-type': 'text/plain', connection: 'close' });
    response.end('loopback transport reached');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  const bound = server.address();
  assert.ok(bound && typeof bound === 'object');
  const response = await requestPinnedAddress(
    new URL(`http://rebind.invalid:${bound.port}/pinned?source=test`),
    '127.0.0.1',
    {},
    2000,
  );
  assert.equal(response.status, 200);
  assert.equal(response.url, `http://rebind.invalid:${bound.port}/pinned?source=test`);
  assert.equal(await response.text(), 'loopback transport reached');
  assert.equal(receivedHost, `rebind.invalid:${bound.port}`);
  assert.equal(receivedUrl, '/pinned?source=test');
  await assert.rejects(assertPublicUrl(`http://127.0.0.1:${bound.port}/must-not-connect`), Error);
});

test('DuckDuckGo results and HTML-to-text conversion', () => {
  const ddg = `<div><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fllama.cpp.org%2Fdocs&amp;rut=x">llama.cpp &amp; docs</a><a class="result__snippet" href="#">Inference <b>CPU</b></a></div>`;
  assert.deepEqual(parseDuckDuckGo(ddg, 5), [{ title: 'llama.cpp & docs', url: 'https://llama.cpp.org/docs', snippet: 'Inference CPU' }]);
  const { title, text } = htmlToText('<html><head><title>Doc</title><script>x()</script></head><body><nav>menu</nav><h2>Install</h2><p>Run <a href="https://a.b/c">this</a></p><ul><li>one</li></ul></body></html>');
  assert.equal(title, 'Doc');
  assert.match(text, /## Install/);
  assert.match(text, /\[this\]\(https:\/\/a\.b\/c\)/);
  assert.match(text, /- one/);
  assert.ok(!text.includes('menu') && !text.includes('x()'));
});
