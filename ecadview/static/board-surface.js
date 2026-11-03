// Rasterize the real outer PCB layers once per prepared 3D scene. Interior copper,
// selection overlays, measurements and 2D visibility never enter the finish.
const NS = 'http://www.w3.org/2000/svg';
const MASK = '#0e452c', COPPER_UNDER_MASK = '#104c30', METAL = '#b8aa7e', INK = '#eeeade';
const COMPONENT = '#ffe066', NET = '#68e0ff', INNER_NET = '#b196ff';

function token(group) { return (group.dataset.layerToken || group.id.replace(/^layer-/i, '')).toUpperCase(); }
function layer(group, side, role) {
  const front = side === 'top', name = token(group);
  if (role === 'copper') return name === (front ? 'TOP' : 'BOTTOM') || name === (front ? 'F.CU' : 'B.CU');
  if (role === 'mask') return name === (front ? 'TOPSOLDER' : 'BOTTOMSOLDER') || name === (front ? 'F.MASK' : 'B.MASK');
  return name === (front ? 'TOPOVERLAY' : 'BOTTOMOVERLAY') || name === (front ? 'F.SILKS' : 'B.SILKS');
}

function drawing(source, groups, window, size) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('xmlns', NS); svg.setAttribute('width', size[0]); svg.setAttribute('height', size[1]);
  svg.setAttribute('viewBox', window.join(' '));
  for (const defs of source.querySelectorAll('defs')) svg.append(defs.cloneNode(true));
  // The caller supplies detached groups: either complete layers or just the
  // selected branches, including their ancestor transforms and clip paths.
  for (const copy of groups) {
    for (const node of [copy, ...copy.querySelectorAll('*')]) {
      node.removeAttribute('style'); node.removeAttribute('class');
      node.removeAttribute('display'); node.removeAttribute('visibility'); node.removeAttribute('opacity');
      // Preserve geometry, fill rules and explicit "none" paints, including
      // stroke-font silkscreen. Every visible paint becomes opaque white.
      for (const key of ['fill', 'stroke']) if (node.hasAttribute(key) && node.getAttribute(key) !== 'none' && !node.getAttribute(key).startsWith('url('))
        node.setAttribute(key, '#fff');
    }
    if (!copy.hasAttribute('fill')) copy.setAttribute('fill', '#fff');
    svg.append(copy);
  }
  return new XMLSerializer().serializeToString(svg);
}

