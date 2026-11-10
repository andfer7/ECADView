const supportedDocument = name => /\.(prjpcb|pcbdoc|schdoc|kicad_pcb|kicad_sch|sch)$/i.test(name);

class DropReadError extends Error {
  constructor(kind, path, cause) {
    super(`Could not read dropped ${kind} "${path}": ${cause?.message || cause || 'Access is unavailable.'}`, { cause });
  }
}

function captureItem(item) {
  const captured = {};
  if (typeof item.getAsFileSystemHandle === 'function') {
    try {
      captured.handle = Promise.resolve(item.getAsFileSystemHandle()).then(handle => ({ handle }), error => ({ error }));
    } catch (error) {
      captured.handle = Promise.resolve({ error });
    }
  }
  // These fallbacks must also be captured while the drop's data store is open.
  if (typeof item.webkitGetAsEntry === 'function') {
    try { captured.entry = item.webkitGetAsEntry(); }
    catch (error) { captured.entryError = error; }
  }
  if (typeof item.getAsFile === 'function') {
    try { captured.file = item.getAsFile(); }
    catch (error) { captured.fileError = error; }
  }
  return captured;
}

async function readHandle(handle, path, root, files) {
  if (handle.kind === 'file') {
    if (!supportedDocument(handle.name)) return;
    try { files.push({ file: await handle.getFile(), path, root }); }
    catch (error) { files.push({ file: null, path, root, error: new DropReadError('file', path, error) }); }
    return;
  }
  try {
    for await (const child of handle.values()) await readHandle(child, `${path}/${child.name}`, root, files);
  } catch (error) {
    if (error instanceof DropReadError) throw error;
    throw new DropReadError('folder', path, error);
  }
}

async function readEntry(entry, path, root, files) {
  if (entry.isFile) {
    if (!supportedDocument(entry.name)) return;
    try {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push({ file, path, root });
    } catch (error) { files.push({ file: null, path, root, error: new DropReadError('file', path, error) }); }
    return;
  }
  if (!entry.isDirectory) return;
  try {
    const reader = entry.createReader();
    while (true) {
      const entries = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      if (!entries.length) break;
      for (const child of entries) await readEntry(child, `${path}/${child.name}`, root, files);
    }
  } catch (error) {
    if (error instanceof DropReadError) throw error;
    throw new DropReadError('folder', path, error);
  }
}

async function collectItems(items, fallbackFiles) {
  const files = [], roots = [];
  let usableItems = false;
  for (const item of items) {
    const result = item.handle ? await item.handle : {};
    const handle = result.handle;
    if (handle?.kind === 'directory') {
      usableItems = true;
      const root = { name: handle.name, handle };
      roots.push(root);
      await readHandle(handle, root.name, root, files);
    } else if (handle?.kind === 'file') {
      usableItems = true;
      try {
        const file = item.file || await handle.getFile();
        files.push({ file, path: file.name, root: null });
      } catch (error) { throw new DropReadError('file', handle.name, error); }
    } else if (item.entry?.isDirectory) {
      usableItems = true;
      const root = { name: item.entry.name, handle: null };
      roots.push(root);
      await readEntry(item.entry, root.name, root, files);
    } else if (item.entry?.isFile) {
      usableItems = true;
      try {
        const file = item.file || await new Promise((resolve, reject) => item.entry.file(resolve, reject));
        files.push({ file, path: file.name, root: null });
      } catch (error) { throw new DropReadError('file', item.entry.name, error); }
    } else if (result.error || item.entryError || item.fileError) {
      throw new DropReadError('item', item.file?.name || 'unknown', result.error || item.entryError || item.fileError);
    } else if (item.file) {
      usableItems = true;
      files.push({ file: item.file, path: item.file.name, root: null });
    }
  }
  if (!usableItems) for (const file of fallbackFiles) files.push({ file, path: file.name, root: null });
  return { files, roots, hasDirectories: roots.length > 0 };
}

export function captureDrop(dataTransfer) {
  // Do not await until every transient DataTransferItem has been captured.
  const fallbackFiles = [...(dataTransfer.files || [])];
  const items = [...(dataTransfer.items || [])].filter(item => item.kind === 'file').map(captureItem);
  return collectItems(items, fallbackFiles);
}

export function resolveProjectDocument(projectRecord, reference, records) {
  const root = projectRecord.root;
  const outside = () => new Error(`Project document "${reference}" is outside the dropped folder.`);
  const missing = () => new Error(`Project document "${reference}" was not found in the dropped folder.`);
  if (!root) throw outside();
  const name = String(reference ?? '').trim().replace(/\\/g, '/');
  if (!name) throw missing();
  if (name.startsWith('/') || name.includes(':') || /[\0-\x1f\x7f]/.test(name)) throw outside();
  const parts = projectRecord.path.split('/');
  if (parts.shift() !== root.name || !parts.length || parts.some(part => !part || part === '.' || part === '..')) throw outside();
  parts.pop();
  for (const part of name.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw outside();
      parts.pop();
    } else parts.push(part);
  }
  const target = `${root.name}/${parts.join('/')}`;
  const candidates = records.filter(record => record.root === root);
  const exact = candidates.filter(record => record.path === target);
  if (exact.length === 1) return exact[0];
  const matches = exact.length ? exact : candidates.filter(record => record.path.toLowerCase() === target.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Project document "${reference}" is ambiguous in the dropped folder.`);
  throw missing();
}
