/** Build only the synthetic observer artifact; no migrations, app imports, install hooks or secret inputs. */
import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = path.join(root, 'dist/durable-observer');
try {
  if (process.argv.length !== 2) throw new Error('arguments_refused');
  await mkdir(output, { recursive: true });
  await build({
    entryPoints: { child: path.join(root, 'scripts/durable-observer/syntheticChild.ts'), screen: path.join(root, 'scripts/durable-observer/screen.ts') },
    outdir: output, outExtension: { '.js': '.mjs' }, platform: 'node', format: 'esm', target: 'node22',
    bundle: true, packages: 'bundle', sourcemap: false, logLevel: 'silent', metafile: true,
  }).then(result => {
    if (!result.metafile || Object.keys(result.metafile.inputs).some(file => !file.replaceAll('\\', '/').includes('scripts/durable-observer/'))) throw new Error('unexpected_artifact_dependency');
    for (const item of Object.values(result.metafile.outputs)) {
      if (item.imports.some(value => value.external && value.path !== 'node:util')) throw new Error('runtime_dependency_refused');
    }
  });
  await copyFile(path.join(root, 'scripts/durable-observer/launch.mjs'), path.join(output, 'launch.mjs'));
  const files = ['launch.mjs', 'child.mjs', 'screen.mjs'];
  const hashes = {};
  for (const file of files) hashes[file] = createHash('sha256').update(await readFile(path.join(output, file))).digest('hex');
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({ schema: 'reconcileai_observer_artifact_v1', execution: 'synthetic_only', liveEnabled: false, sourceBase: '4efaac2a1e4d35f9aaa448b2daba4652e7e58dee', files: hashes }, null, 2) + '\n');
  process.stdout.write('Synthetic observer artifact built; live execution unavailable\n');
} catch {
  process.stderr.write('observer_artifact_build_failed\n');
  process.exitCode = 1;
}
