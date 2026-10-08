import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { format } from 'prettier';
const dirs = ['client', 'server', 'shared'];
let count = 0;
for (const dir of dirs)
  for (const file of await readdir(dir))
    if (file.endsWith('.js')) {
      execFileSync(process.execPath, ['--check', `${dir}/${file}`], { stdio: 'inherit' });
      count++;
    }
execFileSync(process.execPath, ['--check', 'sw.js'], { stdio: 'inherit' });
for (const file of [
  'client/index.html',
  'client/style.css',
  'vendor/geographiclib-geodesic.min.js',
])
  if (!(await readFile(file)).length) throw new Error(`Empty asset ${file}`);
console.log(
  `Build verified: ${count + 1} JavaScript modules and all required assets. No transpilation required.`,
);
await format(await readFile('client/index.html', 'utf8'), { parser: 'html' });
await format(await readFile('client/style.css', 'utf8'), { parser: 'css' });
console.log('HTML and CSS syntax verified.');
