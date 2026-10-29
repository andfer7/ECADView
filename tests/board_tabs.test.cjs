// Install with npm ci, then run npm test.
// Set PLAYWRIGHT_CHANNEL=chrome to use an installed Google Chrome browser.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { resolve } = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { readFileSync } = require('node:fs');

let browser, server, origin;

before(async () => {
  server = spawn(process.env.PCB_TEST_PYTHON || resolve(__dirname, '../.venv/bin/python'),
    ['-B', '-u', resolve(__dirname, '../pcb_viewer_gui.py'), '--no-open']);
  origin = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(new Error(`Viewer startup timed out: ${errors}`)), 20000);
    const fail = error => { clearTimeout(timer); reject(error); };
    server.stderr.on('data', chunk => { errors += chunk.toString(); });
    server.stdout.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
    server.on('error', fail);
    server.on('exit', code => fail(new Error(`Viewer exited with code ${code}: ${errors}`)));
  });
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  });
  // Keep the shared test server alive between independent viewer pages.
  const keeper = await browser.newPage(); await keeper.goto(origin);
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
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
const threeBoardData = name => ({ ...boardData(name), kind: 'pcb', scene3d: {
  board: [{ outline: [[-25, -15], [25, -15], [25, 15], [-25, 15]],
    holes: [[[-2, -2], [-2, 2], [2, 2], [2, -2]]] }],
  thickness: 1.6, bodies: [
    { outline: [[-18, -9], [-8, -9], [-8, 1], [-18, 1]], holes: [], z: 0.8, height: 4,
      color: 0xbbbbbb, opacity: 1, name: 'U1' },
    { outline: [[8, 3], [16, 3], [16, 10], [8, 10]], holes: [], z: -3.8, height: 3,
      color: 0xdd9944, opacity: 1, name: 'U2' },
  ], notes: ['Simplified component bodies.'], units: 'mm',
} });
const schematicData = name => ({
  name, kind: 'schematic', stats: { components: 3, wires: 7, net_labels: 2 },
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1700 1100" data-board="${name}">
    <g id="scene"><g id="DocumentMainGroup"><g id="sheet-id">
      <rect width="1700" height="1100" fill="#fffcf8"/>
      <path d="M100 100 L500 100" stroke="blue"/><text x="100" y="90" fill="black">R1</text>
    </g></g></g></svg>`,
});
const selectableSchematicData = name => ({
  ...schematicData(name),
  selection: {
    components: [
      { id: 'component-1', name: 'R1', elements: ['component-1'], body_elements: ['body-1'] },
      { id: 'component-2', name: 'U[2]"<test>', elements: ['component[2]"'], body_elements: ['body-2'] },
    ],
    nets: [
      { id: 'net[1]"', name: 'GND', elements: ['wire-1', 'wire-2', 'pin-1', 'label-1', 'shared'] },
      { id: 'net-2', name: 'VCC', elements: ['wire-3', 'pin-2', 'shared'] },
    ],
  },
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}" fill="none">
    <g id="scene" transform="translate(2 1)"><g id="DocumentMainGroup"><g id="sheet-id">
      <rect width="96" height="78" fill="#fffcf8"/>
      <g id="component-1"><rect id="body-1" x="10" y="10" width="12" height="10" fill="#ffffb0" stroke="brown"/>
        <text x="10" y="9" fill="black">R1</text>
        <g id="pin-1"><line x1="22" y1="15" x2="30" y2="15" stroke="black" stroke-width="1"/></g></g>
      <g id="component[2]&quot;"><rect id="body-2" x="65" y="10" width="12" height="10" fill="#ffffb0" stroke="brown"/>
        <text x="65" y="9" fill="black">U2</text>
        <g id="pin-2"><line x1="57" y1="15" x2="65" y2="15" stroke="black" stroke-width="1"/></g></g>
      <g id="wire-1"><line x1="30" y1="15" x2="50" y2="15" stroke="blue" stroke-width="1"/></g>
      <g id="wire-2"><line x1="30" y1="45" x2="50" y2="45" stroke="blue" stroke-width="1"/></g>
      <g id="label-1"><text x="30" y="43" fill="blue">GND</text></g>
      <g id="wire-3"><line x1="30" y1="60" x2="50" y2="60" stroke="blue" stroke-width="1"/></g>
      <g id="shared"><line x1="65" y1="65" x2="75" y2="65" stroke="blue" stroke-width="1"/></g>
    </g></g></g></svg>`,
});
const probingSchematicData = name => {
  const data = selectableSchematicData(name);
  data.selection.nets[0].terminals = [{ component: 'R1', pin: '1' }];
  return data;
};
const probingLayoutData = name => ({ ...boardData(name), kind: 'pcb',
  layout_components: [
    { name: 'R99', source_name: 'R1', source_id: 'component-1' },
    { name: 'U7', source_name: 'U[2]"<test>', source_id: 'component-2' },
  ],
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <g id="scene" transform="translate(2 1)">
      <g id="layer-top" data-layer-name="Top copper">
        <rect id="pcb-r" data-component="R99" data-pad-number="1" data-net="PCB_SIGNAL" x="10" y="10" width="8" height="6" fill="red"/>
        <rect id="pcb-other" data-component="R10" data-net="GND" x="70" y="55" width="8" height="6" fill="red"/>
      </g>
      <g id="layer-mechanical1" data-layer-token="MECHANICAL1" data-layer-name="Mechanical 1">
        <rect id="pcb-u" data-component="U7" data-pad-number="1" data-net="VCC" x="50" y="30" width="8" height="6" fill="red"/>
        <rect id="pcb-track" data-net="PCB_SIGNAL" x="20" y="30" width="8" height="6" fill="red"/>
      </g>
    </g></svg>` });
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

const settleView = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => resolve())));
const currentViewBox = page => page.locator('#view > svg').evaluate(svg => {
  const b = svg.viewBox.baseVal; return { x: b.x, y: b.y, w: b.width, h: b.height };
});
const pointOnScreen = (page, x, y) => page.locator('#view > svg').evaluate((svg, p) => {
  const q = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM()); return { clientX: q.x, clientY: q.y };
}, { x, y });
async function pixelOnGraphic(page, graphic) {
  const rect = await graphic.boundingBox(), png = (await page.screenshot({ scale: 'css' })).toString('base64');
  return page.evaluate(async ({ png, x, y }) => {
    const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + png)).blob());
    const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0);
    return [...context.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3);
  }, { png, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
}

const parityBoard = (name, webgl = false) => ({ ...boardData(name), kind: 'pcb', webgl,
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <g id="scene" transform="translate(2 3)">
      <g id="layer-top" data-layer-role="copper" data-layer-token="TOP" data-layer-name="Top copper">
        <circle id="snap-pad" data-primitive="pad" data-component="U1" data-net="A" cx="20" cy="20" r="5" fill="red"/>
        <circle id="snap-via" data-primitive="via" data-net="A" cx="60" cy="50" r="4" fill="red"/>
      </g>
      <g id="layer-bottom" data-layer-role="copper" data-layer-name="Back copper">
        <rect data-primitive="pad" x="35" y="15" width="10" height="10" fill="blue"/>
      </g>
      <g id="layer-mechanical1" data-layer-role="mechanical" data-layer-name="Mechanical">
        <circle data-primitive="pad" cx="80" cy="20" r="4" fill="white"/>
      </g>
      <g id="layer-drills" data-layer-role="drill" data-layer-name="Drills">
        <circle data-hole-owner="snap-via" cx="60" cy="50" r="1" fill="#1b1d21"/>
      </g>
    </g></svg>` });
async function openParityBoard(t, gpu) {
  const result = await openPage(t, { render: (route, name) => reply(route, parityBoard(name, gpu)) });
  const page = result.page;
  await page.locator('#file').setInputFiles(file('Parity.PcbDoc')); await loaded(page, 'Parity.PcbDoc');
  if (gpu) await page.waitForFunction(() => document.querySelector('#view.gpu-layout'));
  return page;
}
async function clickWorld(page, x, y) {
  const p = await pointOnScreen(page, x, y); await page.mouse.click(p.clientX, p.clientY);
}
const segmentPoints = page => page.locator('#measure .measurement-segment').evaluateAll(lines => lines.map(line =>
  ['x1', 'y1', 'x2', 'y2'].map(key => Number(line.getAttribute(key)))));

for (const gpu of [false, true]) {
  const renderer = gpu ? 'WebGL' : 'SVG fallback';
  test(`native parity: ${renderer} measurement pointer, Command snapping, visible copper and screen-sized markers`, async t => {
    const page = await openParityBoard(t, gpu);
    const modifier = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
    const start = await pointOnScreen(page, 22.6, 23.3);
    await page.mouse.move(start.clientX, start.clientY); await page.keyboard.press('m');
    const pointer = page.locator('#measure-pointer');
    assert.equal(await pointer.count(), 1, 'entry does not require a click or extra pointer movement');
    assert.equal(await pointer.getAttribute('data-snapped'), 'false');
    if (modifier === 'Meta') {
      await page.keyboard.down('Control'); assert.equal(await pointer.getAttribute('data-snapped'), 'false'); await page.keyboard.up('Control');
    }
    await page.keyboard.down(modifier);
    assert.equal(await pointer.getAttribute('data-snapped'), 'true');
    const center = await pointer.evaluate(el => { const m = el.transform.baseVal.consolidate().matrix; return [m.e, m.f]; });
    near(center[0], 22, 'pad center X', 1e-9); near(center[1], 23, 'pad center Y', 1e-9);
    await page.mouse.click(start.clientX, start.clientY);
    await page.keyboard.up(modifier);
    assert.equal(await pointer.getAttribute('data-snapped'), 'false');
    const end = await pointOnScreen(page, 62.5, 53.4); await page.mouse.move(end.clientX, end.clientY);
    await page.keyboard.down(modifier);
    near(Number(await page.locator('.measurement-preview').getAttribute('x2')), 62, 'preview via center X', 1e-9);
    near(Number(await page.locator('.measurement-preview').getAttribute('y2')), 53, 'preview via center Y', 1e-9);
    await page.mouse.click(end.clientX, end.clientY); await page.keyboard.up(modifier);
    (await segmentPoints(page))[0].forEach((value, i) => near(value, [22, 23, 62, 53][i], 'exact snapped endpoint', 1e-9));
    assert.equal(await pointer.count(), 1, 'the tool stays visible between measurements');
    assert.equal(await page.locator('.measure-label').textContent(), '50.000 mm');
    const style = await page.locator('.measurement-segment').evaluate(el => ({ stroke: getComputedStyle(el).stroke, width: getComputedStyle(el).strokeWidth }));
    assert.deepEqual(style, { stroke: 'rgb(255, 255, 255)', width: '3px' });
    assert.ok(await page.locator('.measure-label').evaluate(el => parseFloat(getComputedStyle(el).fontSize)) >= 18);
    const markerSize = () => pointer.locator('circle').evaluate(el => el.r.baseVal.value * Math.hypot(el.getScreenCTM().a, el.getScreenCTM().b));
    near(await markerSize(), 6, 'marker radius before zoom', .01);
    await page.locator('#view').dispatchEvent('wheel', { ctrlKey: true, deltaY: -50, clientX: end.clientX, clientY: end.clientY }); await settleView(page);
    near(await markerSize(), 6, 'marker radius after zoom', .01);
    await page.locator('#layers label').filter({ hasText: 'Back copper' }).locator('input').uncheck();
    const hidden = await pointOnScreen(page, 42.3, 23.2); await page.mouse.move(hidden.clientX, hidden.clientY);
    await page.keyboard.down(modifier); assert.equal(await pointer.getAttribute('data-snapped'), 'false');
    await page.locator('#layers label').filter({ hasText: 'Back copper' }).locator('input').check();
    await page.mouse.move(hidden.clientX, hidden.clientY); assert.equal(await pointer.getAttribute('data-snapped'), 'true');
    await page.keyboard.up(modifier); await page.keyboard.press('Escape');
    assert.equal(await pointer.count(), 0); assert.equal((await segmentPoints(page)).length, 1);
    await page.keyboard.press('m'); assert.equal(await pointer.count(), 1, 'entry shows the marker every time');
    const camera = await currentViewBox(page), retained = await segmentPoints(page);
    const move = await pointOnScreen(page, 60, 45);
    await page.mouse.move(move.clientX, move.clientY); await page.mouse.down();
    await page.mouse.move(move.clientX + 30, move.clientY + 15); await page.mouse.up(); await settleView(page);
    assert.notDeepEqual(await currentViewBox(page), camera, 'left dragging pans while measuring');
    assert.deepEqual(await segmentPoints(page), retained); assert.equal(await page.locator('.measurement-preview').count(), 0);
  });

  test(`native parity: ${renderer} selectable X/Y measurements, unit toggle and per-tab imperial preference`, async t => {
    const page = await openParityBoard(t, gpu);
    await page.keyboard.press('m'); await clickWorld(page, 10, 10); await clickWorld(page, 50, 40); await page.keyboard.press('Escape');
    const original = await segmentPoints(page), viewBox = await currentViewBox(page);
    assert.equal(await page.locator('.measurement-axis').count(), 0);
    await clickWorld(page, 30, 25);
    assert.equal(await page.locator('.measurement-segment').count(), 1);
    assert.equal(await page.locator('.measurement-axis').count(), 2);
    assert.deepEqual(await page.locator('.measure-label').allTextContents(), ['50.000 mm', 'X: 40.000 mm', 'Y: 30.000 mm']);
    assert.ok((await page.locator('.measurement-axis').evaluateAll(lines => lines.map(line => getComputedStyle(line).strokeDasharray))).every(value => value !== 'none'));
    await page.locator('[data-unit="in"]').click();
    assert.match(await page.locator('.measure-label').first().textContent(), /1\.9685 in/);
    await page.keyboard.press('q'); assert.equal(await page.locator('#units-toggle').textContent(), 'Metric (mm)');
    await page.keyboard.press('q'); assert.equal(await page.locator('#units-toggle').textContent(), 'Imperial (in)');
    assert.ok((await page.locator('.measure-label').allTextContents()).every(text => text.endsWith(' in')));
    await page.locator('#net-query').fill('q'); await page.keyboard.press('q');
    assert.equal(await page.locator('#net-query').inputValue(), 'qq');
    assert.equal(await page.locator('#units-toggle').textContent(), 'Imperial (in)', 'Q stays typeable in search');
    await page.locator('#file').setInputFiles(file('Other.PcbDoc')); await loaded(page, 'Other.PcbDoc');
    if (gpu) await page.waitForFunction(() => document.querySelector('#view.gpu-layout'));
    assert.equal(await page.locator('#units-toggle').textContent(), 'Metric (mm)');
    await page.locator('[data-unit="mil"]').click(); await page.keyboard.press('q'); await page.keyboard.press('q');
    assert.equal(await page.locator('#units-toggle').textContent(), 'Imperial (mil)');
    await page.getByRole('tab', { name: 'Parity.PcbDoc', exact: true }).click();
    assert.equal(await page.locator('#units-toggle').textContent(), 'Imperial (in)');
    assert.deepEqual(await segmentPoints(page), original); assert.deepEqual(await currentViewBox(page), viewBox);
    assert.equal(await page.locator('.measurement-axis').count(), 2);
    await page.keyboard.press('m'); await clickWorld(page, 30, 25);
    assert.equal(await page.locator('.measurement-preview').count(), 0, 'selecting while measuring does not start a new segment');
    assert.equal(await page.locator('.measurement-axis').count(), 0, 'a repeated segment click toggles X/Y off');
    await clickWorld(page, 30, 25); assert.equal(await page.locator('.measurement-axis').count(), 2);
    await page.keyboard.press('Shift+C'); assert.equal(await page.locator('.measurement-segment, .measurement-axis').count(), 0);
  });
}

test('native parity: green contour-only schematic symbols and 3.5x nets with 45% context contrast, search and restoration', async t => {
  const data = selectableSchematicData('Style.SchDoc');
  data.svg = data.svg.replace('id="wire-1"><line', 'id="wire-1" stroke-width="2"><line').replace('stroke="blue" stroke-width="1"', 'stroke="blue"');
  const { page } = await openPage(t, { render: route => reply(route, data) });
  await page.locator('#file').setInputFiles(file(data.name)); await loaded(page, data.name);
  await page.locator('#component-query').fill('r1');
  const paint = selector => page.locator(selector).evaluate(el => {
    const p = getComputedStyle(el); return { fill: p.fill, stroke: p.stroke, width: p.strokeWidth };
  });
  assert.deepEqual(await paint('#body-1'), { fill: 'rgb(255, 255, 176)', stroke: 'rgb(0, 138, 59)', width: '1px' });
  assert.equal((await paint('#component-1 text')).fill, 'rgb(0, 138, 59)');
  assert.equal((await paint('#wire-1 line:not(.sch-hit)')).stroke, 'rgb(140, 139, 251)');
  await page.locator('#net-query').fill('gnd');
  for (let i = 0; i < 3; i++) {
    assert.equal((await paint('#wire-1 line:not(.sch-hit)')).stroke, 'rgb(0, 138, 59)');
    assert.equal((await paint('#wire-1 line:not(.sch-hit)')).width, '7px');
    await page.locator('#net-clear').click(); await page.locator('#net-query').fill('GND');
  }
  assert.ok(await page.locator('#schematic-highlight').count());
  assert.equal(await page.locator('#schematic-highlight').evaluate(el => getComputedStyle(el).pointerEvents), 'none');
  await page.locator('#net-fit').click();
  assert.notEqual(await page.locator('#view > svg').getAttribute('viewBox'), '0 0 100 80');
  await page.keyboard.press('Escape');
  assert.deepEqual(await paint('#body-1'), { fill: 'rgb(255, 255, 176)', stroke: 'rgb(165, 42, 42)', width: '1px' });
  assert.equal((await paint('#wire-1 line:not(.sch-hit)')).stroke, 'rgb(0, 0, 255)');
  assert.equal((await paint('#wire-1 line:not(.sch-hit)')).width, '2px');
  assert.equal(await page.locator('#schematic-highlight').count(), 0);
});

