const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
let captureDrop, resolveProjectDocument;
before(async () => {
  const source = readFileSync(resolve(__dirname, '../ecadview/static/dropped-files.js'));
  ({ captureDrop, resolveProjectDocument } = await import('data:text/javascript;base64,' + source.toString('base64')));
});

const file = name => ({ name });
const fileHandle = (name, onRead = () => {}) => ({ kind: 'file', name, async getFile() { onRead(); return file(name); } });
const directoryHandle = (name, children) => ({ kind: 'directory', name, async *values() { yield* children; } });
const modernItem = handle => ({ kind: 'file', getAsFileSystemHandle: () => Promise.resolve(handle) });
const legacyFile = (name, onRead = () => {}) => ({ name, isFile: true,
  file(success, failure) { try { onRead(); success(file(name)); } catch (error) { failure(error); } } });
function legacyDirectory(name, batches, onRead = () => {}) {
  return { name, isDirectory: true, createReader() {
    let index = 0;
    return { readEntries(success, failure) {
      try { onRead(); success(batches[index++] || []); } catch (error) { failure(error); }
    } };
  } };
}
const legacyItem = entry => ({ kind: 'file', webkitGetAsEntry: () => entry });

test('captures every modern promise and legacy/file fallback synchronously before awaiting', async () => {
  let active = true, finish;
  const captured = [];
  const pending = new Promise(resolve => { finish = resolve; });
  const makeItem = name => ({ kind: 'file',
    getAsFileSystemHandle() { assert.ok(active); captured.push(`handle:${name}`); return pending; },
    webkitGetAsEntry() { assert.ok(active); captured.push(`entry:${name}`); return legacyFile(name); },
    getAsFile() { assert.ok(active); captured.push(`file:${name}`); return file(name); },
  });
  const transfer = { items: [makeItem('one.PrjPcb'), makeItem('two.PcbDoc')], files: [] };
  const result = captureDrop(transfer);
  active = false;
  transfer.items.length = 0;
  assert.deepEqual(captured, ['handle:one.PrjPcb', 'entry:one.PrjPcb', 'file:one.PrjPcb',
    'handle:two.PcbDoc', 'entry:two.PcbDoc', 'file:two.PcbDoc']);
  finish(null);
  assert.deepEqual((await result).files.map(record => record.path), ['one.PrjPcb', 'two.PcbDoc']);
});

test('modern folders retain complete paths, shared root handles and only read supported CAD files', async () => {
  const read = [], document = name => fileHandle(name, () => read.push(name));
  const rootHandle = directoryHandle('Project', [document('Demo.PrjPcb'),
    directoryHandle('Schematics', [document('Main.SCHDOC'), document('notes.txt')]),
    document('Board.PcbDoc'), document('demo.kicad_pcb'), document('demo.kicad_sch'), document('old.sch'), document('photo.png')]);
  const result = await captureDrop({ items: [modernItem(rootHandle)] });
  assert.equal(result.hasDirectories, true);
  assert.deepEqual(result.roots, [{ name: 'Project', handle: rootHandle }]);
  assert.deepEqual(result.files.map(record => record.path), ['Project/Demo.PrjPcb', 'Project/Schematics/Main.SCHDOC',
    'Project/Board.PcbDoc', 'Project/demo.kicad_pcb', 'Project/demo.kicad_sch', 'Project/old.sch']);
  assert.ok(result.files.every(record => record.root === result.roots[0]));
  assert.deepEqual(read, ['Demo.PrjPcb', 'Main.SCHDOC', 'Board.PcbDoc', 'demo.kicad_pcb', 'demo.kicad_sch', 'old.sch']);
});

test('legacy folders exhaust all readEntries batches and retain nested paths', async () => {
  let reads = 0, unrelatedReads = 0;
  const root = legacyDirectory('Project', [
    [legacyFile('Demo.PrjPcb'), legacyDirectory('Sheets', [[legacyFile('Main.SchDoc')]])],
    [legacyFile('Board.PcbDoc'), legacyFile('notes.txt', () => unrelatedReads++)],
  ], () => reads++);
  const result = await captureDrop({ items: [legacyItem(root)] });
  assert.equal(reads, 3);
  assert.equal(unrelatedReads, 0);
  assert.deepEqual(result.roots, [{ name: 'Project', handle: null }]);
  assert.deepEqual(result.files.map(record => record.path), ['Project/Demo.PrjPcb', 'Project/Sheets/Main.SchDoc', 'Project/Board.PcbDoc']);
  assert.ok(result.files.every(record => record.root === result.roots[0]));
});

