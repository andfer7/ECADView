// Variant identities belong to the project. Prefer saved source links over
// designators, which can change after annotation or repeat on another sheet.
const key = value => String(value ?? '').trim().toLowerCase();
const pathKey = value => key(value).replaceAll('/', '\\').split('\\').filter(Boolean).join('\\');
const leafKey = value => pathKey(value).split('\\').at(-1) || '';
const fullPath = value => pathKey(value).includes('\\');
const add = (map, id, row) => { if (!id) return; if (!map.has(id)) map.set(id, []); map.get(id).push(row); };

function components(board) {
  if (board.kind === 'schematic') {
    let elementsById;
    const resolve = values => (values || []).map(value => {
      if (typeof value !== 'string') return value;
      elementsById ||= new Map([...(board.svg?.querySelectorAll('#scene [id]') || [])].map(element => [element.id, element]));
      return elementsById.get(value);
    }).filter(Boolean);
    const rows = board.schematicComponents instanceof Map ? [...board.schematicComponents] :
      (board.selection?.components || []).map(row => [row.id, row]);
    return rows.map(([id, row]) => ({
      id, name: row.name, sourceId: pathKey(row.source_path || id), aliases: [key(row.name)],
      elements: resolve(row.elements), bodyElements: resolve(row.bodyElements || row.body_elements), board,
    }));
  }
  const graphics = new Map();
  for (const element of board.svg?.querySelectorAll('#scene [data-component]') || []) add(graphics, key(element.dataset.component), element);
  return (board.layoutComponents || []).map(row => ({
    id: row.name, name: row.name, sourceId: pathKey(row.source_path || row.source_id),
    aliases: [...new Set([key(row.name), key(row.source_name)].filter(Boolean))],
    elements: graphics.get(key(row.name)) || [], bodyElements: [], board,
  }));
}

/** Resolve a project's variation rows without changing source metadata or selections.
 * projectBoards lets UID-less rows detect duplicate names on other loaded sheets.
 * variantDocumentKey identifies duplicate tabs of the same project document.
 * PCB and schematic matches are separate: the two representations should agree.
 */
export function variantState(board, variant, projectBoards = [board]) {
  const result = { components: [], notFitted: new Set(), unmatched: [], ambiguous: [] };
  if (!variant) return result;
  const local = components(board);
  const documents = [board], seenDocuments = new Set();
  if (board.variantDocumentKey) seenDocuments.add(pathKey(board.variantDocumentKey));
  for (const other of projectBoards) {
    if (other === board || other.kind !== board.kind) continue;
    const document = pathKey(other.variantDocumentKey);
    if (document && seenDocuments.has(document)) continue;
    if (document) seenDocuments.add(document);
    documents.push(other);
  }
  const all = documents
    .flatMap(other => other === board ? local : components(other));
  const paths = new Map(), leaves = new Map(), names = new Map(), sourceNames = new Map();
  for (const row of all) {
    add(paths, row.sourceId, row); add(leaves, leafKey(row.sourceId), row);
    add(names, key(row.name), row);
    for (const alias of row.aliases) add(sourceNames, alias, row);
  }
  // Repeated sheet instances can have one logical UID but different assembly
  // choices. A logical sheet must not silently show one instance's choice.
  const variantPaths = new Map();
  for (const variation of variant.components || []) {
    const id = pathKey(variation.unique_id), leaf = leafKey(id);
    if (!leaf) continue;
    if (!variantPaths.has(leaf)) variantPaths.set(leaf, new Set());
    variantPaths.get(leaf).add(id);
  }
  const resolved = new Map();
  for (const variation of variant.components || []) {
    const id = pathKey(variation.unique_id), leaf = leafKey(id), name = key(variation.designator);
    let candidates = [], ambiguous = false;
    if (id) {
      candidates = paths.get(id) || [];
      // The same fully identified component can appear in two PCB documents
      // (or two tabs of one document). That does not make its identity vague.
      if (fullPath(id) && candidates.some(row => row.board === board)) candidates = candidates.filter(row => row.board === board);
      // A complete source path remains authoritative even if another path has
      // the same trailing logical UID. Only leaf-only metadata can fall back.
      if (!candidates.length) {
        candidates = (leaves.get(leaf) || []).filter(row => !fullPath(id) || !fullPath(row.sourceId));
        if (candidates.length && (variantPaths.get(leaf)?.size || 0) > 1) ambiguous = true;
      }
      if (!candidates.length) candidates = (names.get(name) || sourceNames.get(name) || []).filter(row => !row.sourceId);
    } else {
      candidates = names.get(name) || sourceNames.get(name) || [];
    }
    if (ambiguous || candidates.length > 1) {
      if (candidates.some(row => row.board === board)) result.ambiguous.push(variation);
      else result.unmatched.push(variation);
      continue;
    }
    const target = candidates[0];
    if (!target || target.board !== board) { result.unmatched.push(variation); continue; }
    const previous = resolved.get(target.id);
    resolved.set(target.id, {
      id: target.id, name: target.name, kind: variation.kind || 'fitted',
      parameters: { ...previous?.parameters, ...variation.parameters },
      alternate_part: variation.alternate_part || '', variation,
      elements: target.elements, bodyElements: target.bodyElements,
    });
  }
  result.components = [...resolved.values()];
  for (const row of result.components) if (row.kind === 'not_fitted') result.notFitted.add(row.name);
  return result;
}

