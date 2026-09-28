import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const FIXTURE = join(ROOT, 'tests/e2e/fixtures');

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.map': 'application/json',
};

// The strict policy the 0.4.1 CSP work exists to survive. `style-src 'self'`
// with no 'unsafe-inline' drops injected <style> nodes; constructed sheets and
// CSSOM writes are unaffected. Served only on /csp so the SPA fixture keeps
// its inline router.
const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; style-src-attr 'none'";

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let filePath;
  const headers = {};

  if (url.pathname.startsWith('/dist/')) {
    filePath = join(ROOT, url.pathname);
  } else if (url.pathname === '/capture') {
    filePath = join(FIXTURE, 'capture.html');
  } else if (url.pathname === '/csp') {
    filePath = join(FIXTURE, 'csp.html');
    headers['Content-Security-Policy'] = STRICT_CSP;
  } else {
    filePath = join(FIXTURE, 'index.html');
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ...headers,
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(4173, () => {
  console.log('E2E fixture server on http://localhost:4173');
});