test('distinct same-name dropped folders keep separate roots and loose files stay unscoped', async () => {
  const first = directoryHandle('Project', [fileHandle('Demo.PrjPcb')]);
  const second = directoryHandle('Project', [fileHandle('Demo.PrjPcb')]);
  const loose = file('Loose.SchDoc');
  const result = await captureDrop({ items: [modernItem(first), modernItem(second), { kind: 'file', getAsFile: () => loose }] });
  assert.equal(result.roots.length, 2);
  assert.notEqual(result.files[0].root, result.files[1].root);
  assert.deepEqual(result.files[2], { file: loose, path: loose.name, root: null });
});

test('empty folders are still recorded and do not become loose directory placeholders', async () => {
  const result = await captureDrop({ items: [modernItem(directoryHandle('Empty', []))], files: [file('Empty')] });
  assert.equal(result.hasDirectories, true);
  assert.equal(result.roots[0].name, 'Empty');
  assert.deepEqual(result.files, []);
});

test('ordinary FileList fallback is snapshotted when items are absent or unusable', async () => {
  const original = [file('one.SchDoc'), file('notes.txt')], transfer = { files: [...original] };
  const pending = captureDrop(transfer);
  transfer.files.length = 0;
  assert.deepEqual(await pending, { files: original.map(file => ({ file, path: file.name, root: null })), roots: [], hasDirectories: false });
  for (const items of [[{ kind: 'string' }], [{ kind: 'file', getAsFileSystemHandle: async () => null, getAsFile: () => null }]]) {
    const result = await captureDrop({ items, files: original });
    assert.deepEqual(result.files.map(record => record.file), original);
  }
});

test('null and rejected modern handles fall back to already captured legacy folders', async () => {
  for (const getAsFileSystemHandle of [async () => null, async () => { throw new Error('API unavailable'); }]) {
    const root = legacyDirectory('Project', [[legacyFile('Demo.PrjPcb')]]);
    const result = await captureDrop({ items: [{ ...legacyItem(root), getAsFileSystemHandle }] });
    assert.equal(result.hasDirectories, true);
    assert.equal(result.files[0].path, 'Project/Demo.PrjPcb');
  }
});

test('unreadable modern folders fail clearly while individual files retain their error and path', async () => {
  const unreadable = { kind: 'directory', name: 'Private', async *values() { throw new Error('Permission denied'); } };
  await assert.rejects(captureDrop({ items: [modernItem(unreadable)], files: [file('Private')] }), /folder "Private".*Permission denied/);
  const broken = directoryHandle('Project', [fileHandle('Board.PcbDoc', () => { throw new Error('File removed'); })]);
  const result = await captureDrop({ items: [modernItem(broken)] });
  assert.equal(result.files[0].file, null);
  assert.equal(result.files[0].path, 'Project/Board.PcbDoc');
  assert.equal(result.files[0].root, result.roots[0]);
  assert.match(result.files[0].error.message, /file "Project\/Board.PcbDoc".*File removed/);
});

test('unreadable legacy folders fail clearly while individual files retain their error and path', async () => {
  const root = legacyDirectory('Project', [[legacyFile('Demo.PrjPcb')]], () => { throw new Error('Permission denied'); });
  await assert.rejects(captureDrop({ items: [legacyItem(root)] }), /folder "Project".*Permission denied/);
  const broken = legacyDirectory('Project', [[legacyFile('Board.PcbDoc', () => { throw new Error('File removed'); })]]);
  const result = await captureDrop({ items: [legacyItem(broken)] });
  assert.equal(result.files[0].file, null);
  assert.equal(result.files[0].path, 'Project/Board.PcbDoc');
  assert.equal(result.files[0].root, result.roots[0]);
  assert.match(result.files[0].error.message, /file "Project\/Board.PcbDoc".*File removed/);
});