function displayed(element, svg) {
  // The GPU renderer deliberately hides #scene via visibility. Display and
  // hidden ancestors still express the user's actual layer/polygon choices.
  for (let node = element; node && node !== svg; node = node.parentElement) {
    if (node.hidden || node.style?.display === 'none' || getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

function boundsInRoot(elements, svg, inverse) {
  const points = [];
  for (const element of elements) {
    if (!displayed(element, svg) || typeof element.getBBox !== 'function') continue;
    const screen = element.getScreenCTM();
    if (!screen) continue;
    const b = element.getBBox(), matrix = inverse.multiply(screen);
    if (!b.width && !b.height) continue;
    for (const [x, y] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]) {
      points.push(new DOMPoint(x, y).matrixTransform(matrix));
    }
  }
  if (!points.length) return null;
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  return { left: Math.min(...xs), right: Math.max(...xs), top: Math.min(...ys), bottom: Math.max(...ys) };
}

/** Draw assembly markers above SVG/GPU geometry, leaving layers and copper intact. */
export function renderVariantOverlay(board, state) {
  const svg = board.svg;
  if (!svg) return;
  svg.querySelector('#variant-overlay')?.remove();
  if (!state?.notFitted?.size || !svg.isConnected) return;
  const matrix = svg.getScreenCTM();
  if (!matrix || matrix.a * matrix.d === matrix.b * matrix.c) return;
  const inverse = matrix.inverse(), namespace = 'http://www.w3.org/2000/svg';
  const overlay = document.createElementNS(namespace, 'g');
  overlay.id = 'variant-overlay'; overlay.setAttribute('pointer-events', 'none'); overlay.setAttribute('aria-hidden', 'true');
  overlay.setAttribute('fill', 'none'); overlay.setAttribute('stroke', '#ff5252');
  overlay.setAttribute('stroke-width', '2.5'); overlay.setAttribute('stroke-linecap', 'round');
  for (const row of state.components) {
    if (row.kind !== 'not_fitted') continue;
    const box = boundsInRoot(row.bodyElements.length ? row.bodyElements : row.elements, svg, inverse);
    if (!box) continue;
    const width = box.right - box.left, height = box.bottom - box.top, padding = Math.max(width, height) * 0.08;
    const left = box.left - padding, right = box.right + padding, top = box.top - padding, bottom = box.bottom + padding;
    const cross = document.createElementNS(namespace, 'path');
    cross.dataset.variantComponent = row.name;
    cross.setAttribute('vector-effect', 'non-scaling-stroke');
    cross.setAttribute('d', `M${left} ${top}L${right} ${bottom}M${left} ${bottom}L${right} ${top}`);
    overlay.append(cross);
  }
  const measurement = svg.querySelector(':scope > #measure');
  svg.insertBefore(overlay, measurement);
}