test('native parity: filled-only schematic bodies retain their interiors and leaf net graphics remain selectable', async t => {
  const data = { ...schematicData('Leaf.SchDoc'), selection: {
    components: [{ id: 'c', name: 'U1', elements: ['c'], body_elements: ['body'] }],
    nets: [{ id: 'n', name: 'SIGNAL', elements: ['route', 'junction'] }],
  }, svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><g id="scene">
    <rect width="100" height="80" fill="#fffcf8"/>
    <g id="c"><rect id="body" x="10" y="10" width="20" height="12" fill="#ffffb0" stroke="none"/></g>
    <line id="route" x1="40" y1="40" x2="80" y2="40" stroke="blue" stroke-width=".3"/>
    <circle id="junction" cx="80" cy="40" r="1" fill="blue"/>
  </g></svg>` };
  const { page } = await openPage(t, { render: route => reply(route, data) });
  await page.locator('#file').setInputFiles(file(data.name)); await page.waitForFunction(() => document.querySelector('#body'));
  await page.locator('#component-query').fill('U1');
  assert.deepEqual(await page.locator('#body').evaluate(el => [getComputedStyle(el).fill, getComputedStyle(el).stroke]),
    ['rgb(255, 255, 176)', 'rgb(0, 138, 59)']);
  await page.keyboard.press('Escape');
  await clickWorld(page, 60, 40.4);
  assert.equal(await schematicStatus(page), 'Nets: SIGNAL');
  assert.equal(await page.locator('#route').evaluate(el => getComputedStyle(el).strokeWidth), '1.05px');
  assert.equal(await page.locator('#junction').evaluate(el => getComputedStyle(el).fill), 'rgb(0, 138, 59)');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#body').evaluate(el => getComputedStyle(el).stroke), 'none');
});

test('native parity: physical layer list order and selecting visible layers retain independent paint/visibility state', async t => {
  const data = layeredBoardData('Stack.PcbDoc');
  data.copper_layer_order = ['TOP', 'MID9', 'MID1', 'BOTTOM'];
  data.svg = data.svg.replace('id="layer-top"', 'id="layer-top" data-layer-token="TOP"')
    .replace('id="layer-bottom"', 'id="layer-bottom" data-layer-token="BOTTOM"')
    .replace('<g id="board-outline">', '<g id="mid1" data-layer-token="MID1" data-layer-role="copper" data-layer-name="A digital"><path d="M0 5H90"/></g><g id="mid9" data-layer-token="MID9" data-layer-role="copper" data-layer-name="Z analogue"><path d="M0 10H90"/></g><g id="board-outline">');
  const { page } = await openPage(t, { render: route => reply(route, data) });
  await page.locator('#file').setInputFiles(file(data.name)); await loaded(page, data.name);
  assert.deepEqual(await page.locator('#layers .layer-name').allTextContents(), ['Top copper', 'Z analogue', 'A digital', 'Bottom copper', 'board-outline']);
  assert.deepEqual(await layerOrder(page), ['layer-top', 'layer-bottom', 'mid1', 'mid9', 'board-outline']);
  await page.getByRole('button', { name: 'Top copper', exact: true }).click();
  assert.equal(await frontLayer(page), 'layer-top');
  assert.equal(await page.locator('#layers input').first().isChecked(), true);
  assert.equal(await page.getByRole('button', { name: 'Top copper', exact: true }).getAttribute('aria-pressed'), 'true');
  const order = await layerOrder(page);
  await page.locator('#file').setInputFiles(file('Other.PcbDoc')); await loaded(page, data.name);
  await page.getByRole('tab').first().click();
  assert.deepEqual(await layerOrder(page), order);
  assert.equal(await page.getByRole('button', { name: 'Top copper', exact: true }).getAttribute('aria-pressed'), 'true');
});

test('native parity: total measurement labels stay outside segments and X/Y legs for all directions and survive zoom', async t => {
  const page = await openParityBoard(t, false);
  for (const [a, b] of [[[10, 10], [60, 45]], [[60, 45], [10, 10]], [[10, 60], [60, 15]], [[60, 15], [10, 60]],
    [[10, 30], [70, 30]], [[40, 10], [40, 60]], [[40, 40], [41, 40.5]]]) {
    await page.keyboard.press('Shift+C'); await page.keyboard.press('m');
    await clickWorld(page, ...a); await clickWorld(page, ...b); await page.keyboard.press('Escape');
    await clickWorld(page, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    const clear = () => page.locator('#view > svg').evaluate(svg => {
      const box = document.querySelector('.measure-label[data-kind="total"]').getBoundingClientRect();
      const lines = [...svg.querySelectorAll('#measure line')];
      return lines.every(line => {
        const a = new DOMPoint(+line.getAttribute('x1'), +line.getAttribute('y1')).matrixTransform(svg.getScreenCTM());
        const b = new DOMPoint(+line.getAttribute('x2'), +line.getAttribute('y2')).matrixTransform(svg.getScreenCTM());
        // An expanded rectangle must not intersect the finite measurement line.
        let low = 0, high = 1;
        for (const [p, q] of [[a.x - b.x, a.x - box.left + 2], [b.x - a.x, box.right + 2 - a.x],
          [a.y - b.y, a.y - box.top + 2], [b.y - a.y, box.bottom + 2 - a.y]]) {
          if (p === 0 && q < 0) return true;
          if (p < 0) low = Math.max(low, q / p); else if (p > 0) high = Math.min(high, q / p);
        }
        return low > high;
      });
    });
    assert.equal(await clear(), true, 'distance text clears its total and dashed axes');
    await page.keyboard.press('+'); await settleView(page);
    assert.equal(await clear(), true, 'labels keep clearing their segments after zoom');
    await page.keyboard.press('f'); await settleView(page);
    await page.keyboard.press('Escape');
  }
});

test('native parity: Shift adds PCB selections and fit/zoom/open shortcuts preserve text entry', async t => {
  const { page } = await openClickableComponents(t);
  await page.locator('[data-primitive="component-pad"]').click();
  await page.locator('[data-primitive="component-body"]').click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('#component-query').inputValue(), 'R1, C2');
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC');
  await page.locator('[data-primitive="component-pad"]').click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('#component-query').inputValue(), 'C2');
  assert.equal(await page.locator('#net-query').inputValue(), '');
  const original = await currentViewBox(page);
  await page.keyboard.press('+'); await settleView(page);
  assert.ok((await currentViewBox(page)).w < original.w);
  await page.keyboard.press('f'); assert.deepEqual(await currentViewBox(page), original);
  await page.locator('#component-query').fill(''); await page.keyboard.type('f-q+');
  assert.equal(await page.locator('#component-query').inputValue(), 'f-q+');
  assert.deepEqual(await currentViewBox(page), original);
  const modifier = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform) ? 'Meta' : 'Control');
  const chooser = page.waitForEvent('filechooser'); await page.keyboard.press(modifier + '+o');
  await (await chooser).setFiles(file('Opened.PcbDoc')); await loaded(page, 'Opened.PcbDoc');
});

test('native parity: schematic embedded PNG diagrams render through the real server and retain their pixels during selection', async t => {
  const source = execFileSync(process.env.PCB_TEST_PYTHON || resolve(__dirname, '../.venv/bin/python'), ['-c', `
import sys, tempfile
from pathlib import Path
from PySide6.QtGui import QColor, QImage, QPainter
from altium_monkey import AltiumSchDoc, SchRectMils, SchPointMils, make_sch_embedded_image, make_sch_wire, make_sch_net_label
with tempfile.TemporaryDirectory() as tmp:
 image = QImage(8, 4, QImage.Format.Format_ARGB32)
 image.fill(QColor('red'))
 painter = QPainter(image); painter.fillRect(4, 0, 4, 4, QColor('blue')); painter.end()
 png = Path(tmp) / 'diagram.png'; image.save(str(png), 'PNG')
 sheet = AltiumSchDoc()
 sheet.add_object(make_sch_embedded_image(bounds_mils=SchRectMils(500, 500, 7500, 4500), source_path=png))
 sheet.add_object(make_sch_wire(points_mils=[SchPointMils(1000, 5500), SchPointMils(8000, 5500)]))
 sheet.add_object(make_sch_net_label(location_mils=SchPointMils(1000, 5500), text='DIAGRAM_NET'))
 path = Path(tmp) / 'diagram.SchDoc'; sheet.save(path); sys.stdout.buffer.write(path.read_bytes())
`]);
  const { page } = await openPage(t); await page.unroute('**/render');
  await page.locator('#file').setInputFiles({ name: 'diagram.SchDoc', mimeType: 'application/octet-stream', buffer: source });
  await page.waitForFunction(() => document.querySelector('#filename').textContent === 'diagram.SchDoc' && document.querySelector('#busy').style.display === 'none');
  assert.ok(await page.locator('#scene image').count() > 0);
  const pixels = async () => {
    const coordinates = await page.locator('#scene image').first().evaluate(el => {
      const b = el.getBBox(); return [.25, .75].map(f => {
        const p = new DOMPoint(b.x + b.width * f, b.y + b.height / 2).matrixTransform(el.getScreenCTM()); return [p.x, p.y];
      });
    });
    const png = (await page.screenshot()).toString('base64');
    return page.evaluate(async ({ png, coordinates }) => {
      const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + png)).blob());
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(bitmap, 0, 0);
      return coordinates.map(([x, y]) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data].slice(0, 3));
    }, { png, coordinates });
  };
  assert.deepEqual(await pixels(), [[255, 0, 0], [0, 0, 255]]);
  await clickSchematicGraphic(page, page.locator('.sch-hit').first());
  assert.match(await schematicStatus(page), /Nets:/);
  assert.deepEqual(await pixels(), [[255, 0, 0], [0, 0, 255]]);
  await page.keyboard.press('Escape'); assert.deepEqual(await pixels(), [[255, 0, 0], [0, 0, 255]]);
});

test('native parity: multiple startup files, reordering tabs and dropping files on the sidebar preserve document state', async t => {
  const data = name => ({ ...boardData(name), source: Buffer.from(name).toString('base64') });
  const { page, requests } = await openPage(t, { initial: { documents: [data('First.PcbDoc'), data('Second.PcbDoc'), data('Third.PcbDoc')] } });
  await loaded(page, 'Third.PcbDoc');
  assert.equal(await page.getByRole('tab').count(), 3);
  await page.getByRole('tab', { name: 'First.PcbDoc', exact: true }).click();
  await page.locator('[data-unit="in"]').click();
  await page.keyboard.press('+'); await settleView(page); const zoom = await currentViewBox(page);
  const names = () => page.getByRole('tab').allTextContents();
  await page.getByRole('tab', { name: 'First.PcbDoc', exact: true }).focus();
  await page.keyboard.press('Alt+Shift+ArrowRight'); assert.deepEqual(await names(), ['Second.PcbDoc', 'First.PcbDoc', 'Third.PcbDoc']);
  await page.locator('.tab').nth(1).dragTo(page.locator('.tab').nth(2));
  assert.deepEqual(await names(), ['Second.PcbDoc', 'Third.PcbDoc', 'First.PcbDoc']);
  assert.deepEqual(await currentViewBox(page), zoom); assert.equal(await page.locator('#units-toggle').textContent(), 'Imperial (in)');
  assert.equal(requests.length, 0, 'startup and tab order changes do not re-upload documents');
  const transfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer(); transfer.items.add(new File(['Dropped.PcbDoc'], 'Dropped.PcbDoc')); return transfer;
  });
  await page.locator('#panel').dispatchEvent('drop', { dataTransfer: transfer }); await loaded(page, 'Dropped.PcbDoc');
  assert.equal(await page.getByRole('tab').count(), 4);
  await page.getByRole('tab', { name: 'First.PcbDoc', exact: true }).click();
  assert.deepEqual(await currentViewBox(page), zoom); assert.equal(await page.locator('#units-toggle').textContent(), 'Imperial (in)');
});
const pointInView = (page, p) => page.locator('#view > svg').evaluate((svg, p) => {
  const q = new DOMPoint(p.clientX, p.clientY).matrixTransform(svg.getScreenCTM().inverse()); return { x: q.x, y: q.y };
}, p);
function near(actual, expected, message, tolerance = 0.0001) { assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} vs ${expected}`); }

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
  assert.equal(await page.locator('#filename').textContent(), 'No document loaded');
  assert.equal(await page.locator('#view > svg').count(), 0);
  await page.locator('#file').setInputFiles(file('A.PcbDoc'));
  await loaded(page, 'A.PcbDoc');
});

test('mixes PCB and schematic tabs while preserving the view and PCB measurements', async t => {
  const { page, requests } = await openPage(t, {
    render: (route, name) => reply(route, /\.schdoc$/i.test(name) ? schematicData(name) : boardData(name)),
  });
  assert.match(await page.locator('#file').getAttribute('accept'), /\.SchDoc/);
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  await page.locator('#measure-btn').click();
  await page.locator('#view').click({ position: { x: 200, y: 200 } });
  await page.locator('#view').click({ position: { x: 400, y: 300 } });
  const measurement = await page.locator('#readout').textContent();
  await page.locator('#file').setInputFiles(file('Sheet.SchDoc')); await loaded(page, 'Sheet.SchDoc');
  assert.equal(await page.locator('#DocumentMainGroup').isVisible(), true);
  assert.equal(await page.locator('#layers-wrap').isVisible(), false);
  assert.equal(await page.locator('#component-query').isVisible(), true);
  assert.equal(await page.locator('#net-query').isVisible(), true);
  assert.equal(await page.locator('#measure-btn').isVisible(), false);
  assert.equal(await page.locator('#stats').textContent(), '3 components, 7 wires, 2 net labels');
  await page.locator('#view').click(); await page.keyboard.press('m');
  assert.equal(await page.locator('#view').evaluate(el => el.classList.contains('measuring')), false);
  await page.locator('#view').dispatchEvent('wheel', { ctrlKey: true, deltaY: -250, clientX: 600, clientY: 400 });
  await settleView(page);
  await page.mouse.move(600, 400); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(630, 420); await page.mouse.up({ button: 'middle' });
  const zoom = await page.locator('#view > svg').getAttribute('viewBox');
  assert.notEqual(zoom, '0 0 1700 1100');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#measure-btn').isVisible(), true);
  assert.equal(await page.locator('#layers-wrap').isVisible(), true);
  assert.equal(await page.locator('#measure line').count(), 1);
  assert.equal(await page.locator('#readout').textContent(), measurement);
  await page.getByRole('tab', { name: 'Sheet.SchDoc', exact: true }).click();
  assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), zoom);
  await page.locator('#view').dblclick();
  assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), '0 0 1700 1100');
  assert.equal(requests.length, 2);
});

test('loads an initial schematic and accepts schematic drag and drop', async t => {
  const { page } = await openPage(t, {
    initial: { ...schematicData('Initial.SchDoc'), source: Buffer.from('schematic').toString('base64') },
    render: (route, name) => reply(route, schematicData(name)),
  });
  await loaded(page, 'Initial.SchDoc');
  assert.equal(await page.locator('#DocumentMainGroup').isVisible(), true);
  await page.locator('#view').evaluate(el => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(['schematic'], 'Dropped.schdoc'));
    el.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  });
  await loaded(page, 'Dropped.schdoc');
  assert.equal(await page.getByRole('tab').count(), 2);
});

async function openSelectableSchematic(t) {
  const result = await openPage(t, {
    render: (route, name) => reply(route, /\.schdoc$/i.test(name) ? selectableSchematicData(name) : boardData(name)),
  });
  await result.page.locator('#file').setInputFiles(file('A.SchDoc')); await loaded(result.page, 'A.SchDoc');
  return result;
}
const schematicStatus = page => page.locator('#schematic-selection-status').textContent();
const symbolBodies = page => page.locator('[data-sch-components] > rect:not(.sch-component-hit)');
async function clickSchematicGraphic(page, target, shift = false) {
  const point = await target.evaluate(el => {
    const b = el.getBBox();
    const p = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(el.getScreenCTM());
    return { x: p.x, y: p.y };
  });
  if (shift) await page.keyboard.down('Shift');
  try { await page.mouse.click(point.x, point.y); }
  finally { if (shift) await page.keyboard.up('Shift'); }
}

test('selects schematic components and entire nets; Shift adds, selected items toggle off, and new clicks replace', async t => {
  const { page } = await openSelectableSchematic(t);
  const component = symbolBodies(page);
  await clickSchematicGraphic(page, component.first());
  assert.equal(await schematicStatus(page), 'Components: R1');
  assert.equal(await page.locator('.sch-component-match').count(), 1);
  await clickSchematicGraphic(page, component.nth(1), true);
  assert.equal(await page.locator('.sch-component-match').count(), 2);
  assert.equal(await schematicStatus(page), 'Components: R1, U[2]"<test>');
  assert.equal(await page.locator('#schematic-selection-status test').count(), 0);
  await page.locator('#label-1 text').click({ modifiers: ['Shift'] });
  assert.equal(await page.locator('.sch-net-match').count(), 5);
  assert.equal(await page.locator('#pin-1').evaluate(el => el.classList.contains('sch-net-match')), true);
  assert.equal(await page.locator('#wire-2').evaluate(el => el.classList.contains('sch-net-match')), true);
  assert.equal(await page.locator('#wire-3').evaluate(el => el.classList.contains('sch-net-match')), false);
  assert.match(await schematicStatus(page), /Nets: GND$/);
  assert.equal(await page.locator('#wire-1 .sch-hit').evaluate(el => getComputedStyle(el).stroke), 'rgba(0, 0, 0, 0)');
  await clickSchematicGraphic(page, page.locator('#wire-3 .sch-hit'), true);
  assert.equal(await page.locator('.sch-net-match').count(), 7);
  assert.match(await schematicStatus(page), /Nets: GND, VCC$/);
  await clickSchematicGraphic(page, component.first());
  assert.equal(await schematicStatus(page), 'Components: U[2]"<test>\nNets: GND, VCC', 'clicking a selected item removes only that item');
  await clickSchematicGraphic(page, component.first());
  assert.equal(await schematicStatus(page), 'Components: R1');
  assert.equal(await page.locator('.sch-net-match').count(), 0);
  await clickSchematicGraphic(page, page.locator('#pin-2 .sch-hit'));
  assert.equal(await schematicStatus(page), 'Nets: VCC', 'a pin selects its net rather than its containing component');
  assert.equal(await page.locator('.sch-component-match').count(), 0);
  await clickSchematicGraphic(page, page.locator('#shared .sch-hit'), true);
  assert.equal(await page.locator('.sch-net-match').count(), 7, 'shared graphics retain the union of selected nets');
  await page.locator('#schematic-clear').click();
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  assert.equal(await page.locator('.sch-net-match').count(), 0);
  assert.equal(await page.locator('#wire-1 line:not(.sch-hit)').evaluate(el => getComputedStyle(el).stroke), 'rgb(0, 0, 255)');
});

test('schematic components and nets can be deselected and reselected, including Shift selections and shared graphics', async t => {
  const { page } = await openSelectableSchematic(t);
  const component = symbolBodies(page);
  for (let cycle = 0; cycle < 2; cycle++) {
    await clickSchematicGraphic(page, component.first());
    assert.equal(await schematicStatus(page), 'Components: R1');
    await clickSchematicGraphic(page, component.first());
    assert.equal(await schematicStatus(page), 'Nothing selected.');
    assert.equal(await page.locator('.sch-component-match').count(), 0);
    assert.equal(await page.locator('#schematic-clear').isDisabled(), true);
    assert.equal(await page.locator('#probe-layout-btn').isDisabled(), true);
  }
  await clickSchematicGraphic(page, component.first());
  await clickSchematicGraphic(page, component.nth(1), true);
  await clickSchematicGraphic(page, component.first(), true);
  assert.equal(await schematicStatus(page), 'Components: U[2]"<test>');
  await clickSchematicGraphic(page, component.first());
  await clickSchematicGraphic(page, page.locator('#wire-1 .sch-hit'), true);
  await page.locator('#label-1 text').click();
  assert.equal(await schematicStatus(page), 'Components: R1', 'a label can deselect its already selected wire net without clearing the component');
  await clickSchematicGraphic(page, page.locator('#pin-1 .sch-hit'));
  assert.equal(await schematicStatus(page), 'Nets: GND', 'an unselected pin net replaces the selection');
  await clickSchematicGraphic(page, page.locator('#wire-3 .sch-hit'), true);
  await clickSchematicGraphic(page, page.locator('#shared .sch-hit'), true);
  assert.equal(await schematicStatus(page), 'Nothing selected.', 'all nets represented by a selected shared graphic toggle off together');
  await clickSchematicGraphic(page, page.locator('#shared .sch-hit'));
  assert.equal(await schematicStatus(page), 'Nets: GND, VCC');
  await clickSchematicGraphic(page, page.locator('#shared .sch-hit'));
  assert.equal(await page.locator('.sch-net-match').count(), 0);
});

test('schematic selections survive tabs and pans; Escape clears only the active sheet', async t => {
  const { page, requests } = await openSelectableSchematic(t);
  await clickSchematicGraphic(page, symbolBodies(page).first());
  await clickSchematicGraphic(page, page.locator('#wire-1 .sch-hit'), true);
  const selection = await schematicStatus(page);
  await page.mouse.move(600, 400); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(640, 420); await page.mouse.up({ button: 'middle' });
  assert.equal(await schematicStatus(page), selection);
  await page.locator('#file').setInputFiles(file('B.SchDoc')); await loaded(page, 'B.SchDoc');
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  await clickSchematicGraphic(page, page.locator('#wire-3 .sch-hit'));
  await page.locator('#file').setInputFiles(file('Board.PcbDoc')); await loaded(page, 'Board.PcbDoc');
  assert.equal(await page.locator('#schematic-selection').isVisible(), false);
  await page.getByRole('tab', { name: 'A.SchDoc', exact: true }).click();
  assert.equal(await schematicStatus(page), selection);
  assert.equal(await page.locator('.sch-component-match').count(), 1);
  assert.equal(await page.locator('.sch-net-match').count(), 5);
  await page.locator('#schematic-clear').focus(); await page.keyboard.press('Escape');
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  assert.equal(await page.locator('.sch-component-match, .sch-net-match').count(), 0);
  assert.equal(await page.locator('#schematic-clear').isDisabled(), true);
  await page.getByRole('tab', { name: 'B.SchDoc', exact: true }).click();
  assert.equal(await schematicStatus(page), 'Nets: VCC');
  await page.getByRole('tab', { name: 'A.SchDoc', exact: true }).click();
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  assert.equal(requests.length, 3);
});

test('thin schematic wires have screen-space hit targets and blank clicks clear selection', async t => {
  const { page } = await openSelectableSchematic(t);
  const point = await page.locator('#wire-1').evaluate(el => {
    const p = new DOMPoint(40, 15).matrixTransform(el.getScreenCTM()); return { x: p.x, y: p.y };
  });
  await page.mouse.click(point.x, point.y + 3);
  assert.equal(await schematicStatus(page), 'Nets: GND');
  await page.locator('#view').dispatchEvent('click', { button: 1 });
  assert.equal(await schematicStatus(page), 'Nets: GND');
  await page.locator('#view').click({ position: { x: 10, y: 10 }, modifiers: ['Shift'] });
  assert.equal(await schematicStatus(page), 'Nets: GND');
  await page.locator('#view').click({ position: { x: 10, y: 10 } });
  assert.equal(await schematicStatus(page), 'Nothing selected.');
});

