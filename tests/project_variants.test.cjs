// Run with PLAYWRIGHT_CHANNEL=chrome node --test tests/project_variants.test.cjs.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { chromium } = require('playwright');

let browser, server, origin;
before(async () => {
  server = spawn(process.env.PCB_TEST_PYTHON || resolve(__dirname, '../.venv/bin/python'),
    ['-B', '-u', resolve(__dirname, '../ecadview.py'), '--no-open']);
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
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const keeper = await browser.newPage(); await keeper.goto(origin);
});
after(async () => {
  await browser?.close();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit'); server.kill(); await exited;
  }
});

const file = (name, text = name) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(text) });
const reply = (route, data) => route.fulfill({ json: data });
const pcbData = (name = 'board.PcbDoc') => ({
  name, kind: 'pcb', stats: { components: 3, pads: 3, tracks: 0, vias: 0, polygons: 0, regions: 0 },
  layout_components: [
    { name: 'R99', source_name: 'R1', source_id: 'component-r', source_path: 'sheet-id\\component-r' },
    { name: 'U7', source_name: 'U1', source_id: 'component-u', source_path: 'sheet-id\\component-u' },
    { name: 'J1', source_name: 'J1', source_id: 'component-j', source_path: 'sheet-id\\component-j' },
  ],
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <g id="scene">
      <g id="layer-top" data-layer-name="Top copper" data-layer-role="copper" data-layer-token="TOP">
        <rect id="pad-r" data-component="R99" data-pad-number="1" data-net="GND" x="15" y="15" width="12" height="8" fill="red"/>
        <rect id="pad-u" data-component="U7" data-pad-number="1" data-net="VCC" x="45" y="35" width="12" height="8" fill="red"/>
        <rect id="pad-j" data-component="J1" data-pad-number="1" data-net="GND" x="70" y="55" width="12" height="8" fill="red"/>
      </g>
      <g id="layer-bottom" data-layer-name="Bottom copper" data-layer-role="copper" data-layer-token="BOTTOM">
        <rect x="10" y="70" width="75" height="2" fill="blue"/>
      </g>
      <g id="board-outline"><rect width="100" height="80" fill="none" stroke="yellow"/></g>
    </g></svg>`,
  scene3d: {
    board: [{ outline: [[-25, -20], [25, -20], [25, 20], [-25, 20]], holes: [] }], thickness: 1.6,
    bodies: [
      { id: 'body-r', name: 'R99', component: 'R99', outline: [[-18,-12],[-10,-12],[-10,-5],[-18,-5]], holes: [], z: 0.8, height: 3, color: 0x777777, opacity: 1 },
      { id: 'body-u', name: 'U7', component: 'U7', outline: [[-4,-4],[4,-4],[4,4],[-4,4]], holes: [], z: 0.8, height: 4, color: 0x999999, opacity: 1 },
      { id: 'body-j', name: 'J1', component: 'J1', outline: [[10,7],[18,7],[18,14],[10,14]], holes: [], z: 0.8, height: 5, color: 0xaaaaaa, opacity: 1 },
    ], notes: [], units: 'mm',
  },
});
const schematicData = (name = 'sheet.SchDoc') => ({
  name, kind: 'schematic', stats: { components: 3, wires: 1, net_labels: 1 },
  selection: {
    components: [
      { id: 'component-r', name: 'R1', elements: ['component-r'], body_elements: ['symbol-r'] },
      { id: 'component-u', name: 'U1', elements: ['component-u'], body_elements: ['symbol-u'] },
      { id: 'component-j', name: 'J1', elements: ['component-j'], body_elements: ['symbol-j'] },
    ],
    nets: [{ id: 'net-gnd', name: 'GND', elements: ['wire-gnd'], terminals: [{ component: 'R1', pin: '1' }] }],
  },
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <g id="scene"><g id="DocumentMainGroup"><g id="sheet-id">
      <rect width="100" height="80" fill="#fff"/>
      <g id="component-r"><rect id="symbol-r" x="15" y="15" width="12" height="8" fill="yellow" stroke="brown"/><text x="15" y="13">R1</text></g>
      <g id="component-u"><rect id="symbol-u" x="45" y="35" width="12" height="8" fill="yellow" stroke="brown"/><text x="45" y="33">U1</text></g>
      <g id="component-j"><rect id="symbol-j" x="70" y="55" width="12" height="8" fill="yellow" stroke="brown"/><text x="70" y="53">J1</text></g>
      <path id="wire-gnd" d="M27 19H35" stroke="blue"/>
    </g></g></g></svg>`,
});
const projectData = (name = 'demo.PrjPcb', documents = ['board.PcbDoc', 'sheet.SchDoc']) => ({
  kind: 'project', name, documents, current_variant: null, warnings: [],
  variants: [
    { name: 'Economy', parameters: { Assembly: 'Budget' }, components: [
      { designator: 'R1', unique_id: 'sheet-id\\component-r', kind: 'not_fitted', parameters: {}, alternate_part: '' },
      { designator: 'U1', unique_id: 'sheet-id\\component-u', kind: 'alternate', parameters: { Comment: 'Low-power part', Value: '3.3V', MPN: '<ALT-123>' }, alternate_part: 'LOW_POWER_IC' },
    ] },
    { name: 'Full', parameters: {}, components: [
      { designator: 'R1', unique_id: 'sheet-id\\component-r', kind: 'fitted', parameters: { Value: '10k' }, alternate_part: '' },
    ] },
  ],
});
const defaultRender = (route, name) => reply(route, /\.prjpcb$/i.test(name) ? projectData(name)
  : /\.schdoc$/i.test(name) ? schematicData(name) : pcbData(name));