async function raster(source, groups, window, size) {
  const canvas = document.createElement('canvas'); [canvas.width, canvas.height] = size;
  if (!groups.length) return canvas;
  const url = URL.createObjectURL(new Blob([drawing(source, groups, window, size)], { type: 'image/svg+xml' }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    canvas.getContext('2d').drawImage(image, 0, 0);
  } finally { URL.revokeObjectURL(url); }
  return canvas;
}

function tinted(context, image, color) {
  const copy = document.createElement('canvas'); copy.width = image.width; copy.height = image.height;
  const paint = copy.getContext('2d'); paint.drawImage(image, 0, 0);
  paint.globalCompositeOperation = 'source-in'; paint.fillStyle = color; paint.fillRect(0, 0, copy.width, copy.height);
  context.drawImage(copy, 0, 0);
}

function surfaceFrame(source, model, maximum) {
  if (!source || !model.surface_origin) return null;
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  for (const part of model.board) for (const [x, y] of part.outline) {
    bounds[0] = Math.min(bounds[0], x); bounds[1] = Math.min(bounds[1], y);
    bounds[2] = Math.max(bounds[2], x); bounds[3] = Math.max(bounds[3], y);
  }
  const width = bounds[2] - bounds[0], height = bounds[3] - bounds[1];
  if (width <= 0 || height <= 0) return null;
  const [x, y] = model.surface_origin, window = [x + bounds[0], y - bounds[3], width, height];
  const size = [Math.max(1, Math.round(maximum * width / Math.max(width, height))),
    Math.max(1, Math.round(maximum * height / Math.max(width, height)))];
  const groups = [...source.querySelectorAll('#scene > g[data-layer-token], #scene > g[id^="layer-"]')];
  return { bounds, window, size, groups };
}

export async function boardSurfaces(source, model, maximum = 2048) {
  const frame = surfaceFrame(source, model, maximum);
  if (!frame) return [];
  const { bounds, window, size, groups } = frame;
  const results = [];
  for (const side of ['top', 'bottom']) {
    const [copper, openings, silk] = await Promise.all(['copper', 'mask', 'silk'].map(role =>
      raster(source, groups.filter(group => layer(group, side, role)).map(group => group.cloneNode(true)), window, size)));
    const exposed = openings.getContext('2d');
    exposed.globalCompositeOperation = 'destination-in'; exposed.drawImage(copper, 0, 0);
    // Where a document has copper but no mask layer, retain the copper relief
    // without pretending that every route is bare metal.
    const color = document.createElement('canvas'); [color.width, color.height] = size;
    const albedo = color.getContext('2d'); albedo.fillStyle = MASK; albedo.fillRect(0, 0, ...size);
    tinted(albedo, copper, COPPER_UNDER_MASK); tinted(albedo, openings, METAL); tinted(albedo, silk, INK);
    const physical = document.createElement('canvas'); [physical.width, physical.height] = size;
    const finish = physical.getContext('2d'); finish.fillStyle = 'rgb(0,145,0)'; finish.fillRect(0, 0, ...size);
    // Three.js roughness uses green, metalness uses blue in the same map.
    tinted(finish, openings, 'rgb(0,72,235)'); tinted(finish, silk, 'rgb(0,205,0)');
    results.push({ side, color, physical, bounds });
  }
  return results;
}

function innerCopper(group) {
  if (layer(group, 'top', 'copper') || layer(group, 'bottom', 'copper') || token(group) === 'MULTILAYER') return false;
  return group.dataset.layerRole === 'copper' || ['signal', 'internal_plane'].includes(group.dataset.layerFamily) ||
    /^(MID\d+|PLANE\d+|IN\d+\.CU)$/.test(token(group));
}

function mechanicalLayer(group) {
  return group.dataset.layerRole === 'mechanical' || /^(MECHANICAL\d+|[FB]\.(FAB|CRTYD))$/.test(token(group));
}

// Metadata can be on the primitive itself or on a group of strokes/shapes.
// Copy the matching subtrees and the ancestors needed to place them.
async function probeMask(source, groups, field, names, frame, tint, unplaced) {
  if (!names.size) return null;
  const copies = [];
  for (const group of groups) {
    const matches = new Set(), branches = new Set();
    for (const node of group.querySelectorAll('[data-' + field + ']')) {
      if (!names.has(node.dataset[field])) continue;
      matches.add(node);
      unplaced?.delete(node.dataset[field]);
      for (let parent = node; parent !== group.parentElement && !branches.has(parent); parent = parent.parentElement)
        branches.add(parent);
    }
    function branch(node) {
      if (matches.has(node)) return node.cloneNode(true);
      const copy = node.cloneNode(false);
      for (const child of node.children) if (branches.has(child)) copy.append(branch(child));
      return copy;
    }
    if (branches.has(group)) copies.push(branch(group));
  }
  if (!copies.length) return null;
  const mask = await raster(source, copies, frame.window, frame.size);
  const context = mask.getContext('2d');
  context.globalCompositeOperation = 'source-in'; context.fillStyle = tint; context.fillRect(0, 0, ...frame.size);
  return mask;
}

export async function boardProbeSurfaces(source, model, selection, maximum = 2048) {
  const nets = new Set(selection?.nets), components = new Set(selection?.components);
  if (!nets.size && !components.size) return [];
  const frame = surfaceFrame(source, model, maximum);
  if (!frame) return [];
  const { groups, size, bounds } = frame, faces = [], unplaced = new Set(components);
  const inner = await probeMask(source, groups.filter(innerCopper), 'net', nets, frame, INNER_NET);
  for (const side of ['top', 'bottom']) {
    const outer = groups.filter(group => layer(group, side, 'copper') || token(group) === 'MULTILAYER');
    const footprint = groups.filter(group => layer(group, side, 'silk') ||
      mechanicalLayer(group) && token(group).startsWith(side === 'top' ? 'F.' : 'B.'));
    const [net, component] = await Promise.all([
      probeMask(source, outer, 'net', nets, frame, NET),
      probeMask(source, [...outer, ...footprint], 'component', components, frame, COMPONENT, unplaced),
    ]);
    faces.push({ side, net, component });
  }
  // Some model-less footprints live only on a side-agnostic mechanical layer.
  // Project those on both faces, without duplicating ordinary sided footprints.
  const mechanical = groups.filter(group => mechanicalLayer(group) && !/^[FB]\./.test(token(group)));
  const fallback = await probeMask(source, mechanical, 'component', unplaced, frame, COMPONENT);
  const results = [];
  for (const { side, net, component } of faces) {
    if (!inner && !net && !component && !fallback) continue;
    const color = document.createElement('canvas'); [color.width, color.height] = size;
    const context = color.getContext('2d');
    // Exposed copper covers projected inner routes, and a footprint stays
    // visible when its pads also belong to a probed net.
    for (const mask of [inner, net, fallback, component]) if (mask) context.drawImage(mask, 0, 0);
    results.push({ side, color, bounds });
  }
  return results;
}