test('hollow rotated and mirrored symbol bodies select components without capturing external pins or distant labels', async t => {
  const data = name => ({ ...selectableSchematicData(name),
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}" fill="none">
      <g id="scene" transform="translate(2 1)"><g id="DocumentMainGroup"><g id="sheet-id">
        <rect width="96" height="78" fill="#fffcf8"/>
        <g id="component-1" transform="translate(25 20)">
          <g id="body-1" transform="rotate(30)"><path d="M0 0 H12 V8 H0 Z" stroke="blue"/></g>
          <text x="0" y="-5" font-size="3" fill="black">R1</text>
          <text x="30" y="0" font-size="3" fill="black">Long value</text>
          <g id="pin-1"><line x1="-20" y1="4" x2="0" y2="4" stroke="black"/></g>
        </g>
        <g id="component[2]&quot;" transform="translate(70 20)">
          <g id="body-2" transform="scale(-1 1)"><circle cx="0" cy="0" r="5" stroke="blue"/></g>
          <g id="pin-2"><line x1="5" y1="0" x2="15" y2="0" stroke="black"/></g>
        </g>
        <g id="wire-1"><line x1="20" y1="60" x2="40" y2="60" stroke="blue"/></g>
      </g></g></g></svg>` });
  const { page } = await openPage(t, { render: (route, name) => reply(route, data(name)) });
  await page.locator('#file').setInputFiles(file('Symbols.SchDoc')); await loaded(page, 'Symbols.SchDoc');
  await clickSchematicGraphic(page, page.locator('#body-1'));
  assert.equal(await schematicStatus(page), 'Components: R1', 'clicking empty space inside the outline selects the component');
  assert.equal(await page.locator('#body-1 path').evaluate(el => getComputedStyle(el).stroke), 'rgb(0, 138, 59)');
  assert.equal(await page.locator('.sch-component-hit').first().evaluate(el => getComputedStyle(el).fill), 'rgba(0, 0, 0, 0)');
  await clickSchematicGraphic(page, page.locator('#body-2'), true);
  assert.equal(await schematicStatus(page), 'Components: R1, U[2]"<test>');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sch-component-match').count(), 0);
  const outside = await page.locator('#component-1').evaluate(el => {
    // Inside the rotated body's axis-aligned envelope, outside the body itself.
    const p = new DOMPoint(-3, 11).matrixTransform(el.getScreenCTM());
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(outside.x, outside.y);
  assert.equal(await schematicStatus(page), 'Nothing selected.', 'rotated bounds must not capture unrelated empty corners');
  await clickSchematicGraphic(page, page.locator('#pin-1 .sch-hit'));
  assert.equal(await schematicStatus(page), 'Nets: GND', 'the external pin remains a net target');
  const blank = await page.locator('#view > svg').evaluate(svg => {
    const p = new DOMPoint(45, 25).matrixTransform(svg.getScreenCTM());
    return { x: p.x, y: p.y };
  });
  await page.mouse.click(blank.x, blank.y);
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  await clickSchematicGraphic(page, page.locator('#component-1 text').first());
  assert.equal(await schematicStatus(page), 'Components: R1', 'designators remain selectable');
  await page.locator('#file').setInputFiles(file('Other.SchDoc')); await loaded(page, 'Other.SchDoc');
  await page.getByRole('tab', { name: 'Symbols.SchDoc', exact: true }).click();
  assert.equal(await page.locator('.sch-component-hit').count(), 2, 'remounting must not duplicate targets');
  assert.equal(await schematicStatus(page), 'Components: R1');
});

test('selects empty symbol interiors from an Altium file with anonymous body graphics', async t => {
  const source = execFileSync(process.env.PCB_TEST_PYTHON || resolve(__dirname, '../.venv/bin/python'), ['-B', '-c', `
import sys, tempfile
from pathlib import Path
from altium_monkey import AltiumSchDoc, AltiumSchComponent, AltiumSchDesignator, SchRectMils, make_sch_rectangle
sheet = AltiumSchDoc()
for index in range(2):
    component = AltiumSchComponent(); sheet.add_object(component)
    designator = AltiumSchDesignator(); designator.text = f'U{index + 1}'
    sheet.add_object(designator, owner=component)
    body = make_sch_rectangle(bounds_mils=SchRectMils(1000 + index * 1500, 1000, 2000 + index * 1500, 2000))
    sheet.add_object(body, owner=component); body.unique_id = None
with tempfile.TemporaryDirectory() as tmp:
    path = Path(tmp) / 'Anonymous.SchDoc'; sheet.save(path)
    sys.stdout.buffer.write(path.read_bytes())
`]);
  const { page } = await openPage(t); await page.unroute('**/render');
  await page.locator('#file').setInputFiles({ name: 'Anonymous.SchDoc', mimeType: 'application/octet-stream', buffer: source });
  await page.waitForFunction(() => document.querySelector('#filename').textContent === 'Anonymous.SchDoc' && document.querySelector('#busy').style.display === 'none');
  assert.equal(await page.locator('.sch-component-hit').count(), 2);
  const bodies = page.locator('.sch-component-hit');
  await clickSchematicGraphic(page, bodies.first());
  assert.equal(await schematicStatus(page), 'Components: U1');
  await clickSchematicGraphic(page, bodies.nth(1), true);
  assert.equal(await schematicStatus(page), 'Components: U1, U2');
  await clickSchematicGraphic(page, bodies.first());
  assert.equal(await schematicStatus(page), 'Components: U2');
});

test('a symbol body that also carries net metadata selects the component while its pin selects the net', async t => {
  const data = selectableSchematicData('Power.SchDoc');
  data.selection.nets[0].elements.push('body-1');
  data.svg = data.svg.replace(/<rect id="body-1"([^>]+)\/>/, '<g id="body-1"><rect$1/></g>');
  const { page } = await openPage(t, { initial: data });
  await loaded(page, 'Power.SchDoc');
  await clickSchematicGraphic(page, page.locator('#component-1 .sch-component-hit'));
  assert.equal(await schematicStatus(page), 'Components: R1');
  await clickSchematicGraphic(page, page.locator('#pin-1 .sch-hit'));
  assert.equal(await schematicStatus(page), 'Nets: GND');
});

test('cross-probes multiple schematic selections using source IDs and pin connectivity, reveals and fits layout matches', async t => {
  const { page, requests } = await openPage(t, { render: (route, name) => reply(route,
    name.endsWith('.SchDoc') ? probingSchematicData(name) : probingLayoutData(name)) });
  await page.locator('#file').setInputFiles(file('Layout.PcbDoc')); await loaded(page, 'Layout.PcbDoc');
  await page.locator('#measure-btn').click();
  await page.locator('#view').click({ position: { x: 200, y: 200 } });
  await page.locator('#view').click({ position: { x: 400, y: 300 } });
  await page.locator('#file').setInputFiles(file('Sheet.SchDoc')); await loaded(page, 'Sheet.SchDoc');
  await clickSchematicGraphic(page, symbolBodies(page).first());
  await clickSchematicGraphic(page, symbolBodies(page).nth(1), true);
  await page.locator('#label-1 text').click({ modifiers: ['Shift'] });
  const selection = await schematicStatus(page), schematicView = await page.locator('#view > svg').getAttribute('viewBox');
  assert.equal(await page.locator('#probe-layout option:checked').textContent(), 'Layout.PcbDoc');
  await page.locator('#probe-layout-btn').click();
  assert.equal(await activeName(page), 'Layout.PcbDoc');
  assert.equal(await page.locator('.component-match').count(), 2);
  assert.equal(await page.locator('.net-match').count(), 2);
  assert.equal(await page.locator('#component-query').inputValue(), 'R99, U7');
  assert.equal(await page.locator('#net-query').inputValue(), 'PCB_SIGNAL', 'pad connectivity wins over a coincident net name');
  assert.equal(await page.locator('#pcb-other').evaluate(el => el.classList.contains('net-match') || el.classList.contains('component-match')), false);
  assert.equal(await page.getByRole('checkbox', { name: 'Mechanical 1', exact: true }).isChecked(), true);
  assert.notEqual(await page.locator('#view > svg').getAttribute('viewBox'), '0 0 100 80');
  assert.equal(await page.locator('#measure line').count(), 1, 'completed PCB measurements survive cross-probing');
  assert.equal(await page.locator('#view').evaluate(el => el.classList.contains('measuring')), false);
  await page.locator('#probe-back').click();
  assert.equal(await activeName(page), 'Sheet.SchDoc');
  assert.equal(await schematicStatus(page), selection);
  assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), schematicView);
  await page.getByRole('tab', { name: 'Layout.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('.component-match').count(), 2, 'exact multi-selection survives remounting');
  await page.locator('#pcb-r').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'U7', 'deselecting one probed component retains the other exact match');
  assert.equal(await page.locator('#net-query').inputValue(), '');
  assert.equal(await page.locator('.component-match').count(), 1);
  assert.equal(await page.locator('#probe-result').isVisible(), false);
  await page.getByRole('tab', { name: 'Sheet.SchDoc', exact: true }).click();
  await page.getByRole('tab', { name: 'Layout.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#component-query').inputValue(), 'U7');
  await page.locator('#pcb-r').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'R99', 'the deselected component can be selected again');
  await page.locator('#component-query').fill('R10');
  assert.equal(await page.locator('.component-match').count(), 1, 'typing replaces the probed component selection');
  assert.equal(await page.locator('#probe-result').isVisible(), false);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.component-match, .net-match').count(), 0);
  assert.equal(requests.length, 2, 'cross-probing uses the already-rendered documents');
});

test('cross-probing requires an open layout and a selection, and lets users choose among layouts', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route,
    name.endsWith('.SchDoc') ? probingSchematicData(name) : probingLayoutData(name)) });
  await page.locator('#file').setInputFiles(file('Sheet.SchDoc')); await loaded(page, 'Sheet.SchDoc');
  assert.equal(await page.locator('#probe-layout-btn').isDisabled(), true);
  assert.match(await page.locator('#probe-status').textContent(), /Open a PCB layout \(\.PcbDoc or \.kicad_pcb\)/);
  await page.locator('#file').setInputFiles([file('First.PcbDoc'), file('Second.PcbDoc')]); await loaded(page, 'Second.PcbDoc');
  await page.getByRole('tab', { name: 'Sheet.SchDoc', exact: true }).click();
  assert.equal(await page.locator('#probe-layout-btn').isDisabled(), true);
  await clickSchematicGraphic(page, symbolBodies(page).first());
  assert.equal(await page.locator('#probe-layout-btn').isDisabled(), true, 'no arbitrary target when several layouts are open');
  const value = await page.locator('#probe-layout option').filter({ hasText: 'Second.PcbDoc' }).getAttribute('value');
  await page.locator('#probe-layout').selectOption(value);
  await page.locator('#probe-layout-btn').click();
  assert.equal(await activeName(page), 'Second.PcbDoc');
  await page.getByRole('tab', { name: 'First.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('.component-match').count(), 0, 'other layouts are untouched');
  await page.getByRole('tab', { name: 'Sheet.SchDoc', exact: true }).click();
  await page.getByRole('button', { name: 'Close Second.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#probe-layout option:checked').textContent(), 'First.PcbDoc');
  await page.getByRole('button', { name: 'Close First.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#probe-layout-btn').isDisabled(), true);
});

test('cross-probing falls back to exact designators, net names, and aliases when source/pin links are absent', async t => {
  const { page } = await openPage(t, { render: (route, name) => {
    if (name.endsWith('.SchDoc')) {
      const data = probingSchematicData(name);
      data.selection.nets[0].terminals = []; data.selection.nets[0].aliases = ['earth'];
      return reply(route, data);
    }
    const data = probingLayoutData(name); data.layout_components = [];
    data.svg = data.svg.replaceAll('R99', 'r1').replaceAll('PCB_SIGNAL', 'EARTH').replace('data-net="GND"', 'data-net="GND_EXTRA"');
    return reply(route, data);
  } });
  await page.locator('#file').setInputFiles(file('Layout.PcbDoc')); await loaded(page, 'Layout.PcbDoc');
  await page.locator('#file').setInputFiles(file('Sheet.SchDoc')); await loaded(page, 'Sheet.SchDoc');
  await clickSchematicGraphic(page, symbolBodies(page).first());
  await page.locator('#label-1 text').click({ modifiers: ['Shift'] });
  await clickSchematicGraphic(page, page.locator('#wire-3 .sch-hit'), true);
  await page.locator('#probe-layout-btn').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'r1');
  assert.equal(await page.locator('#net-query').inputValue(), 'EARTH, VCC');
  assert.equal(await page.locator('.net-match').count(), 3);
  assert.equal(await page.locator('#pcb-other').evaluate(el => el.classList.contains('net-match')), false);
  await page.getByRole('button', { name: 'Close Sheet.SchDoc', exact: true }).click();
  assert.equal(await page.locator('#probe-back').isDisabled(), true);
});

test('unmatched and conflicting schematic probes are reported without selecting similar names or unrelated nets', async t => {
  let conflicting = false;
  const { page } = await openPage(t, { render: (route, name) => {
    if (name.endsWith('.SchDoc')) return reply(route, probingSchematicData(name));
    const data = probingLayoutData(name);
    if (!conflicting) data.svg = data.svg.replaceAll('R99', 'R10').replaceAll('PCB_SIGNAL', 'OTHER');
    else data.svg = data.svg.replace('id="pcb-track"', 'id="pcb-track" data-component="R99" data-pad-number="1"').replace('data-net="PCB_SIGNAL" x="20"', 'data-net="CONFLICT" x="20"');
    return reply(route, data);
  } });
  await page.locator('#file').setInputFiles(file('Missing.PcbDoc')); await loaded(page, 'Missing.PcbDoc');
  await page.locator('#component-query').fill('R10');
  await page.locator('#file').setInputFiles(file('Sheet.SchDoc')); await loaded(page, 'Sheet.SchDoc');
  await clickSchematicGraphic(page, symbolBodies(page).first());
  await page.locator('#probe-layout-btn').click();
  assert.equal(await activeName(page), 'Sheet.SchDoc');
  assert.match(await page.locator('#probe-status').textContent(), /No matches.*\nNot found: component R1/);
  await page.getByRole('tab', { name: 'Missing.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#component-query').inputValue(), 'R10', 'an unsuccessful probe leaves prior selection intact');
  conflicting = true;
  await page.locator('#file').setInputFiles(file('Conflict.PcbDoc')); await loaded(page, 'Conflict.PcbDoc');
  await page.getByRole('tab', { name: 'Sheet.SchDoc', exact: true }).click();
  await page.locator('#label-1 text').click({ modifiers: ['Shift'] });
  const target = await page.locator('#probe-layout option').filter({ hasText: 'Conflict.PcbDoc' }).getAttribute('value');
  await page.locator('#probe-layout').selectOption(target);
  await page.locator('#probe-layout-btn').click();
  assert.equal(await activeName(page), 'Conflict.PcbDoc');
  assert.equal(await page.locator('.component-match').count(), 2);
  assert.equal(await page.locator('.net-match').count(), 0);
  assert.match(await page.locator('#probe-result-status').textContent(), /net GND \(ambiguous\)/);
});

test('layout cross-probing matches renamed source symbols and pin-connected nets, fits and returns without losing layout state', async t => {
  const { page, requests } = await openPage(t, { render: (route, name) => reply(route,
    name.endsWith('.SchDoc') ? probingSchematicData(name) : probingLayoutData(name)) });
  await page.locator('#file').setInputFiles(file('Sheet.SchDoc')); await loaded(page, 'Sheet.SchDoc');
  await page.locator('#file').setInputFiles(file('Layout.PcbDoc')); await loaded(page, 'Layout.PcbDoc');
  await page.locator('#measure-btn').click();
  await page.locator('#view').click({ position: { x: 200, y: 200 } });
  await page.locator('#view').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('Escape');
  await page.locator('#pcb-r').click();
  const layoutView = await page.locator('#view > svg').getAttribute('viewBox');
  assert.equal(await page.locator('#probe-schematic option:checked').textContent(), 'Sheet.SchDoc');
  await page.locator('#probe-schematic-btn').click();
  assert.equal(await activeName(page), 'Sheet.SchDoc');
  assert.equal(await schematicStatus(page), 'Components: R1\nNets: GND');
  assert.notEqual(await page.locator('#view > svg').getAttribute('viewBox'), '0 0 100 80');
  assert.match(await page.locator('#probe-result-status').textContent(), /1 component, 1 net highlighted\./);
  assert.doesNotMatch(await page.locator('#probe-result-status').textContent(), /Not found/);
  assert.equal(await page.locator('#probe-back').textContent(), 'Back to layout');
  await page.locator('#probe-back').click();
  assert.equal(await activeName(page), 'Layout.PcbDoc');
  assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), layoutView);
  assert.equal(await page.locator('#component-query').inputValue(), 'R99');
  assert.equal(await page.locator('#net-query').inputValue(), 'PCB_SIGNAL');
  assert.equal(await page.locator('#measure line').count(), 1);
  await page.getByRole('tab', { name: 'Sheet.SchDoc', exact: true }).click();
  assert.equal(await schematicStatus(page), 'Components: R1\nNets: GND');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#probe-result').isVisible(), false);
  assert.equal(requests.length, 2);
});

test('layout probes require selection and an explicit sheet among multiple targets; closed tabs update controls', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route,
    name.endsWith('.SchDoc') ? probingSchematicData(name) : probingLayoutData(name)) });
  await page.locator('#file').setInputFiles(file('Layout.PcbDoc')); await loaded(page, 'Layout.PcbDoc');
  assert.equal(await page.locator('#probe-schematic-btn').isDisabled(), true);
  assert.match(await page.locator('#probe-schematic-status').textContent(), /Open a schematic \(\.SchDoc, \.kicad_sch, or \.sch\)/);
  await page.locator('#file').setInputFiles([file('First.SchDoc'), file('Second.SchDoc')]); await loaded(page, 'Second.SchDoc');
  await page.getByRole('tab', { name: 'Layout.PcbDoc', exact: true }).click();
  await page.locator('#component-query').fill('R99');
  assert.equal(await page.locator('#probe-schematic-btn').isDisabled(), true);
  const target = await page.locator('#probe-schematic option').filter({ hasText: 'Second.SchDoc' }).getAttribute('value');
  await page.locator('#probe-schematic').selectOption(target);
  await page.locator('#probe-schematic-btn').click();
  assert.equal(await activeName(page), 'Second.SchDoc');
  assert.equal(await schematicStatus(page), 'Components: R1');
  await page.getByRole('tab', { name: 'First.SchDoc', exact: true }).click();
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  await page.getByRole('tab', { name: 'Layout.PcbDoc', exact: true }).click();
  await page.getByRole('button', { name: 'Close Second.SchDoc', exact: true }).click();
  assert.equal(await page.locator('#probe-schematic option:checked').textContent(), 'First.SchDoc');
  await page.locator('#component-query').fill('');
  assert.equal(await page.locator('#probe-schematic-btn').isDisabled(), true);
  await page.locator('#component-query').fill('R99');
  await page.locator('#probe-schematic-btn').click();
  await page.getByRole('button', { name: 'Close Layout.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#probe-back').isDisabled(), true);
});

test('layout probes use exact designator and alias fallbacks and report partial component matches', async t => {
  const { page } = await openPage(t, { render: (route, name) => {
    if (name.endsWith('.SchDoc')) {
      const data = probingSchematicData(name); data.selection.nets[0].terminals = []; data.selection.nets[0].aliases = ['earth'];
      return reply(route, data);
    }
    const data = probingLayoutData(name); data.layout_components = [];
    data.svg = data.svg.replaceAll('R99', 'r1').replaceAll('PCB_SIGNAL', 'EARTH').replace('data-net="GND"', 'data-net="GND_EXTRA"');
    return reply(route, data);
  } });
  await page.locator('#file').setInputFiles(file('Sheet.SchDoc')); await loaded(page, 'Sheet.SchDoc');
  await page.locator('#file').setInputFiles(file('Layout.PcbDoc')); await loaded(page, 'Layout.PcbDoc');
  await page.locator('#component-query').fill('r');
  await page.locator('#net-query').fill('EARTH');
  await page.locator('#probe-schematic-btn').click();
  assert.equal(await schematicStatus(page), 'Components: R1\nNets: GND');
  assert.match(await page.locator('#probe-result-status').textContent(), /Not found: component R10/);
});

test('layout probes preserve target selections on missing source IDs or ambiguous connectivity', async t => {
  const { page } = await openPage(t, { render: (route, name) => {
    if (name.endsWith('.SchDoc')) return reply(route, probingSchematicData(name));
    const data = probingLayoutData(name);
    if (name === 'Wrong.PcbDoc') {
      data.layout_components[0] = { name: 'R1', source_name: 'R1', source_id: 'other-sheet-component' };
      data.svg = data.svg.replaceAll('R99', 'R1');
    } else data.svg = data.svg.replace('id="pcb-track"', 'id="pcb-track" data-component="R99" data-pad-number="1"').replace('data-net="PCB_SIGNAL" x="20"', 'data-net="CONFLICT" x="20"');
    return reply(route, data);
  } });
  await page.locator('#file').setInputFiles(file('Sheet.SchDoc')); await loaded(page, 'Sheet.SchDoc');
  await clickSchematicGraphic(page, symbolBodies(page).nth(1));
  const previous = await schematicStatus(page), viewBox = await page.locator('#view > svg').getAttribute('viewBox');
  await page.locator('#file').setInputFiles(file('Wrong.PcbDoc')); await loaded(page, 'Wrong.PcbDoc');
  await page.locator('#component-query').fill('R1');
  await page.locator('#net-query').fill('PCB_SIGNAL');
  await page.locator('#probe-schematic-btn').click();
  assert.equal(await activeName(page), 'Wrong.PcbDoc');
  assert.match(await page.locator('#probe-schematic-status').textContent(), /No matches.*\nNot found: component R1, net PCB_SIGNAL/);
  await page.locator('#file').setInputFiles(file('Conflict.PcbDoc')); await loaded(page, 'Conflict.PcbDoc');
  await page.locator('#net-query').fill('PCB_SIGNAL');
  await page.locator('#probe-schematic-btn').click();
  assert.equal(await activeName(page), 'Conflict.PcbDoc');
  assert.match(await page.locator('#probe-schematic-status').textContent(), /net PCB_SIGNAL \(ambiguous\)/);
  await page.getByRole('tab', { name: 'Sheet.SchDoc', exact: true }).click();
  assert.equal(await schematicStatus(page), previous);
  assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), viewBox);
});

test('two-finger wheel scrolling pans PCB and schematic views in screen pixels without zooming', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route,
    name.endsWith('.SchDoc') ? schematicData(name) : boardData(name)) });
  for (const name of ['Board.PcbDoc', 'Sheet.SchDoc']) {
    await page.locator('#file').setInputFiles(file(name)); await loaded(page, name);
    const before = await currentViewBox(page), point = await pointOnScreen(page, 30, 30);
    await page.locator('#view').dispatchEvent('wheel', { deltaX: 25, deltaY: -40, ...point });
    await settleView(page);
    const after = await currentViewBox(page), moved = await pointOnScreen(page, 30, 30);
    near(after.w, before.w, 'scroll preserves zoom width'); near(after.h, before.h, 'scroll preserves zoom height');
    near(moved.clientX - point.clientX, -25, 'horizontal scroll displacement');
    near(moved.clientY - point.clientY, 40, 'vertical scroll displacement');
    await page.locator('#view').dispatchEvent('wheel', { deltaY: 2, deltaMode: 1, ...point });
    await settleView(page);
    const lineScroll = await pointOnScreen(page, 30, 30);
    near(lineScroll.clientY - moved.clientY, -32, 'line deltas are normalized');
    const height = await page.locator('#view').evaluate(el => el.clientHeight);
    await page.locator('#view').dispatchEvent('wheel', { deltaY: 1, deltaMode: 2, ...point });
    await settleView(page);
    near((await pointOnScreen(page, 30, 30)).clientY - lineScroll.clientY, -height, 'page deltas are normalized');
  }
});

test('pinch zoom is cursor-anchored inside letterboxed SVGs even for several events in one frame', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route,
    { ...boardData(name), svg: boardData(name).svg.replace('viewBox="0 0 100 80"', 'viewBox="0 0 20 100"') }) });
  await page.locator('#file').setInputFiles(file('Tall.PcbDoc')); await loaded(page, 'Tall.PcbDoc');
  const screen = await pointOnScreen(page, 3, 30), before = await currentViewBox(page);
  // WheelEvent mouse coordinates are integer CSS pixels in Chromium.
  const point = { clientX: Math.round(screen.clientX), clientY: Math.round(screen.clientY) };
  const expected = await pointInView(page, point);
  await page.locator('#view').evaluate((el, point) => {
    for (let i = 0; i < 3; i++) el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -20, ...point }));
  }, point);
  await settleView(page);
  const after = await currentViewBox(page), anchor = await pointInView(page, point);
  assert.ok(after.w < before.w && after.h < before.h);
  near(anchor.x, expected.x, 'pinch keeps cursor X fixed'); near(anchor.y, expected.y, 'pinch keeps cursor Y fixed');
  await page.locator('#view').evaluate((el, point) => {
    for (let i = 0; i < 3; i++) el.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: 20, ...point }));
  }, point);
  await settleView(page);
  const restored = await currentViewBox(page);
  for (const key of ['x', 'y', 'w', 'h']) near(restored[key], before[key], 'opposite pinch restores ' + key);
  await page.locator('#view').evaluate((el, point) => {
    for (let i = 0; i < 30; i++) el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -10000, ...point }));
  }, point);
  await settleView(page);
  const minimum = await currentViewBox(page);
  near(Math.max(minimum.w, minimum.h), 0.01, 'zoom-in limit');
  await page.locator('#view').evaluate((el, point) => {
    for (let i = 0; i < 30; i++) el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: 10000, ...point }));
  }, point);
  await settleView(page);
  const maximum = await currentViewBox(page);
  near(Math.max(maximum.w, maximum.h), 10000, 'zoom-out limit');
  assert.ok(Object.values(maximum).every(Number.isFinite));
});

test('drag panning follows screen distance through letterboxing and supports the middle button in measurement mode', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route,
    { ...boardData(name), svg: boardData(name).svg.replace('viewBox="0 0 100 80"', 'viewBox="0 0 20 100"') }) });
  await page.locator('#file').setInputFiles(file('Tall.PcbDoc')); await loaded(page, 'Tall.PcbDoc');
  const point = await pointOnScreen(page, 10, 50);
  await page.keyboard.down('Space');
  await page.mouse.move(point.clientX, point.clientY); await page.mouse.down();
  await page.mouse.move(point.clientX + 40, point.clientY + 30); await page.mouse.up(); await page.keyboard.up('Space'); await settleView(page);
  const moved = await pointOnScreen(page, 10, 50);
  near(moved.clientX - point.clientX, 40, 'drag X distance'); near(moved.clientY - point.clientY, 30, 'drag Y distance');
  await page.locator('#measure-btn').click();
  await page.mouse.move(moved.clientX, moved.clientY); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(moved.clientX - 20, moved.clientY + 15); await page.mouse.up({ button: 'middle' }); await settleView(page);
  const middle = await pointOnScreen(page, 10, 50);
  near(middle.clientX - moved.clientX, -20, 'middle drag X'); near(middle.clientY - moved.clientY, 15, 'middle drag Y');
  assert.equal(await page.locator('#measure line').count(), 0, 'middle panning does not create measurements');
});

test('pan/zoom redraws are batched and reposition completed measurement labels without recreating their geometry', async t => {
  const { page } = await openPage(t);
  await page.locator('#file').setInputFiles(file('Board.PcbDoc')); await loaded(page, 'Board.PcbDoc');
  await page.locator('#measure-btn').click();
  await page.locator('#view').click({ position: { x: 200, y: 200 } });
  await page.locator('#view').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('Escape');
  const readout = await page.locator('#readout').textContent();
  const result = await page.locator('#view').evaluate(el => new Promise(resolve => {
    const svg = el.querySelector('svg'), line = el.querySelector('#measure line'), label = el.querySelector('.measure-label');
    const center = () => new DOMPoint((+line.getAttribute('x1') + +line.getAttribute('x2')) / 2,
      (+line.getAttribute('y1') + +line.getAttribute('y2')) / 2).matrixTransform(svg.getScreenCTM());
    const before = { center: center(), x: parseFloat(label.style.left), y: parseFloat(label.style.top) };
    let updates = 0;
    const observer = new MutationObserver(records => { updates += records.length; });
    observer.observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
    for (let i = 0; i < 20; i++) el.dispatchEvent(new WheelEvent('wheel', { deltaX: 1, deltaY: 2, bubbles: true, cancelable: true }));
    requestAnimationFrame(() => setTimeout(() => {
      observer.disconnect();
      const midpoint = new DOMPoint((+line.getAttribute('x1') + +line.getAttribute('x2')) / 2,
        (+line.getAttribute('y1') + +line.getAttribute('y2')) / 2).matrixTransform(svg.getScreenCTM());
      const r = el.getBoundingClientRect();
      resolve({ updates, sameLine: line === el.querySelector('#measure line'), sameLabel: label === el.querySelector('.measure-label'),
        x: parseFloat(label.style.left), y: parseFloat(label.style.top), expectedX: before.x + midpoint.x - before.center.x,
        expectedY: before.y + midpoint.y - before.center.y });
    }, 0));
  }));
  assert.equal(result.updates, 1, 'one viewBox update for a burst of events in a frame');
  assert.equal(result.sameLine, true); assert.equal(result.sameLabel, true);
  near(result.x, result.expectedX, 'label X follows measurement', 0.001); near(result.y, result.expectedY, 'label Y follows measurement', 0.001);
  assert.equal(await page.locator('#readout').textContent(), readout);
});

test('zoom controls and native Safari gesture events work for both document kinds and reset safely', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route,
    name.endsWith('.SchDoc') ? schematicData(name) : boardData(name)) });
  assert.equal(await page.locator('#zoom-in').isDisabled(), true);
  for (const name of ['Board.PcbDoc', 'Sheet.SchDoc']) {
    await page.locator('#file').setInputFiles(file(name)); await loaded(page, name);
    const home = await currentViewBox(page);
    await page.locator('#zoom-in').click(); await settleView(page);
    assert.ok((await currentViewBox(page)).w < home.w);
    await page.locator('#zoom-out').click(); await settleView(page);
    near((await currentViewBox(page)).w, home.w, 'zoom button pair restores scale');
    const point = await pointOnScreen(page, home.w * 0.3, home.h * 0.4);
    await page.locator('#view').evaluate((el, point) => {
      for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 2]]) {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.assign(event, { scale, ...point }); el.dispatchEvent(event);
      }
      el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -90, ...point }));
      el.dispatchEvent(new Event('gestureend', { cancelable: true }));
    }, point);
    await settleView(page);
    near((await currentViewBox(page)).w, home.w / 2, 'native gesture scale, without a duplicate wheel zoom');
    const anchor = await pointInView(page, point);
    near(anchor.x, home.w * 0.3, 'native gesture cursor X'); near(anchor.y, home.h * 0.4, 'native gesture cursor Y');
    await page.locator('#view-fit').click();
    assert.deepEqual(await currentViewBox(page), home);
  }
  await page.getByRole('button', { name: 'Close Sheet.SchDoc', exact: true }).click();
  await page.getByRole('button', { name: 'Close Board.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#zoom-in').isDisabled(), true);
  assert.equal(await page.locator('#view-fit').isDisabled(), true);
});

test('pending gesture frames do not leak into another tab or a closed document', async t => {
  const { page } = await openPage(t);
  await page.locator('#file').setInputFiles([file('A.PcbDoc'), file('B.PcbDoc')]); await loaded(page, 'B.PcbDoc');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  const origin = await pointOnScreen(page, 30, 30);
  await page.locator('#view').evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaX: 20, deltaY: 40, cancelable: true }));
    [...document.querySelectorAll('[role="tab"]')].find(tab => tab.title === 'B.PcbDoc').click();
  });
  await settleView(page);
  assert.equal(await activeName(page), 'B.PcbDoc');
  assert.deepEqual(await currentViewBox(page), { x: 0, y: 0, w: 100, h: 80 });
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  const moved = await pointOnScreen(page, 30, 30);
  near(moved.clientX - origin.clientX, -20, 'pending horizontal pan was saved');
  near(moved.clientY - origin.clientY, -40, 'pending vertical pan was saved');
  await page.locator('#view').evaluate(el => {
    el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -20, clientX: 600, clientY: 400, cancelable: true }));
    document.querySelector('button[aria-label="Close A.PcbDoc"]').click();
  });
  await settleView(page);
  assert.equal(await activeName(page), 'B.PcbDoc');
  assert.deepEqual(await currentViewBox(page), { x: 0, y: 0, w: 100, h: 80 });
});

test('preserves each board’s layers, zoom, pan, measurements, and units', async t => {
  const { page, requests } = await openPage(t);
  await page.locator('#file').setInputFiles(file('A.PcbDoc'));
  await loaded(page, 'A.PcbDoc');
  await page.locator('#layers input').first().uncheck();
  await page.locator('#view').dispatchEvent('wheel', { ctrlKey: true, deltaY: -250, clientX: 600, clientY: 400 });
  await settleView(page);
  await page.mouse.move(600, 400); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(630, 420); await page.mouse.up({ button: 'middle' });
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

test('loads and uploads a real schematic through the Python server', {
  skip: !process.env.SCH_TEST_FILE, timeout: 60000,
}, async t => {
  const app = spawn(process.env.PCB_TEST_PYTHON || resolve(__dirname, '../.venv/bin/python'),
    ['-B', '-u', resolve(__dirname, '../pcb_viewer_gui.py'), process.env.SCH_TEST_FILE, '--no-open']);
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
  await page.waitForFunction(() => document.querySelector('#scene text'));
  assert.equal(await page.getByRole('tab').count(), 1);
  assert.equal(await page.locator('#scene > g').first().isVisible(), true);
  assert.equal(await page.locator('#measure-btn').isVisible(), false);
  assert.match(await page.locator('#stats').textContent(), /\d+ components, \d+ wires, \d+ net labels/);
  await page.locator('#file').setInputFiles(process.env.SCH_TEST_FILE);
  await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 2 &&
    document.getElementById('busy').style.display === 'none');
  assert.ok(await page.locator('#scene text').count() > 0);
  assert.equal(await page.locator('#toast').isVisible(), false);
  const symbol = await page.locator('[data-sch-components]').evaluateAll(els => {
    const resistor = els.find(el => [...el.querySelectorAll('text')].some(text => text.textContent === 'R1'));
    const body = (resistor || els[0]).querySelector('.sch-component-hit');
    const b = body.getBBox();
    const p = new DOMPoint(b.x + b.width / 2, b.y + b.height * 0.55).matrixTransform(body.getScreenCTM());
    return { x: p.x, y: p.y, resistor: Boolean(resistor) };
  });
  await page.mouse.click(symbol.x, symbol.y);
  assert.match(await schematicStatus(page), /^Components: /);
  if (symbol.resistor) assert.equal(await schematicStatus(page), 'Components: R1');
  const pin = page.locator('[data-sch-nets] .sch-hit').first();
  const netIds = await pin.evaluate(el => JSON.parse(el.closest('[data-sch-nets]').dataset.schNets));
  await clickSchematicGraphic(page, pin, true);
  assert.match(await schematicStatus(page), /Components: .*\nNets: /);
  const expected = await page.locator('[data-sch-nets]:not(.sch-hit)').evaluateAll((els, ids) =>
    els.filter(el => JSON.parse(el.dataset.schNets).some(id => ids.includes(id))).length, netIds);
  assert.equal(await page.locator('.sch-net-match').count(), expected);
  assert.ok(expected > 1, 'clicking actual pin or wire highlights connected graphics');
  if (process.env.SCH_TEST_SCREENSHOT) await page.screenshot({ path: process.env.SCH_TEST_SCREENSHOT });
  if (process.env.PCB_TEST_FILE) {
    const sourceTab = await page.locator('[role="tab"][aria-selected="true"]').getAttribute('id');
    const selection = await schematicStatus(page), viewBox = await page.locator('#view > svg').getAttribute('viewBox');
    await page.locator('#file').setInputFiles(process.env.PCB_TEST_FILE);
    await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 3 &&
      document.getElementById('busy').style.display === 'none');
    await page.locator('#' + sourceTab).click();
    await page.locator('#probe-layout-btn').click();
    assert.match(await page.locator('#filename').textContent(), /\.PcbDoc$/i);
    assert.ok(await page.locator('.component-match').count() > 0);
    assert.ok(await page.locator('.net-match').count() > 0);
    assert.doesNotMatch(await page.locator('#probe-result-status').textContent(), /Not found/);
    if (process.env.PROBE_TEST_SCREENSHOT) await page.screenshot({ path: process.env.PROBE_TEST_SCREENSHOT });
    const layoutView = await page.locator('#view > svg').getAttribute('viewBox');
    const layoutTab = await page.locator('[role="tab"][aria-selected="true"]').getAttribute('id');
    await page.locator('#probe-back').click();
    assert.equal(await schematicStatus(page), selection);
    assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), viewBox);
    await page.locator('#' + layoutTab).click();
    await page.locator('#probe-schematic').selectOption(sourceTab.replace('board-tab-', ''));
    await page.locator('#probe-schematic-btn').click();
    assert.equal(await schematicStatus(page), selection, 'real source IDs and pin connectivity work in both directions');
    assert.doesNotMatch(await page.locator('#probe-result-status').textContent(), /Not found/);
    await page.locator('#probe-back').click();
    assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), layoutView);
    await page.locator('#probe-back').click();
    assert.equal(await schematicStatus(page), selection);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sch-component-match, .sch-net-match').count(), 0);
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
  const pourShape = await pour.getAttribute('d');
  assert.equal(await pour.evaluate(el => el.classList.contains('polygon-copper')), true);
  assert.ok(await page.locator('#net-highlight .polygon-copper').count() > 0);
  await page.locator('#polygons-toggle').click();
  assert.equal(await pour.isVisible(), false);
  assert.equal(await page.locator('#net-highlight .polygon-copper').count(), 0);
  assert.ok(await page.locator('#scene [data-primitive="pad"]:visible').count() > 0);
  if (process.env.POLYGONS_TEST_SCREENSHOT) await page.screenshot({ path: process.env.POLYGONS_TEST_SCREENSHOT });
  await page.locator('#polygons-toggle').click();
  assert.equal(await pour.isVisible(), true);
  assert.equal(await pour.getAttribute('d'), pourShape);
  await page.locator('#net-fit').click();
  await page.locator('#net-clear').click();
  await pour.click();
  assert.equal(await page.locator('#net-query').inputValue(), netName, 'clicking real polygon copper selects its net');
  await pour.click();
  assert.equal(await page.locator('#net-query').inputValue(), '', 'clicking real polygon copper again deselects its net');
  await pour.click();
  assert.equal(await page.locator('#net-query').inputValue(), netName, 'clicking real polygon copper again reselects its net');
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
  assert.equal(await page.locator('.net-match').first().evaluate(el => getComputedStyle(el).fill), 'rgb(255, 0, 0)', 'original renderer paint is unchanged');
  assert.equal(await page.locator('#scene > g').last().getAttribute('id'), 'net-highlight');
  assert.equal(await page.locator('#net-highlight [id], #net-highlight [data-net]').count(), 0);
  assert.deepEqual(await pixelOnGraphic(page, page.locator('.net-match').first()), [104, 224, 255],
    'highlight is visible above the overlapping blue layer');
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
  await page.locator('#view').dispatchEvent('wheel', { ctrlKey: true, deltaY: -200, clientX: 600, clientY: 400 });
  await settleView(page);
  assert.notEqual(await page.locator('.measure-label').first().getAttribute('style'), before);
  await page.keyboard.press('Shift+C');
  assert.equal(await page.locator('#measure line').count(), 0);
  assert.equal(await page.locator('.measure-label').count(), 0);
  assert.equal(await page.locator('#readout').textContent(), '');
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
  await page.locator('[data-primitive="pad"]').click({ position: { x: 3, y: 3 } });
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
  assert.equal(await page.locator('.component-match').first().evaluate(el => getComputedStyle(el).fill), 'rgb(255, 0, 0)', 'original renderer paint is unchanged');
  assert.equal(await page.locator('#scene > g').last().getAttribute('id'), 'component-highlight');
  assert.equal(await page.locator('#component-highlight [id], #component-highlight [data-component]').count(), 0);
  assert.deepEqual(await pixelOnGraphic(page, page.locator('.component-match').first()), [255, 224, 102],
    'highlight is visible above the overlapping blue layer');
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

const preciseLayoutData = name => ({ ...boardData(name), svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
  <defs><clipPath id="precise-clip"><rect width="96" height="76"/></clipPath></defs>
  <g id="scene" transform="translate(2 1)">
    <g id="layer-top" data-layer-name="Top copper" clip-path="url(#precise-clip)">
      <circle id="precise-pad" data-primitive="pad" data-component="R1" data-net="GND" cx="15" cy="15" r="3" fill="red"/>
      <circle id="precise-via" data-primitive="via" data-net="GND" cx="35" cy="15" r="1.2" fill="red"/>
      <path id="precise-track" data-net="GND" d="M15 15 H35" stroke="red" stroke-width="0.6" fill="none" stroke-linecap="round"/>
      <g data-net="GND" stroke="red" fill="none" stroke-width="0.4"><path id="precise-outline" d="M55 10 H65 V20 H55 Z"/></g>
      <path id="precise-pour" data-net="GND" d="M10 35 H50 V65 H10 Z M20 45 H30 V55 H20 Z" fill="blue" stroke="none" fill-rule="evenodd"/>
      <rect id="precise-other" data-net="VCC" x="70" y="50" width="10" height="10" fill="green"/>
    </g>
    <g id="layer-topoverlay" data-layer-name="Top overlay"><path data-component="R1" d="M10 10 H20 V20 H10 Z" stroke="yellow" stroke-width="0.2" fill="none"/></g>
    <g id="layer-drills" data-layer-role="drill" data-layer-name="Drills">
      <circle id="precise-pad-hole" data-primitive="pad-hole" data-hole-owner="pad" data-component="R1" data-net="GND" cx="15" cy="15" r="1" fill="white"/>
      <circle id="precise-via-hole" data-primitive="via-hole" data-hole-owner="via" data-net="GND" cx="35" cy="15" r="0.4" fill="white"/>
    </g>
  </g></svg>` });
const layoutPaint = (page, selector) => page.locator(selector).evaluate(el => {
  const style = getComputedStyle(el), b = el.getBBox();
  return { fill: style.fill, stroke: style.stroke, width: style.strokeWidth, filter: style.filter,
    bbox: [b.x, b.y, b.width, b.height], rule: style.fillRule };
});

test('layout highlights preserve pad/via sizes, drill holes, unfilled geometry and stroke widths while fading the board', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, preciseLayoutData(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  const pad = await layoutPaint(page, '#precise-pad'), via = await layoutPaint(page, '#precise-via');
  const track = await layoutPaint(page, '#precise-track'), outline = await layoutPaint(page, '#precise-outline');
  const original = await page.locator('#scene').evaluate(el => [...el.querySelectorAll('[id]')].map(node =>
    [...node.attributes].filter(attr => attr.name !== 'class').map(attr => [attr.name, attr.value])));
  await page.locator('#net-query').fill('GND');
  for (const [selector, paint] of [['#net-highlight circle[r="3"]', pad], ['#net-highlight circle[r="1.2"]', via]]) {
    const selected = await layoutPaint(page, selector);
    assert.deepEqual(selected.bbox, paint.bbox);
    assert.equal(selected.stroke, 'none', 'highlighting a filled pad/via must not add an outline');
    assert.equal(selected.filter, 'none', 'highlights must not add glow beyond the original geometry');
  }
  for (const [selector, paint] of [['#net-highlight path[d="M15 15 H35"]', track], ['#net-highlight path[d="M55 10 H65 V20 H55 Z"]', outline]]) {
    const selected = await layoutPaint(page, selector);
    assert.equal(selected.width, paint.width);
    assert.equal(selected.fill, 'none', 'unfilled shapes must stay unfilled');
    assert.deepEqual(selected.bbox, paint.bbox);
  }
  for (const radius of ['1', '0.4']) {
    const hole = await layoutPaint(page, `#net-highlight circle[r="${radius}"]`);
    assert.equal(hole.fill, 'rgb(255, 255, 255)');
    assert.equal(hole.stroke, 'none');
  }
  assert.equal(await page.locator('#net-highlight [fill-rule="evenodd"]').getAttribute('d'), await page.locator('#precise-pour').getAttribute('d'));
  assert.equal(await page.locator('#layer-top').evaluate(el => getComputedStyle(el).filter), 'opacity(0.15)');
  assert.equal(await page.locator('#net-highlight').evaluate(el => getComputedStyle(el).filter), 'none');
  assert.equal(await page.locator('#measure').evaluate(el => getComputedStyle(el).filter), 'none');
  await page.locator('#component-query').fill('R1');
  assert.equal((await layoutPaint(page, '#component-highlight circle[r="3"]')).stroke, 'none');
  assert.equal((await layoutPaint(page, '#component-highlight circle[r="1"]')).fill, 'rgb(255, 255, 255)');
  assert.equal((await layoutPaint(page, '#component-highlight path')).fill, 'none');
  await page.locator('#net-clear').click();
  assert.equal(await page.locator('#layer-top').evaluate(el => getComputedStyle(el).filter), 'opacity(0.15)', 'component selection keeps dimming active');
  await page.locator('#component-clear').click();
  assert.equal(await page.locator('#layer-top').evaluate(el => getComputedStyle(el).filter), 'none');
  assert.deepEqual(await page.locator('#scene').evaluate(el => [...el.querySelectorAll('[id]')].map(node =>
    [...node.attributes].filter(attr => attr.name !== 'class').map(attr => [attr.name, attr.value]))), original);
});

test('layout dimming follows visible matches, clears with Escape, and stays with its own PCB tab', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, preciseLayoutData(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  await page.locator('#net-query').fill('missing');
  assert.equal(await page.locator('#layer-top').evaluate(el => getComputedStyle(el).filter), 'none');
  await page.locator('#net-query').fill('GND');
  await page.getByRole('button', { name: 'Hide all', exact: true }).click();
  assert.equal(await page.locator('#view > svg').evaluate(el => el.classList.contains('layout-selection')), false);
  await page.getByRole('button', { name: 'Show all', exact: true }).click();
  assert.equal(await page.locator('#layer-top').evaluate(el => getComputedStyle(el).filter), 'opacity(0.15)');
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  assert.equal(await page.locator('#layer-top').evaluate(el => getComputedStyle(el).filter), 'none');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#layer-top').evaluate(el => getComputedStyle(el).filter), 'opacity(0.15)');
  await page.locator('#precise-other').click();
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC', 'dimmed items remain clickable');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#component-highlight, #net-highlight').count(), 0);
  assert.equal(await page.locator('#layer-top').evaluate(el => getComputedStyle(el).filter), 'none');
});

