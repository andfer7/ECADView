// Real WebGL 2 + local isolated compiler. npm run test:gpu
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
  origin = await new Promise((done, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(new Error(errors || 'Server startup timed out')), 20000);
    server.stderr.on('data', data => { errors += data; });
    server.stdout.on('data', data => {
      output += data; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) { clearTimeout(timer); done(match[0]); }
    });
    server.on('error', reject);
  });
  browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
  const keeper = await browser.newPage(); await keeper.goto(origin);
});
after(async () => {
  await browser?.close();
  if (server?.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
});
const fixture = (name = 'GPU.PcbDoc') => ({
  name, kind: 'pcb', webgl: true, source: '', polygon_elements: ['pour'],
  stats: { components: 1, pads: 1, vias: 1, tracks: 2, polygons: 1, regions: 0 },
  svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><g id="scene" transform="translate(2 3)">
    <g id="layer-top" data-layer-role="copper" data-layer-name="Top copper">
      <path id="pour" fill="#00aa00" fill-rule="evenodd" d="M5 5H35V30H5Z M12 12H20V20H12Z"/>
      <rect data-component="U1" data-net="GND" data-primitive="pad" data-pad-number="1" x="50" y="10" width="12" height="10" rx="2" fill="#ff0000"/>
      <line data-net="GND" x1="8" y1="45" x2="80" y2="45" stroke="#ff0000" stroke-width="3" stroke-linecap="round"/>
      <circle data-net="GND" data-primitive="via" cx="75" cy="15" r="4" fill="#ff0000"/>
      <ellipse cx="43" cy="63" rx="6" ry="3" fill="#00ff00" fill-opacity=".5"/>
      <text x="5" y="65" font-size="5" fill="white">U1 test</text>
    </g>
    <g id="layer-bottom" data-layer-role="copper" data-layer-name="Bottom copper">
      <line data-net="OTHER" x1="45" y1="30" x2="45" y2="58" stroke="#0000ff" stroke-width="3"/>
    </g>
    <g id="layer-drills" data-layer-role="drill" data-layer-name="Drills">
      <circle data-hole-owner="via" data-primitive="via-hole" cx="75" cy="15" r="1.5" fill="#1b1d21"/>
      <path data-hole-owner="pad" data-primitive="pad-hole" d="M54 15h4" stroke="#1b1d21" stroke-width="2" stroke-linecap="round"/>
    </g></g></svg>`,
});
async function pageFor(t, data = fixture(), init) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  if (init) await page.addInitScript(init);
  await page.route('**/initial', route => route.fulfill({ json: data }));
  await page.route('**/render', route => route.fulfill({ json: fixture(decodeURIComponent(route.request().headers()['x-filename'])) }));
  await page.goto(origin);
  return page;
}
const ready = page => page.waitForFunction(() => document.querySelector('#view').classList.contains('gpu-layout'), undefined, { timeout: 30000 });
const dataset = page => page.locator('.layout-webgl').evaluate(canvas => ({ ...canvas.dataset }));
async function point(page, x, y) {
  return page.locator('#view > svg').evaluate((svg, [x, y]) => {
    const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM()); return { x: p.x, y: p.y };
  }, [x, y]);
}
async function colors(page, coords) {
  const points = await Promise.all(coords.map(([x, y]) => point(page, x, y)));
  const data = (await page.screenshot()).toString('base64');
  return page.evaluate(async ({ data, points }) => {
    const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob());
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
    return points.map(p => [...ctx.getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data].slice(0, 3));
  }, { data, points });
}
const near = (actual, expected, tolerance = 3) => actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]) <= tolerance, `${actual} != ${expected}`));

for (const gpu of [true, false]) test(`real PCB layer colors match swatches and remain stable through visibility changes (${gpu ? 'WebGL' : 'SVG'})`, async t => {
  const page = await pageFor(t, {}, gpu ? undefined : () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type === 'webgl2' ? null : original.call(this, type, ...args);
    };
  });
  await page.unroute('**/render');
  const layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu', 'F.Fab', 'B.Fab'];
  const source = `(kicad_pcb (version 20240108) (generator ecadview)
    (general (thickness 1.6))
    (layers ${layers.map((layer, i) => `(${i} "${layer}" ${layer.endsWith('.Cu') ? 'signal' : 'user'})`).join(' ')}
      (44 "Edge.Cuts" user))
    ${layers.map((layer, i) => `(gr_rect (start ${i * 8 + 1} 2) (end ${i * 8 + 7} 8)
      (stroke (width 0.1) (type solid)) (fill solid) (layer "${layer}"))`).join(' ')}
    (gr_rect (start 0 0) (end 48 10) (stroke (width 0.1) (type solid)) (fill none) (layer "Edge.Cuts")))`;
  await page.locator('#file').setInputFiles({ name: 'Layer colors.kicad_pcb', mimeType: 'application/octet-stream', buffer: Buffer.from(source) });
  await page.waitForFunction(() => document.getElementById('filename').textContent === 'Layer colors.kicad_pcb' &&
    document.getElementById('busy').style.display === 'none');
  if (gpu) await ready(page);
  else assert.equal(await page.locator('#view').evaluate(el => el.classList.contains('gpu-layout')), false);
  for (const checkbox of await page.locator('#layers input').all()) await checkbox.setChecked(true);
  const swatches = await page.locator('#layers .swatch').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
  assert.equal(new Set(swatches).size, swatches.length, 'every layer has a distinct swatch');
  const expected = await page.evaluate(layers => layers.map(layer => {
    const row = [...document.querySelectorAll('#layers label')].find(row => row.querySelector('.layer-name').textContent === layer);
    const group = [...document.querySelectorAll('#scene > g')].find(group => group.dataset.layerName === layer);
    const color = getComputedStyle(row.querySelector('.swatch')).backgroundColor;
    const probe = document.createElement('span'); probe.style.color = group.dataset.color; document.body.append(probe);
    const painted = getComputedStyle(probe).color; probe.remove();
    if (color !== painted) throw new Error(`${layer} swatch differs from SVG metadata`);
    return color.match(/\d+/g).map(Number).slice(0, 3);
  }), layers);
  const coords = layers.map((_, i) => [i * 8 + 4, 5]);
  (await colors(page, coords)).forEach((pixel, i) => near(pixel, expected[i]));
  const inner = page.locator('#layers label').filter({ has: page.getByRole('button', { name: 'In1.Cu', exact: true }) });
  await inner.locator('input').setChecked(false);
  near((await colors(page, [coords[1]]))[0], [27, 29, 33]);
  await inner.locator('input').setChecked(true);
  await inner.locator('.layer-name').click();
  (await colors(page, coords)).forEach((pixel, i) => near(pixel, expected[i]));
  assert.deepEqual(await page.locator('#layers .swatch').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor)), swatches);
  if (gpu && process.env.LAYER_COLOR_SCREENSHOT) await page.screenshot({ path: process.env.LAYER_COLOR_SCREENSHOT });
});

test('layout startup shows WebGL progress and blocks early navigation until the first accelerated draw', async t => {
  const page = await pageFor(t, {});
  let releaseRender, releaseGeometry, renderStarted, geometryStarted;
  const renderGate = new Promise(resolve => { releaseRender = resolve; });
  const geometryGate = new Promise(resolve => { releaseGeometry = resolve; });
  const rendering = new Promise(resolve => { renderStarted = resolve; });
  const preparing = new Promise(resolve => { geometryStarted = resolve; });
  t.after(() => { releaseRender(); releaseGeometry(); });
  await page.route('**/render', async route => {
    renderStarted(); await renderGate;
    await route.fulfill({ json: { ...fixture('Starting.PcbDoc'), scene3d: {
      board: [{ outline: [[0, 0], [100, 0], [100, 80], [0, 80]], holes: [] }], thickness: 1.6, bodies: [],
    } } });
  });
  await page.route('**/geometry', async route => {
    geometryStarted(); await geometryGate; await route.continue().catch(() => {});
  });
  await page.locator('#file').setInputFiles({ name: 'Starting.PcbDoc', mimeType: 'application/octet-stream', buffer: Buffer.from('test') });
  await rendering;
  assert.equal(await page.locator('#busy').textContent(), 'Rendering…');
  assert.equal(await page.locator('#zoom-in').isDisabled(), true);
  await page.keyboard.press('3'); await page.keyboard.press('2');
  assert.equal(await page.locator('#three-view').isHidden(), true, 'mode shortcuts wait for rendering');
  releaseRender(); await preparing;
  assert.equal(await page.locator('#busy').isVisible(), true);
  assert.equal(await page.locator('#busy').textContent(), 'Starting WebGL…');
  assert.equal(await page.locator('#view').getAttribute('aria-busy'), 'true');
  for (const id of ['zoom-in', 'zoom-out', 'view-fit', 'measure-btn', 'view-mode-switch',
    'three-top', 'three-bottom', 'three-rotate-up', 'three-rotate-down', 'three-rotate-left', 'three-rotate-right'])
    assert.equal(await page.locator('#' + id).isDisabled(), true, `${id} is unavailable during startup`);
  const before = await page.locator('#view > svg').getAttribute('viewBox');
  const box = await page.locator('#view').boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y); await page.mouse.wheel(20, 50);
  await page.keyboard.down('Control'); await page.mouse.wheel(0, -50); await page.keyboard.up('Control');
  await page.mouse.down({ button: 'middle' }); await page.mouse.move(x + 80, y + 40); await page.mouse.up({ button: 'middle' });
  await page.mouse.down(); await page.mouse.move(x - 80, y - 40); await page.mouse.up();
  await page.locator('#view').focus(); await page.keyboard.press('+'); await page.keyboard.press('f'); await page.keyboard.press('m');
  await page.keyboard.press('3'); await page.keyboard.press('2');
  assert.equal(await page.locator('#three-view').isHidden(), true, 'mode shortcuts wait for WebGL');
  await page.locator('#view').evaluate(view => {
    for (const [type, scale] of [['gesturestart', 1], ['gesturechange', 2], ['gestureend', 2]]) {
      const event = new Event(type, { bubbles: true, cancelable: true }); event.scale = scale; view.dispatchEvent(event);
    }
  });
  assert.equal(await page.locator('#view > svg').getAttribute('viewBox'), before, 'early input cannot change the camera');
  assert.equal(await page.locator('#selection-rectangle').isHidden(), true);
  assert.equal(await page.locator('#measure-btn').getAttribute('class'), null);
  releaseGeometry(); await ready(page);
  await page.waitForFunction(() => document.querySelector('#view').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#busy').isHidden(), true);
  assert.equal(await page.locator('#zoom-in').isEnabled(), true);
  assert.ok(Number((await dataset(page)).frames) > 0, 'the loading gate ends after WebGL has drawn');
  await page.locator('#zoom-in').click();
  await page.waitForFunction(before => document.querySelector('#view > svg').getAttribute('viewBox') !== before, before);
  const zoomed = await page.locator('#view > svg').getAttribute('viewBox');
  await page.mouse.move(x, y); await page.mouse.wheel(20, 30);
  await page.waitForFunction(before => document.querySelector('#view > svg').getAttribute('viewBox') !== before, zoomed);
});

test('WebGL startup completes even when the browser suspends animation callbacks', async t => {
  const page = await pageFor(t, fixture(), () => { window.requestAnimationFrame = () => 0; });
  await page.waitForFunction(() => document.querySelector('#view').classList.contains('gpu-layout'), undefined, { polling: 50 });
  assert.equal(await page.locator('#busy').isHidden(), true);
  assert.equal(await page.locator('#zoom-in').isEnabled(), true);
});

test('WebGL startup draws once with selections entered during preparation and avoids temporary SVG clones', async t => {
  const page = await pageFor(t, {});
  let release, requested;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requested = resolve; });
  t.after(() => release());
  await page.evaluate(async () => {
    const { LayoutWebGL } = await import('/static/layout-webgl.js'), paint = LayoutWebGL.prototype.paint;
    window.startupFrames = 0;
    LayoutWebGL.prototype.paint = function (...args) {
      const frames = this.stats.frames, starting = document.querySelector('#view').getAttribute('aria-busy') === 'true';
      const result = paint.apply(this, args);
      if (starting && this.stats.frames > frames) window.startupFrames++;
      return result;
    };
  });
  await page.route('**/geometry', async route => { requested(); await gate; await route.continue().catch(() => {}); });
  await page.locator('#file').setInputFiles({ name: 'Selected.PcbDoc', mimeType: 'application/octet-stream', buffer: Buffer.from('test') });
  await started;
  await page.locator('#component-query').fill('U1'); await page.locator('#net-query').fill('GND');
  assert.equal(await page.locator('#component-highlight, #net-highlight, #layout-holes').count(), 0,
    'selection entered while loading does not clone hidden SVG geometry');
  release(); await ready(page);
  await page.waitForFunction(() => document.querySelector('#view').getAttribute('aria-busy') === 'false');
  assert.equal(Number((await dataset(page)).geometryUploads), 1);
  assert.equal(await page.evaluate(() => window.startupFrames), 1, 'the first complete selection state is drawn in one pass');
  assert.equal(await page.locator('#component-query').inputValue(), 'U1');
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  const selected = await colors(page, [[54,15],[30,48]]);
  near(selected[0], [255,224,102]); near(selected[1], [104,224,255]);
});

test('selections entered during preparation become visible in SVG when compilation fails', async t => {
  const page = await pageFor(t, {});
  let release, requested;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requested = resolve; });
  t.after(() => release());
  await page.route('**/geometry', async route => { requested(); await gate; await route.fulfill({ status: 500, json: { error: 'Test compiler failure' } }); });
  await page.locator('#file').setInputFiles({ name: 'SelectedFallback.PcbDoc', mimeType: 'application/octet-stream', buffer: Buffer.from('test') });
  await started;
  await page.locator('#net-query').fill('GND'); release();
  await page.waitForFunction(() => document.querySelector('#view').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#net-highlight').count(), 1);
  assert.equal(await page.locator('#layout-holes').count(), 1);
  near((await colors(page, [[30,48]]))[0], [104,224,255]);
  await page.locator('#net-clear').click();
  assert.equal(await page.locator('#net-highlight, #layout-holes').count(), 0);
});

test('WebGL preparation failure releases the startup gate into a working SVG fallback', async t => {
  const page = await pageFor(t, {});
  await page.route('**/geometry', route => route.fulfill({ status: 500, json: { error: 'Test compiler failure' } }));
  await page.locator('#file').setInputFiles({ name: 'Fallback.PcbDoc', mimeType: 'application/octet-stream', buffer: Buffer.from('test') });
  await page.waitForFunction(() => document.querySelector('#renderer-status').textContent.includes('Test compiler failure'));
  assert.equal(await page.locator('#busy').isHidden(), true);
  assert.equal(await page.locator('#view').getAttribute('aria-busy'), 'false');
  assert.equal(await page.locator('#zoom-in').isEnabled(), true);
  assert.equal(await page.locator('#view.gpu-layout').count(), 0);
  const before = await page.locator('#view > svg').getAttribute('viewBox');
  await page.locator('#zoom-in').click();
  await page.waitForFunction(before => document.querySelector('#view > svg').getAttribute('viewBox') !== before, before);
  const p = await point(page, 30, 48); await page.mouse.click(p.x, p.y);
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
});

test('GPU draws source transforms, pours, cutouts, slots, transparency and layer order like SVG', async t => {
  const page = await pageFor(t); await ready(page);
  const samples = [[9, 11], [18, 19], [54, 15], [58, 18], [77, 18], [77, 21], [47, 48], [45, 66]];
  const gpu = await colors(page, samples);
  near(gpu[0], [0, 170, 0]); near(gpu[1], [27, 29, 33]); near(gpu[2], [255, 0, 0]);
  near(gpu[3], [27, 29, 33]); near(gpu[4], [27, 29, 33]); near(gpu[6], [0, 0, 255]);
  await page.locator('#view').evaluate(view => { view.classList.remove('gpu-layout'); view.querySelector('canvas').hidden = true; });
  const svg = await colors(page, samples); gpu.forEach((color, i) => near(color, svg[i], 5));
  await page.locator('#view').evaluate(view => { view.classList.add('gpu-layout'); view.querySelector('canvas').hidden = false; });
  const top = page.locator('#layers label').filter({ hasText: 'Top copper' }).locator('input');
  await top.uncheck(); await top.check();
  near((await colors(page, [[47, 48]]))[0], [255, 0, 0]);
  await page.locator('#polygons-toggle').click(); near((await colors(page, [[9, 11]]))[0], [27, 29, 33]);
  await page.locator('#net-query').fill('OTHER');
  await page.locator('#layers label').filter({ hasText: 'Bottom copper' }).locator('input').uncheck();
  near((await colors(page, [[30, 48]]))[0], [255, 0, 0]);
});

test('exact SVG picking drives GPU selection without clones or geometry uploads; holes stay open', async t => {
  const page = await pageFor(t); await ready(page);
  const start = await dataset(page);
  const p = await point(page, 30, 48); await page.mouse.click(p.x, p.y);
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  assert.equal(await page.locator('#scene #net-highlight').count(), 0);
  const sampled = await colors(page, [[30, 48], [54, 15], [58, 18], [77, 18], [47, 38]]);
  near(sampled[0], [104, 224, 255]); near(sampled[1], [104, 224, 255]);
  near(sampled[2], [27, 29, 33]); near(sampled[3], [27, 29, 33]);
  near(sampled[4], [23, 25, 66], 3);
  await page.locator('#component-query').fill('U1');
  near((await colors(page, [[54, 15]]))[0], [255, 224, 102]);
  assert.equal((await dataset(page)).geometryUploads, start.geometryUploads);
  assert.ok(Number((await dataset(page)).selectionUploads) > Number(start.selectionUploads));
  await page.keyboard.press('Escape');
  near((await colors(page, [[30, 48]]))[0], [255, 0, 0]);
});

test('camera motion reuses buffers and measurements remain above the canvas with per-tab state', async t => {
  const page = await pageFor(t, fixture(), () => {
    window.bufferBalance = 0;
    for (const [method, difference] of [['createBuffer', 1], ['deleteBuffer', -1]]) {
      const original = WebGL2RenderingContext.prototype[method];
      WebGL2RenderingContext.prototype[method] = function (...args) {
        const result = original.apply(this, args); window.bufferBalance += difference; return result;
      };
    }
  }); await ready(page);
  const before = await dataset(page), p = await point(page, 40, 40);
  await page.mouse.move(p.x, p.y);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -12);
  await page.waitForTimeout(180);
  const after = await dataset(page);
  assert.equal(after.geometryUploads, before.geometryUploads); assert.equal(after.selectionUploads, before.selectionUploads);
  assert.ok(Number(after.frames) > Number(before.frames));
  await page.locator('#measure-btn').click();
  const a = await point(page, 25, 35), b = await point(page, 55, 35);
  await page.mouse.click(a.x, a.y); await page.mouse.click(b.x, b.y);
  assert.equal(await page.locator('#measure line').count() > 0, true);
  const measurement = await page.locator('#measure-label').textContent(); assert.match(measurement, /mm/);
  const line = (await colors(page, [[40, 35]]))[0];
  assert.ok(line[1] > 100, 'measurement paints above GPU board: ' + line);
  await page.locator('#file').setInputFiles({ name: 'Second.PcbDoc', mimeType: 'application/octet-stream', buffer: Buffer.from('test') });
  await page.waitForFunction(() => document.querySelector('#filename').textContent === 'Second.PcbDoc'); await ready(page);
  assert.equal(await page.locator('.layout-webgl').count(), 1);
  assert.equal(await page.locator('#measure line').count(), 0);
  await page.getByRole('tab', { name: 'GPU.PcbDoc' }).click(); await ready(page);
  assert.equal(await page.locator('#measure-label').textContent(), measurement);
  await page.getByRole('button', { name: 'Close GPU.PcbDoc', exact: true }).click();
  await page.getByRole('button', { name: 'Close Second.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('.layout-webgl').isHidden(), true);
  assert.equal(await page.locator('#view > svg').count(), 0);
  assert.equal(await page.evaluate(() => window.bufferBalance), 0, 'closing tabs deletes their GPU buffers');
});

test('context loss immediately restores SVG and restoration reuploads once without losing selection', async t => {
  const page = await pageFor(t); await ready(page);
  await page.locator('#net-query').fill('GND');
  await page.locator('.layout-webgl').evaluate(canvas => { window.loss = canvas.getContext('webgl2').getExtension('WEBGL_lose_context'); window.loss.loseContext(); });
  await page.waitForFunction(() => !document.querySelector('#view').classList.contains('gpu-layout'));
  assert.equal(await page.locator('#net-highlight').count(), 1);
  near((await colors(page, [[30, 48]]))[0], [104, 224, 255]);
  await page.evaluate(() => window.loss.restoreContext()); await ready(page);
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  near((await colors(page, [[30, 48]]))[0], [104, 224, 255]);
  assert.equal(Number((await dataset(page)).geometryUploads), 2);
});

test('unsupported geometry and unavailable WebGL retain the selectable SVG viewer', async t => {
  const unsupported = fixture(); unsupported.svg = unsupported.svg.replace('<g id="scene"', '<g opacity=".5" id="scene"');
  const page = await pageFor(t, unsupported);
  await page.waitForFunction(() => document.querySelector('#renderer-status').textContent.includes('isolated'));
  assert.equal(await page.locator('#view.gpu-layout').count(), 0);
  await page.locator('#net-query').fill('GND'); assert.equal(await page.locator('#net-highlight').count(), 1);
  const unavailable = await pageFor(t, fixture(), () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) { return type === 'webgl2' ? null : original.call(this, type, ...args); };
  });
  await unavailable.waitForFunction(() => document.querySelector('#renderer-status').textContent.includes('unavailable'));
  assert.equal(await unavailable.locator('#busy').isHidden(), true);
  assert.equal(await unavailable.locator('#zoom-in').isEnabled(), true);
  assert.equal(await unavailable.locator('#view.gpu-layout').count(), 0);
  const p = await point(unavailable, 30, 48); await unavailable.mouse.click(p.x, p.y);
  assert.equal(await unavailable.locator('#net-query').inputValue(), 'GND');
});

test('SVG fallback preserves all visible drill cutouts above selected copper, including unrelated holes', async t => {
  const page = await pageFor(t, fixture(), () => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) { return type === 'webgl2' ? null : original.call(this, type, ...args); };
  });
  await page.waitForFunction(() => document.querySelector('#renderer-status').textContent.includes('unavailable'));
  await page.locator('#net-query').fill('GND');
  const sampled = await colors(page, [[54, 15], [58, 18], [77, 18]]);
  near(sampled[0], [104, 224, 255]); near(sampled[1], [27, 29, 33]); near(sampled[2], [27, 29, 33]);
  await page.locator('#component-query').fill('U1'); near((await colors(page, [[58, 18]]))[0], [27, 29, 33]);
  await page.locator('#layers label').filter({ hasText: 'Drills' }).locator('input').uncheck();
  near((await colors(page, [[58, 18]]))[0], [255, 224, 102]);
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#layout-holes').count(), 0);
});

test('cross-probing retains PCB buffers while viewing schematics, draws the fitted result once and releases a closed resident PCB', async t => {
  const page = await pageFor(t, fixture(), () => {
    window.bufferBalance = 0;
    for (const [method, difference] of [['createBuffer',1], ['deleteBuffer',-1]]) {
      const original = WebGL2RenderingContext.prototype[method];
      WebGL2RenderingContext.prototype[method] = function (...args) {
        const result = original.apply(this, args); window.bufferBalance += difference; return result;
      };
    }
  }); await ready(page);
  const original = await dataset(page);
  const schema = { name:'Sheet.SchDoc', kind:'schematic', stats:{components:1,wires:0,net_labels:0},
    selection:{components:[{id:'symbol',name:'U1',elements:['symbol'],body_elements:['symbol']}],nets:[]},
    svg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><g id="scene"><g id="symbol"><rect x="20" y="20" width="10" height="10" fill="yellow" stroke="brown"/></g></g></svg>' };
  await page.route('**/render', route => route.fulfill({ json:schema }));
  await page.locator('#file').setInputFiles({name:'Sheet.SchDoc',mimeType:'application/octet-stream',buffer:Buffer.from('test')});
  await page.waitForFunction(() => document.querySelector('#filename').textContent === 'Sheet.SchDoc' && document.querySelector('#busy').style.display === 'none');
  assert.equal(await page.evaluate(() => window.bufferBalance), 2, 'the hidden PCB keeps its existing vertex/index buffers');
  await page.getByRole('tab', {name:'GPU.PcbDoc',exact:true}).click(); await ready(page);
  assert.equal((await dataset(page)).geometryUploads, original.geometryUploads);
  await page.locator('#component-query').fill('U1'); await page.locator('#probe-schematic-btn').click();
  const frames = await page.evaluate(() => {
    const canvas = document.querySelector('.layout-webgl'), before = Number(canvas.dataset.frames);
    document.querySelector('#probe-layout-btn').click(); return Number(canvas.dataset.frames) - before;
  });
  assert.equal(frames, 1, 'activation, selection and fit produce one final GPU frame');
  assert.equal((await dataset(page)).geometryUploads, original.geometryUploads);
  await page.getByRole('tab', {name:'Sheet.SchDoc',exact:true}).click();
  await page.getByRole('button', {name:'Close GPU.PcbDoc',exact:true}).click();
  assert.equal(await page.evaluate(() => window.bufferBalance), 0, 'closing the hidden PCB frees its resident buffers');
});

test('a real KiCad PCB uses retained WebGL and a schematic remains SVG', async t => {
  const page = await pageFor(t, {});
  await page.unroute('**/render');
  await page.locator('#file').setInputFiles(resolve(__dirname, 'fixtures/kicad/demo.kicad_pcb'));
  await ready(page); assert.ok(Number((await dataset(page)).geometryBytes) > 0);
  await page.locator('#file').setInputFiles(resolve(__dirname, 'fixtures/kicad/demo.kicad_sch'));
  await page.waitForFunction(() => document.querySelector('#filename').textContent === 'demo.kicad_sch');
  assert.equal(await page.locator('#view.gpu-layout').count(), 0);
  assert.equal(await page.locator('.layout-webgl').isHidden(), true);
  await page.getByRole('tab', { name: 'demo.kicad_pcb' }).click(); await ready(page);
  await page.locator('#component-query').fill('R2'); await page.locator('#component-fit').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.pin-label')].some(el => el.textContent === 'A2'));
  await page.locator('#component-clear').click(); await page.locator('#net-query').fill('SIGNAL');
  await page.locator('#probe-schematic-btn').click();
  assert.match(await page.locator('#schematic-selection-status').textContent(), /SIGNAL/);
  await page.locator('#probe-layout-btn').click(); await ready(page);
  assert.equal(await page.locator('#net-query').inputValue(), 'SIGNAL');
  await page.locator('#view-mode-switch').click();
  await page.waitForFunction(() => document.querySelector('#three-view canvas'));
  assert.equal(await page.locator('.layout-webgl').isHidden(), true);
  await page.locator('#view-mode-switch').click(); await ready(page);
});

test('analytic KiCad pads, via rings and thick circular markings match SVG and retain picking and snaps', async t => {
  const page = await pageFor(t, {});
  await page.unroute('**/render');
  const source = `(kicad_pcb (version 20240108)
    (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (37 "F.SilkS" user) (44 "Edge.Cuts" user))
    (net 1 "SIGNAL")
    (footprint "Test" (at 10 10 90) (property "Reference" "U1")
      (pad "1" smd rect (at 0 0 30) (size 4 2) (layers "F.Cu") (net 1 "SIGNAL"))
      (pad "2" smd oval (at 0 7) (size 4 2) (layers "F.Cu") (net 1 "SIGNAL"))
      (pad "3" smd circle (at 0 -7) (size 3 3) (layers "F.Cu") (net 1 "SIGNAL"))
      (fp_circle (center -8 5) (end -8 5.5) (stroke (width 1)) (fill none) (layer "F.SilkS")))
    (via (at 10 20) (size 4) (drill 2) (layers "F.Cu" "B.Cu") (net 1))
    (gr_rect (start 0 0) (end 24 26) (layer "Edge.Cuts") (stroke (width 0.1))))`;
  await page.locator('#file').setInputFiles({ name: 'Analytic.kicad_pcb', mimeType: 'application/octet-stream', buffer: Buffer.from(source) });
  await ready(page);
  for (const row of await page.locator('#layers label').all()) {
    const name = await row.locator('.layer-name').textContent();
    await row.locator('input').setChecked(['F.Cu', 'F.SilkS'].includes(name));
  }
  const samples = [[10, 10], [17, 10], [3, 10], [11.5, 20], [10, 20], [12.3, 20], [15, 18]];
  const gpu = await colors(page, samples);
  near(gpu[4], [27, 29, 33]); near(gpu[5], [27, 29, 33]);
  assert.ok(gpu[6].some((v, i) => Math.abs(v - [27, 29, 33][i]) > 50), 'thick circle has a filled centre');
  await page.locator('#view').evaluate(view => { view.classList.remove('gpu-layout'); view.querySelector('canvas').hidden = true; });
  const svg = await colors(page, samples); gpu.forEach((color, i) => near(color, svg[i], 5));
  await page.locator('#view').evaluate(view => { view.classList.add('gpu-layout'); view.querySelector('canvas').hidden = false; });
  const snaps = await page.evaluate(async () => {
    const { snapIndex } = await import('/static/measurement-tools.js');
    return snapIndex({ svg: document.querySelector('#view > svg') }).map(p => [p.x, p.y]);
  });
  for (const center of [[10, 10], [17, 10], [3, 10], [10, 20]])
    assert.ok(snaps.some(p => Math.hypot(p[0] - center[0], p[1] - center[1]) < 1e-6));
  const before = await dataset(page), pad = await point(page, 10, 10);
  await page.mouse.click(pad.x, pad.y);
  assert.equal(await page.locator('#component-query').inputValue(), 'U1');
  assert.equal((await dataset(page)).geometryUploads, before.geometryUploads);
  near((await colors(page, [[10, 10]]))[0], [255, 224, 102]);
});

test('unpainted GPU interaction trees preserve source visibility and pointer rules', async t => {
  const data = fixture();
  data.svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><g id="scene">
    <g id="layer-top" data-layer-role="copper" fill="red">
      <g visibility="hidden">
        <rect data-net="HIDDEN" x="10" y="10" width="10" height="10"/>
        <rect data-net="VISIBLE" visibility="visible" style="pointer-events:visiblePainted" x="30" y="10" width="10" height="10"/>
      </g>
      <rect data-net="IGNORED" style="pointer-events:none" x="50" y="10" width="10" height="10"/>
    </g></g></svg>`;
  const page = await pageFor(t, data); await ready(page);
  for (const [x, expected] of [[15, ''], [35, 'VISIBLE'], [55, '']]) {
    await page.locator('#net-clear').click();
    const p = await point(page, x, 15); await page.mouse.click(p.x, p.y);
    assert.equal(await page.locator('#net-query').inputValue(), expected);
  }
  const a = await point(page, 8, 8), b = await point(page, 42, 22);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 5 }); await page.mouse.up();
  assert.equal(await page.locator('#net-query').inputValue(), 'VISIBLE', 'rectangle selection excludes source-hidden graphics');
});

