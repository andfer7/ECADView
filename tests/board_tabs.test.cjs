// Requires Node.js and Playwright: node --test tests/board_tabs.test.cjs
// Set PLAYWRIGHT_CHANNEL=chrome to use an installed Google Chrome browser.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const { chromium } = require('playwright');

const source = readFileSync(resolve(__dirname, '../pcb_viewer_gui.py'), 'utf8');
const html = source.match(/PAGE = r"""([\s\S]*?)"""/)[1];
let browser, server, origin;

before(async () => {
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});

const file = name => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(name) });
const boardData = (name, components = 1) => ({
  name,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <g id="scene"><g id="layer-top" data-layer-name="Top copper" data-color="#ff0000">
    <rect x="10" y="10" width="80" height="60" fill="#ff0000"/></g>
    <g id="board-outline"><rect x="0" y="0" width="100" height="80" fill="none" stroke="#cccc00"/></g></g>
  </svg>`,
  stats: { components, pads: 2, tracks: 3, vias: 4, polygons: 5, regions: 6 },
});
const layeredBoardData = name => ({
  ...boardData(name),
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <g id="scene" transform="translate(5 5)">
      <g id="layer-top" data-layer-name="Top copper"><rect width="90" height="70" fill="red"/></g>
      <g id="layer-bottom" data-layer-name="Bottom copper"><rect width="90" height="70" fill="blue"/></g>
      <g id="board-outline"><rect width="90" height="70" fill="none" stroke="yellow"/></g>
    </g>
  </svg>`,
});
const layerOrder = page => page.locator('#scene > g').evaluateAll(groups => groups.map(g => g.id));
const frontLayer = page => page.locator('#view > svg').evaluate(svg => {
  const point = new DOMPoint(50, 40).matrixTransform(svg.getScreenCTM());
  return document.elementFromPoint(point.x, point.y)?.parentElement.id;
});
const reply = (route, data, status = 200) => route.fulfill({ status, json: data });
const activeName = page => page.locator('#view > svg').getAttribute('data-board');
async function loaded(page, name) {
  await page.waitForFunction(name => {
    const svg = document.querySelector('#view > svg');
    return svg?.getAttribute('data-board') === name && document.getElementById('busy').style.display === 'none';
  }, name);
}
async function openPage(t, { render, initial = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.route('**/initial', route => reply(route, initial));
  await page.route('**/render', route => {
    const request = route.request();
    const name = decodeURIComponent(request.headers()['x-filename']);
    requests.push({ name, url: new URL(request.url()), body: request.postDataBuffer() });
    return render ? render(route, name) : reply(route, boardData(name, name === 'B.PcbDoc' ? 9 : 1));
  });
  await page.goto(origin);
  return { page, requests };
}

test('opens multiple files, switches tabs, and closes back to the empty view', async t => {
  const { page, requests } = await openPage(t);
  await page.locator('#file').setInputFiles([file('A.PcbDoc'), file('B.PcbDoc')]);
  await loaded(page, 'B.PcbDoc');
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.match(await page.locator('#stats').textContent(), /^9 components/);
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  await loaded(page, 'A.PcbDoc');
  assert.match(await page.locator('#stats').textContent(), /^1 components/);
  assert.equal(requests.length, 2, 'switching does not render again');
  await page.getByRole('button', { name: 'Close B.PcbDoc', exact: true }).click();
  assert.equal(await activeName(page), 'A.PcbDoc');
  await page.getByRole('button', { name: 'Close A.PcbDoc', exact: true }).click();
  assert.equal(await page.getByRole('tab').count(), 0);
  assert.equal(await page.locator('#empty').isVisible(), true);
  assert.equal(await page.locator('#filename').textContent(), 'No board loaded');
  assert.equal(await page.locator('#view > svg').count(), 0);
  await page.locator('#file').setInputFiles(file('A.PcbDoc'));
  await loaded(page, 'A.PcbDoc');
});

test('preserves each board’s layers, zoom, pan, measurements, and units', async t => {
  const { page, requests } = await openPage(t);
  await page.locator('#file').setInputFiles(file('A.PcbDoc'));
  await loaded(page, 'A.PcbDoc');
  await page.locator('#layers input').first().uncheck();
  await page.locator('#view').dispatchEvent('wheel', { deltaY: -250, clientX: 600, clientY: 400 });
  await page.mouse.move(600, 400); await page.mouse.down();
  await page.mouse.move(630, 420); await page.mouse.up();
  const viewBox = await page.locator('#view > svg').getAttribute('viewBox');
  await page.locator('[data-unit="mil"]').click();
  await page.locator('#measure-btn').click();
  await page.locator('#view').click({ position: { x: 200, y: 200 } });
  await page.locator('#view').click({ position: { x: 400, y: 300 } });
  const measurement = await page.locator('#readout').textContent();
  assert.match(measurement, /^dist .* mil/);
  await page.locator('#file').setInputFiles(file('B.PcbDoc'));
  await loaded(page, 'B.PcbDoc');
  assert.equal(await page.locator('#layers input').first().isChecked(), true);
  assert.equal(await page.locator('#measure line').count(), 0);
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#layers input').first().isChecked(), false);
  assert.equal(await page.locator('#scene > g').first().evaluate(g => g.style.display), 'none');
  assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), viewBox);
  assert.equal(await page.locator('#readout').textContent(), measurement);
  assert.equal(await page.locator('#measure line').count(), 1);
  assert.equal(await page.locator('#measure-btn').getAttribute('class'), 'on');
  assert.equal(requests.length, 2, 'switching tabs preserves the view without rendering again');
});

