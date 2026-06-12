#!/usr/bin/env node
/**
 * Standalone mock broker for a2a-dispatch-round child-process tests.
 *
 * In-process mock servers deadlock with spawnSync (the parent event loop is
 * frozen while the child blocks on HTTP), so child-process CLI tests run the
 * broker as its own process. It prints `{"port":N}` on stdout once listening.
 *
 * Behavior is selected via argv[2]: "ok" (all 201) or "fail-first" (first POST
 * returns 500, the rest 201). Test-only; never used in production.
 */
import http from 'node:http';

const mode = process.argv[2] ?? 'ok';
const store = new Map();
let postCalls = 0;

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const send = (status, obj) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(obj == null ? '' : JSON.stringify(obj));
    };
    const url = req.url ?? '';
    if (req.method === 'POST' && url === '/tasks') {
      const body = raw ? JSON.parse(raw) : {};
      const call = postCalls++;
      if (mode === 'fail-first' && call === 0) {
        return send(500, { error: { code: 'internal' } });
      }
      store.set(body.id, { id: body.id, status: 'queued' });
      return send(201, { task: { id: body.id, status: 'queued' } });
    }
    if (req.method === 'GET' && url.startsWith('/tasks/')) {
      const id = decodeURIComponent(url.slice('/tasks/'.length));
      if (store.has(id)) return send(200, store.get(id));
      return send(404, { error: { code: 'not_found' } });
    }
    return send(404, { error: { code: 'not_found' } });
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
