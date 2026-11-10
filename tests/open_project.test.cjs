// Run with PLAYWRIGHT_CHANNEL=chrome node --test tests/open_project.test.cjs.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
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

const file = (name, bytes = name) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
const reply = (route, data, status = 200) => route.fulfill({ status, json: data });
const boardData = (name = 'board.PcbDoc') => ({
  kind: 'pcb', name, source: Buffer.from(name).toString('base64'),
  stats: { components: 1, pads: 1, tracks: 0, vias: 0, polygons: 0, regions: 0 },
  layout_components: [{ name: 'R1', source_name: 'R1', source_id: 'resistor', source_path: 'sheet\\resistor' }],
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <g id="scene">
      <g id="layer-top" data-layer-name="Top copper" data-layer-role="copper" data-layer-token="TOP">
        <rect data-component="R1" data-pad-number="1" data-net="GND" x="15" y="15" width="12" height="8" fill="red"/>
      </g>
      <g id="layer-bottom" data-layer-name="Bottom copper" data-layer-role="copper" data-layer-token="BOTTOM">
        <rect x="10" y="70" width="75" height="2" fill="blue"/>
      </g>
      <g id="board-outline"><rect width="100" height="80" fill="none" stroke="yellow"/></g>
    </g></svg>`,
});
const schematicData = (name = 'sheet.SchDoc') => ({
  kind: 'schematic', name, source: Buffer.from(name).toString('base64'),
  stats: { components: 1, wires: 0, net_labels: 0 },
  selection: { components: [{ id: 'resistor', name: 'R1', elements: ['resistor'], body_elements: ['body-r'] }], nets: [] },
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${name}">
    <g id="scene"><g id="sheet"><rect width="100" height="80" fill="white"/>
      <g id="resistor"><rect id="body-r" x="15" y="15" width="12" height="8" fill="yellow" stroke="brown"/></g>
    </g></g></svg>`,
});
const projectResponse = (key = 'project-demo', { warnings = [], boardName = 'board.PcbDoc', sheetName = 'sheet.SchDoc', projectName = 'demo.PrjPcb' } = {}) => {
  const project = { kind: 'project', name: projectName, project_key: key, project_label: `/projects/${key}/${projectName}`,
    source: Buffer.from('project-source').toString('base64'), documents: [boardName, `Schematics/${sheetName}`],
    current_variant: 'Economy', warnings,
    variants: [{ name: 'Economy', parameters: {}, components: [
      { designator: 'R1', unique_id: 'sheet\\resistor', kind: 'not_fitted', parameters: {}, alternate_part: '' },
    ] }] };
  return { documents: [project,
    { ...boardData(boardName), project_name: project.name, project_key: key, project_path: boardName },
    { ...schematicData(sheetName), project_name: project.name, project_key: key, project_path: `Schematics/${sheetName}` },
  ] };
};
async function openPage(t, { picker = route => reply(route, projectResponse()) } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [], uploads = [], picks = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.route('**/initial', route => reply(route, {}));
  await page.route('**/render', route => {
    const name = decodeURIComponent(route.request().headers()['x-filename']);
    uploads.push(name); return reply(route, boardData(name));
  });
  await page.route('**/open-project', route => {
    const request = route.request();
    picks.push({ method: request.method(), headers: request.headers(), body: request.postData() });
    return picker(route, picks.length);
  });
  await page.goto(origin);
  return { page, uploads, picks };
}
const loaded = (page, name) => page.waitForFunction(name =>
  document.querySelector('#view > svg')?.getAttribute('data-board') === name && document.getElementById('busy').style.display === 'none', name);
