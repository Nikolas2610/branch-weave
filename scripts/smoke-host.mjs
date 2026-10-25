import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runTests } from '@vscode/test-electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = process.env.VSCODE_EXECUTABLE_PATH || 'C:\\Program Files\\Microsoft VS Code\\Code.exe';
const runDirectory = path.join(root, '.test-host', randomUUID());
const fixture = path.join(runDirectory, 'fixture');
await access(executable);
await access(path.join(root, 'dist', 'extension.js'));
await mkdir(fixture, { recursive: true });
const git = (...args) => execFileSync('git', ['-C', fixture, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '--initial-branch=development');
git('config', 'user.name', 'BranchLens Host Test');
git('config', 'user.email', 'branchlens-host@example.invalid');
git('config', 'core.autocrlf', 'false');
await writeFile(path.join(fixture, 'a.txt'), 'base a\nunchanged\n');
await writeFile(path.join(fixture, 'b.txt'), 'base b\n');
git('add', '.');
git('commit', '-m', 'Base fixture');
const baseSha = git('rev-parse', 'HEAD');
git('branch', 'feature/host-smoke');
await writeFile(path.join(fixture, 'upstream.txt'), 'development-only\n');
git('add', '.');
git('commit', '-m', 'Development-only change');
const developmentSha = git('rev-parse', 'HEAD');
git('switch', 'feature/host-smoke');
await writeFile(path.join(fixture, 'a.txt'), 'feature a\nunchanged\n');
await writeFile(path.join(fixture, 'b.txt'), 'feature b\n');
git('add', '.');
git('commit', '-m', 'Feature changes');
const featureSha = git('rev-parse', 'HEAD');
const resultPath = path.join(runDirectory, 'result.json');
await writeFile(path.join(runDirectory, 'fixture.json'), JSON.stringify({ fixture, baseSha, developmentSha, featureSha }, null, 2));
await build({ entryPoints: [path.join(root, 'tests', 'host', 'index.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(runDirectory, 'host-test.cjs'), sourcemap: true });
console.log(`Host smoke evidence: ${runDirectory}`);
delete process.env.ELECTRON_RUN_AS_NODE;
const startedAt = new Date().toISOString();
try {
await runTests({
  vscodeExecutablePath: executable,
  extensionDevelopmentPath: root,
  extensionTestsPath: path.join(runDirectory, 'host-test.cjs'),
  extensionTestsEnv: { BRANCHLENS_HOST_FIXTURE: fixture, BRANCHLENS_HOST_RESULT: resultPath, BRANCHLENS_HOST_BASE: baseSha, BRANCHLENS_HOST_DEVELOPMENT: developmentSha, BRANCHLENS_HOST_FEATURE: featureSha, BRANCHLENS_HOST_UI_HOLD: process.env.BRANCHLENS_HOST_UI_HOLD || '0' },
  launchArgs: [fixture, '--user-data-dir', path.join(runDirectory, 'user-data'), '--extensions-dir', path.join(runDirectory, 'extensions'), '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-extensions', '--new-window'],
});
await writeFile(path.join(runDirectory, 'launcher-result.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), executable, status: 'passed', exitCode: 0, resultPath }, null, 2));
console.log(`Host smoke passed. Results: ${resultPath}`);
} catch (error) {
  await writeFile(path.join(runDirectory, 'launcher-result.json'), JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), executable, status: 'failed', error: String(error), resultPath }, null, 2));
  throw error;
}
