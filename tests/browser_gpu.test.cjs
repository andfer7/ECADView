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
    ['-B', '-u', resolve(__dirname, '../pcb_viewer_gui.py'), '--no-open']);
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
  await page.locator('#mode-3d').click();
  await page.waitForFunction(() => document.querySelector('#three-view canvas'));
  assert.equal(await page.locator('.layout-webgl').isHidden(), true);
  await page.locator('#mode-2d').click(); await ready(page);
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
  await page.unroute('**/geometry');
  await page.locator('#file').setInputFiles({ name: 'Next.PcbDoc', mimeType: 'application/octet-stream', buffer: Buffer.from('test') });
  await ready(page);
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
