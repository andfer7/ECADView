const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
let variants;
before(async () => {
  const source = readFileSync(resolve(__dirname, '../ecadview/static/variants.js'));
  variants = await import('data:text/javascript;base64,' + source.toString('base64'));
});
const layout = rows => ({ kind: 'pcb', layoutComponents: rows });
const schematic = rows => ({ kind: 'schematic', schematicComponents: new Map(rows.map(([id, name]) => [id, { name, elements: [] }])) });
const variant = rows => ({ name: 'Assembly', components: rows });
const dnp = (designator, unique_id = '') => ({ designator, unique_id, kind: 'not_fitted', parameters: {} });
const matched = state => state.components.map(row => row.name);

test('saved full source paths find renamed components and override misleading designators', () => {
  const board = layout([
    { name: 'R42', source_name: 'R1', source_id: 'COMP', source_path: '\\ROOT\\SHEET\\COMP' },
    { name: 'R1', source_name: 'R1', source_id: 'OTHER', source_path: '\\ROOT\\SHEET\\OTHER' },
  ]);
  const state = variants.variantState(board, variant([dnp('R1', '/root/sheet/comp')]));
  assert.deepEqual(matched(state), ['R42']);
  assert.deepEqual([...state.notFitted], ['R42']);
  assert.equal(state.components[0].variation.designator, 'R1');
});

test('repeated sheet instances resolve by complete path and conflicting paths never fall back to a UID leaf', () => {
  const board = layout([
    { name: 'R1A', source_name: 'R1', source_id: 'C', source_path: '\\A\\C' },
    { name: 'R1B', source_name: 'R1', source_id: 'C', source_path: '\\B\\C' },
  ]);
  const rows = [dnp('R1A', '\\A\\C'), { designator: 'R1B', unique_id: '\\B\\C', kind: 'fitted', parameters: { Value: '10k' } }];
  const state = variants.variantState(board, variant(rows));
  assert.deepEqual(matched(state), ['R1A', 'R1B']);
  assert.deepEqual([...state.notFitted], ['R1A']);
  const missing = variants.variantState(board, variant([dnp('R1A', '\\WRONG\\C')]));
  assert.deepEqual(matched(missing), []);
  assert.equal(missing.unmatched.length, 1);
});

test('logical source sheets reject different instance variations but accept an unambiguous UID leaf', () => {
  const board = schematic([['C', 'R1']]);
  assert.deepEqual(matched(variants.variantState(board, variant([dnp('Renamed', '\\A\\C')]))), ['R1']);
  const repeated = variants.variantState(board, variant([dnp('R1A', '\\A\\C'), dnp('R1B', '\\B\\C')]));
  assert.deepEqual(matched(repeated), []);
  assert.equal(repeated.ambiguous.length, 2);
});

test('complete identities remain valid in multiple PCB documents of one project', () => {
  const a = layout([{ name: 'R1', source_id: 'C', source_path: '\\SHEET\\C' }]);
  const b = layout([{ name: 'R42', source_id: 'C', source_path: '\\SHEET\\C' }]);
  const rows = variant([dnp('R1', '\\SHEET\\C')]);
  assert.deepEqual(matched(variants.variantState(a, rows, [a, b])), ['R1']);
  assert.deepEqual(matched(variants.variantState(b, rows, [a, b])), ['R42']);
});

test('explicit mismatched IDs never mark an unrelated component with the same designator', () => {
  const board = schematic([['ONE', 'R1'], ['TWO', 'R2']]);
  const state = variants.variantState(board, variant([dnp('R1', 'OTHER')]));
  assert.deepEqual(matched(state), []);
  assert.equal(state.unmatched.length, 1);
});

test('unlinked legacy components use unique designators and source aliases, without ambiguous guesses', () => {
  const board = layout([{ name: 'R1' }, { name: 'R99', source_name: 'R2' }]);
  assert.deepEqual(matched(variants.variantState(board, variant([dnp(' r1 ', 'SAVED'), dnp('r2')]))), ['R1', 'R99']);
  const duplicates = layout([{ name: 'R99', source_name: 'R2' }, { name: 'R100', source_name: 'R2' }]);
  const state = variants.variantState(duplicates, variant([dnp('R2')]));
  assert.deepEqual(matched(state), []);
  assert.equal(state.ambiguous.length, 1);
});

test('other project sheets detect repeated names while PCB and schematic representations remain independent', () => {
  const a = schematic([['A', 'R1']]), b = schematic([['B', 'R1']]), pcb = layout([{ name: 'R1', source_id: 'A' }]);
  const rows = variant([dnp('R1')]);
  const repeated = variants.variantState(a, rows, [a, b, pcb]);
  assert.deepEqual(matched(repeated), []);
  assert.equal(repeated.ambiguous.length, 1);
  assert.deepEqual(matched(variants.variantState(a, rows, [a, pcb])), ['R1']);
  assert.deepEqual(matched(variants.variantState(a, variant([dnp('R1', 'A')]), [a, b])), ['R1']);
});

test('parameter overrides retain empty values and alternate metadata, base design clears all state without mutating sources', () => {
  const board = layout([{ name: 'U1', source_id: 'ID' }]);
  const original = variant([{ designator: 'U1', unique_id: 'ID', kind: 'alternate',
    alternate_part: 'Replacement <part>', parameters: { Value: '', Manufacturer: 'A & B' } }]);
  const snapshot = structuredClone(original);
  const state = variants.variantState(board, original);
  assert.deepEqual(state.components[0].parameters, { Value: '', Manufacturer: 'A & B' });
  assert.equal(state.components[0].alternate_part, 'Replacement <part>');
  assert.equal(state.notFitted.size, 0);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(variants.variantState(board, null), { components: [], notFitted: new Set(), unmatched: [], ambiguous: [] });
});

test('duplicate document tabs retain variant state while genuinely distinct sheets remain ambiguous', () => {
  const first = schematic([['COMP', 'R1']]), duplicate = schematic([['COMP', 'R1']]);
  first.variantDocumentKey = 'sheets/Main.SchDoc';
  duplicate.variantDocumentKey = 'SHEETS\\MAIN.SCHDOC';
  const tabs = [first, duplicate];
  for (const rows of [variant([dnp('R1')]), variant([dnp('R1', 'COMP')])]) {
    for (const board of tabs) {
      const state = variants.variantState(board, rows, tabs);
      assert.deepEqual([...state.notFitted], ['R1']);
      assert.deepEqual(state.ambiguous, []);
    }
    const other = schematic([['COMP', 'R1']]);
    other.variantDocumentKey = 'sheets/Other.SchDoc';
    const state = variants.variantState(first, rows, [...tabs, other]);
    assert.deepEqual([...state.notFitted], []);
    assert.equal(state.ambiguous.length, 1);
  }
});