const polygonBoardData = name => ({ ...boardData(name), polygon_elements: ['pour', 'hatch-track', 'hatch-arc', 'hatch-fill'],
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <g id="scene"><g id="layer-top" data-layer-name="Top copper">
      <path id="route" data-primitive="track" data-net="SIGNAL" d="M10 30 H40" stroke="red" stroke-width="3"/>
      <rect id="pad" data-primitive="pad" data-component="U1" data-net="SIGNAL" x="10" y="10" width="8" height="8" fill="red"/>
      <path id="custom-pad" data-primitive="shapebased-region" data-component="U1" data-net="SIGNAL" d="M65 10 H75 V20 H65 Z" fill="red"/>
      <path id="ordinary-region" data-primitive="region" data-net="SIGNAL" d="M65 25 H75 V35 H65 Z" fill="red"/>
      <rect id="ordinary-fill" data-primitive="fill" x="65" y="40" width="10" height="8" fill="red"/>
      <path id="pour" data-primitive="shapebased-region" data-net="GND" d="M5 5 H55 V50 H5 Z M20 10 H30 V20 H20 Z" fill="blue" fill-rule="evenodd"/>
      <line id="hatch-track" data-primitive="track" data-net="GND" x1="5" y1="55" x2="55" y2="55" stroke="blue"/>
      <path id="hatch-arc" data-primitive="arc" data-net="GND" d="M5 60 Q30 70 55 60" stroke="blue" fill="none"/>
      <rect id="hatch-fill" data-primitive="fill" data-net="GND" x="5" y="70" width="50" height="2" fill="blue"/>
      <path data-primitive="polygon-outline" d="M5 5 H55 V50 H5 Z" stroke="blue" fill="none"/>
      <path data-primitive="polygon-cutout" d="M20 10 H30 V20 H20 Z" stroke="blue" fill="none"/>
    </g></g></svg>` });

test('polygon visibility hides only linked solid/hatched pours and their highlights while preserving ordinary copper and layer choices', async t => {
  const { page, requests } = await openPage(t, { render: (route, name) => reply(route, polygonBoardData(name)) });
  assert.equal(await page.locator('#polygons-toggle').isDisabled(), true);
  await page.locator('#file').setInputFiles(file('Layout.PcbDoc')); await loaded(page, 'Layout.PcbDoc');
  await page.locator('#net-query').fill('GND');
  const viewBox = await page.locator('#view > svg').getAttribute('viewBox'), shape = await page.locator('#pour').getAttribute('d');
  assert.equal(await page.locator('#net-highlight .polygon-copper').count(), 4);
  await page.locator('#polygons-toggle').click();
  assert.equal(await page.locator('#polygons-toggle').textContent(), 'Show polygons');
  assert.equal(await page.locator('#polygons-toggle').getAttribute('aria-pressed'), 'true');
  for (const id of ['pour', 'hatch-track', 'hatch-arc', 'hatch-fill']) assert.equal(await page.locator('#' + id).isVisible(), false);
  assert.equal(await page.locator('[data-primitive="polygon-outline"]').isVisible(), false);
  assert.equal(await page.locator('[data-primitive="polygon-cutout"]').isVisible(), false);
  for (const id of ['route', 'pad', 'custom-pad', 'ordinary-region', 'ordinary-fill']) {
    assert.equal(await page.locator('#' + id).evaluate(el => getComputedStyle(el).display !== 'none' &&
      Boolean(el.getBoundingClientRect().width || el.getBoundingClientRect().height)), true);
  }
  assert.equal(await page.locator('#net-highlight').count(), 0);
  assert.equal(await page.locator('#net-fit').isDisabled(), true);
  assert.equal(await page.locator('#view > svg').evaluate(el => el.classList.contains('layout-selection')), false);
  assert.match(await page.locator('#net-status').textContent(), /1 net matched; polygons hidden/);
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  await page.locator('#none').click(); await page.locator('#all').click();
  assert.equal(await page.locator('#pour').isVisible(), false, 'Show all layers respects the polygon visibility choice');
  assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), viewBox);
  await page.locator('#polygons-toggle').click();
  assert.equal(await page.locator('#pour').isVisible(), true);
  assert.equal(await page.locator('#pour').getAttribute('d'), shape);
  assert.equal(await page.locator('#net-highlight .polygon-copper').count(), 4);
  assert.equal(await page.locator('#polygons-toggle').getAttribute('aria-pressed'), 'false');
  await page.getByRole('checkbox', { name: 'Top copper', exact: true }).uncheck();
  await page.locator('#polygons-toggle').click(); await page.locator('#polygons-toggle').click();
  assert.equal(await page.getByRole('checkbox', { name: 'Top copper', exact: true }).isChecked(), false);
  assert.equal(await page.locator('#pour').isVisible(), false, 'showing polygons does not enable a hidden layer');
  assert.equal(requests.length, 1, 'visibility toggles use the rendered SVG without re-uploading');
});

test('hidden polygons expose routes for selection and retain measurements and visibility independently per tab', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route,
    name.endsWith('.SchDoc') ? schematicData(name) : polygonBoardData(name)) });
  await page.locator('#file').setInputFiles(file('First.PcbDoc')); await loaded(page, 'First.PcbDoc');
  await page.locator('#measure-btn').click();
  await page.locator('#view').click({ position: { x: 200, y: 200 } });
  await page.locator('#view').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('Escape');
  const readout = await page.locator('#readout').textContent();
  await page.locator('#polygons-toggle').click();
  await clickSchematicGraphic(page, page.locator('#route'));
  assert.equal(await page.locator('#net-query').inputValue(), 'SIGNAL');
  assert.equal(await page.locator('#net-highlight .polygon-copper').count(), 0);
  assert.equal(await page.locator('#measure line').count(), 1);
  assert.equal(await page.locator('#readout').textContent(), readout);
  await page.locator('#file').setInputFiles(file('Second.PcbDoc')); await loaded(page, 'Second.PcbDoc');
  assert.equal(await page.locator('#polygons-toggle').textContent(), 'Hide polygons');
  assert.equal(await page.locator('#pour').isVisible(), true);
  await page.locator('#file').setInputFiles(file('Sheet.SchDoc')); await loaded(page, 'Sheet.SchDoc');
  assert.equal(await page.locator('#polygons-toggle').isVisible(), false);
  await page.getByRole('tab', { name: 'First.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#polygons-toggle').textContent(), 'Show polygons');
  assert.equal(await page.locator('#pour').isVisible(), false);
  assert.equal(await page.locator('#net-query').inputValue(), 'SIGNAL');
  assert.equal(await page.locator('#measure line').count(), 1);
  await page.locator('#polygons-toggle').click();
  assert.equal(await page.locator('#pour').isVisible(), true);
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
  assert.equal(await page.locator('#component-query').inputValue(), '', 'clicking a searched component deselects it');
  const track = await page.locator('[data-primitive="track"]').boundingBox();
  await page.mouse.click(track.x + track.width / 2, track.y + track.height / 2);
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  assert.equal(await page.locator('.net-match').count(), 3, 'selects all copper on the clicked net');
  await page.locator('[data-primitive="via"]').click();
  assert.equal(await page.locator('#net-query').inputValue(), '', 'clicking another primitive on the selected net deselects the whole net');
  assert.equal(await page.locator('.net-match, #net-highlight').count(), 0);
  assert.equal(await page.locator('#net-fit').isDisabled(), true);
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
  await page.mouse.move(x, y); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(x + 30, y + 20); await page.mouse.up({ button: 'middle' });
  assert.notEqual(await page.locator('#view > svg').getAttribute('viewBox'), before);
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC', 'finishing a drag over copper does not select it');
  const via = await page.locator('[data-primitive="via"]').boundingBox();
  const vx = via.x + via.width / 2, vy = via.y + via.height / 2;
  await page.mouse.move(vx, vy); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(vx + 30, vy); await page.mouse.move(vx, vy); await page.mouse.up({ button: 'middle' });
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC', 'a drag returning to its start remains a pan');
  await page.locator('[data-primitive="via"]').click();
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  await page.locator('#measure-btn').click();
  await page.locator('[data-primitive="pad"]').click();
  await page.locator('[data-primitive="via"]').click();
  assert.equal(await page.locator('#measure line').count(), 1);
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  await page.locator('#measure-btn').click();
  await page.locator('[data-primitive="pad"]').click({ position: { x: 3, y: 3 } });
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC', 'copper away from the measurement remains selectable');
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
  assert.equal(await page.locator('#component-query').inputValue(), '', 'another pad of the selected component deselects the whole component');
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

test('repeated layout component clicks toggle selection, highlighting and dimming while pan and measurement clicks do not', async t => {
  const { page } = await openClickableComponents(t);
  const body = page.locator('[data-primitive="component-body"]');
  for (let cycle = 0; cycle < 2; cycle++) {
    await body.click();
    assert.equal(await page.locator('#component-query').inputValue(), 'C2');
    assert.equal(await page.locator('.component-match').count(), 1);
    await body.click();
    assert.equal(await page.locator('#component-query').inputValue(), '');
    assert.equal(await page.locator('.component-match, #component-highlight').count(), 0);
    assert.equal(await page.locator('#component-fit').isDisabled(), true);
    assert.equal(await page.locator('#component-status').textContent(), '');
    assert.equal(await page.locator('#view > svg').evaluate(el => el.classList.contains('layout-selection')), false);
  }
  await body.click();
  const b = await body.boundingBox(), x = b.x + b.width / 2, y = b.y + b.height / 2;
  await page.mouse.move(x, y); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(x + 30, y + 10); await page.mouse.move(x, y); await page.mouse.up({ button: 'middle' });
  assert.equal(await page.locator('#component-query').inputValue(), 'C2');
  await page.locator('#measure-btn').click();
  await body.click(); await page.locator('[data-primitive="component-pad"]').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'C2');
  await page.locator('#measure-btn').click();
  await body.click({ position: { x: 3, y: 3 } });
  assert.equal(await page.locator('#component-query').inputValue(), '');
  assert.equal(await page.locator('#measure line').count(), 1);
  await body.click({ position: { x: 3, y: 3 } });
  assert.equal(await page.locator('#component-query').inputValue(), 'C2');
  assert.equal(await page.locator('#measure line').count(), 1);
});

test('deselecting one layout search match preserves the other exact matches across tabs', async t => {
  const { page } = await openPage(t, { render: (route, name) => {
    const data = clickableComponents(name);
    data.svg = data.svg.replace('</g></g></svg>', `<rect id="r10" data-component="R10" data-net="VCC_A" x="65" y="30" width="6" height="6" fill="red"/>
      <rect id="r100" data-component="R100" data-net="VCC_B" x="80" y="30" width="6" height="6" fill="red"/></g></g></svg>`);
    return reply(route, data);
  } });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  await page.locator('#component-query').fill('R');
  await page.locator('#net-query').fill('V');
  await page.locator('[data-primitive="component-pad"]').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'R10, R100');
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC_A, VCC_B');
  assert.equal(await page.locator('.component-match').count(), 2);
  assert.equal(await page.locator('.net-match').count(), 2);
  assert.equal(await page.locator('[data-primitive="component-pad"]').evaluate(el => el.classList.contains('component-match') || el.classList.contains('net-match')), false);
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('.component-match').count(), 2);
  assert.equal(await page.locator('.net-match').count(), 2);
  await page.locator('#r10').click(); await page.locator('#r100').click();
  assert.equal(await page.locator('#component-query').inputValue(), '');
  assert.equal(await page.locator('#net-query').inputValue(), '');
  await page.locator('[data-primitive="component-pad"]').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'R1');
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC');
  await page.locator('[data-primitive="component-pad"]').click();
  assert.equal(await page.locator('#component-query').inputValue(), '');
  assert.equal(await page.locator('#net-query').inputValue(), '', 'a repeated pad click deselects both its component and its net');
  await page.locator('[data-primitive="component-pad"]').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'R1');
  assert.equal(await page.locator('#net-query').inputValue(), 'VCC');
});

test('component selection ignores pans and measurement clicks and remains local to each board', async t => {
  const { page } = await openClickableComponents(t);
  await page.locator('[data-primitive="component-pad"]').click();
  const body = await page.locator('[data-primitive="component-body"]').boundingBox();
  const x = body.x + body.width / 2, y = body.y + body.height / 2;
  await page.mouse.move(x, y); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(x + 30, y + 20); await page.mouse.up({ button: 'middle' });
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

const labelBoardData = name => ({ ...boardData(name), polygon_elements: ['label-pour'],
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 160" data-board="${name}">
    <g id="scene" transform="translate(0 0)">
      <g id="layer-top" data-layer-name="Top copper" data-layer-role="copper">
        <rect id="label-pad" data-primitive="pad" data-component="U1" data-net="GND" x="94" y="73" width="4" height="4" fill="red"/>
        <rect data-net="OCCLUDED" x="101" y="73" width="4" height="3" fill="red"/>
        <rect id="special-label-pad" data-primitive="pad" data-net="N[1]&quot;&lt;&amp;" x="101" y="73" width="4" height="3" fill="orange"/>
        <path id="label-track" data-primitive="track" data-net="SCL" d="M94 81 H101" stroke="red" stroke-width="0.6" fill="none"/>
        <line id="vertical-label-track" data-primitive="track" data-net="VCC" x1="104" y1="80" x2="104" y2="86" stroke="red" stroke-width="0.6"/>
        <g transform="translate(96 85) rotate(30) scale(-1 1)"><rect id="mirrored-label-pad" data-primitive="pad" data-net="MIR" x="-1.5" y="-1" width="3" height="2" fill="orange"/></g>
        <rect id="label-pour" data-primitive="region" data-net="POUR" x="100" y="84" width="2.5" height="2.5" fill="blue"/>
        <rect data-primitive="pad" x="100" y="78" width="2" height="2" fill="red"/>
      </g>
      <g id="layer-bottom" data-layer-name="Bottom copper" data-layer-role="copper">
        <rect id="bottom-label-pad" data-net="BOTTOM" x="106" y="78" width="3" height="3" fill="blue"/>
      </g>
      <g id="layer-topmask" data-layer-token="TOPMASK" data-layer-role="mask" data-layer-name="Top mask">
        <rect data-net="MASK_ONLY" x="98" y="78" width="2" height="2" fill="purple"/>
      </g>
      <g id="layer-drills" data-layer-role="drill" data-layer-name="Drills">
        <circle id="label-pad-hole" data-primitive="pad-hole" data-hole-owner="pad" data-net="GND" cx="96" cy="75" r="0.6" fill="white"/>
        <circle data-primitive="via-hole" data-hole-owner="via" data-net="HOLE_ONLY" cx="99" cy="78" r="0.5" fill="white"/>
      </g>
    </g></svg>` });