test('closing a tab during preparation cannot mount stale GPU geometry', async t => {
  let release, requested;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { requested = resolve; });
  const page = await pageFor(t, {});
  await page.route('**/geometry', async route => { requested(); await blocked; await route.continue().catch(() => {}); });
  await page.locator('#file').setInputFiles({ name: 'Closing.PcbDoc', mimeType: 'application/octet-stream', buffer: Buffer.from('test') });
  await started;
  await page.getByRole('button', { name: 'Close Closing.PcbDoc', exact: true }).click();
  release(); await page.waitForTimeout(100);
  assert.equal(await page.locator('#view.gpu-layout').count(), 0);
  assert.equal(await page.locator('.layout-webgl').isHidden(), true);
  assert.equal(await page.locator('#view > svg').count(), 0);
  assert.equal(await page.locator('#busy').isHidden(), true);
  assert.equal(await page.locator('#view').getAttribute('aria-busy'), 'false');
  await page.unroute('**/geometry');
  await page.locator('#file').setInputFiles({ name: 'Next.PcbDoc', mimeType: 'application/octet-stream', buffer: Buffer.from('test') });
  await ready(page);
});

test('WebGL startup state follows the active tab without blocking a ready document', async t => {
  const page = await pageFor(t); await ready(page);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const preparing = new Promise(resolve => { started = resolve; });
  t.after(() => release());
  await page.route('**/geometry', async route => { started(); await gate; await route.continue().catch(() => {}); });
  await page.locator('#file').setInputFiles({ name: 'Pending.PcbDoc', mimeType: 'application/octet-stream', buffer: Buffer.from('test') });
  await preparing;
  assert.equal(await page.locator('#busy').textContent(), 'Starting WebGL…');
  await page.getByRole('tab', { name: 'GPU.PcbDoc', exact: true }).click(); await ready(page);
  assert.equal(await page.locator('#busy').isHidden(), true);
  assert.equal(await page.locator('#zoom-in').isEnabled(), true);
  await page.getByRole('tab', { name: 'Pending.PcbDoc', exact: true }).click();
  assert.equal(await page.locator('#busy').isVisible(), true);
  assert.equal(await page.locator('#zoom-in').isDisabled(), true);
  await page.getByRole('tab', { name: 'GPU.PcbDoc', exact: true }).click();
  const compiled = page.waitForResponse(response => response.url().endsWith('/geometry'));
  release();
  // A background completion must not replace the active board or its controls.
  await compiled;
  await page.waitForFunction(() => document.querySelector('#busy').style.display === 'none');
  assert.equal(await page.locator('#filename').textContent(), 'GPU.PcbDoc');
  await page.getByRole('tab', { name: 'Pending.PcbDoc', exact: true }).click(); await ready(page);
  assert.equal(await page.locator('#busy').isHidden(), true);
  assert.equal(await page.locator('#zoom-in').isEnabled(), true);
});

