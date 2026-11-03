const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
let probe;
before(async () => {
  const source = readFileSync(resolve(__dirname, '../ecadview/static/cross-probe.js'));
  probe = await import('data:text/javascript;base64,' + source.toString('base64'));
});
const elements = rows => rows.map(dataset => ({ dataset }));
const row = (name, terminals = [], aliases = []) => ({ name, terminals, aliases });

test('source IDs remain authoritative, metadata duplicates retain first-name lookup and unlinked aliases fall back exactly', () => {
  const layout = probe.indexLayout(elements([{ component: 'P1' }, { component: 'p1' }, { component: 'R1' }, { component: 'Alias' }]), [
    { name: 'P1', source_id: ' Source-1 ', source_name: 'R1' },
    { name: 'P1', source_id: 'duplicate-link', source_name: 'Wrong' },
    { name: 'Ghost', source_id: 'missing-geometry', source_name: 'R1' },
    { name: 'Alias', source_id: '', source_name: 'R1' },
  ]);
  assert.deepEqual(probe.matchingComponents('SOURCE-1', row('Wrong'), layout), ['P1','p1']);
  assert.deepEqual(probe.matchingComponents('duplicate-link', row('Wrong'), layout), ['P1','p1']);
  assert.deepEqual(probe.matchingComponents('missing-geometry', row('R1'), layout), []);
  assert.deepEqual(probe.matchingComponents('unrelated', row(' r1 '), layout), ['R1','Alias']);
  assert.deepEqual(probe.matchingComponents('', row('R1'), layout), ['P1','p1','R1','Alias']);
  const schematic = probe.indexSchematic(new Map([['source-1', row('R1')], ['other',row('Wrong')]]), new Map());
  assert.deepEqual(probe.schematicComponents('p1', schematic, layout), ['source-1']);
});

test('terminal lookup uses the first equal schematic name and reverse component lookup retains all matching IDs', () => {
  const schematic = probe.indexSchematic(new Map([['first', row('U1')], ['second',row('u1')]]), new Map());
  const linked = probe.indexLayout(elements([
    { component: 'A', padNumber: '1', net: 'FIRST' }, { component: 'B', padNumber: '1', net: 'SECOND' },
  ]), [{ name: 'A', source_id: 'first' }, { name: 'B', source_id: 'second' }]);
  assert.deepEqual(probe.matchingNets('n', row('N',[{component:'U1',pin:'1'}]), schematic, linked), ['FIRST']);
  const unlinked = probe.indexLayout(elements([{ component: 'U1' }]), []);
  assert.deepEqual(probe.schematicComponents('U1', schematic, unlinked), ['first','second']);
});

test('component probes match owned 3D bodies without pads or footprint graphics', () => {
  const layout = probe.indexLayout([], [
    { name: 'U17', source_id: 'source-1', source_name: 'U1' },
    { name: 'U3', source_id: 'no-geometry', source_name: 'U2' },
  ], [{ name: 'Package A', component: 'U17' }, { name: 'Package B', component: 'U17' },
    { name: 'U2' }, { name: 'U3', component: null }]);
  assert.deepEqual(probe.matchingComponents('source-1', row('U1'), layout), ['U17']);
  assert.deepEqual(probe.matchingComponents('', row('U2'), layout), ['U2']);
  assert.deepEqual(probe.matchingComponents('no-geometry', row('U2'), layout), []);
  assert.deepEqual(probe.matchingComponents('', row('Package A'), layout), []);
});

test('pin connectivity wins over aliases; reverse net matching preserves case and separates ambiguous candidates', () => {
  const layout = probe.indexLayout(elements([
    { component:'P1', padNumber:'1', net:'UPPER' }, { component:'P1', padDesignator:'2', net:'OTHER' },
    { net:'SIGNAL' }, { net:'signal' },
  ]), [{name:'P1',source_id:'c1'}]);
  const components = new Map([['c1',row('U1')]]);
  const nets = new Map([
    ['pin', row('OTHER',[{component:'U1',pin:'1'}], ['OTHER'])],
    ['ambiguous', row('N',[{component:'U1',pin:'1'},{component:'U1',pin:'2'}])],
    ['alias', row('missing',[],[' SiGnAl '])],
  ]);
  const schematic = probe.indexSchematic(components,nets);
  assert.deepEqual(probe.matchingNets('pin',nets.get('pin'),schematic,layout), ['UPPER']);
  assert.deepEqual(probe.matchingNets('alias',nets.get('alias'),schematic,layout), ['SIGNAL','signal']);
  const reverse = probe.reverseNets(schematic,layout);
  assert.deepEqual(reverse.reverse.get('UPPER'), ['pin']);
  assert.equal(reverse.reverse.has('upper'), false);
  assert.deepEqual([...reverse.ambiguous].sort(), ['OTHER','SIGNAL','UPPER','signal'].sort());
});

test('component probes do no net work, repeated net probes reuse connectivity and new document indexes invalidate results', () => {
  let reads = 0;
  const net = { name:'N', aliases:[], get terminals() { reads++; return [{ component:'U1',pin:'1' }]; } };
  const components = new Map([['c1',row('U1')]]), nets = new Map([['n',net]]);
  const schematic = probe.indexSchematic(components,nets);
  const layout = probe.indexLayout(elements([{ component:'P1',padNumber:'1',net:'OLD' }]), [{name:'P1',source_id:'c1'}]);
  assert.deepEqual(probe.schematicComponents('P1',schematic,layout), ['c1']);
  assert.equal(reads,0);
  assert.deepEqual(probe.matchingNets('n',net,schematic,layout), ['OLD']);
  assert.deepEqual(probe.matchingNets('n',net,schematic,layout), ['OLD']);
  assert.strictEqual(probe.reverseNets(schematic,layout), probe.reverseNets(schematic,layout));
  assert.equal(reads,1);
  const replacement = probe.indexLayout(elements([{ component:'P1',padNumber:'1',net:'NEW' }]), [{name:'P1',source_id:'c1'}]);
  assert.deepEqual(probe.matchingNets('n',net,schematic,replacement), ['NEW']);
  assert.equal(reads,2);
});