const netCaptions = page => page.locator('#net-labels .net-label');
const captionNamed = (page, name) => netCaptions(page).filter({ hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') });
async function zoomForLabels(page, factor = 10, x = 100, y = 80) {
  const point = await pointOnScreen(page, x, y);
  await page.locator('#view').evaluate((el, { point, factor }) => {
    for (let i = 0; i < 3; i++) el.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, ctrlKey: true, deltaY: -Math.log(factor) * 100 / 3, ...point,
    }));
  }, { point, factor });
  await settleView(page);
}

test('zoom reveals readable net names on pads and tracks, keeps names literal and labels transparent to selection', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, labelBoardData(name)) });
  await page.locator('#file').setInputFiles(file('Labels.PcbDoc')); await loaded(page, 'Labels.PcbDoc');
  assert.equal(await netCaptions(page).count(), 0, 'overview stays uncluttered');
  await zoomForLabels(page);
  const names = await netCaptions(page).allTextContents();
  for (const name of ['GND', 'SCL', 'VCC', 'MIR', 'N[1]"<&', 'POUR', 'BOTTOM']) assert.ok(names.includes(name), name);
  for (const name of ['OCCLUDED', 'MASK_ONLY', 'HOLE_ONLY']) assert.ok(!names.includes(name), name);
  assert.equal(await page.locator('#net-labels script, #net-labels svg').count(), 0);
  const vertical = await captionNamed(page, 'VCC').evaluate(el => ({ font: getComputedStyle(el).fontSize, transform: el.style.transform }));
  assert.equal(vertical.font, '12px');
  assert.match(vertical.transform, /rotate\(1\.570/);
  const padCaption = await captionNamed(page, 'GND').boundingBox();
  const hole = await page.locator('#label-pad-hole').boundingBox();
  assert.ok(padCaption.y + padCaption.height < hole.y || padCaption.y > hole.y + hole.height ||
    padCaption.x + padCaption.width < hole.x || padCaption.x > hole.x + hole.width, 'caption avoids drill hole');
  await page.mouse.click(padCaption.x + padCaption.width / 2, padCaption.y + padCaption.height / 2);
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  assert.equal(await page.locator('#component-query').inputValue(), 'U1');
  assert.deepEqual(await netCaptions(page).allTextContents(), ['GND'], 'selection labels only highlighted copper');
  await page.keyboard.press('Escape');
  await page.locator('#view-fit').click();
  assert.equal(await netCaptions(page).count(), 0);
});