async function activate(page, name) {
  await page.getByRole('tab', { name, exact: true }).click(); await loaded(page, name);
}
async function dropFiles(page, files, target = '#view') {
  const transfer = await page.evaluateHandle(files => {
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(new File([Uint8Array.from(atob(file.source), character => character.charCodeAt(0))], file.name));
    return transfer;
  }, files.map(file => ({ name: file.name, source: file.buffer.toString('base64') })));
  try { await page.locator(target).dispatchEvent('drop', { dataTransfer: transfer }); }
  finally { await transfer.dispose(); }
}
async function pickerFinished(page) {
  await page.waitForFunction(() => !document.getElementById('open-project').disabled);
  assert.equal(await page.locator('#open-project-spinner').isHidden(), true);
  assert.equal(await page.locator('#open-project-label').textContent(), 'Open project…');
  assert.equal(await page.locator('#open-project').getAttribute('aria-busy'), 'false');
}
async function pickerLoading(page) {
  assert.equal(await page.locator('#open-project').isDisabled(), true);
  assert.equal(await page.locator('#open-project-spinner').isVisible(), true);
  assert.equal(await page.locator('#open-project-label').textContent(), 'Loading project…');
  assert.equal(await page.locator('#open-project').getAttribute('aria-busy'), 'true');
}
const activeName = page => page.locator('#view > svg').getAttribute('data-board');
const snapshot = page => page.evaluate(() => ({
  name: document.querySelector('#view > svg')?.getAttribute('data-board'),
  viewBox: document.querySelector('#view > svg')?.getAttribute('viewBox'),
  layers: [...document.querySelectorAll('#layers input')].map(input => input.checked),
  measurement: document.getElementById('measure')?.innerHTML,
}));

test('Open project loads referenced drawings and saved variants alongside existing tabs without reuploading', async t => {
  const warning = 'Could not open project document missing.SchDoc: File not found';
  const { page, picks, uploads } = await openPage(t, { picker: route => reply(route, projectResponse('project-demo', { warnings: [warning] })) });
  await page.locator('#file').setInputFiles(file('existing.PcbDoc')); await loaded(page, 'existing.PcbDoc');
  assert.equal(await page.getByRole('button', { name: 'Open project…', exact: true }).count(), 1);
  assert.equal(await page.locator('#open-project-status').getAttribute('role'), 'status');
  await page.locator('#open-project').click();
  await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 3); await pickerFinished(page);
  assert.deepEqual(uploads, ['existing.PcbDoc'], 'returned documents are mounted directly from the local backend');
  assert.equal(picks.length, 1);
  assert.equal(picks[0].method, 'POST');
  assert.equal(picks[0].headers['x-viewer-request'], 'open-project');
  assert.equal(picks[0].headers['x-project-name'], undefined, 'the button opens the native chooser without a dropped-file hint');
  assert.equal(picks[0].headers['x-project-sha256'], undefined);
  assert.ok(!picks[0].body, 'the browser never submits a local filesystem path');
  await activate(page, 'sheet.SchDoc');
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.equal(await page.locator('#variant-overlay [data-variant-component="R1"]').count(), 1);
  assert.match(await page.locator('#open-project-status').textContent(), /missing\.SchDoc/);
  await activate(page, 'board.PcbDoc');
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.equal(await page.locator('#variant-overlay').count(), 0, 'opening a project preserves the unmarked PCB layout');
  await activate(page, 'existing.PcbDoc');
  assert.equal(await page.locator('#variant-project').inputValue(), '', 'unrelated open documents are not attached to the new project');
});

test('reopening a selected project reuses its tabs and preserves document and variant choices', async t => {
  const { page, uploads, picks } = await openPage(t);
  await page.locator('#open-project').click();
  await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 2); await pickerFinished(page);
  await activate(page, 'board.PcbDoc');
  await page.locator('#variant-select').selectOption('');
  await page.locator('#layers label').filter({ hasText: 'Bottom copper' }).locator('input').uncheck();
  await page.locator('#zoom-in').click();
  await page.locator('#measure-btn').click();
  await page.locator('#view').click({ position: { x: 300, y: 320 } });
  await page.locator('#view').click({ position: { x: 360, y: 360 } });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#measure .measurement-segment').count(), 1);
  const before = await snapshot(page);
  await page.locator('#open-project').click(); await pickerFinished(page);
  await activate(page, 'board.PcbDoc');
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.equal(await page.locator('#variant-project option').count(), 2, 'project metadata is reused too');
  assert.equal(await page.locator('#variant-select').inputValue(), '', 'explicit Base design choice is retained');
  assert.deepEqual(await snapshot(page), before);
  assert.deepEqual(uploads, []); assert.equal(picks.length, 2);
  const reopened = page.waitForResponse(response => response.url().endsWith('/open-project'));
  await dropFiles(page, [file('demo.PrjPcb', 'project-source')]); await reopened;
  await pickerFinished(page); await activate(page, 'board.PcbDoc');
  assert.equal(picks.length, 3);
  assert.equal(await page.getByRole('tab').count(), 2, 'dropping the project reuses the same tabs opened by the button');
  assert.equal(await page.locator('#variant-project option').count(), 2);
  assert.equal(await page.locator('#variant-select').inputValue(), '');
  assert.deepEqual(await snapshot(page), before);
  assert.deepEqual(uploads, []);
});

