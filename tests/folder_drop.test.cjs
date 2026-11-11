// Run with PLAYWRIGHT_CHANNEL=chrome node --test tests/folder_drop.test.cjs.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
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

const projectData = (documents = ['board.PcbDoc', 'sheet.SchDoc']) => ({
  kind: 'project', documents, current_variant: 'Economy', warnings: [],
  variants: [{ name: 'Economy', parameters: {}, components: [
    { designator: 'R1', unique_id: 'sheet\\resistor', kind: 'not_fitted', parameters: {}, alternate_part: '' },
  ] }],
});
const drawing = (id, kind = 'pcb') => ({ kind, id });
const rendered = (name, data) => ({
  name, kind: data.kind, stats: { components: 1, pads: 1, tracks: 0, vias: 0, polygons: 0, regions: 0, wires: 0, net_labels: 0 },
  layout_components: [{ name: 'R1', source_name: 'R1', source_id: 'resistor', source_path: 'sheet\\resistor' }],
  selection: { components: [{ id: 'resistor', name: 'R1', elements: ['resistor'], body_elements: ['body-r'] }], nets: [] },
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80" data-board="${data.id}">
    <g id="scene">${data.kind === 'schematic'
      ? '<g id="sheet"><g id="resistor"><rect id="body-r" x="15" y="15" width="12" height="8" fill="yellow" stroke="brown"/></g></g>'
      : `<g id="layer-top" data-layer-name="Top copper" data-layer-role="copper" data-layer-token="TOP">
          <rect data-component="R1" data-pad-number="1" data-net="GND" x="15" y="15" width="12" height="8" fill="red"/>
        </g><g id="layer-bottom" data-layer-name="Bottom copper" data-layer-role="copper" data-layer-token="BOTTOM">
          <rect x="10" y="70" width="75" height="2" fill="blue"/>
        </g><g id="board-outline"><rect width="100" height="80" fill="none" stroke="yellow"/></g>`}
    </g></svg>`,
});
const nativeFile = (name, data) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(JSON.stringify(data)) });
const basicFolder = (id = 'folder-one', name = 'Design') => ({ id, name, files: {
  'demo.PrjPcb': projectData(), 'board.PcbDoc': drawing(`${id}-pcb`), 'sheet.SchDoc': drawing(`${id}-sch`, 'schematic'),
} });
const reply = (route, data, status = 200) => route.fulfill({ status, json: data });
const renderReply = (route, name, data) => data.error ? reply(route, { error: data.error }, 500)
  : reply(route, data.kind === 'project' ? { ...data, name } : rendered(name, data));
async function openPage(t, { render = renderReply } = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [], uploads = [], picks = [], choosers = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('filechooser', chooser => choosers.push(chooser));
  t.after(async () => {
    await page.close();
    assert.deepEqual(errors, []);
    assert.deepEqual(picks, [], 'dragging files or folders never invokes the native project picker');
    assert.deepEqual(choosers, [], 'dropping a folder does not open another file chooser');
  });
  await page.route('**/initial', route => reply(route, {}));
  await page.route('**/open-project', route => { picks.push(route.request().url()); return reply(route, { cancelled: true }); });
  await page.route('**/render', route => {
    const name = decodeURIComponent(route.request().headers()['x-filename']);
    const data = JSON.parse(route.request().postDataBuffer().toString());
    uploads.push({ name, data, webgl: route.request().headers()['x-webgl'] });
    return render(route, name, data);
  });
  await page.goto(origin);
  return { page, uploads, picks };
}

// Native DragEvents use mocked browser handle/entry APIs, without exposing any
// product internals. Every drop creates fresh wrappers for the same root id.
async function dropFolder(page, folder, { mode = 'modern', target = '#view', track = true } = {}) {
  await page.locator(target).evaluate((target, { folder, mode, track }) => {
    const tree = { kind: 'directory', name: folder.name, children: new Map() };
    for (const [path, data] of Object.entries(folder.files)) {
      const parts = path.split('/'); let node = tree;
      for (const name of parts.slice(0, -1)) {
        if (!node.children.has(name)) node.children.set(name, { kind: 'directory', name, children: new Map() });
        node = node.children.get(name);
      }
      node.children.set(parts.at(-1), { kind: 'file', name: parts.at(-1), data });
    }
    const makeFile = node => new File([JSON.stringify(node.data)], node.name);
    const handle = (node, path) => ({
      kind: node.kind, name: node.name, identity: `${folder.id}/${path}`,
      async isSameEntry(other) { window.sameEntryChecks = (window.sameEntryChecks || 0) + 1; return this.identity === other.identity; },
      async getFile() { if (node.data?.readError) throw new Error(node.data.readError); return makeFile(node); },
      async *values() { for (const child of node.children.values()) yield handle(child, `${path}/${child.name}`); },
      async *entries() { for (const child of node.children.values()) yield [child.name, handle(child, `${path}/${child.name}`)]; },
    });
    const entry = (node, path) => ({
      name: node.name, fullPath: `/${path}`, isFile: node.kind === 'file', isDirectory: node.kind === 'directory',
      file(success) { queueMicrotask(() => success(makeFile(node))); },
      createReader() {
        const children = [...node.children.values()]; let offset = 0;
        return { readEntries(success) {
          window.legacyReads ||= {}; window.legacyReads[path] = (window.legacyReads[path] || 0) + 1;
          const batch = children.slice(offset, offset + 100).map(child => entry(child, `${path}/${child.name}`)); offset += batch.length;
          queueMicrotask(() => success(batch));
        } };
      },
    });
    const transfer = new DataTransfer(); transfer.items.add(new File([], folder.name));
    const prototype = Object.getPrototypeOf(transfer.items[0]); let live = true;
    const capture = value => { if (!live) throw new Error('Drop items were read after the event ended'); return value; };
    const methods = {
      getAsFileSystemHandle: () => capture(Promise.resolve(mode === 'modern' ? handle(tree, folder.name) : null)),
      webkitGetAsEntry: () => capture(entry(tree, folder.name)),
    };
    const originals = Object.fromEntries(Object.keys(methods).map(name => [name, Object.getOwnPropertyDescriptor(prototype, name)]));
    for (const [name, value] of Object.entries(methods)) Object.defineProperty(prototype, name, { configurable: true, value });
    if (track) {
      window.folderDropDone = false; let loading = false;
      const observer = new MutationObserver(() => {
        if (document.getElementById('open-project').disabled) loading = true;
        else if (loading) { window.folderDropDone = true; observer.disconnect(); }
      });
      observer.observe(document.getElementById('open-project'), { attributes: true, attributeFilter: ['disabled'] });
    }
    try { target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); }
    finally {
      live = false;
      for (const [name, descriptor] of Object.entries(originals)) {
        if (descriptor) Object.defineProperty(prototype, name, descriptor); else delete prototype[name];
      }
    }
  }, { folder, mode, track });
}
async function dropLoose(page, files) {
  await page.locator('#view').evaluate((target, files) => {
    const transfer = new DataTransfer();
    for (const { name, data } of files) transfer.items.add(new File([JSON.stringify(data)], name));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
  }, files);
}
const loaded = (page, id) => page.waitForFunction(id => document.querySelector('#view > svg')?.getAttribute('data-board') === id
  && document.getElementById('busy').style.display === 'none', id);
async function finished(page) {
  await page.waitForFunction(() => window.folderDropDone);
  assert.equal(await page.locator('#open-project-spinner').isHidden(), true);
  assert.equal(await page.locator('#open-project').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#open-project-label').textContent(), 'Open project…');
}
async function loading(page) {
  assert.equal(await page.locator('#open-project-spinner').isVisible(), true);
  assert.equal(await page.locator('#open-project').isDisabled(), true);
  assert.equal(await page.locator('#open-project').getAttribute('aria-busy'), 'true');
}
const snapshot = page => page.evaluate(() => ({
  id: document.querySelector('#view > svg')?.getAttribute('data-board'),
  viewBox: document.querySelector('#view > svg')?.getAttribute('viewBox'),
  layers: [...document.querySelectorAll('#layers input')].map(input => input.checked),
  measurement: document.getElementById('measure')?.innerHTML,
}));

test('dropping a folder loads only project references by full nested paths and restores its saved variant', async t => {
  const { page, uploads } = await openPage(t);
  const folder = { id: 'nested', name: 'Workspace', files: {
    'Projects/demo.PrjPcb': projectData(['../Layouts/A/main.PcbDoc', '..\\Layouts\\B\\main.PcbDoc', '../Sheets/sheet.SchDoc']),
    'Layouts/A/main.PcbDoc': drawing('layout-a'), 'Layouts/B/main.PcbDoc': drawing('layout-b'),
    'Sheets/sheet.SchDoc': drawing('sheet', 'schematic'), 'main.PcbDoc': drawing('unreferenced'), 'notes.txt': 'notes',
  } };
  await dropFolder(page, folder, { target: '#panel' }); await finished(page);
  assert.equal(await page.locator('#project-folder-hint').isVisible(), false);
  assert.equal(await page.getByRole('tab').count(), 3, JSON.stringify({ uploads, status: await page.locator('#open-project-status').textContent() }));
  assert.deepEqual(uploads.filter(upload => upload.data.kind !== 'project').map(upload => upload.data.id).sort(), ['layout-a', 'layout-b', 'sheet']);
  assert.ok(uploads.filter(upload => upload.data.kind !== 'project').every(upload => upload.webgl === '1'));
  const boards = page.getByRole('tab', { name: 'main.PcbDoc', exact: true });
  await boards.first().click(); await loaded(page, 'layout-a');
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.equal(await page.locator('#variant-overlay').count(), 0);
  await boards.last().click(); await loaded(page, 'layout-b');
  assert.equal(await page.locator('#variant-overlay').count(), 0);
  await page.getByRole('tab', { name: 'sheet.SchDoc', exact: true }).click(); await loaded(page, 'sheet');
  assert.equal(await page.locator('#variant-overlay [data-variant-component="R1"]').count(), 1);
});

test('legacy directory drops read every page and find a referenced document beyond the first hundred entries', async t => {
  const { page, uploads } = await openPage(t);
  const folder = { id: 'legacy', name: 'Legacy', files: { 'demo.PrjPcb': projectData(['last.PcbDoc']) } };
  for (let index = 0; index < 105; index++) folder.files[`unused-${index}.PcbDoc`] = drawing(`unused-${index}`);
  folder.files['last.PcbDoc'] = drawing('last');
  await dropFolder(page, folder, { mode: 'legacy' }); await finished(page); await loaded(page, 'last');
  assert.equal(await page.getByRole('tab').count(), 1);
  assert.deepEqual(uploads.map(upload => upload.name), ['demo.PrjPcb', 'last.PcbDoc']);
  assert.equal(await page.evaluate(() => window.legacyReads.Legacy), 3, 'two nonempty pages and the terminating empty page are consumed');
});

test('missing, outside-root and failed linked documents warn without substituting same-name files', async t => {
  const { page, uploads } = await openPage(t);
  const folder = { id: 'partial', name: 'Partial', files: {
    'demo.PrjPcb': projectData(['good.PcbDoc', 'missing/board.PcbDoc', '../../outside.PcbDoc', 'bad.SchDoc', 'unreadable.SchDoc']),
    'good.PcbDoc': drawing('good'), 'other/board.PcbDoc': drawing('wrong-directory'),
    'outside.PcbDoc': drawing('outside'), 'bad.SchDoc': { kind: 'schematic', error: 'Invalid schematic bytes' },
    'unreadable.SchDoc': { readError: 'Linked file access denied' },
    'archived.PcbDoc': { readError: 'Unreferenced archive cannot be read' },
  } };
  await dropFolder(page, folder); await finished(page); await loaded(page, 'good');
  assert.equal(await page.getByRole('tab').count(), 1);
  assert.deepEqual(uploads.map(upload => upload.name).sort(), ['bad.SchDoc', 'demo.PrjPcb', 'good.PcbDoc']);
  const status = await page.locator('#open-project-status').textContent();
  for (const text of ['missing/board.PcbDoc', '../../outside.PcbDoc', 'bad.SchDoc', 'Invalid schematic bytes', 'unreadable.SchDoc', 'Linked file access denied']) assert.ok(status.includes(text), text);
  assert.doesNotMatch(status, /Unreferenced archive cannot be read|archived\.PcbDoc/, 'unreferenced unreadable files do not block or warn about the project');
});

test('a pending folder load shares the spinner, rejects concurrent opening and preserves a later tab selection', { timeout: 15000 }, async t => {
  let requested;
  const pending = new Promise(resolve => { requested = resolve; });
  const { page, uploads } = await openPage(t, { render: (route, name, data) => data.kind === 'project'
    ? requested({ route, name, data }) : renderReply(route, name, data) });
  await page.locator('#file').setInputFiles([nativeFile('first.PcbDoc', drawing('first')), nativeFile('second.PcbDoc', drawing('second'))]);
  await loaded(page, 'second');
  await dropFolder(page, basicFolder());
  const request = await pending; await loading(page);
  await dropFolder(page, basicFolder('rejected'), { track: false });
  await page.locator('#open-project').evaluate(button => button.click());
  assert.equal(await page.locator('#toast').isVisible(), true);
  assert.ok((await page.locator('#toast').textContent()).trim());
  await page.getByRole('tab', { name: 'first.PcbDoc', exact: true }).click(); await loaded(page, 'first');
  const before = await snapshot(page);
  await renderReply(request.route, request.name, request.data); await finished(page);
  assert.equal(await page.getByRole('tab').count(), 4);
  assert.deepEqual(await snapshot(page), before);
  assert.equal(uploads.filter(upload => upload.data.kind === 'project').length, 1);
});

test('dropping the same directory again reuses its tabs and preserves manual variant and view choices', async t => {
  const { page } = await openPage(t); const folder = basicFolder();
  await dropFolder(page, folder); await finished(page);
  await page.getByRole('tab', { name: 'board.PcbDoc', exact: true }).click(); await loaded(page, 'folder-one-pcb');
  await page.locator('#variant-select').selectOption('');
  await page.locator('#layers label').filter({ hasText: 'Bottom copper' }).locator('input').uncheck();
  await page.locator('#zoom-in').click(); await page.locator('#measure-btn').click();
  await page.locator('#view').click({ position: { x: 300, y: 320 } });
  await page.locator('#view').click({ position: { x: 360, y: 360 } }); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#measure .measurement-segment').count(), 1);
  const before = await snapshot(page);
  await dropFolder(page, folder); await finished(page);
  await page.getByRole('tab', { name: 'board.PcbDoc', exact: true }).click(); await loaded(page, 'folder-one-pcb');
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.equal(await page.locator('#variant-project option').count(), 2);
  assert.equal(await page.locator('#variant-select').inputValue(), '');
  assert.deepEqual(await snapshot(page), before);
  assert.ok(await page.evaluate(() => window.sameEntryChecks > 0), 'fresh handle wrappers are compared by filesystem identity');
});

test('different directories with identical names and project bytes remain separate', async t => {
  const { page } = await openPage(t);
  await dropFolder(page, basicFolder('first-root')); await finished(page);
  await page.locator('#variant-select').selectOption('');
  const firstProject = await page.locator('#variant-project').inputValue();
  await dropFolder(page, basicFolder('second-root')); await finished(page);
  assert.equal(await page.getByRole('tab').count(), 4);
  assert.equal(await page.locator('#variant-project option').count(), 3);
  assert.notEqual(await page.locator('#variant-project').inputValue(), firstProject);
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  await page.getByRole('tab', { name: 'sheet.SchDoc', exact: true }).first().click(); await loaded(page, 'first-root-sch');
  assert.equal(await page.locator('#variant-project').inputValue(), firstProject);
  assert.equal(await page.locator('#variant-select').inputValue(), '');
});

test('a lone project drop explains folder access and loose project-plus-document drops still open normally', async t => {
  const { page, uploads } = await openPage(t);
  const project = { name: 'demo.PRJPCB', data: projectData() };
  await dropLoose(page, [project]);
  const hint = page.getByRole('dialog', { name: 'Drop the whole project folder' });
  await hint.waitFor({ state: 'visible' });
  assert.match(await hint.innerText(), /schematic|\.schdoc/i);
  assert.match(await hint.innerText(), /layout|\.pcbdoc/i);
  await page.waitForFunction(() => document.querySelector('#variant-select')?.value === 'Economy');
  await hint.getByRole('button', { name: 'OK', exact: true }).click();
  await hint.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('tab').count(), 0);
  await dropLoose(page, [project, { name: 'board.PcbDoc', data: drawing('loose-pcb') },
    { name: 'sheet.SchDoc', data: drawing('loose-sch', 'schematic') }]);
  await loaded(page, 'loose-sch');
  assert.equal(await hint.isVisible(), false);
  assert.equal(await page.getByRole('tab').count(), 2);
  assert.equal(await page.locator('#variant-select').inputValue(), 'Economy');
  assert.equal(await page.locator('#variant-overlay [data-variant-component="R1"]').count(), 1);
  assert.deepEqual(uploads.filter(upload => upload.data.kind !== 'project').map(upload => upload.name), ['board.PcbDoc', 'sheet.SchDoc']);
});

test('dropping the containing folder on the open hint dismisses it and loads the drawings', async t => {
  const { page } = await openPage(t);
  await dropLoose(page, [{ name: 'demo.PrjPcb', data: projectData() }]);
  const hint = page.getByRole('dialog', { name: 'Drop the whole project folder' });
  await hint.waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.getElementById('open-project').disabled);
  await dropFolder(page, basicFolder(), { target: '#project-folder-hint' }); await finished(page);
  assert.equal(await hint.isVisible(), false);
  assert.equal(await page.getByRole('tab').count(), 2);
  await loaded(page, 'folder-one-sch');
});