test('shows the last enabled layer above overlapping layers without reordering bulk actions', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, layeredBoardData(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  assert.equal(await frontLayer(page), 'layer-bottom');
  const top = page.getByRole('checkbox', { name: 'Top copper', exact: true });
  const bottom = page.getByRole('checkbox', { name: 'Bottom copper', exact: true });
  await top.uncheck(); await top.check();
  assert.equal(await frontLayer(page), 'layer-top');
  assert.deepEqual(await layerOrder(page), ['layer-bottom', 'board-outline', 'layer-top']);
  assert.equal(await page.locator('#scene').getAttribute('transform'), 'translate(5 5)');
  await bottom.uncheck();
  assert.equal(await frontLayer(page), 'layer-top', 'hiding a layer does not change priority');
  await bottom.check();
  assert.equal(await frontLayer(page), 'layer-bottom');
  const order = await layerOrder(page);
  await page.getByRole('button', { name: 'Hide all', exact: true }).click();
  assert.deepEqual(await layerOrder(page), order);
  assert.equal(await page.locator('#layers input:checked').count(), 0);
  await page.getByRole('button', { name: 'Show all', exact: true }).click();
  assert.deepEqual(await layerOrder(page), order);
  assert.equal(await page.locator('#layers input:checked').count(), 3);
  assert.equal(await frontLayer(page), 'layer-bottom');
  assert.equal(await page.locator('#view > svg > g').last().getAttribute('id'), 'measure');
});

test('retains each board’s layer priority and sidebar order when switching tabs', async t => {
  const { page, requests } = await openPage(t, { render: (route, name) => reply(route, layeredBoardData(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  const sidebar = await page.locator('#layers label').allTextContents();
  const top = page.getByRole('checkbox', { name: 'Top copper', exact: true });
  await top.uncheck(); await top.check();
  const order = await layerOrder(page);
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  assert.equal(await frontLayer(page), 'layer-bottom');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await frontLayer(page), 'layer-top');
  assert.deepEqual(await layerOrder(page), order);
  assert.deepEqual(await page.locator('#layers label').allTextContents(), sidebar);
  await top.uncheck();
  assert.equal(await frontLayer(page), 'layer-bottom', 'the restored checkbox still controls its layer');
  assert.equal(requests.length, 2, 'layer selection and tab switching do not render again');
});

test('background renders stay in their own tabs and closing a pending tab cancels it', async t => {
  const pending = new Map(), arrivals = new Map();
  const waitForBoard = name => new Promise(resolve => arrivals.set(name, resolve));
  const { page } = await openPage(t, { render: (route, name) => {
    pending.set(name, route); arrivals.get(name)?.();
  } });
  const both = Promise.all([waitForBoard('A.PcbDoc'), waitForBoard('B.PcbDoc')]);
  await page.locator('#file').setInputFiles([file('A.PcbDoc'), file('B.PcbDoc')]);
  await both;
  await reply(pending.get('B.PcbDoc'), boardData('B.PcbDoc'));
  await loaded(page, 'B.PcbDoc');
  await reply(pending.get('A.PcbDoc'), boardData('A.PcbDoc'));
  await page.waitForFunction(() => [...document.querySelectorAll('[role=tab]')].every(tab => !tab.textContent.includes('…')));
  assert.equal(await activeName(page), 'B.PcbDoc');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  await loaded(page, 'A.PcbDoc');
  const third = waitForBoard('C.PcbDoc');
  await page.locator('#file').setInputFiles(file('C.PcbDoc'));
  await third;
  await page.getByRole('button', { name: 'Close C.PcbDoc', exact: true }).click();
  assert.equal(await activeName(page), 'B.PcbDoc');
  await reply(pending.get('C.PcbDoc'), boardData('C.PcbDoc')).catch(() => {});
  assert.equal(await page.getByRole('tab').count(), 2);
});

test('failed uploads preserve previously loaded boards', async t => {
  let fail = false;
  const { page } = await openPage(t, {
    render: (route, name) => fail ? reply(route, { error: 'Invalid board' }, 500) : reply(route, boardData(name)),
  });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  fail = true;
  await page.locator('#file').setInputFiles(file('Invalid.PcbDoc'));
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 1);
  assert.equal(await activeName(page), 'A.PcbDoc');
  assert.match(await page.locator('#toast').textContent(), /Invalid.PcbDoc.*Invalid board/);
  assert.equal(await page.getByRole('tab').count(), 1);
});

test('command-line boards support tab switching without uploading again', async t => {
  const data = { ...boardData('Initial.PcbDoc'), source: Buffer.from([0, 128, 255, 42]).toString('base64') };
  const { page, requests } = await openPage(t, { initial: data });
  await loaded(page, 'Initial.PcbDoc');
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  await page.getByRole('tab', { name: 'Initial.PcbDoc', exact: true }).click();
  await loaded(page, 'Initial.PcbDoc');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].name, 'B.PcbDoc');
});