test('net labels follow pans and resizing, remain readable while zooming, and leave measurement clicks available', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, labelBoardData(name)) });
  await page.locator('#file').setInputFiles(file('Labels.PcbDoc')); await loaded(page, 'Labels.PcbDoc');
  await zoomForLabels(page);
  const before = await captionNamed(page, 'MIR').boundingBox();
  await page.locator('#view').dispatchEvent('wheel', { deltaX: 20, deltaY: 10 }); await settleView(page);
  const after = await captionNamed(page, 'MIR').boundingBox();
  near(after.x - before.x, -20, 'pan label X', 0.1); near(after.y - before.y, -10, 'pan label Y', 0.1);
  near(after.width, before.width, 'constant screen width', 0.1);
  await page.setViewportSize({ width: 1300, height: 850 }); await settleView(page);
  const aligned = await captionNamed(page, 'MIR').evaluate(el => {
    const label = el.getBoundingClientRect(), pad = document.getElementById('mirrored-label-pad').getBoundingClientRect();
    return { x: label.x + label.width / 2, y: label.y + label.height / 2, px: pad.x + pad.width / 2, py: pad.y + pad.height / 2 };
  });
  near(aligned.x, aligned.px, 'resize alignment X', 0.1); near(aligned.y, aligned.py, 'resize alignment Y', 0.1);
  await page.locator('#measure-btn').click();
  const box = await captionNamed(page, 'MIR').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2 + 30, box.y + box.height / 2);
  assert.equal(await page.locator('#measure line').count(), 1);
  assert.equal(await page.locator('#net-query').inputValue(), '');
  await page.locator('#view').dispatchEvent('wheel', { deltaX: 2000, deltaY: 2000 }); await settleView(page);
  assert.equal(await netCaptions(page).count(), 0, 'offscreen copper has no floating labels');
});

test('net labels respect hidden layers and pours and are restored only for the active zoomed PCB tab', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, name.endsWith('.SchDoc') ? schematicData(name) : labelBoardData(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  await zoomForLabels(page);
  assert.equal(await captionNamed(page, 'BOTTOM').count(), 1);
  await page.locator('#layers label').filter({ hasText: 'Bottom copper' }).locator('input').uncheck();
  assert.equal(await captionNamed(page, 'BOTTOM').count(), 0);
  await page.locator('#polygons-toggle').click();
  assert.equal(await captionNamed(page, 'POUR').count(), 0);
  await page.locator('#none').click(); assert.equal(await netCaptions(page).count(), 0);
  await page.locator('#all').click();
  assert.equal(await captionNamed(page, 'POUR').count(), 0);
  assert.equal(await captionNamed(page, 'MASK_ONLY').count(), 0);
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  assert.equal(await netCaptions(page).count(), 0);
  await page.locator('#file').setInputFiles(file('Sheet.SchDoc')); await loaded(page, 'Sheet.SchDoc');
  assert.equal(await netCaptions(page).count(), 0);
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.ok(await netCaptions(page).count() > 0);
  assert.equal(await captionNamed(page, 'POUR').count(), 0);
  await page.getByRole('button', { name: 'Close A.PcbDoc', exact: true }).click();
  assert.equal(await netCaptions(page).count(), 0);
});

test('net labels avoid collisions and clipped copper and appear only when the name fits', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, { ...labelBoardData(name),
    svg: labelBoardData(name).svg.replace('<g id="scene"', `<defs><clipPath id="label-clip"><rect x="99" y="78" width="2" height="2"/></clipPath></defs><g id="scene"`)
      .replace('</g></svg>', `<g id="layer-mid1" data-layer-role="copper" data-layer-name="Mid copper">
        <rect id="clipped-label-pad" data-net="CLIP" x="98" y="77" width="4" height="4" fill="green" clip-path="url(#label-clip)"/>
        <rect data-net="TOO_LONG_TO_FIT_ON_A_TINY_PAD" x="102" y="78" width="0.2" height="0.2" fill="green"/>
      </g></g></svg>`) }) });
  await page.locator('#file').setInputFiles(file('Clipped.PcbDoc')); await loaded(page, 'Clipped.PcbDoc');
  await zoomForLabels(page);
  assert.equal(await captionNamed(page, 'TOO_LONG_TO_FIT_ON_A_TINY_PAD').count(), 0);
  const boxes = await netCaptions(page).evaluateAll(els => els.map(el => {
    const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, right: b.right, bottom: b.bottom };
  }));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(a.right <= b.x || b.right <= a.x || a.bottom <= b.y || b.bottom <= a.y, 'labels do not overlap');
  }
  const clipLabels = await captionNamed(page, 'CLIP').count();
  assert.equal(clipLabels, 1);
  const caption = await captionNamed(page, 'CLIP').boundingBox();
  const a = await pointOnScreen(page, 99, 78), b = await pointOnScreen(page, 101, 80);
  assert.ok(caption.x >= a.clientX && caption.x + caption.width <= b.clientX);
  assert.ok(caption.y >= a.clientY && caption.y + caption.height <= b.clientY);
});

test('net labels stay upright on mirrored routes and follow the visible segment of a long track', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, { ...boardData(name),
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 160" data-board="${name}">
      <g id="scene"><g id="layer-top" data-layer-role="copper" data-layer-name="Top copper" transform="translate(100 80) rotate(30) scale(-1 1)">
        <path data-net="LONG" data-primitive="track" d="M-1000 0 H1000" stroke="red" stroke-width="0.6" fill="none"/>
      </g></g></svg>` }) });
  await page.locator('#file').setInputFiles(file('Long.PcbDoc')); await loaded(page, 'Long.PcbDoc');
  await zoomForLabels(page);
  assert.equal(await captionNamed(page, 'LONG').count(), 1);
  const angle = await captionNamed(page, 'LONG').evaluate(el => +el.style.transform.match(/rotate\(([-\d.]+)rad\)/)[1]);
  near(angle, Math.PI / 6, 'mirrored route caption stays upright', 0.001);
  await page.locator('#view').dispatchEvent('wheel', { deltaX: 1500, deltaY: 1500 * Math.tan(Math.PI / 6) });
  await settleView(page);
  assert.equal(await captionNamed(page, 'LONG').count(), 1, 'label follows visible copper when the track midpoint is offscreen');
});

const viaLabelBoardData = name => ({ ...boardData(name),
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 160" data-board="${name}">
    <g id="scene">
      <g id="layer-top" data-layer-name="Top copper" data-layer-role="copper">
        <circle id="top-label-via" data-primitive="via" data-net="VIA" cx="100" cy="80" r="1.4" fill="red"/>
        <circle id="small-label-via" data-primitive="via" data-net="SMALL" cx="96" cy="80" r="0.2" fill="red"/>
        <circle data-primitive="via" cx="104" cy="80" r="1.4" fill="red"/>
      </g>
      <g id="layer-bottom" data-layer-name="Bottom copper" data-layer-role="copper" transform="translate(200 0) scale(-1 1)">
        <circle id="bottom-label-via" data-primitive="via" data-net="VIA" cx="100" cy="80" r="1.4" fill="blue"/>
      </g>
      <g id="layer-drills" data-layer-name="Drills" data-layer-role="drill">
        <circle id="label-via-hole" data-primitive="via-hole" data-hole-owner="via" data-net="VIA" cx="100" cy="80" r="0.95" fill="white"/>
        <circle data-primitive="via-hole" data-hole-owner="via" data-net="SMALL" cx="96" cy="80" r="0.14" fill="white"/>
        <circle data-primitive="via-hole" data-hole-owner="via" cx="104" cy="80" r="0.95" fill="white"/>
      </g>
    </g></svg>` });

test('zoomed via labels fit on the annular ring, avoid the drill and allow selection and measurement clicks', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, viaLabelBoardData(name)) });
  await page.locator('#file').setInputFiles(file('Vias.PcbDoc')); await loaded(page, 'Vias.PcbDoc');
  assert.equal(await netCaptions(page).count(), 0);
  await zoomForLabels(page);
  assert.deepEqual(await netCaptions(page).allTextContents(), ['VIA'], 'one label for stacked copper, none on drills or unconnected vias');
  const label = await captionNamed(page, 'VIA').boundingBox();
  const hole = await page.locator('#label-via-hole').boundingBox();
  assert.ok(label.y + label.height < hole.y || label.y > hole.y + hole.height ||
    label.x + label.width < hole.x || label.x > hole.x + hole.width, 'via label stays off the drill');
  await page.mouse.click(label.x + label.width / 2, label.y + label.height / 2);
  assert.equal(await page.locator('#net-query').inputValue(), 'VIA');
  assert.equal(await page.locator('#component-query').inputValue(), '');
  await page.keyboard.press('Escape');
  await page.locator('#measure-btn').click();
  await page.mouse.click(label.x + label.width / 2, label.y + label.height / 2);
  await page.mouse.click(label.x + label.width / 2 + 20, label.y + label.height / 2);
  assert.equal(await page.locator('#measure line').count(), 1);
  assert.equal(await page.locator('#net-query').inputValue(), '');
});

test('via labels respect copper visibility and tab state and wait for enough zoom on small annular rings', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, viaLabelBoardData(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  await zoomForLabels(page);
  const bottom = page.locator('#layers label').filter({ hasText: 'Bottom copper' }).locator('input');
  const top = page.locator('#layers label').filter({ hasText: 'Top copper' }).locator('input');
  await bottom.uncheck(); assert.equal(await captionNamed(page, 'VIA').count(), 1);
  await top.uncheck(); assert.equal(await netCaptions(page).count(), 0, 'drill graphics alone do not create captions');
  await top.check(); assert.equal(await captionNamed(page, 'VIA').count(), 1);
  assert.equal(await captionNamed(page, 'SMALL').count(), 0);
  await zoomForLabels(page, 8, 96, 80);
  assert.deepEqual(await netCaptions(page).allTextContents(), ['SMALL'], 'small via becomes readable at closer zoom');
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  assert.equal(await netCaptions(page).count(), 0);
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.deepEqual(await netCaptions(page).allTextContents(), ['SMALL']);
  await page.locator('#view-fit').click(); assert.equal(await netCaptions(page).count(), 0);
});

const pinBoardData = name => ({ ...boardData(name),
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 160" data-board="${name}">
    <g id="scene">
      <g id="layer-top" data-layer-name="Top copper" data-layer-role="copper">
        <rect id="numbered-pad" data-primitive="pad" data-component="U1" data-pad-number="1" data-net="GND" x="94" y="73" width="4" height="4" fill="red"/>
        <rect id="unconnected-numbered-pad" data-primitive="pad" data-component="U1" data-pad-number="A[1]&quot;&lt;&amp;" x="101" y="73" width="4" height="3" fill="orange"/>
        <rect id="small-numbered-pad" data-primitive="pad" data-component="U2" data-pad-number="3" data-net="VCC" x="99.65" y="78.725" width="0.7" height="0.55" fill="red"/>
        <g transform="translate(96 85) rotate(30) scale(-1 1)"><rect id="mirrored-numbered-pad" data-primitive="pad" data-component="U3" data-pad-designator="0" data-net="MIR" x="-1.5" y="-1" width="3" height="2" fill="orange"/></g>
        <circle id="through-hole-numbered-pad" data-primitive="pad" data-component="J1" data-pad-number="2" data-net="PTH" cx="103" cy="85" r="1.5" fill="red"/>
        <rect data-primitive="pad" data-pad-number="FREE" x="106" y="78" width="2" height="2" fill="red"/>
        <circle data-primitive="via" data-pad-number="VIA_NUMBER" data-net="VIA" cx="97" cy="79" r="0.8" fill="red"/>
      </g>
      <g id="layer-bottom" data-layer-name="Bottom copper" data-layer-role="copper" transform="translate(200 0) scale(-1 1)">
        <rect data-primitive="pad" data-component="J2" data-pad-number="B1" data-net="BOTTOM" x="92" y="78" width="3" height="3" fill="blue"/>
      </g>
      <g id="layer-topmask" data-layer-role="mask" data-layer-token="TOPMASK" data-layer-name="Top mask">
        <rect data-primitive="pad" data-component="U1" data-pad-number="MASK" x="98" y="75" width="2" height="2" fill="purple"/>
      </g>
      <g id="layer-drills" data-layer-role="drill" data-layer-name="Drills">
        <circle id="numbered-pad-hole" data-primitive="pad-hole" data-hole-owner="pad" data-component="J1" data-pad-number="2" data-net="PTH" cx="103" cy="85" r="0.55" fill="white"/>
      </g>
    </g></svg>` });
const pinCaptions = page => page.locator('#net-labels .pin-label');
const pinNamed = (page, number) => pinCaptions(page).filter({ hasText: new RegExp('^' + number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') });

test('component pin numbers share pads with net names and include literal unconnected and alphanumeric pad designators', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, pinBoardData(name)) });
  await page.locator('#file').setInputFiles(file('Pins.PcbDoc')); await loaded(page, 'Pins.PcbDoc');
  assert.equal(await pinCaptions(page).count(), 0);
  await zoomForLabels(page);
  const numbers = await pinCaptions(page).allTextContents();
  for (const number of ['1', 'A[1]"<&', '0', '2', '3', 'B1']) assert.ok(numbers.includes(number), number);
  for (const number of ['FREE', 'VIA_NUMBER', 'MASK']) assert.ok(!numbers.includes(number), number);
  const padCaption = page.locator('.copper-label').filter({ has: page.locator('.pin-label').filter({ hasText: /^1$/ }) });
  assert.deepEqual(await padCaption.locator('span').allTextContents(), ['1', 'GND']);
  assert.equal(await page.locator('#net-labels script, #net-labels svg').count(), 0);
  const pin = await pinNamed(page, '1').boundingBox();
  await page.mouse.click(pin.x + pin.width / 2, pin.y + pin.height / 2);
  assert.equal(await page.locator('#component-query').inputValue(), 'U1');
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  await page.keyboard.press('Escape');
  const unconnected = await pinNamed(page, 'A[1]"<&').boundingBox();
  await page.mouse.click(unconnected.x + unconnected.width / 2, unconnected.y + unconnected.height / 2);
  assert.equal(await page.locator('#component-query').inputValue(), 'U1');
  assert.equal(await page.locator('#net-query').inputValue(), '');
  await page.keyboard.press('Escape');
  await page.locator('#measure-btn').click();
  await page.mouse.click(pin.x + pin.width / 2, pin.y + pin.height / 2);
  await page.mouse.click(pin.x + pin.width / 2 + 20, pin.y + pin.height / 2);
  assert.equal(await page.locator('#measure line').count(), 1);
});

test('small pads prioritize the pin number and reveal both pin and net at closer zoom', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, pinBoardData(name)) });
  await page.locator('#file').setInputFiles(file('Pins.PcbDoc')); await loaded(page, 'Pins.PcbDoc');
  await zoomForLabels(page);
  assert.equal(await pinNamed(page, '3').count(), 1);
  assert.equal(await captionNamed(page, 'VCC').count(), 0, 'two rows do not fit yet');
  await zoomForLabels(page, 2, 100, 79);
  assert.equal(await pinNamed(page, '3').count(), 1);
  assert.equal(await captionNamed(page, 'VCC').count(), 1);
  const pin = await pinNamed(page, '3').boundingBox(), net = await captionNamed(page, 'VCC').boundingBox();
  assert.ok(pin.y + pin.height <= net.y, 'pin and net occupy separate rows');
});

test('pin captions remain upright on mirrored pads, avoid holes and respect layer and tab visibility', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, name.endsWith('.SchDoc') ? schematicData(name) : pinBoardData(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc')); await loaded(page, 'A.PcbDoc');
  await zoomForLabels(page);
  const mirrored = await pinNamed(page, '0').evaluate(el => el.closest('.copper-label').style.transform);
  assert.match(mirrored, /rotate\(0rad\)/);
  const pin = await pinNamed(page, '2').boundingBox(), hole = await page.locator('#numbered-pad-hole').boundingBox();
  assert.ok(pin.y + pin.height < hole.y || pin.y > hole.y + hole.height || pin.x + pin.width < hole.x || pin.x > hole.x + hole.width);
  await page.locator('#layers label').filter({ hasText: 'Bottom copper' }).locator('input').uncheck();
  assert.equal(await pinNamed(page, 'B1').count(), 0);
  await page.locator('#none').click(); assert.equal(await pinCaptions(page).count(), 0);
  await page.locator('#all').click(); assert.equal(await pinNamed(page, 'MASK').count(), 0);
  await page.locator('#file').setInputFiles(file('B.PcbDoc')); await loaded(page, 'B.PcbDoc');
  assert.equal(await pinCaptions(page).count(), 0);
  await page.locator('#file').setInputFiles(file('Sheet.SchDoc')); await loaded(page, 'Sheet.SchDoc');
  assert.equal(await pinCaptions(page).count(), 0);
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  assert.equal(await pinNamed(page, '1').count(), 1);
  const before = await pinNamed(page, '1').boundingBox();
  await page.locator('#view').dispatchEvent('wheel', { deltaX: 25, deltaY: 10 }); await settleView(page);
  const after = await pinNamed(page, '1').boundingBox();
  near(after.x - before.x, -25, 'pin follows pan X', 0.1); near(after.y - before.y, -10, 'pin follows pan Y', 0.1);
  await page.locator('#view-fit').click(); assert.equal(await pinCaptions(page).count(), 0);
});

const wait3D = page => page.waitForFunction(() =>
  !document.getElementById('three-view').hidden && /\d+ bod(y|ies)/.test(document.getElementById('three-summary').textContent));
const image3D = async page => {
  await settleView(page);
  return page.locator('#three-view canvas').screenshot();
};

test('3D board finishes use actual outer copper, mask and silkscreen on both sides independently of selection and hidden layers', async t => {
  const { page } = await openPage(t);
  const result = await page.evaluate(async () => {
    const { boardSurfaces } = await import('/static/board-surface.js');
    const source = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg">
      <defs><pattern id="hatch" patternUnits="userSpaceOnUse" width="2" height="2"><rect width="1" height="2" fill="white"/></pattern></defs><g id="scene">
      <g data-layer-token="TOP" style="display:none;opacity:0.1"><rect x="12" y="12" width="6" height="6" fill="red"/>
        <rect x="20" y="18" width="8" height="4" fill="url(#hatch)"/></g>
      <g data-layer-token="TOPSOLDER"><rect x="13" y="13" width="4" height="4" fill="red"/><rect x="19" y="24" width="2" height="2"/></g>
      <g data-layer-token="TOPOVERLAY" class="component-match"><rect x="24" y="12" width="4" height="3" fill="yellow"/></g>
      <g data-layer-token="BOTTOM"><rect x="24" y="24" width="4" height="4"/></g>
      <g data-layer-token="BOTTOMSOLDER"><rect x="24" y="24" width="4" height="4"/></g>
      <g data-layer-token="MID1"><rect x="10" y="10" width="20" height="20"/></g>
      <g id="measurement"><rect x="10" y="10" width="20" height="20"/></g>
    </g></svg>`, 'image/svg+xml').documentElement;
    const before = source.outerHTML;
    const finishes = await boardSurfaces(source, { surface_origin: [20, 20],
      board: [{ outline: [[-10,-10],[10,-10],[10,10],[-10,10]] }] }, 200);
    const pixel = (canvas, x, y) => [...canvas.getContext('2d').getImageData((x-10)*10, (y-10)*10, 1, 1).data];
    return { unchanged: before === source.outerHTML, topPad: pixel(finishes[0].color, 15, 15),
      bottomPad: pixel(finishes[1].color, 25, 25), silk: pixel(finishes[0].color, 25, 13),
      hiddenCopper: pixel(finishes[0].color, 12.5, 12.5), noCopper: pixel(finishes[0].color, 20, 25),
      otherSide: pixel(finishes[1].color, 15, 15), metal: pixel(finishes[0].physical, 15, 15),
      mask: pixel(finishes[0].physical, 20, 25), hatchCopper: pixel(finishes[0].color, 20.5, 19),
      hatchGap: pixel(finishes[0].color, 21.5, 19) };
  });
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.topPad, [184,170,126,255]);
  assert.deepEqual(result.bottomPad, [184,170,126,255]);
  assert.deepEqual(result.silk, [238,234,222,255]);
  assert.deepEqual(result.hiddenCopper, [16,76,48,255]);
  assert.deepEqual(result.noCopper, [14,69,44,255], 'mask openings with no copper must not become metallic');
  assert.deepEqual(result.otherSide, [14,69,44,255], 'top copper must not leak onto the bottom');
  assert.deepEqual(result.metal, [0,72,235,255]);
  assert.deepEqual(result.mask, [0,145,0,255]);
  assert.deepEqual(result.hatchCopper, [16,76,48,255]);
  assert.deepEqual(result.hatchGap, [14,69,44,255], 'hatched copper paint servers retain their physical gaps');
});