test('rectangle selects mixed GPU objects and additive nets without rebuilding retained geometry, including SVG fallback', async t => {
  const page = await pageFor(t); await ready(page);
  const start = await dataset(page);
  const drag = async (a, b, shift = false) => {
    const p = await point(page, ...a), q = await point(page, ...b);
    if (shift) await page.keyboard.down('Shift');
    await page.mouse.move(p.x, p.y); await page.mouse.down(); await page.mouse.move(q.x, q.y, { steps: 5 });
    assert.equal(await page.locator('#selection-rectangle').isVisible(), true);
    await page.mouse.up(); if (shift) await page.keyboard.up('Shift');
  };
  await drag([50, 12], [65, 25]);
  assert.equal(await page.locator('#component-query').inputValue(), 'U1');
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  near((await colors(page, [[54, 15]]))[0], [255, 224, 102]);
  await drag([44, 32], [50, 42], true);
  assert.equal(await page.locator('#net-query').inputValue(), 'GND, OTHER');
  assert.equal((await dataset(page)).geometryUploads, start.geometryUploads);
  assert.equal(await page.locator('#scene #net-highlight, #scene #component-highlight').count(), 0);
  near((await colors(page, [[47, 38]]))[0], [104, 224, 255]);
  // Disabled layers cannot be selected by a rectangle even though their
  // retained geometry and DOM metadata still exist.
  await page.locator('#layers label').filter({ hasText: 'Bottom copper' }).locator('input').uncheck();
  await drag([44, 32], [50, 42]);
  assert.equal(await page.locator('#net-query').inputValue(), '');
  await page.locator('.layout-webgl').evaluate(canvas => canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
  await page.waitForFunction(() => !document.querySelector('#view').classList.contains('gpu-layout'));
  await drag([65, 25], [50, 12]);
  assert.equal(await page.locator('#component-query').inputValue(), 'U1');
  assert.equal(await page.locator('#net-query').inputValue(), 'GND');
  assert.equal(await page.locator('#scene #component-highlight').count(), 1);
  near((await colors(page, [[54, 15]]))[0], [255, 224, 102]);
});
