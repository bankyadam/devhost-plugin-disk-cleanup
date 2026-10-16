import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import plugin from '../index.js';
import { fakeContext } from './fake.js';

const DAY = 86_400_000;
const action = (id) => plugin.actions.find((a) => a.id === id);

async function setup({ dryRun = false, options = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'clean-'));
  const env = join(home, 'work', 'b', 'api');
  const wt = (n) => join(env, '.claude', 'worktrees', n);
  for (const n of ['old', 'dirty', 'unpushed', 'busy', 'fresh', 'active']) await mkdir(wt(n), { recursive: true });
  const now = Date.now();
  const f = fakeContext({
    dryRun,
    options,
    home,
    environments: [{ name: 'api', account: 'b', dir: env }],
    sessions: async () => [{ id: 's', account: 'b', env: 'api', cwd: wt('active'), state: 'idle', lastActivityAt: now }],
    rules: [
      ['brew --cache', { stdout: '/Users/x/Library/Caches/Homebrew\n' }],
      ['du -sk /Users/x/Library/Caches/Homebrew', { stdout: '2097152\t/Users/x/Library/Caches/Homebrew\n' }],
      ['npm config get cache', { stdout: '/Users/x/.npm\n' }],
      ['du -sk /Users/x/.npm/_cacache', { stdout: '1048576\t/Users/x/.npm/_cacache\n' }],
      [/^du -sk .*worktrees/, { stdout: '4194304\tx\n' }],
      ['lsof', { stdout: `p1\nn${wt('busy')}/src\n` }],
      [/git -C .*dirty status/, { stdout: ' M a.ts\n' }],
      [/git -C .* status --porcelain/, { stdout: '' }],
      [/git -C .*unpushed rev-list/, { stdout: '2\n' }],
      [/git -C .* rev-list/, { stdout: '0\n' }],
      [/git -C .* rev-parse --git-path index/, (c) => ({ stdout: `${c.args[1]}/.git-index\n` })],
      [/stat -f %m .*fresh/, { stdout: `${Math.floor((now - 3_600_000) / 1000)}\n` }],
      [/stat -f %m /, { stdout: `${Math.floor((now - 3 * DAY) / 1000)}\n` }],
      ['brew cleanup', {}],
      ['npm cache clean', {}],
      [/git -C .* worktree remove/, {}],
    ],
  });
  return { ...f, env, wt };
}

test('reports caches and which worktrees could go, saying why the others stay', async () => {
  const { ctx } = await setup();
  const r = await action('report').run(ctx, {});
  assert.equal(r.summary.split('\n')[0], '7.0 GB reclaimable: Homebrew cache 2.0 GB, npm cache 1.0 GB, 1 old worktree(s) 4.0 GB');
  const keep = Object.fromEntries(r.data.worktrees.map((w) => [w.path.split('/').at(-1), w.keep ?? null]));
  assert.deepEqual(keep, { active: 'its session is still active', busy: 'a process is working in it', dirty: 'it has uncommitted changes', fresh: 'used in the last 24 h', old: null, unpushed: '2 commit(s) not on any remote' });
});

test('clean empties the caches and removes only the worktree that can go, without --force', async () => {
  const { ctx, calls, env, wt } = await setup();
  await action('clean').run(ctx, {});
  assert.deepEqual(calls.filter((l) => /brew cleanup|npm cache clean|worktree remove/.test(l)), ['brew cleanup -s --prune=all', 'npm cache clean --force', `git -C ${env} worktree remove ${wt('old')}`]);
});

test('a dry run only plans; the check warns above warnGiB; categories narrow it', async () => {
  const dry = await setup({ dryRun: true });
  await action('clean').run(dry.ctx, {});
  assert.equal(dry.calls.some((l) => /brew cleanup|worktree remove/.test(l)), false);
  assert.ok(dry.ctx.exec.plan.some((p) => p.action === 'brew cleanup -s --prune=all'));
  assert.equal((await plugin.checks[0].run(dry.ctx)).status, 'warn');
  assert.equal((await plugin.checks[0].run({ ...dry.ctx, options: { warnGiB: 50 } })).status, 'ok');
  const npmOnly = await setup({ options: { categories: ['npm'] } });
  assert.equal((await action('report').run(npmOnly.ctx, {})).summary.split('\n')[0], '1.0 GB reclaimable: npm cache 1.0 GB');
});
