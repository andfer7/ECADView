// Install with npm ci, then run npm test.
// Set PLAYWRIGHT_CHANNEL=chrome to use an installed Google Chrome browser.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');

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
  assert.equal(await page.locator('#component-query').isVisible(), false);
  assert.equal(await page.locator('#net-query').isVisible(), false);
  assert.equal(await page.locator('#measure-btn').isVisible(), false);
  assert.equal(await page.locator('#stats').textContent(), '3 components, 7 wires, 2 net labels');
  await page.locator('#view').click(); await page.keyboard.press('m');
  assert.equal(await page.locator('#view').evaluate(el => el.classList.contains('measuring')), false);
  await page.locator('#view').dispatchEvent('wheel', { ctrlKey: true, deltaY: -250, clientX: 600, clientY: 400 });
  await settleView(page);
  await page.mouse.move(600, 400); await page.mouse.down();
  await page.mouse.move(630, 420); await page.mouse.up();
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
  await page.mouse.move(600, 400); await page.mouse.down();
  await page.mouse.move(640, 420); await page.mouse.up();
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
  assert.equal(await page.locator('#body-1 path').evaluate(el => getComputedStyle(el).stroke), 'rgb(189, 97, 0)');
  assert.equal(await page.locator('.sch-component-hit').first().evaluate(el => getComputedStyle(el).fill), 'rgba(0, 0, 0, 0)');
  await clickSchematicGraphic(page, page.locator('#body-2'), true);
  assert.equal(await schematicStatus(page), 'Components: R1, U[2]"<test>');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.sch-component-match').count(), 0);
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
  assert.match(await page.locator('#probe-status').textContent(), /Open a .PcbDoc/);
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
  assert.match(await page.locator('#probe-schematic-status').textContent(), /Open a .SchDoc/);
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
  await page.mouse.move(point.clientX, point.clientY); await page.mouse.down();
  await page.mouse.move(point.clientX + 40, point.clientY + 30); await page.mouse.up(); await settleView(page);
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
        x: parseFloat(label.style.left), y: parseFloat(label.style.top), expectedX: midpoint.x - r.left, expectedY: midpoint.y - r.top });
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
  const expected = await page.locator('[data-sch-nets]').evaluateAll((els, ids) =>
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
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 30, y + 10); await page.mouse.move(x, y); await page.mouse.up();
  assert.equal(await page.locator('#component-query').inputValue(), 'C2');
  await page.locator('#measure-btn').click();
  await body.click(); await page.locator('[data-primitive="component-pad"]').click();
  assert.equal(await page.locator('#component-query').inputValue(), 'C2');
  await page.locator('#measure-btn').click();
  await body.click();
  assert.equal(await page.locator('#component-query').inputValue(), '');
  assert.equal(await page.locator('#measure line').count(), 1);
  await body.click();
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
