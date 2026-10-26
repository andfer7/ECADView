import { NetLabels } from './net-labels.js';

(function () {
  const $ = id => document.getElementById(id);
  const view = $('view'), layersEl = $('layers'), readout = $('readout'), label = $('measure-label');
  const NS = 'http://www.w3.org/2000/svg';
  const netLabels = new NetLabels($('net-labels'));
  let svg = null, groups = [], vb = null, home = null;
  const boards = [];
  let activeBoard = null, nextBoardId = 1;

  // ------------------------------------------------------------ board tabs / loading
  function saveBoard() {
    if (!activeBoard) return;
    Object.assign(activeBoard, { svg, groups, vb, home, unit, measuring, pts, measurements, hover, mg });
  }
  function createBoard(file, name = file.name) {
    const board = { id: nextBoardId++, file, name, stats: null, warnings: [],
                    svg: null, groups: [], vb: null, home: null, unit: 'mm', measuring: false,
                    pts: [], measurements: [], hover: null, mg: null, loading: false, request: 0 };
    boards.push(board);
    return board;
  }
  function updateTabs() {
    $('tabs').replaceChildren();
    for (const board of boards) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (board === activeBoard ? ' active' : '');
      const button = document.createElement('button');
      button.className = 'tab-name'; button.id = 'board-tab-' + board.id;
      button.textContent = board.name + (board.loading ? ' …' : ''); button.title = board.name;
      button.setAttribute('role', 'tab'); button.setAttribute('aria-controls', 'view');
      button.setAttribute('aria-selected', String(board === activeBoard));
      button.tabIndex = board === activeBoard ? 0 : -1;
      button.onclick = () => activateBoard(board);
      button.onkeydown = e => {
        const index = boards.indexOf(board);
        let target;
        if (e.key === 'ArrowRight') target = boards[(index + 1) % boards.length];
        if (e.key === 'ArrowLeft') target = boards[(index + boards.length - 1) % boards.length];
        if (e.key === 'Home') target = boards[0];
        if (e.key === 'End') target = boards[boards.length - 1];
        if (e.key === 'Delete') { e.preventDefault(); closeBoard(board); }
        if (target) { e.preventDefault(); activateBoard(target); $('board-tab-' + target.id).focus(); }
      };
      const close = document.createElement('button');
      close.className = 'tab-close'; close.textContent = '×';
      close.setAttribute('aria-label', 'Close ' + board.name);
      close.onclick = () => closeBoard(board);
      tab.append(button, close); $('tabs').append(tab);
    }
    updateProbeTargets();
    updateProbeResult();
  }
  function activateBoard(board) {
    saveBoard();
    mountBoard(board);
  }
  function mountBoard(board) {
    cancelViewUpdate();
    unmount3D();
    if (svg) svg.remove();
    activeBoard = board; drag = null; gestureScale = null;
    ({ svg, groups, vb, home, unit, measuring, pts, measurements, hover, mg } = board || {
      svg: null, groups: [], vb: null, home: null, unit: 'mm', measuring: false, pts: [], measurements: [], hover: null, mg: null,
    });
    $('filename').textContent = board ? board.name : 'No document loaded';
    for (const id of ['zoom-in', 'zoom-out', 'view-fit']) $(id).disabled = !svg;
    const schematic = board?.kind === 'schematic';
    document.querySelectorAll('[data-pcb-only]').forEach(el => { el.hidden = schematic; });
    $('schematic-selection').hidden = !schematic;
    $('schematic-hint').hidden = !schematic;
    $('warnings').textContent = board ? board.warnings.join('\n') : '';
    $('warnings').hidden = !$('warnings').textContent;
    const s = board && board.stats;
    $('stats').textContent = !s ? '' : schematic ?
      `${s.components} components, ${s.wires} wires, ${s.net_labels} net labels` :
      `${s.components} components, ${s.pads} pads, ${s.tracks} tracks, ${s.vias} vias\n${s.polygons} polygons, ${s.regions} poured regions`;
    $('empty').style.display = board ? 'none' : '';
    $('busy').style.display = board && board.loading ? 'flex' : 'none';
    label.replaceChildren(); readout.textContent = '';
    $('measure-btn').classList.toggle('on', measuring); view.classList.toggle('measuring', measuring);
    document.querySelectorAll('.unit').forEach(b => b.classList.toggle('on', b.dataset.unit === unit));
    layersEl.replaceChildren();
    if (svg) {
      svg.style.display = '';
      view.prepend(svg);
      if (schematic) buildSchematicComponentTargets(board);
      else buildLayers();
      apply();
    }
    updatePolygonControl();
    mountNetSearch();
    updateTabs();
    mountComponentSearch();
    updateSchematicSelection();
    netLabels.update(activeBoard);
    mountViewMode();
    if (board) $('view').setAttribute('aria-labelledby', 'board-tab-' + board.id);
    else $('view').removeAttribute('aria-labelledby');
  }
  function closeBoard(board) {
    const index = boards.indexOf(board);
    if (index < 0) return;
    board.controller?.abort();
    boards.splice(index, 1);
    if (board === activeBoard) mountBoard(boards[Math.min(index, boards.length - 1)] || null);
    else updateTabs();
    if (activeBoard) $('board-tab-' + activeBoard.id).focus();
  }
  function openFiles(files) {
    for (const file of files) {
      const board = createBoard(file);
      activateBoard(board);
      renderBoard(board);
    }
  }
  async function renderBoard(board) {
    if (board === activeBoard) saveBoard();
    board.controller?.abort();
    const controller = new AbortController(); board.controller = controller;
    const request = ++board.request;
    board.loading = true;
    updateTabs();
    if (board === activeBoard) $('busy').style.display = 'flex';
    try {
      const r = await fetch('/render', { method: 'POST', headers: { 'X-Filename': encodeURIComponent(board.file.name) }, body: board.file, signal: controller.signal });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || r.statusText);
      if (boards.includes(board) && request === board.request) show(board, data);
    } catch (e) {
      if (e.name !== 'AbortError' && boards.includes(board) && request === board.request) {
        toast('Could not render ' + board.name + ': ' + e.message);
        if (!board.svg) closeBoard(board);
      }
    } finally {
      if (boards.includes(board) && request === board.request) {
        board.loading = false; updateTabs();
        if (board === activeBoard) $('busy').style.display = 'none';
      }
    }
  }

  function show(board, data) {
    const tpl = document.createElement('div'); tpl.innerHTML = data.svg;
    const rendered = tpl.querySelector('svg');
    if (!rendered) throw new Error('The renderer did not return an SVG.');
    if (board === activeBoard) saveBoard();
    const b = rendered.viewBox.baseVal;
    const origin = { x: b.x, y: b.y, w: b.width, h: b.height };
    const previousLayers = new Map(board.groups.map(g => [g.id, g.style.display]));
    // Schematic groups are drawing containers, not PCB layers.
    const kind = data.kind || 'pcb';
    const polygonIds = new Set(data.polygon_elements || []);
    if (kind === 'pcb') for (const el of rendered.querySelectorAll('#scene [id], #scene [data-primitive]')) {
      if (polygonIds.has(el.id) || ['polygon-outline', 'polygon-cutout'].includes(el.dataset.primitive)) el.classList.add('polygon-copper');
    }
    for (const g of kind === 'pcb' ? rendered.querySelectorAll('#scene > g') : []) {
      g.style.display = previousLayers.has(g.id) ? previousLayers.get(g.id) : defaultLayerVisible(g) ? '' : 'none';
    }
    const measure = document.createElementNS(NS, 'g'); measure.id = 'measure'; rendered.append(measure);
    Object.assign(board, { svg: rendered, name: data.name, kind, stats: data.stats, warnings: data.warnings || [], groups: [],
                           layoutComponents: data.layout_components || [], scene3d: data.scene3d, camera3d: null, bodyEdits: null,
                           home: origin, vb: { ...origin }, pts: [], measurements: [], hover: null, mg: measure });
    if (kind === 'schematic') prepareSchematicSelection(board, data.selection);
    if (board === activeBoard) mountBoard(board);
  }

  $('open').onclick = () => $('file').click();
  $('file').onchange = e => { openFiles(e.target.files); e.target.value = ''; };
  view.addEventListener('dragover', e => { e.preventDefault(); view.classList.add('drop'); });
  view.addEventListener('dragleave', () => view.classList.remove('drop'));
  view.addEventListener('drop', e => { e.preventDefault(); view.classList.remove('drop'); openFiles(e.dataTransfer.files); });

  function toast(msg) { const t = $('toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', 5000); }

  // ------------------------------------------------------------ 3D mode
  let threeViewer = null, threeModule = null, threeMount = 0, threeBoard = null;
  function is3D() { return activeBoard?.mode === '3d'; }
  function unmount3D() {
    threeMount++;
    if (threeBoard) threeBoard.camera3d = threeViewer?.state();
    threeBoard = null;
    threeViewer?.clear();
    $('three-view').hidden = true;
  }
  function mountViewMode() {
    const available = activeBoard?.kind !== 'schematic' && Boolean(activeBoard?.scene3d?.board?.length);
    if (!available && activeBoard) activeBoard.mode = '2d';
    const showing = is3D();
    $('mode-2d').disabled = !svg;
    $('mode-3d').disabled = !available;
    for (const mode of ['2d', '3d']) {
      $('mode-' + mode).classList.toggle('on', (mode === '3d') === showing);
      $('mode-' + mode).setAttribute('aria-pressed', String((mode === '3d') === showing));
    }
    document.querySelectorAll('[data-2d-only]').forEach(el => { el.hidden = showing || activeBoard?.kind === 'schematic'; });
    $('three-controls').hidden = !showing;
    $('three-status').textContent = (activeBoard?.scene3d?.notes || []).join('\n');
    $('three-status').hidden = !showing && available;
    $('net-labels').hidden = showing; label.hidden = showing;
    view.classList.toggle('measuring', !showing && measuring);
    if (svg) svg.style.display = showing ? 'none' : '';
    updateBodyControls();
    if (showing) show3D();
  }
  async function show3D() {
    const board = activeBoard, request = ++threeMount;
    $('three-view').hidden = false;
    $('three-summary').textContent = 'Loading 3D view…';
    try {
      threeModule ||= import('./viewer-3d.js');
      const { Board3D } = await threeModule;
      if (request !== threeMount || board !== activeBoard || !is3D()) return;
      threeViewer ||= new Board3D($('three-view'), message => {
        $('three-status').hidden = false; $('three-status').textContent = message;
      }, pickBody);
      threeViewer.show(board.scene3d, board.camera3d, bodyEdits(board));
      threeBoard = board;
      updateBodyControls();
    } catch (error) {
      if (request !== threeMount || board !== activeBoard) return;
      threeViewer?.clear();
      threeBoard = null;
      board.mode = '2d'; mountViewMode();
      $('three-view').hidden = true;
      $('three-status').hidden = false;
      $('three-status').textContent = 'Could not open 3D. Check WebGL support in your browser. ' + error.message;
    }
  }
  function setViewMode(mode) {
    if (!activeBoard || activeBoard.kind === 'schematic') return;
    unmount3D(); activeBoard.mode = mode; drag = null; gestureScale = null;
    mountViewMode();
    if (mode === '2d') apply();
  }
  $('mode-2d').onclick = () => setViewMode('2d');
  $('mode-3d').onclick = () => setViewMode('3d');
  for (const preset of ['top', 'bottom', 'iso']) $('three-' + preset).onclick = () => threeViewer?.fit(preset);

  function bodyEdits(board) {
    return board.bodyEdits ||= { selected: new Set(), deleted: new Set(), undo: [] };
  }
  function bodyNames(board) {
    return new Map(board.scene3d.bodies.map((body, index) => [body.id ?? `body-${index}`, body.name || `Body ${index + 1}`]));
  }
  function updateBodyControls() {
    const ready = is3D() && threeBoard === activeBoard;
    const state = ready ? bodyEdits(activeBoard) : null;
    const list = $('three-body-list'), scroll = list.scrollTop;
    list.replaceChildren(); list.disabled = !ready;
    if (ready) {
      const names = bodyNames(activeBoard);
      for (const [id, name] of names) {
        if (state.deleted.has(id)) continue;
        const option = document.createElement('option'); option.value = id; option.textContent = name;
        option.selected = state.selected.has(id); list.append(option);
      }
      list.scrollTop = scroll;
      const count = list.options.length;
      $('three-summary').textContent = `${activeBoard.scene3d.thickness.toFixed(2)} mm board · ${count} ${count === 1 ? 'body' : 'bodies'}`;
      $('three-selection').textContent = state.selected.size ?
        `${state.selected.size} selected: ${[...state.selected].map(id => names.get(id)).join(', ')}` : 'No body selected.';
    } else $('three-selection').textContent = 'No body selected.';
    $('three-clear').disabled = $('three-delete').disabled = !state?.selected.size;
    $('three-undo').disabled = !state?.undo.length;
  }
  function updateBodies() {
    if (!is3D() || threeBoard !== activeBoard) return;
    threeViewer.updateBodies(bodyEdits(activeBoard));
    updateBodyControls();
  }
  function pickBody(id, additive) {
    if (!is3D() || threeBoard !== activeBoard) return;
    const state = bodyEdits(activeBoard), already = state.selected.has(id);
    if (!additive) state.selected.clear();
    if (id !== null) {
      if (already) state.selected.delete(id);
      else state.selected.add(id);
    }
    updateBodies();
  }
  function clearBodies() {
    if (!is3D() || threeBoard !== activeBoard) return;
    bodyEdits(activeBoard).selected.clear(); updateBodies();
  }
  function deleteBodies() {
    if (!is3D() || threeBoard !== activeBoard) return;
    const state = bodyEdits(activeBoard);
    if (!state.selected.size) return;
    const ids = [...state.selected];
    ids.forEach(id => state.deleted.add(id)); state.undo.push(ids); state.selected.clear();
    updateBodies();
  }
  function undoBodies() {
    if (!is3D() || threeBoard !== activeBoard) return;
    const state = bodyEdits(activeBoard), ids = state.undo.pop();
    if (!ids) return;
    ids.forEach(id => state.deleted.delete(id)); state.selected = new Set(ids);
    updateBodies();
  }
  $('three-body-list').onchange = () => {
    if (!is3D() || threeBoard !== activeBoard) return;
    bodyEdits(activeBoard).selected = new Set([...$('three-body-list').selectedOptions].map(option => option.value));
    updateBodies();
  };
  $('three-clear').onclick = clearBodies;
  $('three-delete').onclick = deleteBodies;
  $('three-undo').onclick = undoBodies;

  // ------------------------------------------------------------ schematic selection
  function prepareSchematicSelection(board, selection = {}) {
    // Resolve IDs within this SVG only. Source IDs and names need no CSS escaping.
    const elements = new Map([...board.svg.querySelectorAll('#scene [id]')].map(el => [el.id, el]));
    function index(rows, attribute) {
      const result = new Map();
      for (const row of rows || []) {
        const targets = row.elements.map(id => elements.get(id)).filter(Boolean);
        if (!targets.length) continue;
        result.set(row.id, { name: row.name, elements: targets,
          aliases: row.aliases || [], terminals: row.terminals || [],
          bodyElements: (row.body_elements || []).map(id => elements.get(id)).filter(Boolean) });
        for (const el of targets) {
          const ids = JSON.parse(el.getAttribute(attribute) || '[]');
          el.setAttribute(attribute, JSON.stringify([...new Set([...ids, row.id])]));
        }
      }
      return result;
    }
    board.schematicComponents = index(selection.components, 'data-sch-components');
    board.schematicNets = index(selection.nets, 'data-sch-nets');
    board.selectedComponents = new Set(); board.selectedNets = new Set();
    // Give thin wires and pins a usable screen-space click target without changing their drawing.
    for (const el of board.svg.querySelectorAll('[data-sch-nets] line, [data-sch-nets] path, [data-sch-nets] polyline')) {
      const hit = el.cloneNode(false);
      for (const attr of [...hit.attributes]) if (attr.name === 'id' || attr.name.startsWith('data-')) hit.removeAttribute(attr.name);
      hit.removeAttribute('style'); hit.setAttribute('class', 'sch-hit');
      hit.setAttribute('aria-hidden', 'true'); el.before(hit);
    }
  }
  function buildSchematicComponentTargets(board) {
    // getBBox/CTM require the SVG to be mounted. Work in each component's local
    // coordinates so rotated/mirrored symbol graphics keep their correct bounds.
    for (const row of board.schematicComponents.values()) for (const component of row.elements) {
      if (component.querySelector('.sch-component-hit')) continue;
      const points = [];
      const inverse = component.getScreenCTM().inverse();
      for (const graphic of row.bodyElements) {
        if (!component.contains(graphic)) continue;
        const b = graphic.getBBox(), transform = inverse.multiply(graphic.getScreenCTM());
        if (!b.width && !b.height) continue;
        for (const [x, y] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]])
          points.push(new DOMPoint(x, y).matrixTransform(transform));
      }
      if (!points.length) continue;
      const xs = points.map(p => p.x), ys = points.map(p => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      const hit = document.createElementNS(NS, 'rect');
      hit.setAttribute('x', x); hit.setAttribute('y', y);
      hit.setAttribute('width', Math.max(Math.max(...xs) - x, 1));
      hit.setAttribute('height', Math.max(Math.max(...ys) - y, 1));
      hit.setAttribute('class', 'sch-component-hit'); hit.setAttribute('aria-hidden', 'true');
      // Above the symbol's own pin hit targets, within the symbol body only.
      component.append(hit);
    }
  }
  function updateSchematicSelection() {
    if (activeBoard?.kind !== 'schematic') return;
    const board = activeBoard;
    for (const [index, selected, cls] of [
      [board.schematicComponents, board.selectedComponents, 'sch-component-match'],
      [board.schematicNets, board.selectedNets, 'sch-net-match'],
    ]) {
      const matched = new Set([...selected].flatMap(id => index.get(id).elements));
      for (const row of index.values()) for (const el of row.elements) el.classList.toggle(cls, matched.has(el));
    }
    const names = (selected, index) => [...selected].map(id => index.get(id).name).join(', ');
    const selected = [];
    if (board.selectedComponents.size) selected.push('Components: ' + names(board.selectedComponents, board.schematicComponents));
    if (board.selectedNets.size) selected.push('Nets: ' + names(board.selectedNets, board.schematicNets));
    $('schematic-selection-status').textContent = selected.join('\n') || 'Nothing selected.';
    $('schematic-clear').disabled = !selected.length;
    updateProbeTargets();
  }
  function clearSchematicSelection() {
    if (activeBoard?.kind !== 'schematic') return;
    activeBoard.selectedComponents.clear(); activeBoard.selectedNets.clear();
    activeBoard.probeMessage = ''; activeBoard.probeResult = null; updateProbeResult();
    updateSchematicSelection();
  }
  function selectSchematic(e) {
    const net = e.target.closest('#scene [data-sch-nets]');
    const component = e.target.closest('#scene [data-sch-components]');
    activeBoard.probeMessage = ''; activeBoard.probeResult = null; updateProbeResult();
    // A pin selects its net; clicking the symbol body selects the component.
    const target = net || component;
    if (target && svg.contains(target)) {
      const selected = net ? activeBoard.selectedNets : activeBoard.selectedComponents;
      const ids = JSON.parse(target.getAttribute(net ? 'data-sch-nets' : 'data-sch-components'));
      if (ids.every(id => selected.has(id))) ids.forEach(id => selected.delete(id));
      else {
        if (!e.shiftKey) clearSchematicSelection();
        ids.forEach(id => selected.add(id));
      }
    } else if (!e.shiftKey) clearSchematicSelection();
    updateSchematicSelection();
  }
  $('schematic-clear').onclick = clearSchematicSelection;

  // ------------------------------------------------------------ cross-probing
  const identity = value => String(value || '').trim().toLowerCase();
  function updateProbeTargets() {
    const source = activeBoard;
    const fromSchematic = source?.kind === 'schematic';
    const kind = fromSchematic ? 'pcb' : 'schematic', noun = fromSchematic ? 'layout' : 'schematic';
    const select = $(fromSchematic ? 'probe-layout' : 'probe-schematic');
    const button = $(fromSchematic ? 'probe-layout-btn' : 'probe-schematic-btn');
    const status = $(fromSchematic ? 'probe-status' : 'probe-schematic-status');
    const targets = boards.filter(board => board.kind === kind && board.svg && !board.loading);
    if (source && !targets.some(board => board.id === source.probeTargetId))
      source.probeTargetId = targets.length === 1 ? targets[0].id : null;
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = targets.length ? 'Choose a ' + noun + '…' : 'No ' + noun + ' open';
    select.replaceChildren(empty, ...targets.map(board => {
      const option = document.createElement('option'); option.value = board.id; option.textContent = board.name; return option;
    }));
    select.value = source?.probeTargetId || '';
    select.disabled = !targets.length || !source?.svg;
    const selected = fromSchematic ? source.selectedComponents.size + source.selectedNets.size : componentHits.length + netHits.length;
    button.disabled = !source?.svg || !selected || !source.probeTargetId;
    status.textContent = !source?.svg ? '' : source.probeMessage || (!targets.length ?
      'Open a ' + (fromSchematic ? 'PCB layout (.PcbDoc or .kicad_pcb)' : 'schematic (.SchDoc, .kicad_sch, or .sch)') + ' to cross-probe.' :
      !selected ? 'Select ' + (fromSchematic ? 'schematic' : 'layout') + ' components or nets.' : !source.probeTargetId ? 'Choose the ' + noun + ' to probe.' : '');
  }
  function updateProbeResult() {
    const result = activeBoard?.probeResult;
    $('probe-result').hidden = !result;
    $('probe-result-status').textContent = result?.message || '';
    $('probe-back').disabled = !result || !boards.some(board => board.id === result.sourceId);
    $('probe-back').textContent = activeBoard?.kind === 'schematic' ? 'Back to layout' : 'Back to schematic';
  }
  $('probe-layout').onchange = () => {
    activeBoard.probeTargetId = Number($('probe-layout').value) || null;
    activeBoard.probeMessage = ''; updateProbeTargets();
  };
  $('probe-schematic').onchange = () => {
    activeBoard.probeTargetId = Number($('probe-schematic').value) || null;
    activeBoard.probeMessage = ''; updateProbeTargets();
  };
  $('probe-back').onclick = () => {
    const source = boards.find(board => board.id === activeBoard?.probeResult?.sourceId);
    if (source) activateBoard(source);
  };
  function matchingComponents(sourceId, row, layout, names) {
    const linked = layout.layoutComponents.filter(component => sourceId && component.source_id && identity(component.source_id) === identity(sourceId));
    if (linked.length) return [...names].filter(name => linked.some(component => identity(component.name) === identity(name)));
    return [...names].filter(name => {
      const link = layout.layoutComponents.find(component => identity(component.name) === identity(name));
      // An explicit link to another source symbol must not match by designator.
      if (sourceId && link?.source_id) return false;
      return identity(link?.source_name || name) === identity(row.name);
    });
  }
  const padKey = (component, pin) => JSON.stringify([identity(component), identity(pin)]);
  function layoutConnections(layout) {
    const primitives = [...layout.svg.querySelectorAll('#scene [data-component], #scene [data-net]')];
    const names = new Set(primitives.map(el => el.dataset.component).filter(Boolean));
    const netNames = new Set(primitives.map(el => el.dataset.net).filter(Boolean));
    const padNets = new Map();
    for (const el of primitives) {
      const { component, padNumber, padDesignator, net } = el.dataset;
      if (!component || !(padNumber || padDesignator) || !net) continue;
      const key = padKey(component, padNumber || padDesignator);
      if (!padNets.has(key)) padNets.set(key, new Set());
      padNets.get(key).add(net);
    }
    return { names, netNames, padNets };
  }
  function matchingNets(row, schematic, layout, { names, netNames, padNets }) {
    const byPins = new Set();
    for (const terminal of row.terminals) {
      if (!terminal.component || !terminal.pin) continue;
      const component = [...schematic.schematicComponents].find(([, item]) => identity(item.name) === identity(terminal.component));
      const matches = matchingComponents(component?.[0] || '', component?.[1] || { name: terminal.component }, layout, names);
      for (const name of matches) for (const net of padNets.get(padKey(name, terminal.pin)) || []) byPins.add(net);
    }
    return byPins.size ? [...byPins] : [...netNames].filter(name =>
      [row.name, ...row.aliases].some(alias => identity(alias) === identity(name)));
  }
  function probeResult(source, components, nets, unmatched) {
    return { sourceId: source.id,
      message: 'From ' + source.name + ': ' + components.size + ' component' + (components.size === 1 ? '' : 's') +
        ', ' + nets.size + ' net' + (nets.size === 1 ? '' : 's') + ' highlighted.' + unmatched };
  }
  $('probe-layout-btn').onclick = () => {
    const source = activeBoard;
    const layout = boards.find(board => board.id === source?.probeTargetId && board.kind === 'pcb' && board.svg && !board.loading);
    if (source?.kind !== 'schematic' || !layout) return;
    const connections = layoutConnections(layout), { names } = connections;
    const components = new Set(), nets = new Set(), missing = [];
    const resolveComponent = (id, row) => matchingComponents(id, row, layout, names);
    for (const id of source.selectedComponents) {
      const row = source.schematicComponents.get(id), matches = resolveComponent(id, row);
      if (matches.length) matches.forEach(name => components.add(name));
      else missing.push('component ' + row.name);
    }
    for (const id of source.selectedNets) {
      const row = source.schematicNets.get(id);
      const matches = matchingNets(row, source, layout, connections);
      if (matches.length === 1) nets.add(matches[0]);
      else missing.push('net ' + row.name + (matches.length > 1 ? ' (ambiguous)' : ''));
    }
    const unmatched = missing.length ? '\nNot found: ' + missing.join(', ') : '';
    if (!components.size && !nets.size) {
      source.probeMessage = 'No matches in ' + layout.name + '.' + unmatched; updateProbeTargets(); return;
    }
    layout.probeComponents = [...components]; layout.probeNets = [...nets];
    layout.componentQuery = [...components].join(', '); layout.netQuery = [...nets].join(', ');
    layout.probeResult = probeResult(source, components, nets, unmatched);
    activateBoard(layout); setViewMode('2d'); setMeasuring(false);
    const hits = [...componentHits, ...netHits];
    for (const group of groups) if (group.style.display === 'none' && hits.some(el => group.contains(el))) group._cb.click();
    fitMatches(hits);
  };
  $('probe-schematic-btn').onclick = () => {
    const source = activeBoard;
    const target = boards.find(board => board.id === source?.probeTargetId && board.kind === 'schematic' && board.svg && !board.loading);
    if (source?.kind !== 'pcb' || !target) return;
    const connections = layoutConnections(source);
    const components = new Set(), nets = new Set(), missing = [];
    for (const name of new Set(componentHits.map(el => el.dataset.component))) {
      const link = source.layoutComponents.find(component => identity(component.name) === identity(name));
      const matches = [...target.schematicComponents].filter(([id, row]) => link?.source_id ?
        identity(id) === identity(link.source_id) : identity(row.name) === identity(link?.source_name || name));
      if (matches.length) matches.forEach(([id]) => components.add(id));
      else missing.push('component ' + name);
    }
    const netMatches = [...target.schematicNets].map(([id, row]) => [id, matchingNets(row, target, source, connections)]);
    for (const name of new Set(netHits.map(el => el.dataset.net))) {
      const matches = netMatches.filter(([, names]) => names.length === 1 && names[0] === name);
      if (matches.length) matches.forEach(([id]) => nets.add(id));
      else missing.push('net ' + name + (netMatches.some(([, names]) => names.includes(name)) ? ' (ambiguous)' : ''));
    }
    const unmatched = missing.length ? '\nNot found: ' + missing.join(', ') : '';
    if (!components.size && !nets.size) {
      source.probeMessage = 'No matches in ' + target.name + '.' + unmatched; updateProbeTargets(); return;
    }
    target.selectedComponents = components; target.selectedNets = nets; target.probeMessage = '';
    target.probeResult = probeResult(source, components, nets, unmatched);
    activateBoard(target);
    const hits = [...components].flatMap(id => target.schematicComponents.get(id).elements)
      .concat([...nets].flatMap(id => target.schematicNets.get(id).elements));
    fitMatches(hits);
  };
  function resetProbeSelection(kind) {
    if (!activeBoard) return;
    activeBoard[kind] = null; activeBoard.probeResult = null; activeBoard.probeMessage = ''; updateProbeResult();
  }

  // ------------------------------------------------------------ layout highlight drawing
  function buildLayoutHighlight(id, hits, color) {
    svg?.querySelector('#' + id)?.remove();
    const overlay = document.createElementNS(NS, 'g'); overlay.id = id;
    overlay.style.pointerEvents = 'none';
    const hiddenPolygon = el => activeBoard?.polygonsHidden && el.closest('.polygon-copper');
    const visibleHits = hits.filter(el => !hiddenPolygon(el));
    const matched = new Set(visibleHits), branches = new Set();
    for (const el of visibleHits) for (let node = el; node && node.id !== 'scene'; node = node.parentElement) branches.add(node);
    function tintedCopy(node) {
      const copy = node.cloneNode(true);
      const originals = [node, ...node.querySelectorAll('*')], copies = [copy, ...copy.querySelectorAll('*')];
      for (let i = 0; i < originals.length; i++) {
        const original = originals[i], clone = copies[i];
        // Drill cutouts keep their paint. Tinting them would fill pad/via holes.
        if (!original.matches('path, rect, circle, ellipse, line, polyline, polygon, text, tspan, use') ||
            original.closest('[data-hole-owner], [data-primitive$="-hole"]')) continue;
        const paint = getComputedStyle(original);
        for (const property of ['fill', 'stroke']) {
          const value = paint[property];
          clone.style.setProperty(property, ['none', 'transparent', 'rgba(0, 0, 0, 0)'].includes(value) ? value : color, 'important');
        }
        clone.style.setProperty('stroke-width', paint.strokeWidth, 'important');
      }
      return copy;
    }
    function branch(node) {
      if (matched.has(node)) return tintedCopy(node);
      const copy = node.cloneNode(false);
      for (const child of node.children) if (branches.has(child)) copy.append(branch(child));
      return copy;
    }
    // Keep the renderer's transforms, clipping, widths, and shape geometry.
    // Only the original layer groups are faded; these copies stay at full opacity.
    for (const group of groups) if (group.style.display !== 'none' && branches.has(group)) overlay.append(branch(group));
    for (const el of overlay.querySelectorAll('*')) {
      el.removeAttribute('id'); el.classList.remove('component-match', 'net-match');
      for (const attr of [...el.attributes]) if (attr.name.startsWith('data-')) el.removeAttribute(attr.name);
    }
    if (overlay.childElementCount) svg.querySelector('#scene').append(overlay);
    svg?.classList.toggle('layout-selection', Boolean(svg.querySelector('#component-highlight, #net-highlight')));
    return { overlay, hidden: groups.filter(group => group.style.display === 'none' && branches.has(group)).length,
      hiddenPolygons: hits.some(hiddenPolygon) };
  }

  // ------------------------------------------------------------ component search
  let componentIndex = new Map(), componentHits = [];
  function mountComponentSearch() {
    componentIndex = new Map(); componentHits = [];
    for (const el of svg?.querySelectorAll('#scene [data-component]') || []) {
      const name = el.dataset.component;
      if (!name) continue;
      if (!componentIndex.has(name)) componentIndex.set(name, []);
      componentIndex.get(name).push(el);
    }
    $('component-options').replaceChildren(...[...componentIndex.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(name => {
      const option = document.createElement('option'); option.value = name; return option;
    }));
    $('component-query').disabled = !svg;
    $('component-query').value = activeBoard?.componentQuery || '';
    searchComponents();
  }
  function searchComponents() {
    for (const el of componentHits) el.classList.remove('component-match');
    componentHits = [];
    const query = $('component-query').value.trim().toLowerCase();
    if (activeBoard) activeBoard.componentQuery = $('component-query').value;
    const names = [...componentIndex.keys()];
    const exact = names.find(name => name.toLowerCase() === query);
    const matches = activeBoard?.probeComponents || (query ? names.filter(name => exact ? name === exact : name.toLowerCase().includes(query)) : []);
    componentHits = matches.flatMap(name => componentIndex.get(name));
    for (const el of componentHits) el.classList.add('component-match');
    updateComponentStatus(matches.length);
    updateProbeTargets();
  }
  function updateComponentStatus(count = new Set(componentHits.map(el => el.dataset.component)).size) {
    const { overlay, hidden, hiddenPolygons } = buildLayoutHighlight('component-highlight', componentHits, '#ffe066');
    $('component-fit').disabled = !overlay.childElementCount;
    $('component-reveal').hidden = !hidden;
    $('component-status').textContent = !$('component-query').value.trim() ? '' : !count ? 'No matching components.' :
      `${count} component${count === 1 ? '' : 's'} ${hiddenPolygons && !overlay.childElementCount ? 'matched' : 'highlighted'}` +
      (hidden ? `; ${hidden} hidden layer${hidden === 1 ? '' : 's'}` : '') + (hiddenPolygons ? '; polygons hidden.' : '.');
    netLabels.update(activeBoard);
  }
  function clearComponent() { resetProbeSelection('probeComponents'); $('component-query').value = ''; searchComponents(); }
  $('component-query').oninput = () => { resetProbeSelection('probeComponents'); searchComponents(); };
  $('component-clear').onclick = clearComponent;
  $('component-fit').onclick = () => fitMatches(componentHits);
  function fitMatches(hits) {
    const rects = hits.map(el => el.getBoundingClientRect()).filter(r => r.width || r.height);
    if (!rects.length) return;
    const bounds = rects.reduce((b, r) => ({ left: Math.min(b.left, r.left), top: Math.min(b.top, r.top),
      right: Math.max(b.right, r.right), bottom: Math.max(b.bottom, r.bottom) }), rects[0]);
    const a = toSvg({ clientX: bounds.left, clientY: bounds.top });
    const b = toSvg({ clientX: bounds.right, clientY: bounds.bottom });
    const pad = Math.max(b.x - a.x, b.y - a.y, 2) * 0.25;
    vb = { x: a.x - pad, y: a.y - pad, w: b.x - a.x + 2 * pad, h: b.y - a.y + 2 * pad }; apply();
  }
  $('component-reveal').onclick = () => {
    for (const g of groups) if (g.style.display === 'none' && componentHits.some(el => g.contains(el))) g._cb.click();
    updateComponentStatus();
  };

  // ------------------------------------------------------------ layers
  function updatePolygonControl() {
    const hidden = Boolean(activeBoard?.polygonsHidden);
    svg?.classList.toggle('hide-polygons', hidden);
    $('polygons-toggle').textContent = hidden ? 'Show polygons' : 'Hide polygons';
    $('polygons-toggle').setAttribute('aria-pressed', String(hidden));
    $('polygons-toggle').disabled = activeBoard?.kind !== 'pcb' || !svg?.querySelector('.polygon-copper');
  }
  $('polygons-toggle').onclick = () => {
    if (activeBoard?.kind !== 'pcb' || !svg) return;
    activeBoard.polygonsHidden = !activeBoard.polygonsHidden;
    updatePolygonControl(); updateComponentStatus(); updateNetStatus();
  };
  function defaultLayerVisible(g) {
    const { layerRole: role, layerFamily: family, layerToken: token } = g.dataset;
    if (g.id === 'board-outline' || role === 'copper' || role === 'drill' ||
        family === 'signal' || family === 'internal_plane') return true;
    // Tokens stay stable even when the board gives layers custom display names.
    if (token) return /^(TOP|BOTTOM|MID\d+|PLANE\d+|TOPOVERLAY|DRILLS|DRILLDRAWING|DRILLGUIDE|MULTILAYER)$/i.test(token);
    return /^(layer-)?(top|bottom|mid\d+|plane\d+|topoverlay|drills|drilldrawing|drillguide|multilayer)$/i.test(g.id) ||
      /^(top copper|bottom copper|top overlay)$/i.test(g.dataset.layerName || '');
  }
  function buildLayers() {
    layersEl.innerHTML = '';
    // Keep the sidebar in renderer order even after changing SVG paint order.
    if (!groups.length) groups = [...svg.querySelectorAll('#scene > g')];
    for (const g of groups) {
      const name = g.dataset.layerDisplayName || g.dataset.layerName || g.id.replace(/^layer-/, '');
      const color = g.dataset.color || (g.id === 'board-outline' ? '#C0A000' : '#888');
      const lab = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = g.style.display !== 'none';
      cb.onchange = () => {
        g.style.display = cb.checked ? '' : 'none';
        // SVG paints later siblings on top; retain the scene's transforms and clipping.
        if (cb.checked) g.parentNode.append(g);
        updateComponentStatus();
      };
      const sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = color;
      lab.append(cb, sw, document.createTextNode(name));
      if (g.dataset.primitiveCount !== undefined) { const c = document.createElement('span'); c.className = 'count'; c.textContent = g.dataset.primitiveCount; lab.append(c); }
      layersEl.append(lab); g._cb = cb;
    }
  }
  const setAll = v => { groups.forEach(g => { g._cb.checked = v; g.style.display = v ? '' : 'none'; }); updateComponentStatus(); };
  $('all').onclick = () => setAll(true);
  $('none').onclick = () => setAll(false);

  // ------------------------------------------------------------ net search
  let netIndex = new Map(), netHits = [];
  function mountNetSearch() {
    netIndex = new Map(); netHits = [];
    for (const el of svg?.querySelectorAll('#scene [data-net]') || []) {
      const name = el.dataset.net;
      if (!name) continue;
      if (!netIndex.has(name)) netIndex.set(name, []);
      netIndex.get(name).push(el);
    }
    $('net-options').replaceChildren(...[...netIndex.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(name => {
      const option = document.createElement('option'); option.value = name; return option;
    }));
    $('net-query').disabled = !svg;
    $('net-query').value = activeBoard?.netQuery || '';
    searchNets();
  }
  function searchNets() {
    for (const el of netHits) el.classList.remove('net-match');
    netHits = [];
    const query = $('net-query').value.trim().toLowerCase();
    if (activeBoard) activeBoard.netQuery = $('net-query').value;
    const names = [...netIndex.keys()];
    const exact = names.find(name => name.toLowerCase() === query);
    const matches = activeBoard?.probeNets || (query ? names.filter(name => exact ? name === exact : name.toLowerCase().includes(query)) : []);
    netHits = matches.flatMap(name => netIndex.get(name));
    for (const el of netHits) el.classList.add('net-match');
    updateNetStatus(matches.length);
    updateProbeTargets();
  }
  function updateNetStatus(count = new Set(netHits.map(el => el.dataset.net)).size) {
    const { overlay, hidden, hiddenPolygons } = buildLayoutHighlight('net-highlight', netHits, '#68e0ff');
    $('net-fit').disabled = !overlay.childElementCount;
    $('net-reveal').hidden = !hidden;
    $('net-status').textContent = !$('net-query').value.trim() ? '' : !count ? 'No matching nets.' :
      `${count} net${count === 1 ? '' : 's'} ${hiddenPolygons && !overlay.childElementCount ? 'matched' : 'highlighted'}` +
      (hidden ? `; ${hidden} hidden layer${hidden === 1 ? '' : 's'}` : '') + (hiddenPolygons ? '; polygons hidden.' : '.');
    netLabels.update(activeBoard);
  }
  function clearNet() { resetProbeSelection('probeNets'); $('net-query').value = ''; searchNets(); }
  $('net-query').oninput = () => { resetProbeSelection('probeNets'); searchNets(); };
  $('net-clear').onclick = clearNet;
  function toggleLayoutSelection(name, attribute, hits, selectionKey, queryId, search) {
    const selected = new Set(hits.map(el => el.dataset[attribute]));
    const remove = selected.delete(name);
    resetProbeSelection(selectionKey);
    // Retain the other exact matches from a search or cross-probe. The query
    // remains a readable list; the array prevents substring or comma matching.
    if (remove && selected.size) activeBoard[selectionKey] = [...selected];
    $(queryId).value = remove ? [...selected].join(', ') : name;
    search();
  }
  view.addEventListener('click', e => {
    if (is3D()) return;
    if (!svg || measuring || panned || e.button !== 0) return;
    if (activeBoard.kind === 'schematic') { selectSchematic(e); return; }
    const primitive = e.target.closest('#scene [data-net]');
    const name = primitive?.dataset.net;
    if (name && svg.contains(primitive) && netIndex.has(name)) {
      toggleLayoutSelection(name, 'net', netHits, 'probeNets', 'net-query', searchNets);
    }
    const component = e.target.closest('#scene [data-component]');
    const designator = component?.dataset.component;
    if (designator && svg.contains(component) && componentIndex.has(designator)) {
      toggleLayoutSelection(designator, 'component', componentHits, 'probeComponents', 'component-query', searchComponents);
    }
  });
  $('net-fit').onclick = () => fitMatches(netHits);
  $('net-reveal').onclick = () => {
    for (const g of groups) if (g.style.display === 'none' && netHits.some(el => g.contains(el))) g._cb.click();
    updateNetStatus();
  };

  layersEl.addEventListener('change', () => updateNetStatus());
  $('all').addEventListener('click', () => updateNetStatus());
  $('none').addEventListener('click', () => updateNetStatus());

  // ------------------------------------------------------------ pan / zoom
  let viewFrame = 0, drag = null, panned = false, gestureScale = null;
  function cancelViewUpdate() { cancelAnimationFrame(viewFrame); viewFrame = 0; }
  function apply(redrawMeasurements = true) {
    cancelViewUpdate();
    if (!svg) return;
    svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
    if (redrawMeasurements) draw(); else positionMeasurementLabels();
    netLabels.update(activeBoard);
  }
  function queueViewUpdate() {
    if (!viewFrame) viewFrame = requestAnimationFrame(() => { viewFrame = 0; apply(false); });
  }
  function viewPoint(e) {
    const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
    const shown = svg.viewBox.baseVal;
    // Input can arrive several times before the next animation frame. Account
    // for the pending viewBox while using the actual SVG letterbox transform.
    return { x: vb.x + (point.x - shown.x) * vb.w / shown.width,
             y: vb.y + (point.y - shown.y) * vb.h / shown.height };
  }
  function screenUnits() {
    const inverse = svg.getScreenCTM().inverse(), ratio = vb.w / svg.viewBox.baseVal.width;
    return { a: inverse.a * ratio, b: inverse.b * ratio, c: inverse.c * ratio, d: inverse.d * ratio };
  }
  function centerPoint() {
    const r = view.getBoundingClientRect(); return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  }
  function zoomAt(point, factor) {
    if (!svg || !Number.isFinite(factor) || factor <= 0) return;
    const span = Math.max(vb.w, vb.h), base = Math.max(home.w, home.h);
    const k = Math.max(base * 0.0001, Math.min(base * 100, span * factor)) / span;
    const anchor = viewPoint(point);
    vb = { x: anchor.x - (anchor.x - vb.x) * k, y: anchor.y - (anchor.y - vb.y) * k,
           w: vb.w * k, h: vb.h * k };
    queueViewUpdate();
  }
  function resetView() { if (is3D()) { threeViewer?.fit(); return; } if (svg) { drag = null; vb = { ...home }; apply(); } }
  $('zoom-in').onclick = () => is3D() ? threeViewer?.zoom(1 / 1.25) : zoomAt(centerPoint(), 1 / 1.25);
  $('zoom-out').onclick = () => is3D() ? threeViewer?.zoom(1.25) : zoomAt(centerPoint(), 1.25);
  $('view-fit').onclick = resetView;
  view.addEventListener('wheel', e => {
    if (!svg || is3D()) return;
    e.preventDefault();
    if (gestureScale !== null || !Number.isFinite(e.deltaX) || !Number.isFinite(e.deltaY)) return;
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) {
      zoomAt(e, Math.exp(Math.max(-100, Math.min(100, e.deltaY * unit)) * 0.01));
    } else {
      const scale = screenUnits(), dx = e.deltaX * unit, dy = e.deltaY * unit;
      vb.x += scale.a * dx + scale.c * dy; vb.y += scale.b * dx + scale.d * dy;
      queueViewUpdate();
    }
  }, { passive: false });
  // Safari exposes native pinch gestures separately from wheel events.
  view.addEventListener('gesturestart', e => {
    if (!svg || is3D()) return; e.preventDefault(); gestureScale = e.scale > 0 ? e.scale : 1;
  }, { passive: false });
  view.addEventListener('gesturechange', e => {
    if (!svg || is3D() || gestureScale === null || !Number.isFinite(e.scale) || e.scale <= 0) return;
    e.preventDefault();
    const point = Number.isFinite(e.clientX) && Number.isFinite(e.clientY) ? e : centerPoint();
    zoomAt(point, gestureScale / e.scale); gestureScale = e.scale;
  }, { passive: false });
  view.addEventListener('gestureend', e => { if (gestureScale !== null) e.preventDefault(); gestureScale = null; }, { passive: false });
  view.addEventListener('mousedown', e => {
    panned = false;
    if (!is3D() && svg && (e.button === 1 || e.button === 0 && !measuring)) {
      if (e.button === 1) e.preventDefault();
      drag = { x: e.clientX, y: e.clientY, vx: vb.x, vy: vb.y, scale: screenUnits() };
    }
  });
  window.addEventListener('mousemove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y, scale = drag.scale;
    if (Math.hypot(dx, dy) > 3) panned = true;
    vb.x = drag.vx - scale.a * dx - scale.c * dy; vb.y = drag.vy - scale.b * dx - scale.d * dy;
    queueViewUpdate();
  });
  window.addEventListener('mouseup', () => { drag = null; });
  window.addEventListener('blur', () => { drag = null; gestureScale = null; });
  view.addEventListener('dblclick', e => { if (e.button === 0 && !measuring) resetView(); });

  // ------------------------------------------------------------ measuring (SVG units are mm)
  const UNITS = { mm: { f: 1, d: 3 }, mil: { f: 1000 / 25.4, d: 1 }, in: { f: 1 / 25.4, d: 4 } };
  let unit = 'mm', measuring = false, pts = [], measurements = [], hover = null, mg = null;
  const fmt = v => (v * UNITS[unit].f).toFixed(UNITS[unit].d) + ' ' + unit;
  const toSvg = e => viewPoint(e);
  const toScreen = p => { const q = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM()); const r = view.getBoundingClientRect(); return { x: q.x - r.left, y: q.y - r.top }; };
  function dot(p) { const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', p.x); c.setAttribute('cy', p.y); c.setAttribute('r', 0.3); return c; }
  function positionMeasurementLabels() {
    if (!svg || is3D() || !label.childElementCount) return;
    const segments = [...measurements];
    if (pts.length && hover) segments.push([pts[0], hover]);
    for (let i = 0; i < segments.length; i++) {
      const [a, b] = segments[i], caption = label.children[i];
      if (!caption) continue;
      const point = toScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      caption.style.left = point.x + 'px'; caption.style.top = point.y + 'px';
    }
  }
  function draw() {
    if (!mg || is3D()) return;
    mg.replaceChildren(); label.replaceChildren();
    const segments = [...measurements];
    if (pts.length && hover) segments.push([pts[0], hover]);
    if (pts.length) mg.append(dot(pts[0]));
    for (const [a, b] of segments) {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', a.x); l.setAttribute('y1', a.y); l.setAttribute('x2', b.x); l.setAttribute('y2', b.y);
      mg.append(l, dot(a), dot(b));
      const m = toScreen({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      const caption = document.createElement('div'); caption.className = 'measure-label';
      caption.textContent = fmt(Math.hypot(b.x - a.x, b.y - a.y));
      caption.style.left = m.x + 'px'; caption.style.top = m.y + 'px'; label.append(caption);
    }
    const latest = segments.at(-1);
    if (!latest) {
      const p = pts[0] || (measuring && hover);
      readout.textContent = p ? `cursor  ${fmt(p.x)}, ${fmt(-p.y)}` : ''; return;
    }
    const [a, b] = latest, dx = b.x - a.x, dy = b.y - a.y;
    readout.textContent = `dist ${fmt(Math.hypot(dx, dy))}\ndx   ${fmt(Math.abs(dx))}\ndy   ${fmt(Math.abs(dy))}\nang  ${(Math.atan2(-dy, dx) * 180 / Math.PI).toFixed(1)}°`;
  }
  function setMeasuring(v) {
    v = Boolean(v && svg && !is3D() && activeBoard?.kind !== 'schematic');
    measuring = v; $('measure-btn').classList.toggle('on', v); view.classList.toggle('measuring', v);
    if (!v) { pts = []; hover = null; draw(); }
  }
  $('measure-btn').onclick = () => setMeasuring(!measuring);
  window.addEventListener('keydown', e => {
    if (is3D()) {
      if (e.target.closest('input, textarea, [contenteditable]') || e.target.closest('select') && e.target !== $('three-body-list')) return;
      if (e.key === 'Escape') { e.preventDefault(); clearBodies(); }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        // A tab's Delete key belongs to the existing tab-close shortcut.
        if (!e.target.closest('[role="tab"]')) { e.preventDefault(); deleteBodies(); }
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); undoBodies(); }
      return;
    }
    if (e.key === 'Escape') {
      clearSchematicSelection();
      clearComponent();
      e.preventDefault();
      clearNet(); setMeasuring(false);
      return;
    }
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    if (e.key === 'm' || e.key === 'M') setMeasuring(!measuring);
    if (e.shiftKey && e.key.toLowerCase() === 'c') { measurements = []; pts = []; hover = null; draw(); }
  });
  document.querySelectorAll('.unit').forEach(b => b.onclick = () => {
    unit = b.dataset.unit; document.querySelectorAll('.unit').forEach(x => x.classList.toggle('on', x === b)); draw();
  });
  view.addEventListener('click', e => {
    if (is3D()) return;
    if (!svg || !measuring || e.button !== 0) return;
    pts.push(toSvg(e));
    if (pts.length === 2) { measurements.push(pts); pts = []; hover = null; }
    draw();
  });
  view.addEventListener('mousemove', e => { if (svg && !is3D() && measuring) { hover = toSvg(e); if (pts.length || !measurements.length) draw(); } });

  new ResizeObserver(() => {
    positionMeasurementLabels();
    netLabels.update(activeBoard);
  }).observe(view);

  // ------------------------------------------------------------ board passed on the command line
  fetch('/initial').then(r => r.ok ? r.json() : null).then(d => {
    if (!d || !d.svg) return;
    const file = new File([Uint8Array.from(atob(d.source), c => c.charCodeAt(0))], d.name);
    const board = createBoard(file);
    show(board, d);
    if (!activeBoard) activateBoard(board);
    else updateTabs();
  }).catch(e => toast('Could not load the initial document: ' + e.message));
})();
