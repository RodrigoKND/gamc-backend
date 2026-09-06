// Post-build: normaliza los imports/export ESM relativos emitidos por tsc-alias
// (que resuelve los aliases @ → rutas relativas SIN extensión). Node ESM exige
// la extensión `.js`, así que la agregamos donde falte.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve('dist');

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else if (entry.name.endsWith('.js')) yield p;
  }
}

const SPECIFIER = /((?:from\s+|import\s+|export\s+\*\s+from\s+|\bimport\(|export\s+\{\s*[^}]*\s+from\s+)[\s]*)(['"])((?:\.\/|\.\.\/)[^'"]*)(\2)/g;

let fileCount = 0;
let rewriteCount = 0;

for await (const file of walk(root)) {
  const source = await readFile(file, 'utf8');
  const out = source.replace(SPECIFIER, (match, prefix, quote, spec, q2) => {
    if (/\.(?:js|json|node)$/.test(spec)) return match;
    return `${prefix}${quote}${spec}.js${q2}`;
  });
  if (out !== source) {
    await writeFile(file, out, 'utf8');
    fileCount++;
    rewriteCount++;
  }
}

console.log(`fix-esm-imports: ${fileCount} archivo(s) ajustado(s)`);