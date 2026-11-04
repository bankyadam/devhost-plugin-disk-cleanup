// devhost plugin: disk-cleanup. Install: devhost plugin install git@github.com:bankyadam/devhost-plugin-disk-cleanup.git --enable
// Plugin API: https://github.com/bankyadam/devhost.app (packages/cli/src/plugins/api.ts). Uses only that API
// (the ctx argument) and Node's own modules.
/**
 * disk-cleanup: what can go without losing anything. Caches are downloaded again when needed;
 * a Remote Control worktree (`<env>/.claude/worktrees/<name>`, one per session) only when it is
 * clean, everything in it is pushed, no process works in it, its session is not active and it was
 * not touched for `worktreeIdleHours` (default 24). Options: `categories` (default all),
 * `warnGiB` (doctor warns above it, default 5).
 */
import { existsSync, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const GiB = 1024 ** 3;
/** Ignored files that are build output or caches: they go with the worktree. Anything else ignored (.env, local config) stays. */
const DISPOSABLE = /^(node_modules|dist|build|out|target|coverage|\.next|\.nuxt|\.turbo|\.cache|\.venv|venv|__pycache__|\.pytest_cache|\.DS_Store)(\/|$)/;
/** A non-negative number option, else the default (a typo must not switch a safety margin off). */
const numberOption = (v, fallback) => (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fallback);
const CATEGORIES = ['homebrew', 'npm', 'worktrees'];
const human = (bytes) => (bytes >= GiB ? `${(bytes / GiB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
/** Bytes under a path (`du -sk`); 0 when it cannot be measured. */
async function du(ctx, path) {
    const m = /^(\d+)\s/.exec((await ctx.exec.query('du', ['-sk', path])).stdout.trim());
    return m ? Number(m[1]) * 1024 : 0;
}
const brewEnv = { HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_ANALYTICS: '1' };
async function homebrew(ctx) {
    const r = await ctx.exec.query('brew', ['--cache'], { env: brewEnv });
    const path = r.stdout.trim();
    return r.code === 0 && path.startsWith('/') ? { path, bytes: await du(ctx, path) } : null;
}
/** npm starts with `#!/usr/bin/env node`: over ssh (the desktop app) PATH has no nvm Node, so put devhost's first. */
const npmEnv = (ctx) => ({ PATH: `${dirname(ctx.nodePath)}:${process.env.PATH ?? '/usr/bin:/bin'}` });
/** npm next to the Node devhost runs on (an nvm one is on no default PATH). */
const npmFor = (ctx) => {
    const npmPath = join(dirname(ctx.nodePath), 'npm');
    return existsSync(npmPath) ? npmPath : 'npm';
};
async function npm(ctx) {
    const r = await ctx.exec.query(npmFor(ctx), ['config', 'get', 'cache'], { env: npmEnv(ctx) });
    const root = r.stdout.trim();
    if (r.code !== 0 || !root.startsWith('/'))
        return null;
    const path = join(root, '_cacache');
    return { path, bytes: await du(ctx, path) };
}
/** Working directories of every process (lsof's cwd entries). */
async function processCwds(ctx) {
    const r = await ctx.exec.query('lsof', ['-a', '-d', 'cwd', '-Fn']);
    return r.stdout.split('\n').filter((l) => l.startsWith('n/')).map((l) => l.slice(1));
}
async function worktrees(ctx, now) {
    const idleHours = numberOption(ctx.options['worktreeIdleHours'], 24);
    const busy = await processCwds(ctx);
    const active = new Set((await ctx.sessions()).filter((x) => x.state !== 'ended').map((x) => x.cwd));
    const out = [];
    for (const e of ctx.environments) {
        const root = join(e.dir, '.claude', 'worktrees');
        let names = [];
        try {
            names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
        }
        catch {
            continue;
        }
        for (const name of names) {
            const path = join(root, name);
            let status;
            const w = { env: e.name, path, bytes: await du(ctx, path) };
            // --no-optional-locks: looking must not rewrite the index (its mtime is the "last used" signal).
            const git = (args) => ctx.exec.query('git', ['-C', path, '--no-optional-locks', ...args]);
            if (busy.some((c) => c === path || c.startsWith(`${path}/`)))
                w.keep = 'a process is working in it';
            else if (active.has(path))
                w.keep = 'its session is still active';
            else if ((status = (await git(['status', '--porcelain', '--ignored'])).stdout.split('\n').filter(Boolean)).some((l) => !l.startsWith('!! ')))
                w.keep = 'it has uncommitted changes';
            else if (status.some((l) => !DISPOSABLE.test(l.slice(3))))
                w.keep = 'it has ignored files that are not build output (.env, local config)';
            else {
                const unpushed = await git(['rev-list', '--count', 'HEAD', '--not', '--remotes']);
                if (unpushed.code !== 0)
                    w.keep = 'not a git worktree git can read';
                else if (Number(unpushed.stdout.trim()) > 0)
                    w.keep = `${unpushed.stdout.trim()} commit(s) not on any remote`;
                else {
                    const index = (await git(['rev-parse', '--git-path', 'index'])).stdout.trim();
                    const mtime = Number((await ctx.exec.query('stat', ['-f', '%m', index.startsWith('/') ? index : join(path, index)])).stdout.trim()) * 1000;
                    if (Number.isFinite(mtime) && mtime > 0 && now - mtime < idleHours * 3_600_000)
                        w.keep = `used in the last ${idleHours} h`;
                }
            }
            out.push(w);
        }
    }
    return out;
}
function enabled(ctx) {
    const want = ctx.options['categories'];
    return new Set(Array.isArray(want) ? CATEGORIES.filter((c) => want.includes(c)) : CATEGORIES);
}
async function report(ctx, now) {
    const on = enabled(ctx);
    return {
        homebrew: on.has('homebrew') ? await homebrew(ctx) : null,
        npm: on.has('npm') ? await npm(ctx) : null,
        worktrees: on.has('worktrees') ? await worktrees(ctx, now) : [],
    };
}
let cache = null;
/** doctor runs every check often; sizing every worktree each time is slow, so it reuses a minute-old report. */
async function cachedReport(ctx) {
    const key = JSON.stringify([ctx.options['categories'], ctx.options['worktreeIdleHours'], ctx.environments.map((e) => e.dir)]);
    if (cache && cache.key === key && Date.now() - cache.at < 60_000)
        return cache.r;
    const r = await report(ctx, Date.now());
    cache = { key, at: Date.now(), r };
    return r;
}
const reclaimable = (r) => (r.homebrew?.bytes ?? 0) + (r.npm?.bytes ?? 0) + r.worktrees.filter((w) => !w.keep).reduce((n, w) => n + w.bytes, 0);
function describe(r) {
    const parts = [
        r.homebrew && r.homebrew.bytes > 0 ? `Homebrew cache ${human(r.homebrew.bytes)}` : null,
        r.npm && r.npm.bytes > 0 ? `npm cache ${human(r.npm.bytes)}` : null,
        r.worktrees.some((w) => !w.keep) ? `${r.worktrees.filter((w) => !w.keep).length} old worktree(s) ${human(r.worktrees.filter((w) => !w.keep).reduce((n, w) => n + w.bytes, 0))}` : null,
    ].filter(Boolean);
    return parts.length === 0 ? 'nothing to reclaim' : `${human(reclaimable(r))} reclaimable: ${parts.join(', ')}`;
}
const data = (r) => ({ reclaimableBytes: reclaimable(r), homebrew: r.homebrew, npm: r.npm, worktrees: r.worktrees });
export const diskCleanup = {
    name: 'disk-cleanup',
    version: pkg.version,
    description: 'Free disk space: package caches and old Remote Control worktrees',
    actions: [
        {
            id: 'report',
            title: 'What can be freed',
            description: 'Sizes of the Homebrew and npm caches and of the worktrees that could go, with why the others stay',
            scope: 'host',
            async run(ctx) {
                const r = await report(ctx, Date.now());
                const kept = r.worktrees.filter((w) => w.keep).map((w) => `${w.env}: ${w.path.split('/').at(-1)} stays (${w.keep})`);
                return { summary: [describe(r), ...kept].join('\n'), data: data(r) };
            },
        },
        {
            id: 'clean',
            title: 'Free disk space',
            description: 'Empty the Homebrew and npm caches (downloaded again when needed) and remove old worktrees that are clean and pushed',
            scope: 'host',
            destructive: true,
            async run(ctx) {
                const r = await report(ctx, Date.now());
                if (r.homebrew && r.homebrew.bytes > 0)
                    await ctx.exec.exec('brew', ['cleanup', '-s', '--prune=all'], { env: brewEnv, progress: true });
                if (r.npm && r.npm.bytes > 0)
                    await ctx.exec.exec(npmFor(ctx), ['cache', 'clean', '--force'], { env: npmEnv(ctx) });
                const removed = [];
                for (const w of r.worktrees.filter((x) => !x.keep)) {
                    const env = ctx.environments.find((e) => e.name === w.env);
                    // No --force: git refuses a worktree that changed since the check.
                    const res = await ctx.exec.exec('git', ['-C', env.dir, 'worktree', 'remove', w.path], { allowFailure: true });
                    if (res.code === 0)
                        removed.push(w.path);
                    else
                        ctx.exec.warn(`kept ${w.path}: ${res.stderr.trim() || 'git worktree remove failed'}`);
                }
                return { summary: `${ctx.exec.dryRun ? 'would free' : 'freed'} about ${human(reclaimable({ ...r, worktrees: r.worktrees.filter((w) => removed.includes(w.path)) }))} (${describe(r).replace(/ reclaimable:/, ':')})`, data: { ...data(r), removedWorktrees: removed } };
            },
        },
    ],
    checks: [
        {
            id: 'reclaimable',
            async run(ctx) {
                const r = await cachedReport(ctx);
                const warnAt = numberOption(ctx.options['warnGiB'], 5) * GiB;
                return reclaimable(r) > warnAt
                    ? { status: 'warn', message: describe(r), fix: 'devhost plugin run disk-cleanup clean' }
                    : { status: 'ok', message: describe(r) };
            },
        },
    ],
};

export default diskCleanup;