test('supports dropping multiple boards and keyboard navigation and closing', async t => {
  const { page } = await openPage(t);
  await page.locator('#view').evaluate(view => {
    const dataTransfer = new DataTransfer();
    for (const name of ['A.PcbDoc', 'B.PcbDoc']) dataTransfer.items.add(new File([name], name));
    view.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await loaded(page, 'B.PcbDoc');
  await page.getByRole('tab', { name: 'B.PcbDoc', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await loaded(page, 'A.PcbDoc');
  assert.equal(await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Delete');
  await loaded(page, 'B.PcbDoc');
  assert.equal(await page.getByRole('tab').count(), 1);
});

test('font substitution notices stay with their board tab', async t => {
  const notice = 'Embedded font "Cambria" could not be read; using "Arimo-Regular". Text shape and spacing may differ.';
  const { page } = await openPage(t, { render: (route, name) => {
    return reply(route, { ...boardData(name), warnings: name === 'A.PcbDoc' ? [notice] : [] });
  } });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  assert.equal(await page.locator('#warnings').textContent(), notice);
  assert.equal(await page.locator('#warnings').isVisible(), true);
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  assert.equal(await page.locator('#warnings').isVisible(), false);
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#warnings').textContent(), notice);
  assert.equal(await page.locator('#warnings').isVisible(), true);
  await page.getByRole('button', { name: 'Close A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#warnings').isVisible(), false);
});

test('uploads the affected layout through the real Python server', {
  skip: !process.env.PCB_TEST_FILE, timeout: 60000,
}, async t => {
  const app = spawn(process.env.PCB_TEST_PYTHON || resolve(__dirname, '../.venv/bin/python'),
    ['-B', '-u', resolve(__dirname, '../pcb_viewer_gui.py'), '--no-open']);
  t.after(() => app.kill());
  const url = await new Promise((resolve, reject) => {
    let output = '';
    app.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) resolve(match[0]);
    });
    app.on('error', reject);
    app.on('exit', code => reject(new Error(`Viewer exited with code ${code}`)));
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.goto(url);
  await page.locator('#file').setInputFiles(process.env.PCB_TEST_FILE);
  await page.waitForFunction(() => document.querySelector('#view > svg') &&
    document.getElementById('busy').style.display === 'none');
  assert.equal(await page.getByRole('tab').count(), 1);
  assert.match(await page.locator('#warnings').textContent(), /Cambria.*Arimo-Regular/);
  assert.equal(await page.locator('[data-text-fallback]').count(), 0);
  assert.equal(await page.locator('#toast').isVisible(), false);
  assert.ok(await page.locator('#layers input').count() > 0);
  const designator = await page.locator('#component-options option').first().getAttribute('value');
  assert.ok(designator, 'real renderer exposes component designators');
  await page.locator('#component-query').fill(designator);
  assert.ok(await page.locator('#scene .component-match').count() > 0);
  await page.locator('#component-fit').click();
  const pour = page.locator('#scene [data-primitive="shapebased-region"][data-layer-role="copper"][data-net]').first();
  assert.ok(await pour.count(), 'real polygon copper exposes its connected net');
  const netName = await pour.getAttribute('data-net');
  await page.locator('#net-query').fill(netName);
  assert.ok(await page.locator('#scene .net-match').count() > 0);
  assert.equal(await pour.evaluate(el => el.classList.contains('net-match')), true);
  assert.ok(await page.locator('#net-highlight path[fill-rule="evenodd"]').count() > 0);
  assert.equal(await pour.evaluate(el => getComputedStyle(el).stroke), 'none');
  assert.equal(await page.locator('#net-highlight path[fill-rule="evenodd"]').first().evaluate(el => getComputedStyle(el).stroke), 'none');
  await page.locator('#net-fit').click();
  await page.locator('#net-clear').click();
  await pour.click();
  assert.equal(await page.locator('#net-query').inputValue(), netName, 'clicking real polygon copper selects its net');
  if (process.env.PCB_TEST_SCREENSHOT) await page.screenshot({ path: process.env.PCB_TEST_SCREENSHOT });
});

const netBoardData = name => ({ ...boardData(name), svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
  <g id="scene"><g id="layer-top" data-layer-name="Top copper">
    <rect data-net="GND" x="10" y="10" width="10" height="5" fill="red"/>
    <circle data-net="GND" cx="25" cy="12" r="2" fill="red"/>
    <rect data-net="GND_A" x="40" y="10" width="10" height="5" fill="red"/>
    <rect data-net="U[1]&quot;" x="60" y="30" width="10" height="5" fill="red"/>
  </g><g id="layer-bottom" data-layer-name="Bottom copper"><rect width="100" height="80" fill="blue"/><rect data-net="VCC" x="70" y="50" width="10" height="5"/></g></g></svg>` });

test('finds nets case insensitively, prefers exact net names and safely clears highlighting', async t => {
  const { page, requests } = await openPage(t, { render: (route, name) => reply(route, netBoardData(name)) });
  assert.equal(await page.locator('#net-query').isDisabled(), true);
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  assert.deepEqual(await page.locator('#net-options option').evaluateAll(os => os.map(o => o.value)), ['GND', 'GND_A', 'U[1]"', 'VCC']);
  await page.locator('#net-query').fill('gn');
  assert.equal(await page.locator('.net-match').count(), 3);
  assert.match(await page.locator('#net-status').textContent(), /2 nets highlighted/);
  await page.locator('#net-query').fill('gnd');
  assert.equal(await page.locator('.net-match').count(), 2);
  assert.equal(await page.locator('.net-match').first().evaluate(el => getComputedStyle(el).fill), 'rgb(104, 224, 255)');
  assert.equal(await page.locator('#scene > g').last().getAttribute('id'), 'net-highlight');
  assert.equal(await page.locator('#net-highlight [id], #net-highlight [data-net]').count(), 0);
  assert.equal(await page.locator('.net-match').first().evaluate(el => {
    const r = el.getBoundingClientRect();
    const overlay = document.querySelector('#net-highlight');
    overlay.style.pointerEvents = 'auto';
    const color = getComputedStyle(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)).fill;
    overlay.style.pointerEvents = 'none';
    return color;
  }), 'rgb(104, 224, 255)', 'highlight is visible above the overlapping blue layer');
  await page.locator('#net-fit').click();
  assert.notEqual(await page.locator('#view > svg').getAttribute('viewBox'), '0 0 100 80');
  await page.locator('#net-query').fill('U[1]"');
  assert.equal(await page.locator('.net-match').count(), 1);
  await page.locator('#net-query').fill('missing');
  assert.equal(await page.locator('.net-match').count(), 0);
  assert.equal(await page.locator('#net-status').textContent(), 'No matching nets.');
  await page.locator('#net-clear').click();
  assert.equal(await page.locator('#net-query').inputValue(), '');
  assert.equal(await page.locator('#net-status').textContent(), '');
  assert.equal(await page.locator('[data-net="GND"]').first().getAttribute('fill'), 'red');
  assert.equal(requests.length, 1, 'searching stays in the browser');
});

test('keeps net searches with their board across tabs and can reveal matching layers', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, netBoardData(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  await page.getByRole('checkbox', { name: 'Bottom copper', exact: true }).uncheck();
  await page.locator('#net-query').fill('vcc');
  assert.match(await page.locator('#net-status').textContent(), /1 hidden layer/);
  await page.locator('#net-reveal').click();
  assert.equal(await page.getByRole('checkbox', { name: 'Bottom copper', exact: true }).isChecked(), true);
  assert.equal(await page.locator('#net-reveal').isVisible(), false);
  await page.locator('#none').click();
  assert.equal(await page.locator('#net-reveal').isVisible(), true);
  await page.locator('#all').click();
  assert.equal(await page.locator('#net-reveal').isVisible(), false);
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  assert.equal(await page.locator('#net-query').inputValue(), '');
  assert.equal(await page.locator('.net-match').count(), 0);
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#net-query').inputValue(), 'vcc');
  assert.equal(await page.locator('.net-match').count(), 1);
  await page.getByRole('button', { name: 'Close A.PcbDoc', exact: true }).click();
  await page.getByRole('button', { name: 'Close B.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#net-query').isDisabled(), true);
  assert.equal(await page.locator('#net-options option').count(), 0);
});

test('highlights net tracks and pads across transformed, clipped layers', async t => {
  const data = name => ({ ...boardData(name), svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <defs><clipPath id="board-clip"><rect width="100" height="80"/></clipPath></defs>
    <g id="scene" transform="translate(3 4)"><g id="layer-top" data-layer-name="Top copper" clip-path="url(#board-clip)">
      <g transform="translate(10 20)"><path data-net="GND" d="M0 0 L20 10" stroke="red" fill="none"/></g>
    </g><g id="layer-bottom" data-layer-name="Bottom copper"><circle data-net="GND" cx="40" cy="50" r="3" fill="blue"/></g></g></svg>` });
  const { page } = await openPage(t, { render: (route, name) => reply(route, data(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  await page.locator('#net-query').fill('GND');
  assert.equal(await page.locator('.net-match').count(), 2);
  const native = await page.locator('[data-net="GND"]').first().boundingBox();
  const highlighted = await page.locator('#net-highlight path').boundingBox();
  assert.deepEqual(highlighted, native, 'copied track keeps all ancestor transforms');
  assert.equal(await page.locator('#net-highlight [clip-path]').getAttribute('clip-path'), 'url(#board-clip)');
  await page.locator('#net-clear').click();
  assert.equal(await page.locator('#net-highlight').count(), 0);
  assert.equal(await page.locator('[data-net="GND"]').first().getAttribute('stroke'), 'red');
});

test('sidebar scrolls to keep layers and measurements accessible in short windows', async t => {
  const { page } = await openPage(t);
  await page.setViewportSize({ width: 1200, height: 500 });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  assert.ok(await page.locator('#layers-wrap').evaluate(el => el.clientHeight >= 160));
  await page.locator('#layers input').first().uncheck();
  await page.locator('#measure-btn').click();
  assert.ok(await page.locator('#panel').evaluate(el => el.scrollTop > 0));
  assert.equal(await page.locator('#measure-btn').getAttribute('class'), 'on');
});

test('new boards show only copper, top overlay, outline and drills; tabs preserve choices', async t => {
  const data = name => ({ ...boardData(name), svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><g id="scene">
    <g id="signal" data-layer-family="signal" data-layer-display-name="Custom signal"/>
    <g id="plane" data-layer-family="internal_plane"/>
    <g id="top-overlay" data-layer-token="TOPOVERLAY"/>
    <g id="bottom-overlay" data-layer-token="BOTTOMOVERLAY"/>
    <g id="mask" data-layer-token="TOPSOLDER"/>
    <g id="paste" data-layer-token="TOPPASTE"/>
    <g id="mechanical" data-layer-role="mechanical"/>
    <g id="board-outline"/><g id="layer-DRILLS" data-layer-role="drill"/>
    </g></svg>` });
  const { page } = await openPage(t, { render: (route, name) => reply(route, data(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loadedWithoutName(page);
  const visible = () => page.locator('#scene > g').evaluateAll(gs => gs.filter(g => g.style.display !== 'none').map(g => g.id));
  assert.deepEqual(await visible(), ['signal', 'plane', 'top-overlay', 'board-outline', 'layer-DRILLS']);
  await page.locator('#all').click(); assert.equal((await visible()).length, 9);
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loadedWithoutName(page);
  assert.equal((await visible()).length, 5);
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal((await visible()).length, 9);
});
async function loadedWithoutName(page) {
  await page.waitForFunction(() => document.querySelector('#view > svg') && document.querySelector('#busy').style.display === 'none');
}

test('retains multiple measurements with labels and units, cancels previews and clears only the active board', async t => {
  const { page } = await openPage(t);
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  await page.locator('#measure-btn').click();
  for (const [x, y] of [[200, 200], [400, 300], [250, 400], [450, 450]]) {
    await page.locator('#view').click({ position: { x, y } });
  }
  assert.equal(await page.locator('#measure line').count(), 2);
  assert.equal(await page.locator('.measure-label').count(), 2);
  assert.ok((await page.locator('.measure-label').allTextContents()).every(s => s.endsWith(' mm')));
  await page.locator('[data-unit="mil"]').click();
  assert.ok((await page.locator('.measure-label').allTextContents()).every(s => s.endsWith(' mil')));
  await page.locator('#view').click({ position: { x: 500, y: 500 } });
  await page.mouse.move(800, 600);
  assert.equal(await page.locator('#measure line').count(), 3);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#measure line').count(), 2);
  assert.equal(await page.locator('#measure-btn').evaluate(el => el.classList.contains('on')), false);
  assert.equal(await page.locator('#view').evaluate(el => el.classList.contains('measuring')), false);
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  assert.equal(await page.locator('#measure line').count(), 0);
  await page.keyboard.press('Shift+C');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#measure line').count(), 2);
  const before = await page.locator('.measure-label').first().getAttribute('style');
  await page.locator('#view').dispatchEvent('wheel', { deltaY: -200, clientX: 600, clientY: 400 });
  assert.notEqual(await page.locator('.measure-label').first().getAttribute('style'), before);
  await page.keyboard.press('Shift+C');
  assert.equal(await page.locator('#measure line').count(), 0);
  assert.equal(await page.locator('.measure-label').count(), 0);
  assert.equal(await page.locator('#readout').textContent(), '');
});

const componentBoardData = name => ({ ...boardData(name), svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
  <g id="scene"><g id="layer-top" data-layer-name="Top copper">
    <rect data-component="R1" x="10" y="10" width="10" height="5" fill="red"/>
    <circle data-component="R1" cx="25" cy="12" r="2" fill="red"/>
    <rect data-component="R10" x="40" y="10" width="10" height="5" fill="red"/>
    <rect data-component="U[1]&quot;" x="60" y="30" width="10" height="5" fill="red"/>
  </g><g id="layer-bottom" data-layer-name="Bottom copper"><rect width="100" height="80" fill="blue"/><rect data-component="C2" x="70" y="50" width="10" height="5"/></g></g></svg>` });

test('finds components case insensitively, prefers exact designators and safely clears highlighting', async t => {
  const { page, requests } = await openPage(t, { render: (route, name) => reply(route, componentBoardData(name)) });
  assert.equal(await page.locator('#component-query').isDisabled(), true);
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  assert.deepEqual(await page.locator('#component-options option').evaluateAll(os => os.map(o => o.value)), ['C2', 'R1', 'R10', 'U[1]"']);
  await page.locator('#component-query').fill('r');
  assert.equal(await page.locator('.component-match').count(), 3);
  assert.match(await page.locator('#component-status').textContent(), /2 components highlighted/);
  await page.locator('#component-query').fill('r1');
  assert.equal(await page.locator('.component-match').count(), 2);
  assert.equal(await page.locator('.component-match').first().evaluate(el => getComputedStyle(el).fill), 'rgb(255, 224, 102)');
  assert.equal(await page.locator('#scene > g').last().getAttribute('id'), 'component-highlight');
  assert.equal(await page.locator('#component-highlight [id], #component-highlight [data-component]').count(), 0);
  assert.equal(await page.locator('.component-match').first().evaluate(el => {
    const r = el.getBoundingClientRect();
    const overlay = document.querySelector('#component-highlight');
    overlay.style.pointerEvents = 'auto';
    const color = getComputedStyle(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)).fill;
    overlay.style.pointerEvents = 'none';
    return color;
  }), 'rgb(255, 224, 102)', 'highlight is visible above the overlapping blue layer');
  await page.locator('#component-fit').click();
  assert.notEqual(await page.locator('#view > svg').getAttribute('viewBox'), '0 0 100 80');
  await page.locator('#component-query').fill('U[1]"');
  assert.equal(await page.locator('.component-match').count(), 1);
  await page.locator('#component-query').fill('missing');
  assert.equal(await page.locator('.component-match').count(), 0);
  assert.equal(await page.locator('#component-status').textContent(), 'No matching components.');
  await page.locator('#component-clear').click();
  assert.equal(await page.locator('#component-query').inputValue(), '');
  assert.equal(await page.locator('#component-status').textContent(), '');
  assert.equal(await page.locator('[data-component="R1"]').first().getAttribute('fill'), 'red');
  assert.equal(requests.length, 1, 'searching stays in the browser');
});

test('keeps component searches with their board across tabs and can reveal matching layers', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, componentBoardData(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  await page.getByRole('checkbox', { name: 'Bottom copper', exact: true }).uncheck();
  await page.locator('#component-query').fill('c2');
  assert.match(await page.locator('#component-status').textContent(), /1 hidden layer/);
  await page.locator('#component-reveal').click();
  assert.equal(await page.getByRole('checkbox', { name: 'Bottom copper', exact: true }).isChecked(), true);
  assert.equal(await page.locator('#component-reveal').isVisible(), false);
  await page.locator('#none').click();
  assert.equal(await page.locator('#component-reveal').isVisible(), true);
  await page.locator('#all').click();
  assert.equal(await page.locator('#component-reveal').isVisible(), false);
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  assert.equal(await page.locator('#component-query').inputValue(), '');
  assert.equal(await page.locator('.component-match').count(), 0);
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#component-query').inputValue(), 'c2');
  assert.equal(await page.locator('.component-match').count(), 1);
  await page.getByRole('button', { name: 'Close A.PcbDoc', exact: true }).click();
  await page.getByRole('button', { name: 'Close B.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#component-query').isDisabled(), true);
  assert.equal(await page.locator('#component-options option').count(), 0);
});

test('component and net highlights coexist with default layers and saved measurements', async t => {
  const data = name => ({ ...boardData(name), svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <g id="scene"><g id="layer-top" data-layer-family="signal" data-layer-name="Top copper">
      <rect data-component="R1" data-net="GND" x="10" y="10" width="10" height="5" fill="red"/>
    </g><g id="layer-mask" data-layer-token="TOPSOLDER" data-layer-name="Top solder"><rect width="100" height="80" fill="purple"/></g></g></svg>` });
  const { page } = await openPage(t, { render: (route, name) => reply(route, data(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  assert.equal(await page.getByRole('checkbox', { name: 'Top solder', exact: true }).isChecked(), false);
  await page.locator('#measure-btn').click();
  await page.locator('#view').click({ position: { x: 200, y: 200 } });
  await page.locator('#view').click({ position: { x: 400, y: 300 } });
  await page.locator('#measure-btn').click();
  await page.locator('#component-query').fill('R1');
  await page.locator('#net-query').fill('GND');
  assert.equal(await page.locator('#component-highlight rect').evaluate(el => getComputedStyle(el).fill), 'rgb(255, 224, 102)');
  assert.equal(await page.locator('#net-highlight rect').evaluate(el => getComputedStyle(el).fill), 'rgb(104, 224, 255)');
  await page.locator('#net-fit').click();
  assert.equal(await page.locator('#measure line').count(), 1);
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#component-options option').count(), 1);
  assert.equal(await page.locator('#net-options option').count(), 1);
  assert.equal(await page.locator('#layers label').count(), 2, 'highlight overlays stay out of layer controls');
  assert.equal(await page.locator('#component-highlight rect').count(), 1);
  assert.equal(await page.locator('#net-highlight rect').count(), 1);
  await page.locator('#net-clear').click();
  assert.equal(await page.locator('#component-highlight rect').count(), 1);
  assert.equal(await page.locator('#net-highlight').count(), 0);
  await page.locator('#component-clear').click();
  assert.equal(await page.locator('#component-highlight').count(), 0);
  await page.locator('#view').click({ position: { x: 300, y: 200 } });
  await page.keyboard.press('Shift+C');
  assert.equal(await page.locator('#measure line').count(), 0);
});

test('net search highlights filled polygon copper and preserves its holes and layer controls', async t => {
  const data = name => ({ ...boardData(name), svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <g id="scene"><g id="layer-top" data-layer-name="Top copper"><path data-net="GND" d="M10 10 L50 10" stroke="red"/></g>
    <g id="layer-bottom" data-layer-name="Bottom copper">
      <path data-primitive="shapebased-region" data-net="GND" d="M10 10 H90 V70 H10 Z M30 30 H50 V50 H30 Z" fill="blue" fill-rule="evenodd" stroke="none"/>
      <path data-primitive="region" data-net="VCC" d="M0 0 H5 V5 Z" fill="red" fill-rule="evenodd" stroke="none"/>
    </g></g></svg>` });
  const { page } = await openPage(t, { render: (route, name) => reply(route, data(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  const pour = page.locator('[data-primitive="shapebased-region"]');
  const shape = await pour.getAttribute('d');
  await page.locator('#net-query').fill('gnd');
  assert.equal(await page.locator('.net-match').count(), 2);
  const overlay = page.locator('#net-highlight [fill-rule="evenodd"]');
  assert.equal(await overlay.getAttribute('d'), shape);
  assert.equal(await overlay.evaluate(el => getComputedStyle(el).stroke), 'none');
  assert.equal(await overlay.evaluate(el => getComputedStyle(el).fill), 'rgb(104, 224, 255)');
  assert.equal(await page.locator('[data-net="VCC"]').evaluate(el => el.classList.contains('net-match')), false);
  await page.getByRole('checkbox', { name: 'Bottom copper', exact: true }).uncheck();
  assert.equal(await overlay.count(), 0);
  await page.locator('#net-reveal').click();
  assert.equal(await overlay.count(), 1);
  await page.locator('#net-clear').click();
  assert.equal(await page.locator('#net-highlight').count(), 0);
  assert.equal(await pour.evaluate(el => getComputedStyle(el).fill), 'rgb(0, 0, 255)');
  assert.equal(await pour.evaluate(el => getComputedStyle(el).stroke), 'none');
});

const clickableNets = name => ({ ...boardData(name), svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
  <g id="scene" transform="translate(2 1)"><g id="layer-top" data-layer-name="Top copper">
    <rect data-primitive="pad" data-net="VCC" data-component="R1" x="10" y="10" width="12" height="8" fill="red"/>
    <g data-net="Net[1]&quot;" data-primitive="nested"><circle cx="40" cy="15" r="4" fill="red"/></g>
    <path data-primitive="track" data-net="GND" d="M10 40 H40" stroke="red" stroke-width="3"/>
    <circle data-primitive="via" data-net="GND" cx="50" cy="40" r="3" fill="red"/>
    <rect data-primitive="unlinked" x="10" y="60" width="12" height="8" fill="red"/>
  </g><g id="layer-bottom" data-layer-name="Bottom copper">
    <path data-primitive="shapebased-region" data-net="GND" d="M60 50 H90 V70 H60 Z" fill="blue" fill-rule="evenodd" stroke="none"/>
  </g></g></svg>` });
async function openClickableNets(t) {
  const result = await openPage(t, { render: (route, name) => reply(route, clickableNets(name)) });
  await result.page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(result.page, 'A.PcbDoc');
  return result;
}

test('clicking pads, tracks, vias, polygon copper and nested geometry selects the exact net', async t => {
  const { page, requests } = await openClickableNets(t);
  const viewBox = await page.locator('#view > svg').getAttribute('viewBox');
  await page.locator('#component-query').fill('R1');
  await page.locator('[data-primitive="pad"]').click();
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC');
  assert.equal(await page.locator('#component-query').inputValue(), 'R1');
  const track = await page.locator('[data-primitive="track"]').boundingBox();
  await page.mouse.click(track.x + track.width / 2, track.y + track.height / 2);
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  assert.equal(await page.locator('.net-match').count(), 3, 'selects all copper on the clicked net');
  await page.locator('[data-primitive="via"]').click();
  assert.equal(await page.locator('#net-query').inputValue(), 'GND', 'highlight overlay permits clicking the native via');
  await page.locator('[data-primitive="shapebased-region"]').click();
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  await page.locator('[data-primitive="nested"] circle').click();
  assert.equal(await page.locator('#net-query').inputValue(), 'Net[1]"');
  await page.locator('[data-primitive="unlinked"]').click();
  assert.equal(await page.locator('#net-query').inputValue(), 'Net[1]"');
  await page.locator('#view').click({ position: { x: 20, y: 20 } });
  assert.equal(await page.locator('#net-query').inputValue(), 'Net[1]"', 'blank space keeps the selection');
  assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), viewBox, 'selecting does not move the view');
  assert.equal(requests.length, 1, 'selection does not render again');
});

test('panning and measurements do not change the selected net, and later clicks still work', async t => {
  const { page } = await openClickableNets(t);
  await page.locator('[data-primitive="pad"]').click();
  const track = await page.locator('[data-primitive="track"]').boundingBox();
  const x = track.x + track.width / 2, y = track.y + track.height / 2;
  const before = await page.locator('#view > svg').getAttribute('viewBox');
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 30, y + 20); await page.mouse.up();
  assert.notEqual(await page.locator('#view > svg').getAttribute('viewBox'), before);
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC', 'finishing a drag over copper does not select it');
  const via = await page.locator('[data-primitive="via"]').boundingBox();
  const vx = via.x + via.width / 2, vy = via.y + via.height / 2;
  await page.mouse.move(vx, vy); await page.mouse.down();
  await page.mouse.move(vx + 30, vy); await page.mouse.move(vx, vy); await page.mouse.up();
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC', 'a drag returning to its start remains a pan');
  await page.locator('[data-primitive="via"]').click();
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  await page.locator('#measure-btn').click();
  await page.locator('[data-primitive="pad"]').click();
  await page.locator('[data-primitive="via"]').click();
  assert.equal(await page.locator('#measure line').count(), 1);
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  await page.locator('#measure-btn').click();
  await page.locator('[data-primitive="pad"]').click();
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC', 'saved measurement endpoints do not intercept selection');
});

test('clicked net selections remain attached to their own board tabs', async t => {
  const { page } = await openClickableNets(t);
  await page.locator('[data-primitive="pad"]').click();
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  assert.equal(await page.locator('#net-query').inputValue(), '');
  await page.locator('[data-primitive="via"]').click();
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC');
  assert.equal(await page.locator('.net-match').count(), 1);
  await page.getByRole('tab', { name: 'B.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  assert.equal(await page.locator('.net-match').count(), 3);
});

test('Escape deselects components and nets from search fields and only affects the active board', async t => {
  const { page } = await openClickableNets(t);
  await page.locator('[data-primitive="pad"]').click();
  await page.locator('#component-query').fill('R1');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#net-query').inputValue(), '');
  assert.equal(await page.locator('.net-match').count(), 0);
  assert.equal(await page.locator('#net-highlight').count(), 0);
  assert.equal(await page.locator('#net-status').textContent(), '');
  assert.equal(await page.locator('#net-fit').isDisabled(), true);
  assert.equal(await page.locator('#component-query').inputValue(), '');
  assert.equal(await page.locator('.component-match').count(), 0);
  assert.equal(await page.locator('#component-highlight').count(), 0);
  assert.equal(await page.locator('#component-status').textContent(), '');
  assert.equal(await page.locator('#component-fit').isDisabled(), true);
  await page.locator('#net-query').fill('GND');
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  await page.locator('[data-primitive="pad"]').click();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#net-query').inputValue(), '');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  await page.locator('#net-query').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#net-query').inputValue(), '');
  assert.equal(await page.locator('.net-match').count(), 0);
  await page.getByRole('tab', { name: 'B.PcbDoc', exact: true }).click();
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#net-query').inputValue(), '', 'deselection survives switching tabs');
});

const clickableComponents = name => ({ ...boardData(name), svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
  <g id="scene" transform="translate(2 1)"><g id="layer-top" data-layer-name="Top copper">
    <rect data-primitive="component-pad" data-component="R1" data-net="VCC" x="10" y="10" width="10" height="8" fill="red"/>
    <rect data-primitive="component-pad-2" data-component="R1" data-net="GND" x="25" y="10" width="10" height="8" fill="red"/>
    <g data-component="U[1]&quot;"><circle data-primitive="nested-body" data-net="Net[1]&quot;" cx="50" cy="15" r="4" fill="red"/></g>
    <rect data-primitive="component-body" data-component="C2" x="10" y="60" width="12" height="8" fill="red"/>
    <circle data-primitive="free-via" data-net="GND" cx="50" cy="40" r="3" fill="red"/>
  </g></g></svg>` });
async function openClickableComponents(t) {
  const result = await openPage(t, { render: (route, name) => reply(route, clickableComponents(name)) });
  await result.page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(result.page, 'A.PcbDoc');
  return result;
}

test('clicking components highlights all their geometry and retains selection of connected nets', async t => {
  const { page, requests } = await openClickableComponents(t);
  const viewBox = await page.locator('#view > svg').getAttribute('viewBox');
  await page.locator('[data-primitive="component-pad"]').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'R1');
  assert.equal(await page.locator('.component-match').count(), 2);
  assert.equal(await page.locator('#component-highlight rect').count(), 2);
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC');
  await page.locator('[data-primitive="component-pad-2"]').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'R1');
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  await page.locator('[data-primitive="nested-body"]').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'U[1]"');
  assert.equal(await page.locator('#net-query').inputValue(), 'Net[1]"');
  await page.locator('[data-primitive="component-body"]').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'C2', 'components without a net can be selected');
  assert.equal(await page.locator('#net-query').inputValue(), 'Net[1]"');
  await page.locator('[data-primitive="free-via"]').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'C2', 'a net-only item keeps the component selection');
  await page.locator('#view').click({ position: { x: 20, y: 20 } });
  assert.equal(await page.locator('#component-query').inputValue(), 'C2');
  assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), viewBox);
  assert.equal(requests.length, 1);
});

test('component selection ignores pans and measurement clicks and remains local to each board', async t => {
  const { page } = await openClickableComponents(t);
  await page.locator('[data-primitive="component-pad"]').click();
  const body = await page.locator('[data-primitive="component-body"]').boundingBox();
  const x = body.x + body.width / 2, y = body.y + body.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 30, y + 20); await page.mouse.up();
  assert.equal(await page.locator('#component-query').inputValue(), 'R1');
  await page.locator('#measure-btn').click();
  await page.locator('[data-primitive="component-body"]').click();
  await page.locator('[data-primitive="nested-body"]').click();
  assert.equal(await page.locator('#measure line').count(), 1);
  assert.equal(await page.locator('#component-query').inputValue(), 'R1');
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC');
  await page.locator('#measure-btn').click();
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  await page.locator('[data-primitive="component-body"]').click();
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#component-query').inputValue(), 'R1');
  await page.locator('#component-query').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.component-match').count(), 0);
  assert.equal(await page.locator('#component-highlight').count(), 0);
  assert.equal(await page.locator('#net-highlight').count(), 0);
  assert.equal(await page.locator('#measure line').count(), 1, 'Escape retains completed measurements');
  await page.getByRole('tab', { name: 'B.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#component-query').inputValue(), 'C2');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#component-query').inputValue(), '');
});

test('Escape exits measurement mode with a search field focused and retains finished measurements', async t => {
  const { page } = await openClickableNets(t);
  await page.locator('#measure-btn').click();
  await page.locator('[data-primitive="pad"]').click();
  await page.locator('[data-primitive="via"]').click();
  const caption = await page.locator('.measure-label').textContent();
  await page.locator('#component-query').focus();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#measure-btn').evaluate(el => el.classList.contains('on')), false);
  assert.equal(await page.locator('#view').evaluate(el => el.classList.contains('measuring')), false);
  assert.equal(await page.locator('#measure line').count(), 1);
  assert.equal(await page.locator('.measure-label').textContent(), caption);
  await page.locator('[data-primitive="pad"]').click();
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC', 'normal selection resumes after Escape');
  assert.equal(await page.locator('#measure line').count(), 1);
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#measure-btn').evaluate(el => el.classList.contains('on')), false);
  assert.equal(await page.locator('#measure line').count(), 1);
  await page.locator('#view').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Shift+C');
  assert.equal(await page.locator('#measure line').count(), 0, 'Shift+C still clears finished measurements');
});