test('3D studio shadows and mapped finishes render through WebGL and release their resources', async t => {
  const { page } = await openPage(t);
  const shaderErrors = [];
  page.on('console', message => { if (message.type() === 'error' && /THREE|shader|WebGL/i.test(message.text())) shaderErrors.push(message.text()); });
  const result = await page.evaluate(async () => {
    const { Board3D } = await import('/static/viewer-3d.js');
    const host = document.createElement('div'); Object.assign(host.style, { width: '400px', height: '300px' });
    document.body.append(host);
    const source = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg"><g id="scene">
      <g data-layer-token="TOP"><rect x="1" y="1" width="4" height="4"/></g>
      <g data-layer-token="TOPSOLDER"><rect x="1" y="1" width="4" height="4"/></g>
    </g></svg>`, 'image/svg+xml').documentElement;
    const model = { board: [{ outline: [[-10,-10],[10,-10],[10,10],[-10,10]], holes: [] }],
      thickness: 1.6, bodies: [], surface_origin: [10,10] };
    const viewer = new Board3D(host, () => {});
    viewer.show(model, null, null, source);
    const deadline = performance.now() + 5000;
    while (!viewer.scene.children.some(child => child.userData.boardSurface) && performance.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 20));
    const surfaces = viewer.scene.children.filter(child => child.userData.boardSurface);
    const maps = surfaces.map(surface => [surface.material.map.image.width, surface.material.roughnessMap === surface.material.metalnessMap]);
    const lit = viewer.studioLights.every(light => light.shadow.map && light.castShadow);
    viewer.clear();
    const texturesAfterClear = viewer.renderer.info.memory.textures;
    viewer.show(model, null, null, source);
    await new Promise(resolve => setTimeout(resolve, 100)); viewer.clear();
    const stableResources = viewer.renderer.info.memory.textures === texturesAfterClear;
    viewer.observer.disconnect(); viewer.environment.dispose(); viewer.renderer.dispose(); host.remove();
    return { surfaces: surfaces.length, maps, lit, stableResources };
  });
  assert.equal(result.surfaces, 2); assert.equal(result.lit, true);
  assert.ok(result.maps.every(([size, shared]) => size === 2048 && shared));
  assert.equal(result.stableResources, true, 'repeated 3D mounts must release surface maps and shadow targets');
  assert.deepEqual(shaderErrors, []);
});

test('embedded STEP bodies load lazily through local WASM, share assets, and retain picking and delete/undo', async t => {
  const source = execFileSync(process.env.PCB_TEST_PYTHON || resolve(__dirname, '../.venv/bin/python'), ['-B', '-c', `
import sys, tempfile
from pathlib import Path
from altium_monkey import AltiumPcbDoc
from altium_monkey.altium_board import AltiumBoardOutline
from altium_monkey.altium_pcb_enums import PcbBodyProjection
p = AltiumPcbDoc()
p.set_board_outline(AltiumBoardOutline.from_points_mils([(0,0),(50/.0254,0),(50/.0254,30/.0254),(0,30/.0254)]))
m = p.add_embedded_model(name='box.step', model_data=Path('tests/fixtures/step/box.step').read_bytes())
for index, (x,y,side) in enumerate([(13,11,PcbBodyProjection.TOP),(37,21,PcbBodyProjection.BOTTOM)]):
 p.add_component(designator=f'U{index+1}', footprint='TEST', position_mils=(x/.0254,y/.0254))
 body = p.add_embedded_3d_model(m, location_mils=(x/.0254,y/.0254),
   bounds_mils=((x-5)/.0254,(y-5)/.0254,(x+5)/.0254,(y+5)/.0254),
   overall_height_mils=3/.0254, side=side)
 body.component_index=index; p.shapebased_component_bodies[-1].component_index=index
with tempfile.TemporaryDirectory() as tmp:
 path=Path(tmp)/'Models.PcbDoc'; p.save(path); sys.stdout.buffer.write(path.read_bytes())
`]);
  const { page } = await openPage(t); await page.unroute('**/render');
  const resources = []; page.on('request', request => resources.push(request.url()));
  await page.locator('#file').setInputFiles({ name: 'Models.PcbDoc', mimeType: 'application/octet-stream', buffer: source });
  await page.waitForFunction(() => document.querySelector('#filename').textContent === 'Models.PcbDoc' && document.querySelector('#busy').style.display === 'none');
  assert.ok(!resources.some(url => url.includes('occt-import-js')), '2D never starts the STEP converter');
  const svgBefore = await page.locator('#scene').evaluate(el => el.outerHTML);
  await page.locator('#mode-3d').click(); await wait3D(page);
  await page.waitForFunction(() => document.querySelector('#step-status').textContent === 'STEP models: 1/1 loaded');
  assert.equal(resources.filter(url => url.endsWith('occt-import-js.wasm')).length, 1);
  assert.equal(await page.locator('#three-body-list option').count(), 2);
  await page.locator('#three-top').click();
  await click3D(page, 0.35, 0.55);
  assert.deepEqual(await selected3DBodies(page), ['body-0']);
  const selected = await image3D(page);
  await page.keyboard.press('Delete');
  assert.equal(await page.locator('#three-body-list option').count(), 1);
  assert.ok(!(await image3D(page)).equals(selected), 'deletion hides the actual STEP mesh');
  await page.locator('#three-undo').click();
  assert.deepEqual(await selected3DBodies(page), ['body-0']);
  await page.locator('#three-clear').click();
  await page.locator('#three-bottom').click();
  await click3D(page, 0.65, 0.58);
  assert.deepEqual(await selected3DBodies(page), ['body-1']);
  await page.locator('#mode-2d').click();
  assert.equal(await page.locator('#scene').evaluate(el => el.outerHTML), svgBefore);
  await page.locator('#mode-3d').click(); await wait3D(page);
  await page.waitForFunction(() => document.querySelector('#step-status').textContent === 'STEP models: 1/1 loaded');
  assert.deepEqual(await selected3DBodies(page), ['body-1']);
  assert.equal(resources.filter(url => url.endsWith('occt-import-js.wasm')).length, 1, 'converted model is reused after remount');
});

test('missing KiCad STEP references can be supplied locally without changing the board or losing body edits', async t => {
  const source = `(kicad_pcb (version 20240108) (generator pcbvisualizer)
    (general (thickness 1.6)) (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
    (gr_rect (start 0 0) (end 50 30) (stroke (width .1) (type default)) (fill none) (layer "Edge.Cuts"))
    (footprint "TEST" (layer "F.Cu") (at 13 19) (property "Reference" "U1")
      (model "models/box.step" (offset (xyz 0 0 0)) (scale (xyz 1 1 1)) (rotate (xyz 0 0 0)))))`;
  const { page } = await openPage(t); await page.unroute('**/render');
  await page.locator('#file').setInputFiles({ name: 'External.kicad_pcb', mimeType: 'application/octet-stream', buffer: Buffer.from(source) });
  await loadedDocument(page, 'External.kicad_pcb');
  const svgBefore = await page.locator('#scene').evaluate(el => el.outerHTML);
  await page.locator('#mode-3d').click(); await wait3D(page);
  await page.waitForFunction(() => document.querySelector('#step-status').textContent.includes('Missing STEP file'));
  const before = await image3D(page);
  await page.locator('#step-files').setInputFiles(resolve(__dirname, 'fixtures/step/box.step'));
  await page.waitForFunction(() => document.querySelector('#step-status').textContent === 'STEP models: 1/1 loaded');
  assert.ok(!(await image3D(page)).equals(before), 'the supplied model adds visible geometry');
  await page.locator('#three-top').click(); await click3D(page, 0.35, 0.55);
  assert.deepEqual(await selected3DBodies(page), ['kc-body-0-0']);
  await page.keyboard.press('Delete');
  await page.locator('#step-files').setInputFiles(resolve(__dirname, 'fixtures/step/box.step'));
  await page.waitForFunction(() => document.querySelector('#step-status').textContent === 'STEP models: 1/1 loaded');
  assert.equal(await page.locator('#three-body-list option').count(), 0, 'reloading STEP data preserves deletions');
  await page.locator('#three-undo').click(); assert.equal(await page.locator('#three-body-list option').count(), 1);
  await page.locator('#mode-2d').click();
  assert.equal(await page.locator('#scene').evaluate(el => el.outerHTML), svgBefore);
});

test('failed STEP conversion retains extruded bodies and leaving 3D cancels pending conversion', async t => {
  const data = threeBoardData('Fallback.PcbDoc');
  data.scene3d.bodies[0] = { ...data.scene3d.bodies[0], model: 'invalid', id: 'body-0',
    matrix: [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1] };
  data.scene3d.step_models = { invalid: { name: 'invalid.step', data: Buffer.from('not STEP').toString('base64') } };
  const { page } = await openPage(t, { initial: data });
  await loaded(page, 'Fallback.PcbDoc');
  await page.locator('#mode-3d').click(); await wait3D(page);
  await page.waitForFunction(() => document.querySelector('#step-status').textContent.includes('1 unavailable'));
  await page.locator('#three-top').click(); await click3D(page, 0.35, 0.56);
  assert.deepEqual(await selected3DBodies(page), ['body-0'], 'failed model retains selectable extrusion');
  await page.locator('#mode-2d').click();
  let pending;
  const requested = new Promise(resolve => { pending = resolve; });
  await page.route('**/occt-import-js.wasm', route => { pending(); return new Promise(() => {}); });
  await page.locator('#mode-3d').click(); await requested;
  await page.locator('#mode-2d').click();
  assert.equal(await page.locator('#three-view').isHidden(), true);
  assert.equal(await page.locator('#view > svg').isVisible(), true);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('3D renders local solids, preserves 2D measurements and layers, and remembers cameras across tabs', async t => {
  const { page, requests } = await openPage(t, { render: (route, name) => reply(route,
    name.endsWith('.SchDoc') ? schematicData(name) : threeBoardData(name)) });
  const assets = [];
  page.on('request', request => assets.push(request.url()));
  await page.locator('#file').setInputFiles(file('A.PcbDoc'));
  await loaded(page, 'A.PcbDoc');
  assert.ok(!assets.some(url => url.includes('three.module')), '3D assets load only on demand');
  await page.locator('#zoom-in').click();
  await settleView(page);
  const before = await currentViewBox(page);
  await page.locator('#measure-btn').click();
  await page.locator('#view > svg').click({ position: { x: 300, y: 300 } });
  await page.locator('#view > svg').click({ position: { x: 350, y: 330 } });
  assert.equal(await page.locator('#measure line').count(), 1);
  await page.locator('#none').click();
  await page.locator('#mode-3d').click();
  await wait3D(page);
  assert.equal(await page.locator('#mode-3d').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#view > svg').isVisible(), false);
  assert.equal(await page.locator('#layers-wrap').isVisible(), false);
  assert.match(await page.locator('#three-status').textContent(), /Simplified/);
  const iso = await image3D(page);
  await page.locator('#three-top').click();
  const top = await image3D(page);
  assert.notDeepEqual(iso, top, 'preset changes actual rendered pixels');
  await page.locator('#three-bottom').click();
  const bottom = await image3D(page);
  assert.notDeepEqual(top, bottom, 'both sides render differently');
  await page.locator('#three-iso').click();
  const canvas = page.locator('#three-view canvas');
  const rect = await canvas.boundingBox();
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 100, rect.y + rect.height / 2 + 40, { steps: 5 });
  await page.mouse.up();
  const rotated = await image3D(page);
  assert.notDeepEqual(iso, rotated, 'drag rotates the solids');
  await page.locator('#zoom-in').click();
  const zoomed = await image3D(page);
  assert.notDeepEqual(rotated, zoomed, 'zoom button affects 3D');
  assert.deepEqual(await currentViewBox(page), before, '3D interaction leaves the SVG camera unchanged');
  await page.locator('#file').setInputFiles([file('B.PcbDoc'), file('sheet.SchDoc')]);
  await loaded(page, 'sheet.SchDoc');
  assert.equal(await page.locator('#view-mode').isVisible(), false);
  assert.equal(await page.locator('#three-view').isVisible(), false);
  await page.getByRole('tab', { name: 'B.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#mode-2d').getAttribute('aria-pressed'), 'true');
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  await wait3D(page);
  assert.deepEqual(await image3D(page), zoomed, 'restores the saved 3D camera');
  await page.locator('#mode-2d').click();
  assert.deepEqual(await currentViewBox(page), before);
  assert.equal(await page.locator('#measure line').count(), 1);
  assert.equal(await page.locator('#scene #layer-top').evaluate(el => el.style.display), 'none');
  await page.locator('#mode-3d').click();
  await wait3D(page);
  assert.deepEqual(await image3D(page), zoomed, 'mode toggling also restores the camera');
  await page.getByRole('button', { name: 'Close A.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#three-view').isVisible(), false);
  assert.equal(requests.length, 3, 'camera and tab changes never re-upload files');
  assert.ok(assets.every(url => new URL(url).origin === new URL(origin).origin), 'all assets stay local');
});

test('3D requires an outline and an unavailable WebGL context returns safely to 2D', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route,
    name === 'missing.PcbDoc' ? { ...boardData(name), scene3d: { board: [], notes: ['No board outline.'] } } : threeBoardData(name)) });
  await page.locator('#file').setInputFiles(file('missing.PcbDoc'));
  await loaded(page, 'missing.PcbDoc');
  assert.equal(await page.locator('#mode-3d').isDisabled(), true);
  assert.match(await page.locator('#three-status').textContent(), /No board outline/);
  await page.locator('#file').setInputFiles(file('A.PcbDoc'));
  await loaded(page, 'A.PcbDoc');
  await page.evaluate(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type.startsWith('webgl') ? null : getContext.call(this, type, ...args);
    };
  });
  await page.locator('#mode-3d').click();
  await page.waitForFunction(() => document.getElementById('three-status').textContent.includes('WebGL'));
  assert.equal(await page.locator('#mode-2d').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#view > svg').isVisible(), true);
  assert.equal(await page.locator('#three-view').isVisible(), false);
});

test('a delayed 3D import cannot mount onto another tab', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, threeBoardData(name)) });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  await page.route('**/viewer-3d.js', async route => { await blocked; await route.continue(); });
  await page.locator('#file').setInputFiles([file('A.PcbDoc'), file('B.PcbDoc')]);
  await loaded(page, 'B.PcbDoc');
  const requested = page.waitForRequest('**/viewer-3d.js');
  await page.locator('#mode-3d').click();
  await requested;
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click();
  release();
  await page.waitForResponse('**/viewer-3d.js');
  await settleView(page);
  assert.equal(await page.locator('#three-view').isVisible(), false);
  assert.equal(await activeName(page), 'A.PcbDoc');
  await page.getByRole('tab', { name: 'B.PcbDoc', exact: true }).click();
  await wait3D(page);
  assert.equal(await activeName(page), 'B.PcbDoc');
});

test('uploads a generated PcbDoc and displays its parsed board and bodies in WebGL', async t => {
  const data = execFileSync(process.env.PCB_TEST_PYTHON || resolve(__dirname, '../.venv/bin/python'), ['-c', `
import sys, tempfile
from pathlib import Path
from altium_monkey import AltiumPcbDoc
from altium_monkey.altium_board import AltiumBoardOutline
from altium_monkey.altium_pcb_enums import PcbBodyProjection
p = AltiumPcbDoc()
p.set_board_outline(AltiumBoardOutline.from_points_mils([(0,0),(2000,0),(2000,1200),(1600,1200),(1600,1600),(0,1600)]))
p.add_region(outline_points_mils=[(800,600),(1100,600),(1100,900),(800,900)], is_board_cutout=True)
for x, y in [(100,100),(1900,100),(100,1500)]:
 p.add_pad(designator='1', position_mils=(x,y), width_mils=130, height_mils=130, hole_size_mils=90)
p.add_pad(designator='2', position_mils=(1200,1300), width_mils=150, height_mils=150, hole_size_mils=80, slot_length_mils=280, slot_rotation_degrees=35)
p.add_extruded_3d_body(outline_points_mils=[(200,300),(600,300),(600,700),(200,700)], overall_height_mils=200, body_color_3d=0x444444)
p.add_extruded_3d_body(outline_points_mils=[(1200,200),(1700,200),(1700,400),(1200,400)], overall_height_mils=250, body_color_3d=0xBBBBBB)
p.add_extruded_3d_body(outline_points_mils=[(200,1000),(500,1000),(500,1300),(200,1300)], overall_height_mils=100, side=PcbBodyProjection.BOTTOM, body_color_3d=0x4477DD)
with tempfile.TemporaryDirectory() as tmp:
 path = Path(tmp) / 'generated.PcbDoc'
 p.save(path)
 sys.stdout.buffer.write(path.read_bytes())
`]);
  const { page } = await openPage(t);
  await page.unroute('**/render');
  await page.locator('#file').setInputFiles({ name: 'generated.PcbDoc', mimeType: 'application/octet-stream', buffer: data });
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'generated.PcbDoc' && document.getElementById('busy').style.display === 'none');
  assert.equal(await page.locator('#mode-3d').isEnabled(), true);
  await page.locator('#mode-3d').click();
  await wait3D(page);
  assert.match(await page.locator('#three-summary').textContent(), /3 bodies/);
  const iso = await image3D(page);
  if (process.env.PCB_3D_SCREENSHOT) await page.screenshot({ path: process.env.PCB_3D_SCREENSHOT });
  await page.locator('#three-top').click();
  assert.notDeepEqual(await image3D(page), iso);
  await page.locator('#mode-2d').click();
  assert.equal(await page.locator('#view > svg').isVisible(), true);
});

const selected3DBodies = page => page.locator('#three-body-list').evaluate(list =>
  [...list.selectedOptions].map(option => option.value));
async function click3D(page, x, y, modifiers = []) {
  const rect = await page.locator('#three-view canvas').boundingBox();
  await page.locator('#three-view canvas').click({ position: { x: rect.width * x, y: rect.height * y }, modifiers });
}

test('3D body picking highlights visible bodies, toggles selection, and ignores camera drags and occluded bodies', async t => {
  const { page } = await openPage(t, { render: (route, name) => reply(route, threeBoardData(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc'));
  await loaded(page, 'A.PcbDoc');
  await page.locator('#mode-3d').click(); await wait3D(page);
  await page.locator('#three-top').click();
  const original = await image3D(page);
  await click3D(page, 0.35, 0.56);
  assert.deepEqual(await selected3DBodies(page), ['body-0']);
  assert.match(await page.locator('#three-selection').textContent(), /1 selected: U1/);
  assert.ok(!(await image3D(page)).equals(original), 'selection changes the rendered body');
  if (process.env.PCB_3D_SELECTION_SCREENSHOT) await page.screenshot({ path: process.env.PCB_3D_SELECTION_SCREENSHOT });
  await click3D(page, 0.35, 0.56);
  assert.deepEqual(await selected3DBodies(page), []);
  assert.ok((await image3D(page)).equals(original), 'deselect restores original materials');
  await click3D(page, 0.64, 0.4);
  assert.deepEqual(await selected3DBodies(page), [], 'the board occludes the bottom body');
  await click3D(page, 0.35, 0.56);
  await click3D(page, 0.05, 0.05);
  assert.deepEqual(await selected3DBodies(page), [], 'blank space clears selection');
  await page.locator('#three-bottom').click();
  await click3D(page, 0.64, 0.6);
  assert.deepEqual(await selected3DBodies(page), ['body-1'], 'bottom body becomes selectable from below');
  const rect = await page.locator('#three-view canvas').boundingBox();
  await page.mouse.move(rect.x + rect.width * 0.64, rect.y + rect.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * 0.64 + 50, rect.y + rect.height * 0.6 + 40, { steps: 4 });
  await page.mouse.move(rect.x + rect.width * 0.64, rect.y + rect.height * 0.6, { steps: 4 });
  await page.mouse.up();
  assert.deepEqual(await selected3DBodies(page), ['body-1'], 'moving out and back is still a drag');
  await page.keyboard.press('Escape');
  assert.deepEqual(await selected3DBodies(page), []);
});

test('3D supports multiple bodies, Delete and Backspace, per-tab deletions, and undo without changing the source', async t => {
  const fixture = name => {
    const data = threeBoardData(name);
    // Same display name as the first body, but a separate selectable identity.
    data.scene3d.bodies.push({ outline: [[4, -12], [10, -12], [10, -6], [4, -6]],
      holes: [], z: 0.8, height: 3, color: 0x888888, opacity: 1, name: 'U1' });
    return data;
  };
  const { page, requests } = await openPage(t, { render: (route, name) => reply(route, fixture(name)) });
  await page.locator('#file').setInputFiles(file('A.PcbDoc'));
  await loaded(page, 'A.PcbDoc');
  const originalSVG = await page.locator('#scene').evaluate(scene => scene.outerHTML);
  await page.locator('#mode-3d').click(); await wait3D(page);
  await page.locator('#three-top').click();
  await click3D(page, 0.35, 0.56);
  await click3D(page, 0.59, 0.63, ['Shift']);
  assert.deepEqual(await selected3DBodies(page), ['body-0', 'body-2']);
  await click3D(page, 0.59, 0.63, ['Shift']);
  assert.deepEqual(await selected3DBodies(page), ['body-0'], 'Shift-click toggles one body');
  await click3D(page, 0.59, 0.63, ['Shift']);
  await page.locator('#three-iso').click();
  const selected = await image3D(page);
  await page.keyboard.press('Delete');
  assert.equal(await page.locator('#three-body-list option').count(), 1);
  assert.match(await page.locator('#three-summary').textContent(), /1 body/);
  assert.equal(await page.locator('#three-delete').isDisabled(), true);
  assert.ok(!(await image3D(page)).equals(selected), 'deletion removes solids from the image');
  await page.locator('#mode-2d').click();
  assert.equal(await page.locator('#scene').evaluate(scene => scene.outerHTML), originalSVG);
  await page.locator('#mode-3d').click(); await wait3D(page);
  assert.equal(await page.locator('#three-body-list option').count(), 1);
  await page.locator('#file').setInputFiles(file('B.PcbDoc'));
  await loaded(page, 'B.PcbDoc');
  await page.locator('#mode-3d').click(); await wait3D(page);
  assert.equal(await page.locator('#three-body-list option').count(), 3, 'another tab keeps its own bodies');
  assert.equal(await page.locator('#three-undo').isDisabled(), true);
  await page.getByRole('tab', { name: 'A.PcbDoc', exact: true }).click(); await wait3D(page);
  assert.equal(await page.locator('#three-body-list option').count(), 1);
  await page.locator('#three-undo').click();
  assert.deepEqual(await selected3DBodies(page), ['body-0', 'body-2']);
  assert.ok((await image3D(page)).equals(selected), 'undo restores solids, highlighting, and camera');
  await page.locator('#three-clear').click();
  await page.locator('#three-body-list').selectOption(['body-0']);
  await page.keyboard.press('Backspace');
  assert.equal(await page.locator('#three-body-list option').count(), 2);
  await page.locator('#three-body-list').selectOption(['body-2']);
  await page.locator('#three-delete').click();
  assert.equal(await page.locator('#three-body-list option').count(), 1);
  await page.keyboard.press('ControlOrMeta+z');
  assert.deepEqual(await selected3DBodies(page), ['body-2']);
  await page.keyboard.press('ControlOrMeta+z');
  assert.equal(await page.locator('#three-body-list option').count(), 3);
  assert.deepEqual(await selected3DBodies(page), ['body-0']);
  assert.equal(await page.locator('#three-undo').isDisabled(), true);
  await page.locator('#three-body-list').selectOption(['body-0', 'body-1', 'body-2']);
  await page.keyboard.press('Delete');
  assert.equal(await page.locator('#three-body-list option').count(), 0, 'all bodies can be removed while keeping the board');
  await page.locator('#view-fit').click();
  await page.locator('#three-undo').click();
  assert.equal(await page.locator('#three-body-list option').count(), 3);
  assert.equal(requests.length, 2, 'deletion and undo do not write or re-upload source files');
});

const kicadFixture = extension => resolve(__dirname, `fixtures/kicad/demo.${extension}`);
async function loadedDocument(page, name) {
  await page.waitForFunction(name => document.getElementById('filename').textContent === name &&
    document.getElementById('busy').style.display === 'none', name);
}

test('opens real KiCad PCB and schematic files, cross-probes, searches pins and nets, measures, and shows the 3D board', async t => {
  const { page } = await openPage(t);
  await page.unroute('**/render');
  assert.match(await page.locator('#file').getAttribute('accept'), /\.kicad_pcb/);
  assert.match(await page.locator('#file').getAttribute('accept'), /\.kicad_sch/);
  await page.locator('#file').setInputFiles([kicadFixture('kicad_pcb'), kicadFixture('kicad_sch')]);
  await loadedDocument(page, 'demo.kicad_sch');
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.match(await page.locator('#stats').textContent(), /2 components, 2 wires, 2 net labels/);
  assert.equal(await page.locator('#view-mode').isVisible(), false);
  if (process.env.KICAD_SCREENSHOT_DIR) await page.screenshot({ path: resolve(process.env.KICAD_SCREENSHOT_DIR, 'schematic.png') });
  await clickSchematicGraphic(page, page.locator('[id^="kc-body-"] path').first());
  assert.equal(await schematicStatus(page), 'Components: R1');
  await page.locator('#probe-layout-btn').click();
  await loadedDocument(page, 'demo.kicad_pcb');
  assert.equal(await page.locator('#component-query').inputValue(), 'R1');
  assert.ok(await page.locator('#scene [data-component="R1"].component-match').count() > 0);
  await page.locator('#component-clear').click();
  await page.locator('#net-query').fill('SIGNAL');
  assert.ok(await page.locator('#scene .net-match').count() > 0);
  await page.locator('#probe-schematic-btn').click();
  await loadedDocument(page, 'demo.kicad_sch');
  assert.equal(await schematicStatus(page), 'Nets: SIGNAL');
  await page.locator('#schematic-clear').click();
  await page.locator('#view-fit').click();
  await settleView(page);
  await clickSchematicGraphic(page, page.locator('[id^="kc-wire-"] .sch-hit').first());
  assert.equal(await schematicStatus(page), 'Nets: GND');
  await page.getByRole('tab', { name: 'demo.kicad_pcb', exact: true }).click();
  await page.locator('#net-clear').click();
  const layerNames = await page.locator('#layers label').allTextContents();
  assert.ok(layerNames.some(name => name.includes('Front copper')));
  assert.ok(layerNames.some(name => name.includes('Back copper')));
  assert.equal(await page.locator('#scene [data-layer-token="TOP"]').evaluate(el => el.style.display), '');
  await page.locator('#polygons-toggle').click();
  assert.equal(await page.locator('#scene [data-primitive="region"]').isVisible(), false);
  await page.locator('#polygons-toggle').click();
  await page.locator('#component-query').fill('R2');
  await page.locator('#component-fit').click();
  await settleView(page);
  assert.ok((await page.locator('.pin-label').allTextContents()).includes('A2'));
  await page.locator('#component-clear').click();
  await page.locator('#view-fit').click();
  await page.locator('#measure-btn').click();
  for (const point of [[5, 5], [15, 5]]) {
    const screen = await pointOnScreen(page, ...point); await page.mouse.click(screen.clientX, screen.clientY);
  }
  const measured = (await page.locator('#readout').textContent()).match(/dist ([\d.]+) mm/);
  assert.ok(measured && Math.abs(Number(measured[1]) - 10) < 0.05, '10 mm distance within mouse pixel rounding');
  await page.keyboard.press('Escape');
  if (process.env.KICAD_SCREENSHOT_DIR) await page.screenshot({ path: resolve(process.env.KICAD_SCREENSHOT_DIR, 'pcb.png') });
  await page.locator('#mode-3d').click(); await wait3D(page);
  assert.match(await page.locator('#three-status').textContent(), /no usable STEP model references/);
  assert.equal(await page.locator('#three-body-list option').count(), 0);
  if (process.env.KICAD_SCREENSHOT_DIR) await page.screenshot({ path: resolve(process.env.KICAD_SCREENSHOT_DIR, 'board-3d.png') });
  await page.locator('#mode-2d').click();
  assert.equal(await page.locator('#measure line').count(), 1);
});

test('KiCad and Altium tabs coexist and a malformed KiCad upload preserves the open documents', async t => {
  const { page } = await openPage(t, { render: (route, name) => name.toLowerCase().endsWith('.pcbdoc') ? reply(route, boardData(name)) : route.continue() });
  await page.locator('#file').setInputFiles(file('Altium.PcbDoc'));
  await loaded(page, 'Altium.PcbDoc');
  await page.locator('#file').setInputFiles(kicadFixture('kicad_pcb'));
  await loadedDocument(page, 'demo.kicad_pcb');
  const source = readFileSync(kicadFixture('kicad_sch')).toString('base64');
  await page.locator('#view').evaluate((view, source) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(atob(source), c => c.charCodeAt(0))], 'dropped.kicad_sch'));
    view.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, source);
  await loadedDocument(page, 'dropped.kicad_sch');
  assert.equal(await page.getByRole('tab').count(), 3);
  await page.locator('#file').setInputFiles({ name: 'broken.kicad_pcb', mimeType: 'application/octet-stream', buffer: Buffer.from('(kicad_pcb') });
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('Invalid KiCad'));
  assert.equal(await page.getByRole('tab').count(), 3);
  await page.getByRole('tab', { name: 'Altium.PcbDoc', exact: true }).click();
  assert.equal(await activeName(page), 'Altium.PcbDoc');
});

test('legacy KiCad sheets open with explicit placeholder warnings, wire selection and component probing', async t => {
  const { page } = await openPage(t);
  await page.unroute('**/render');
  const pcb = readFileSync(kicadFixture('kicad_pcb'), 'utf8').replace('00000000-0000-0000-0000-000000000101', '5AAB499C');
  await page.locator('#file').setInputFiles({ name: 'legacy.kicad_pcb', mimeType: 'application/octet-stream', buffer: Buffer.from(pcb) });
  await loadedDocument(page, 'legacy.kicad_pcb');
  await page.locator('#file').setInputFiles(resolve(__dirname, 'fixtures/kicad/legacy.sch'));
  await loadedDocument(page, 'legacy.sch');
  assert.match(await page.locator('#file').getAttribute('accept'), /,\.sch$/);
  assert.match(await page.locator('#warnings').textContent(), /symbol graphics and pin connectivity are unavailable/);
  assert.equal(await page.locator('#scene [data-symbol-preview="placeholder"]').count(), 2);
  assert.match(await page.locator('#stats').textContent(), /2 components, 3 wires, 2 net labels/);
  assert.equal(await page.locator('#mode-3d').isVisible(), false);
  await clickSchematicGraphic(page, page.locator('[data-symbol-preview="placeholder"]').first());
  assert.equal(await schematicStatus(page), 'Components: R1');
  await page.locator('#probe-layout-btn').click();
  await loadedDocument(page, 'legacy.kicad_pcb');
  assert.equal(await page.locator('#component-query').inputValue(), 'R1');
  await page.getByRole('tab', { name: 'legacy.sch', exact: true }).click();
  await page.locator('#schematic-clear').click();
  await page.locator('#view-fit').click(); await settleView(page);
  await clickSchematicGraphic(page, page.locator('[id^="kc-wire-"] .sch-hit').first());
  assert.equal(await schematicStatus(page), 'Nets: GND');
});

test('opens the reported co60 legacy files through the real server', {
  skip: !process.env.KICAD_TEST_PCB || !process.env.KICAD_TEST_SCH,
}, async t => {
  const { page } = await openPage(t);
  await page.unroute('**/render');
  await page.locator('#file').setInputFiles(process.env.KICAD_TEST_PCB);
  await loadedDocument(page, 'co60.kicad_pcb');
  await page.locator('#file').setInputFiles(process.env.KICAD_TEST_SCH);
  await loadedDocument(page, 'co60.sch');
  await settleView(page);
  assert.match(await page.locator('#stats').textContent(), /52 components, 158 wires, 42 net labels/);
  assert.match(await page.locator('#warnings').textContent(), /Legacy \.sch preview/);
  if (process.env.KICAD_SCREENSHOT_DIR) await page.screenshot({ path: resolve(process.env.KICAD_SCREENSHOT_DIR, 'co60-schematic.png') });
  // The legacy GND field overlaps the centre of C2's placeholder at overview
  // scale. Its upper corner remains a real, unobscured component hit target.
  await page.locator('#kc-component-1 .sch-component-hit').click({ position: { x: 1, y: 1 } });
  assert.equal(await schematicStatus(page), 'Components: C2');
  await page.locator('#probe-layout-btn').click();
  await loadedDocument(page, 'co60.kicad_pcb');
  assert.equal(await page.locator('#component-query').inputValue(), 'C2');
  await page.locator('#component-clear').click();
  await page.locator('#view-fit').click(); await settleView(page);
  if (process.env.KICAD_SCREENSHOT_DIR) await page.screenshot({ path: resolve(process.env.KICAD_SCREENSHOT_DIR, 'co60-pcb.png') });
  await page.locator('#component-query').fill('K_[1');
  assert.match(await page.locator('#component-status').textContent(), /1 component highlighted/);
  await page.locator('#mode-3d').click(); await wait3D(page);
  if (process.env.KICAD_SCREENSHOT_DIR) await page.screenshot({ path: resolve(process.env.KICAD_SCREENSHOT_DIR, 'co60-3d.png') });
});

async function rectangleDrag(page, a, b, { shift = false, release = true } = {}) {
  const start = await pointOnScreen(page, ...a), end = await pointOnScreen(page, ...b);
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(start.clientX, start.clientY); await page.mouse.down();
  await page.mouse.move(end.clientX, end.clientY, { steps: 5 });
  if (release) await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
}

test('rectangle selects multiple schematic symbols and nets in either direction with dashed live feedback', async t => {
  const { page } = await openSelectableSchematic(t);
  const camera = await currentViewBox(page);
  for (const [a, b] of [[[8, 7], [83, 25]], [[83, 25], [8, 7]]]) {
    await rectangleDrag(page, a, b, { release: false });
    const rectangle = page.locator('#selection-rectangle');
    assert.equal(await rectangle.isVisible(), true);
    assert.equal(await rectangle.evaluate(el => getComputedStyle(el).borderTopStyle), 'dashed');
    assert.deepEqual(await currentViewBox(page), camera, 'selecting does not move the camera');
    await page.mouse.up();
    assert.equal(await rectangle.isHidden(), true);
    assert.equal(await schematicStatus(page), 'Components: R1, U[2]"<test>\nNets: GND, VCC');
    assert.equal(await page.locator('.sch-component-match').count(), 2);
    assert.equal(await page.locator('.sch-net-match').count(), 7);
    assert.equal(await page.locator('#body-1').evaluate(el => getComputedStyle(el).stroke), 'rgb(0, 138, 59)');
    assert.equal(await page.locator('#body-1').evaluate(el => getComputedStyle(el).fill), 'rgb(255, 255, 176)');
  }
  // A net's aggregate bounds enclose this empty gap; its individual wires do not.
  await rectangleDrag(page, [35, 23], [48, 26]);
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  await rectangleDrag(page, [12, 12], [20, 19]);
  assert.equal(await schematicStatus(page), 'Components: R1');
  await rectangleDrag(page, [33, 60], [48, 62], { shift: true });
  assert.equal(await schematicStatus(page), 'Components: R1\nNets: VCC');
  await rectangleDrag(page, [35, 23], [48, 26], { shift: true });
  assert.equal(await schematicStatus(page), 'Components: R1\nNets: VCC', 'empty additive rectangle preserves the selection');
  await page.locator('#file').setInputFiles(file('B.SchDoc')); await loaded(page, 'B.SchDoc');
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  await page.getByRole('tab', { name: 'A.SchDoc', exact: true }).click();
  assert.equal(await schematicStatus(page), 'Components: R1\nNets: VCC');
  await page.keyboard.press('Escape'); assert.equal(await schematicStatus(page), 'Nothing selected.');
});

test('SVG rectangle selection respects hidden layers and polygons and keeps exact mixed selections across tabs', async t => {
  const data = probingLayoutData('Rectangle.PcbDoc');
  data.polygon_elements = ['area'];
  data.svg = data.svg.replace('<rect id="pcb-other"', '<rect id="area" data-net="POUR" x="90" y="60" width="5" height="5" fill="red"/><rect id="pcb-other"');
  const { page } = await openPage(t, { initial: data, render: (route, name) => reply(route, probingLayoutData(name)) });
  await loaded(page, 'Rectangle.PcbDoc');
  await rectangleDrag(page, [8, 8], [85, 65]);
  assert.equal(await page.locator('#component-query').inputValue(), 'R99, R10');
  assert.equal(await page.locator('#net-query').inputValue(), 'PCB_SIGNAL, GND');
  await page.locator('#layers label').filter({ hasText: 'Mechanical 1' }).locator('input').check();
  await rectangleDrag(page, [50, 29], [62, 39], { shift: true });
  assert.equal(await page.locator('#component-query').inputValue(), 'R99, R10, U7');
  assert.equal(await page.locator('#net-query').inputValue(), 'PCB_SIGNAL, GND, VCC');
  await page.locator('#file').setInputFiles(file('Other.PcbDoc')); await loaded(page, 'Other.PcbDoc');
  await page.getByRole('tab', { name: 'Rectangle.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#component-query').inputValue(), 'R99, R10, U7');
  assert.equal(await page.locator('#net-query').inputValue(), 'PCB_SIGNAL, GND, VCC');
  await rectangleDrag(page, [91, 60], [98, 69]);
  assert.equal(await page.locator('#net-query').inputValue(), 'POUR');
  await page.locator('#polygons-toggle').click();
  await rectangleDrag(page, [91, 60], [98, 69]);
  assert.equal(await page.locator('#net-query').inputValue(), '', 'hidden polygons are not selected');
  // Exclude a diagonal wire whose bounds overlap the box but whose line does not.
  await page.locator('#layer-top').evaluate(layer => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    for (const [name, value] of Object.entries({ 'data-net': 'DIAGONAL', x1: 30, y1: 10, x2: 60, y2: 40, stroke: 'red' })) line.setAttribute(name, value);
    layer.append(line);
  });
  // Remount to index the added fixture wire.
  await page.getByRole('tab', { name: 'Other.PcbDoc', exact: true }).click();
  await page.getByRole('tab', { name: 'Rectangle.PcbDoc', exact: true }).click();
  await rectangleDrag(page, [31, 34], [36, 39]);
  assert.equal(await page.locator('#net-query').inputValue(), '');
  await rectangleDrag(page, [44, 22], [48, 28]);
  assert.equal(await page.locator('#net-query').inputValue(), 'DIAGONAL');
});

test('rectangle cancellation, click threshold, outside release and Space panning do not leak selections', async t => {
  const { page } = await openSelectableSchematic(t);
  await clickSchematicGraphic(page, symbolBodies(page).first());
  const body = await pointOnScreen(page, 16, 16);
  await page.mouse.move(body.clientX, body.clientY); await page.mouse.down();
  await page.mouse.move(body.clientX + 1, body.clientY + 1); await page.mouse.up();
  assert.equal(await schematicStatus(page), 'Nothing selected.', 'tiny motion still clicks and toggles the symbol');
  await rectangleDrag(page, [8, 7], [83, 25], { release: false });
  await page.keyboard.press('Escape'); await page.mouse.up();
  assert.equal(await page.locator('#selection-rectangle').isHidden(), true);
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  await rectangleDrag(page, [8, 7], [83, 25], { release: false });
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up();
  assert.equal(await page.locator('#selection-rectangle').isHidden(), true);
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  await rectangleDrag(page, [8, 7], [83, 25], { release: false });
  await page.locator('#file').setInputFiles(file('B.SchDoc')); await loaded(page, 'B.SchDoc'); await page.mouse.up();
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  assert.equal(await page.locator('#selection-rectangle').isHidden(), true);
  const camera = await currentViewBox(page);
  await page.keyboard.down('Space'); await rectangleDrag(page, [8, 7], [83, 25]); await page.keyboard.up('Space');
  assert.notDeepEqual(await currentViewBox(page), camera);
  assert.equal(await schematicStatus(page), 'Nothing selected.');
  await page.keyboard.press('f');
  await rectangleDrag(page, [83, 25], [8, 7], { release: false });
  await page.mouse.move(200, 0); await page.mouse.up();
  assert.equal(await page.locator('#selection-rectangle').isHidden(), true);
  assert.match(await schematicStatus(page), /Components: R1/);
  await page.locator('#schematic-clear').focus(); await page.keyboard.press('Space');
  assert.equal(await schematicStatus(page), 'Nothing selected.', 'Space still activates sidebar buttons');
  await rectangleDrag(page, [83, 25], [8, 7], { release: false });
  await page.keyboard.press('+'); await page.mouse.up();
  assert.equal(await page.locator('#selection-rectangle').isHidden(), true);
  assert.equal(await schematicStatus(page), 'Nothing selected.', 'zoom cancels an in-progress rectangle');
});

test('Quit viewer stops the session through the local endpoint and reports failures without losing the document', async t => {
  const { page } = await openPage(t, { initial: boardData('Session.PcbDoc') });
  await loaded(page, 'Session.PcbDoc');
  await page.route('**/shutdown', route => reply(route, { error: 'failure' }, 500));
  await page.locator('#quit').click();
  await page.waitForFunction(() => !document.querySelector('#quit').disabled);
  assert.equal(await page.locator('#session-stopped').isHidden(), true);
  assert.equal(await activeName(page), 'Session.PcbDoc');
  await page.unroute('**/shutdown');
  let request;
  await page.route('**/shutdown', route => { request = route.request(); return reply(route, { stopped: true }); });
  await page.locator('#quit').click();
  await page.locator('#session-stopped').waitFor({ state: 'visible' });
  assert.equal(request.method(), 'POST');
  assert.equal(request.headers()['x-viewer-request'], 'shutdown');
  assert.equal(await page.locator('#session-stopped').textContent(), 'Viewer stopped. You can close this tab.');
});