test('cancelling or failing a native project picker preserves the workspace and restores the button', async t => {
  let picked;
  const { page, picks } = await openPage(t, { picker: route => picked(route) });
  await page.locator('#file').setInputFiles(file('existing.PcbDoc')); await loaded(page, 'existing.PcbDoc');
  await page.locator('#zoom-in').click();
  await page.waitForFunction(() => document.querySelector('#view > svg').getAttribute('viewBox') !== '0 0 100 80');
  const before = await snapshot(page);
  let request = new Promise(resolve => { picked = resolve; });
  await page.locator('#open-project').click();
  let route = await request; await pickerLoading(page);
  await reply(route, { cancelled: true }); await pickerFinished(page);
  assert.equal((await page.locator('#open-project-status').textContent()).trim(), '');
  assert.deepEqual(await snapshot(page), before);
  request = new Promise(resolve => { picked = resolve; });
  await page.locator('#open-project').click();
  route = await request; await pickerLoading(page);
  await reply(route, { error: 'Native project dialog unavailable' }, 503); await pickerFinished(page);
  assert.match(await page.locator('#open-project-status').textContent(), /Native project dialog unavailable/);
  assert.deepEqual(await snapshot(page), before);
  assert.equal(await page.getByRole('tab').count(), 1); assert.equal(picks.length, 2);
  assert.equal(await page.locator('#open').isEnabled(), true, 'manual file selection remains available if the native picker fails');
});

test('a pending picker accepts one request and a late response does not replace the tab selected while waiting', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { page, picks } = await openPage(t, { picker: async route => {
    started(); await pending; return reply(route, projectResponse());
  } });
  await page.locator('#file').setInputFiles([file('first.PcbDoc'), file('second.PcbDoc')]); await loaded(page, 'second.PcbDoc');
  await page.locator('#open-project').evaluate(button => { button.click(); button.click(); });
  await entered;
  await pickerLoading(page);
  assert.ok((await page.locator('#open-project-status').textContent()).trim());
  await activate(page, 'first.PcbDoc'); const before = await snapshot(page);
  release();
  await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 4); await pickerFinished(page);
  assert.equal(picks.length, 1); assert.equal(await activeName(page), 'first.PcbDoc');
  assert.deepEqual(await snapshot(page), before);
  await activate(page, 'sheet.SchDoc'); assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
});

test('different projects with the same filenames keep separate tabs and saved variant state', async t => {
  const { page } = await openPage(t, { picker: (route, count) => {
    const data = projectResponse(count === 1 ? 'project-one' : 'project-two');
    if (count > 1) data.documents[0].current_variant = null;
    return reply(route, data);
  } });
  await page.locator('#open-project').click();
  await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 2); await pickerFinished(page);
  await page.locator('#open-project').click();
  await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 4); await pickerFinished(page);
  const sheets = page.getByRole('tab', { name: 'sheet.SchDoc', exact: true });
  await sheets.first().click(); await loaded(page, 'sheet.SchDoc');
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.match(await page.locator('#variant-project').evaluate(select => select.selectedOptions[0].textContent), /project-one/);
  await sheets.last().click(); await loaded(page, 'sheet.SchDoc');
  assert.equal(await page.locator('#variant-select').inputValue(), '');
  assert.match(await page.locator('#variant-project').evaluate(select => select.selectedOptions[0].textContent), /project-two/);
});