async function openPage(t, { render = defaultRender, initial = {} } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.route('**/initial', route => reply(route, initial));
  await page.route('**/render', route => {
    const name = decodeURIComponent(route.request().headers()['x-filename']);
    requests.push(name); return render(route, name);
  });
  await page.goto(origin);
  return { page, requests };
}
async function loaded(page, name) {
  await page.waitForFunction(name => document.querySelector('#view > svg')?.getAttribute('data-board') === name
    && document.getElementById('busy').style.display === 'none', name);
}
async function openFiles(page, names) {
  await page.locator('#file').setInputFiles(names.map(name => file(name)));
  const document = names.findLast(name => !/\.prjpcb$/i.test(name));
  if (document) await loaded(page, document);
}
async function activate(page, name) {
  await page.getByRole('tab', { name, exact: true }).click(); await loaded(page, name);
}
async function selectVariant(page, name) {
  await page.locator('#variant-select').selectOption(name);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
const variantReady = page => page.waitForFunction(() => [...document.querySelectorAll('#variant-select option')].some(option => option.value === 'Economy'));
const hasCross = page => page.locator('#variant-overlay').evaluateAll(groups => groups.some(group => group.childElementCount > 0));
const notFittedNames = page => page.locator('#variant-details li').evaluateAll(items => items
  .map(item => item.textContent.match(/^(.+?) — Not fitted(?:\n|$)/)?.[1]).filter(Boolean));
const noLayoutCrosses = async page => assert.equal(await page.locator('#variant-overlay').count(), 0, '2D PCB layout never receives variant X markers');
const viewState = page => page.evaluate(() => ({
  viewBox: document.querySelector('#view > svg').getAttribute('viewBox'),
  layers: [...document.querySelectorAll('#scene > g')].filter(group => group.id.startsWith('layer-') || group.id === 'board-outline')
    .map(group => ({ id: group.id, display: group.style.display })),
  checked: [...document.querySelectorAll('#layers input')].map(input => input.checked),
  measurements: document.getElementById('measure')?.innerHTML,
}));
const bodyIds = page => page.locator('#three-body-list option').evaluateAll(options => options.map(option => option.value));
async function set3D(page, enabled) {
  const control = page.locator('#view-mode-switch');
  if (await control.getAttribute('aria-checked') !== String(enabled)) await control.click();
  if (enabled) await page.waitForFunction(() => !document.getElementById('three-view').hidden
    && /\d+ bod(y|ies)/.test(document.getElementById('three-summary').textContent));
}

test('project variants resolve paired documents by source identity while preserving unmarked layout geometry', async t => {
  const { page, requests } = await openPage(t, { render: (route, name) => /\.pcbdoc$/i.test(name)
    ? reply(route, { ...pcbData(name), webgl: true }) : defaultRender(route, name) });
  await openFiles(page, ['demo.PrjPcb', 'board.PcbDoc', 'sheet.SchDoc']); await variantReady(page);
  assert.equal(await page.getByRole('tab').count(), 2, 'project metadata does not become a drawing tab');
  await activate(page, 'board.PcbDoc');
  assert.match(await page.locator('#view').getAttribute('class'), /\bgpu-layout\b/, 'layout preservation is tested with the actual WebGL drawing');
  await page.locator('#layers label').filter({ hasText: 'Bottom copper' }).locator('input').uncheck();
  await page.locator('#zoom-in').click();
  await page.locator('#measure-btn').click();
  await page.locator('#view').click({ position: { x: 300, y: 320 } });
  await page.locator('#view').click({ position: { x: 360, y: 360 } });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#measure .measurement-segment').count(), 1);
  const before = await viewState(page);
  await selectVariant(page, 'Economy');
  assert.deepEqual(await notFittedNames(page), ['R99'], 'renamed PCB R99 is resolved through its source UID');
  await noLayoutCrosses(page);
  assert.deepEqual(await viewState(page), before, 'changing assembly does not alter layers, camera or measurements');
  const details = await page.locator('#variant-details').textContent();
  for (const value of ['3.3V', '<ALT-123>', 'LOW_POWER_IC']) assert.ok(details.includes(value), value);
  assert.equal(await page.locator('#variant-details script, #variant-details img').count(), 0, 'metadata stays literal text');
  await activate(page, 'sheet.SchDoc');
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy', 'project selection is shared across tabs');
  assert.equal(await hasCross(page), true, 'schematic R1 receives the matching cross');
  const cross = await page.locator('#variant-overlay').boundingBox(), symbol = await page.locator('#symbol-r').boundingBox();
  assert.ok(cross.x <= symbol.x + symbol.width / 2 && cross.x + cross.width >= symbol.x + symbol.width / 2);
  assert.ok(cross.y <= symbol.y + symbol.height / 2 && cross.y + cross.height >= symbol.y + symbol.height / 2);
  assert.equal(await page.locator('#variant-overlay [data-variant-component="R1"]').count(), 1);
  await selectVariant(page, ''); assert.equal(await hasCross(page), false);
  await activate(page, 'board.PcbDoc');
  assert.equal(await page.locator('#variant-select').inputValue(), '');
  assert.deepEqual(await notFittedNames(page), []);
  await noLayoutCrosses(page);
  assert.deepEqual(await viewState(page), before);
  assert.equal(requests.length, 3, 'variant changes do not re-upload or render documents');
});

test('variant exclusions restore 3D bodies independently of manual deletion and camera state', async t => {
  const { page } = await openPage(t);
  await page.evaluate(async () => {
    const { Board3D } = await import('/static/viewer-3d.js'), show = Board3D.prototype.show;
    Board3D.prototype.show = function (...args) { window.variantTestViewer = this; return show.apply(this, args); };
  });
  await openFiles(page, ['demo.PrjPcb', 'board.PcbDoc']); await variantReady(page);
  await set3D(page, true);
  assert.deepEqual(await bodyIds(page), ['body-r', 'body-u', 'body-j']);
  await page.locator('#three-body-list').selectOption(['body-j']); await page.locator('#three-delete').click();
  await page.locator('#three-rotate-right').click();
  const camera = await page.evaluate(() => window.variantTestViewer.state());
  await selectVariant(page, 'Economy');
  assert.deepEqual(await bodyIds(page), ['body-u'], 'DNP R99 and manually deleted J1 are both omitted');
  assert.deepEqual(await page.evaluate(() => window.variantTestViewer.state()), camera);
  await selectVariant(page, '');
  assert.deepEqual(await bodyIds(page), ['body-r', 'body-u'], 'base restores only the variant exclusion');
  await page.locator('#three-undo').click();
  assert.deepEqual(await bodyIds(page), ['body-r', 'body-u', 'body-j'], 'manual undo history survives variant switches');
  await page.locator('#three-body-list').selectOption(['body-r']);
  await selectVariant(page, 'Economy');
  await page.locator('#three-body-list').focus(); await page.keyboard.press('Delete');
  await selectVariant(page, '');
  assert.deepEqual(await bodyIds(page), ['body-r', 'body-u', 'body-j'], 'Delete cannot remove a selected body hidden by the current variant');
  await selectVariant(page, 'Economy'); await set3D(page, false);
  assert.deepEqual(await notFittedNames(page), ['R99']);
  await noLayoutCrosses(page);
  await set3D(page, true); assert.deepEqual(await bodyIds(page), ['body-u', 'body-j']);
});

test('metadata loaded after documents associates unambiguous paths and keeps unrelated projects isolated', async t => {
  const { page } = await openPage(t, { render: (route, name) => {
    if (name === 'demo.PrjPcb') return reply(route, projectData(name, ['layout/board.PcbDoc', 'schematics/sheet.SchDoc']));
    if (name === 'other.PrjPcb') return reply(route, projectData(name, ['other.PcbDoc']));
    return defaultRender(route, name);
  } });
  await openFiles(page, ['board.PcbDoc', 'sheet.SchDoc', 'other.PcbDoc']);
  await openFiles(page, ['demo.PrjPcb']);
  await activate(page, 'board.PcbDoc'); await variantReady(page); await selectVariant(page, 'Economy');
  assert.deepEqual(await notFittedNames(page), ['R99']);
  await noLayoutCrosses(page);
  await activate(page, 'other.PcbDoc'); assert.deepEqual(await notFittedNames(page), []);
  await noLayoutCrosses(page);
  await openFiles(page, ['other.PrjPcb']); await variantReady(page);
  assert.equal(await page.locator('#variant-select').inputValue(), '', 'the second project starts in its own base state');
  await selectVariant(page, 'Full');
  await activate(page, 'sheet.SchDoc');
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.equal(await hasCross(page), true);
  await page.locator('#variant-project').selectOption('');
  assert.equal(await hasCross(page), false, 'explicitly detaching the document removes the project projection');
  await activate(page, 'board.PcbDoc');
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy', 'detaching one sheet does not clear the project selection');
  assert.deepEqual(await notFittedNames(page), ['R99']);
  await noLayoutCrosses(page);
});

test('initial documents restore the saved project variant regardless of metadata order', async t => {
  const project = { ...projectData(), current_variant: 'Economy' };
  const { page } = await openPage(t, { initial: { documents: [pcbData(), schematicData(), project] } });
  await loaded(page, 'sheet.SchDoc'); await variantReady(page);
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.equal(await hasCross(page), true);
  await activate(page, 'board.PcbDoc'); assert.deepEqual(await notFittedNames(page), ['R99']);
  await noLayoutCrosses(page);
  await selectVariant(page, '');
  await activate(page, 'sheet.SchDoc'); assert.equal(await hasCross(page), false);
});

test('a delayed document response uses the latest project selection without reverting the active tab', async t => {
  let delayedRoute, notifyRequest;
  const delayedRequest = new Promise(resolve => { notifyRequest = resolve; });
  const { page } = await openPage(t, { render: (route, name) => {
    if (name === 'board.PcbDoc') { delayedRoute = route; notifyRequest(); return; }
    return defaultRender(route, name);
  } });
  await page.locator('#file').setInputFiles(['demo.PrjPcb', 'board.PcbDoc', 'sheet.SchDoc'].map(name => file(name)));
  await delayedRequest; await loaded(page, 'sheet.SchDoc'); await variantReady(page);
  await selectVariant(page, 'Economy');
  await reply(delayedRoute, pcbData());
  await page.getByRole('tab', { name: 'board.PcbDoc', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#view > svg').getAttribute('data-board'), 'sheet.SchDoc');
  await activate(page, 'board.PcbDoc');
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.deepEqual(await notFittedNames(page), ['R99'], 'late render gets the current variant');
  await noLayoutCrosses(page);
});

test('the project upload endpoint reads real PrjPcb bytes and connects them to an open layout', async t => {
  const projectText = [
    '[Design]', 'CurrentVariant=Economy', '', '[Document1]', 'DocumentPath=board.PcbDoc',
    'DocumentUniqueId=board-id', '', '[ProjectVariant1]', 'UniqueId=VARIANT-ID', 'Description=Economy',
    'VariationCount=1', 'Variation1=Designator=R1|UniqueId=sheet-id\\component-r|Kind=1',
    'ParameterCount=0', 'ParamVariationCount=0', '',
  ].join('\r\n');
  const { page } = await openPage(t, { render: (route, name) => /\.prjpcb$/i.test(name) ? route.continue() : defaultRender(route, name) });
  await openFiles(page, ['board.PcbDoc']);
  await page.locator('#file').setInputFiles(file('actual.PrjPcb', projectText));
  await variantReady(page);
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.deepEqual(await notFittedNames(page), ['R99']);
  await noLayoutCrosses(page);
  assert.equal(await page.getByRole('tab').count(), 1);
  assert.ok((await page.locator('#file').getAttribute('accept')).toLowerCase().includes('.prjpcb'));
  assert.equal(await page.locator('#project-files').getAttribute('webkitdirectory') !== null, true);
  await selectVariant(page, '');
  const reloaded = page.waitForResponse(response => response.url().endsWith('/render'));
  await page.locator('#file').setInputFiles(file('actual.PrjPcb', projectText));
  await (await reloaded).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.locator('#variant-select').inputValue(), '', 'reloading project metadata preserves an explicit Base design choice');
  assert.deepEqual(await notFittedNames(page), []);
  await noLayoutCrosses(page);
});

test('folder uploads distinguish duplicate document basenames by project-relative path', async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'ecadview-variant-folders-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const project of ['Alpha', 'Beta']) {
    const folder = resolve(directory, project); await mkdir(folder);
    await writeFile(resolve(folder, `${project}.PrjPcb`), project);
    await writeFile(resolve(folder, 'board.PcbDoc'), project);
  }
  await writeFile(resolve(directory, 'unreferenced.PcbDoc'), 'unreferenced');
  const { page, requests } = await openPage(t, { render: (route, name) => {
    const owner = route.request().postDataBuffer().toString();
    if (/\.prjpcb$/i.test(name)) return reply(route, { ...projectData(name, ['board.PcbDoc']), current_variant: owner === 'Alpha' ? 'Economy' : 'Full' });
    return reply(route, pcbData(`${owner}.PcbDoc`));
  } });
  await page.locator('#project-files').setInputFiles(directory);
  await page.getByRole('tab', { name: 'Alpha.PcbDoc', exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('tab', { name: 'Beta.PcbDoc', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await page.getByRole('tab').count(), 2, 'unreferenced documents in the folder stay closed');
  assert.ok(!requests.includes('unreferenced.PcbDoc'));
  await activate(page, 'Alpha.PcbDoc');
  assert.match(await page.locator('#variant-project').evaluate(select => select.selectedOptions[0].textContent), /(?:^|\/)Alpha\.PrjPcb$/);
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.deepEqual(await notFittedNames(page), ['R99']);
  await noLayoutCrosses(page);
  await activate(page, 'Beta.PcbDoc');
  assert.match(await page.locator('#variant-project').evaluate(select => select.selectedOptions[0].textContent), /(?:^|\/)Beta\.PrjPcb$/);
  assert.equal(await page.locator('#variant-select').inputValue(), 'Full');
  assert.deepEqual(await notFittedNames(page), [], 'a sibling project with the same PCB filename keeps its own variant');
  assert.match(await page.locator('#variant-details').textContent(), /R99 — Fitted\nValue: 10k/);
  await noLayoutCrosses(page);
});

test('ordinary uploads keep same-name projects separate and require a choice for ambiguous documents', async t => {
  const second = projectData('demo.PrjPcb', ['board.PcbDoc']);
  second.variants[0].components = [
    { designator: 'U1', unique_id: 'sheet-id\\component-u', kind: 'not_fitted', parameters: {}, alternate_part: '' },
  ];
  const { page } = await openPage(t, { render: (route, name) => name === 'demo.PrjPcb'
    ? reply(route, { ...(route.request().postDataBuffer().toString() === 'second' ? second : projectData(name, ['board.PcbDoc'])), current_variant: 'Economy' })
    : defaultRender(route, name) });
  await openFiles(page, ['demo.PrjPcb', 'board.PcbDoc']); await variantReady(page);
  const firstProject = await page.locator('#variant-project').inputValue();
  assert.deepEqual(await notFittedNames(page), ['R99']);
  await noLayoutCrosses(page);
  await page.locator('#file').setInputFiles(file('demo.PrjPcb', 'second'));
  await page.waitForFunction(() => document.querySelectorAll('#variant-project option').length === 3);
  assert.equal(await page.locator('#variant-project').inputValue(), '', 'duplicate basenames do not silently pick or replace a project');
  assert.deepEqual(await notFittedNames(page), []);
  await noLayoutCrosses(page);
  await page.locator('#variant-project').selectOption(firstProject);
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.deepEqual(await notFittedNames(page), ['R99'], 'the first project remains intact');
  await noLayoutCrosses(page);
  const secondProject = await page.locator('#variant-project option').evaluateAll((options, first) => options.find(option => option.value && option.value !== first).value, firstProject);
  await page.locator('#variant-project').selectOption(secondProject);
  assert.deepEqual(await notFittedNames(page), ['U7'], 'the other same-name project has its own component choice');
  await noLayoutCrosses(page);
});