test('an unrelated unreadable CAD file preserves good projects and can be resolved if referenced', async () => {
  const fail = () => { throw new Error('Archive file unavailable'); };
  const sources = [
    modernItem(directoryHandle('Project', [fileHandle('Demo.PrjPcb'),
      directoryHandle('Archive', [fileHandle('Old.PcbDoc', fail)]), fileHandle('Main.SchDoc')])),
    legacyItem(legacyDirectory('Project', [[legacyFile('Demo.PrjPcb'),
      legacyDirectory('Archive', [[legacyFile('Old.PcbDoc', fail)]]), legacyFile('Main.SchDoc')]])),
  ];
  for (const item of sources) {
    const { files } = await captureDrop({ items: [item] });
    assert.deepEqual(files.map(record => record.path), ['Project/Demo.PrjPcb', 'Project/Archive/Old.PcbDoc', 'Project/Main.SchDoc']);
    assert.equal(files[0].file.name, 'Demo.PrjPcb');
    assert.equal(resolveProjectDocument(files[0], 'Main.SchDoc', files), files[2]);
    const archived = resolveProjectDocument(files[0], 'Archive/Old.PcbDoc', files);
    assert.equal(archived, files[1]);
    assert.equal(archived.file, null);
    assert.match(archived.error.message, /Archive file unavailable/);
  }
});

test('modern access failures without a legacy tree remain visible even if FileList exists', async () => {
  const item = { kind: 'file', getAsFileSystemHandle: async () => { throw new Error('Permission denied'); }, getAsFile: () => file('Private') };
  await assert.rejects(captureDrop({ items: [item], files: [file('Private')] }), /Permission denied/);
});

function projectRecords(paths, root = { name: 'Project', handle: null }) {
  return paths.map(path => ({ root, path: `${root.name}/${path}`, file: file(path.split('/').at(-1)) }));
}

test('project references resolve Windows separators and dot segments relative to nested projects', () => {
  const records = projectRecords(['Design/Demo.PrjPcb', 'Design/Sheets/Main.SchDoc', 'Shared/Board.PcbDoc']);
  assert.equal(resolveProjectDocument(records[0], '.\\Sheets\\.\\Main.SchDoc', records), records[1]);
  assert.equal(resolveProjectDocument(records[0], '..\\Shared\\Board.PcbDoc', records), records[2]);
  assert.equal(resolveProjectDocument(records[0], './Sheets/../Sheets/Main.SchDoc', records), records[1]);
});

test('exact path spelling wins before an unambiguous case-insensitive fallback', () => {
  const records = projectRecords(['Demo.PrjPcb', 'Sheets/Main.SchDoc', 'sheets/main.schdoc']);
  assert.equal(resolveProjectDocument(records[0], 'Sheets/Main.SchDoc', records), records[1]);
  assert.throws(() => resolveProjectDocument(records[0], 'SHEETS/MAIN.SCHDOC', records), /ambiguous/);
  assert.equal(resolveProjectDocument(records[0], 'SHEETS/MAIN.SCHDOC', records.slice(0, 2)), records[1]);
});

test('project resolution never borrows files from another dropped root or loose files', () => {
  const records = projectRecords(['Demo.PrjPcb']);
  const other = projectRecords(['Board.PcbDoc']);
  const loose = { root: null, path: 'Project/Board.PcbDoc', file: file('Board.PcbDoc') };
  assert.throws(() => resolveProjectDocument(records[0], 'Board.PcbDoc', [...records, ...other, loose]), /not found/);
  assert.throws(() => resolveProjectDocument({ ...records[0], root: null }, 'Board.PcbDoc', other), /outside/);
});

test('absolute, drive, URI and parent references outside the dropped root are rejected', () => {
  const records = projectRecords(['Design/Demo.PrjPcb', 'Board.PcbDoc']);
  for (const reference of ['../../Board.PcbDoc', '.././../Project/Board.PcbDoc', '/Board.PcbDoc', '\\Board.PcbDoc',
    '\\\\server\\share\\Board.PcbDoc', 'C:\\Board.PcbDoc', 'C:Board.PcbDoc', 'file:///Board.PcbDoc',
    'https://example.com/Board.PcbDoc', 'Board\0.PcbDoc']) {
    assert.throws(() => resolveProjectDocument(records[0], reference, records), /outside/, reference);
  }
  assert.equal(resolveProjectDocument(records[0], '../Board.PcbDoc', records), records[1]);
});

test('missing references and duplicate exact records produce clear errors', () => {
  const records = projectRecords(['Demo.PrjPcb', 'Board.PcbDoc']);
  assert.throws(() => resolveProjectDocument(records[0], 'Missing.SchDoc', records), /Missing.SchDoc.*not found/);
  assert.throws(() => resolveProjectDocument(records[0], 'Board.PcbDoc', [...records, { ...records[1] }]), /ambiguous/);
});