test('a project whose linked documents are missing still exposes its saved variants and warnings', async t => {
  const warning = 'Could not open project document Schematics/sheet.SchDoc: File not found';
  const data = projectResponse('missing-documents', { warnings: [warning] });
  data.documents = data.documents.filter(document => document.kind === 'project');
  const { page, uploads } = await openPage(t, { picker: route => reply(route, data) });
  await page.locator('#open-project').click(); await pickerFinished(page);
  assert.equal(await page.getByRole('tab').count(), 0);
  assert.equal(await page.locator('#variant-controls').isVisible(), true);
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.match(await page.locator('#open-project-status').textContent(), /Schematics\/sheet\.SchDoc: File not found/);
  assert.match(await page.locator('#open-project-status').textContent(), /No linked documents loaded/);
  await page.locator('#open-project').click(); await pickerFinished(page);
  assert.equal(await page.locator('#variant-project option').count(), 2, 'metadata is reused even when no linked document is loaded');
  assert.deepEqual(uploads, []);
});

test('project controls omit the folder picker and variant details while keeping manual file selection', async t => {
  const { page, picks } = await openPage(t);
  await pickerFinished(page);
  assert.equal(await page.locator('#open-project-folder, #project-files, #variant-status, #variant-details').count(), 0);
  await page.locator('#open-project').click(); await pickerFinished(page);
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.equal(await page.locator('#variant-status, #variant-details').count(), 0);
  const chooserReady = page.waitForEvent('filechooser');
  await page.locator('#open').click();
  const chooser = await chooserReady;
  assert.equal(await chooser.element().getAttribute('id'), 'file');
  assert.equal(await chooser.element().getAttribute('webkitdirectory'), null);
  assert.equal(chooser.isMultiple(), true);
  assert.equal(picks.length, 1);
});

test('dropping a project uses the native opener with its filename and byte digest and loads linked documents', async t => {
  let picked;
  const pending = new Promise(resolve => { picked = resolve; });
  const { page, picks, uploads } = await openPage(t, { picker: route => picked(route) });
  const project = file('controller rev A.PrjPcb', Buffer.from([0xff, 0xfe, 0x50, 0x00, 0x52, 0x00]));
  await dropFiles(page, [project]);
  const route = await pending; await pickerLoading(page);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].method, 'POST');
  assert.equal(picks[0].headers['x-viewer-request'], 'open-project');
  assert.equal(picks[0].headers['x-project-name'], encodeURIComponent(project.name));
  assert.equal(picks[0].headers['x-project-sha256'], createHash('sha256').update(project.buffer).digest('hex'));
  assert.ok(!picks[0].body, 'dropped file bytes are hashed locally, not sent as a path or request body');
  assert.deepEqual(uploads, [], 'a dropped project does not use the metadata-only upload route');
  await reply(route, projectResponse('controller', { projectName: project.name }));
  await loaded(page, 'sheet.SchDoc'); await pickerFinished(page);
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.equal(await page.locator('#variant-overlay [data-variant-component="R1"]').count(), 1);
  assert.deepEqual(uploads, []);
});

test('cancelling or failing a dropped project stops its mixed batch and leaves the workspace intact', async t => {
  let picked;
  const { page, picks, uploads } = await openPage(t, { picker: route => picked(route) });
  await page.locator('#file').setInputFiles(file('existing.PcbDoc')); await loaded(page, 'existing.PcbDoc');
  await page.locator('#layers label').filter({ hasText: 'Bottom copper' }).locator('input').uncheck();
  const before = await snapshot(page);
  for (const outcome of [{ data: { cancelled: true }, status: 200 },
    { data: { error: 'Selected project does not match the dropped file' }, status: 400 }]) {
    const pending = new Promise(resolve => { picked = resolve; });
    await dropFiles(page, [file('demo.PrjPcb'), file('unrelated.PcbDoc')]);
    const route = await pending; await pickerLoading(page);
    await reply(route, outcome.data, outcome.status); await pickerFinished(page);
    assert.deepEqual(await snapshot(page), before);
    assert.equal(await page.getByRole('tab').count(), 1);
    assert.deepEqual(uploads, ['existing.PcbDoc'], 'cancelled/failed project batches do not open trailing files');
    assert.equal((await page.locator('#open-project-status').textContent()).trim(), outcome.data.error
      ? `Could not open project: ${outcome.data.error}` : '');
  }
  assert.equal(picks.length, 2);
});

