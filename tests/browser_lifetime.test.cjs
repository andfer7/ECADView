// Each test owns a backend: closing the last viewer must really exit it.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
let browser;
const options = { headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) };
const pause = ms => new Promise(done => setTimeout(done, ms));
before(async () => { browser = await chromium.launch(options); });
after(async () => { await browser?.close(); });

async function backend(t) {
  const child = spawn(process.env.PCB_TEST_PYTHON || resolve(__dirname, '../.venv/bin/python'),
    ['-B', '-u', resolve(__dirname, '../ecadview.py'), '--no-open']);
  let output = '';
  child.stderr.on('data', data => { output += data; });
  const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } });
  const url = await new Promise((done, reject) => {
    const timeout = setTimeout(() => reject(new Error('Backend startup timed out: ' + output)), 20000);
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) { clearTimeout(timeout); done(match[0]); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Backend exited before startup: ' + output)); });
  });
  return {
    process: child, url,
    async stopped() {
      let timeout;
      try {
        const result = await Promise.race([exited, new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Backend did not quit after the last viewer closed: ' + output)), 10000);
        })]);
        assert.deepEqual(result, { code: 0, signal: null });
      } finally { clearTimeout(timeout); }
    },
  };
}
async function viewer(t, server, host = browser, init) {
  const page = await host.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { if (!page.isClosed()) await page.close(); assert.deepEqual(errors, []); });
  if (init) await page.addInitScript(init);
  const connected = page.waitForResponse(response => response.url() === server.url + 'session' && response.status() === 200);
  await page.goto(server.url); await connected;
  return page;
}
async function alive(server) {
  assert.equal(server.process.exitCode, null);
  assert.equal((await fetch(server.url)).status, 200);
}

test('an unopened server waits; closing its first and last tab automatically exits the program', { timeout: 30000 }, async t => {
  const server = await backend(t);
  await pause(4200); await alive(server);
  const page = await viewer(t, server);
  await page.close(); await server.stopped();
});

test('refreshes and a new viewer during the reconnect grace keep the backend running', { timeout: 30000 }, async t => {
  const server = await backend(t), page = await viewer(t, server);
  for (let i = 0; i < 3; i++) {
    const reconnected = page.waitForResponse(response => response.url() === server.url + 'session' && response.status() === 200);
    await page.reload(); await reconnected;
  }
  await pause(3500); await alive(server);
  await page.close(); await pause(500);
  const replacement = await viewer(t, server);
  await pause(3500); await alive(server);
  await replacement.close(); await server.stopped();
});

test('closing one of several viewer tabs keeps the remaining viewer alive without JS heartbeat timers', { timeout: 30000 }, async t => {
  const server = await backend(t), first = await viewer(t, server), second = await viewer(t, server);
  await first.close();
  // A busy/paused renderer must not look like a closed background tab.
  const busy = second.evaluate(() => {
    const until = performance.now() + 4500;
    while (performance.now() < until) { /* Intentionally block JS heartbeat work. */ }
  });
  await pause(3500); await alive(server); await busy;
  await second.close(); await server.stopped();
});

test('pagehide/pageshow reconnect a restored page without stopping its backend', { timeout: 30000 }, async t => {
  const server = await backend(t), page = await viewer(t, server);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await pause(500);
  const connected = page.waitForResponse(response => response.url() === server.url + 'session' && response.status() === 200);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await connected; await pause(3500); await alive(server);
  await page.close(); await server.stopped();
});

test('closing a whole browser exits the backend even when pagehide handlers never run', { timeout: 30000 }, async t => {
  const server = await backend(t), window = await chromium.launch(options);
  t.after(async () => { await window.close(); });
  await viewer(t, server, window, () => {
    window.addEventListener('pagehide', event => event.stopImmediatePropagation(), true);
  });
  await window.close(); await server.stopped();
});