test('a pending dropped project rejects concurrent drops and preserves navigation when it finishes', async t => {
  let picked;
  const pending = new Promise(resolve => { picked = resolve; });
  const { page, picks, uploads } = await openPage(t, { picker: route => picked(route) });
  await page.locator('#file').setInputFiles([file('first.PcbDoc'), file('second.PcbDoc')]); await loaded(page, 'second.PcbDoc');
  await dropFiles(page, [file('demo.PrjPcb')], '#panel');
  const route = await pending; await pickerLoading(page);
  await dropFiles(page, [file('another.PrjPcb'), file('unrelated.PcbDoc')]);
  await page.locator('#open-project').evaluate(button => button.click());
  assert.equal(await page.locator('#toast').isVisible(), true);
  assert.ok((await page.locator('#toast').textContent()).trim(), 'a busy drop receives feedback');
  assert.equal(picks.length, 1);
  await activate(page, 'first.PcbDoc'); const before = await snapshot(page);
  await reply(route, projectResponse());
  await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 4); await pickerFinished(page);
  assert.equal(picks.length, 1);
  assert.deepEqual(uploads, ['first.PcbDoc', 'second.PcbDoc']);
  assert.deepEqual(await snapshot(page), before);
  await activate(page, 'sheet.SchDoc');
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
});

test('mixed project drops skip returned companions only when both filename and bytes match', async t => {
  const { page, picks, uploads } = await openPage(t);
  await dropFiles(page, [file('demo.PrjPcb'), file('board.PcbDoc'), file('sheet.SchDoc'),
    file('unrelated.PcbDoc', 'board.PcbDoc'), file('board.PcbDoc', 'different board bytes')]);
  await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 4);
  await loaded(page, 'board.PcbDoc'); await pickerFinished(page);
  assert.equal(picks.length, 1);
  assert.deepEqual(uploads, ['unrelated.PcbDoc', 'board.PcbDoc'], 'explicit unmatched files open without duplicate linked documents');
  assert.equal(await page.getByRole('tab', { name: 'sheet.SchDoc', exact: true }).count(), 1);
  assert.equal(await page.getByRole('tab', { name: 'board.PcbDoc', exact: true }).count(), 2,
    'a same-name file with different content is kept');
  assert.equal(await page.getByRole('tab', { name: 'unrelated.PcbDoc', exact: true }).count(), 1,
    'matching bytes alone do not hide an explicitly dropped file');
  await activate(page, 'sheet.SchDoc');
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
});

test('multiple dropped projects open sequentially with their own native picker hints', async t => {
  let picked;
  const { page, picks, uploads } = await openPage(t, { picker: route => picked(route) });
  let pending = new Promise(resolve => { picked = resolve; });
  await dropFiles(page, [file('first.PrjPcb'), file('second.PrjPcb')]);
  let route = await pending; await pickerLoading(page);
  assert.equal(picks.length, 1, 'the second picker waits for the first project to finish');
  pending = new Promise(resolve => { picked = resolve; });
  await reply(route, projectResponse('first-project', { projectName: 'first.PrjPcb' }));
  route = await pending; await pickerLoading(page);
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.deepEqual(picks.map(pick => pick.headers['x-project-name']), ['first.PrjPcb', 'second.PrjPcb']);
  await reply(route, projectResponse('second-project', { projectName: 'second.PrjPcb' }));
  await page.waitForFunction(() => document.querySelectorAll('[role="tab"]').length === 4); await pickerFinished(page);
  assert.deepEqual(uploads, []);
  assert.equal(await page.locator('#variant-project option').count(), 3);
});
