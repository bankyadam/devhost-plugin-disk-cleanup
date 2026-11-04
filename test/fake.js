// A stand-in for the devhost plugin context: scripted commands, the plan, warnings.
// Rules: [match, respond] where match is a command-line prefix or a RegExp and respond a result
// or a function of the call; the first match wins, anything else exits 127.
export function fakeContext({ rules = [], dryRun = false, ...rest } = {}) {
  const calls = [];
  const plan = [];
  const warnings = [];
  const waits = [];
  const run = (command, args, opts) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    for (const [match, respond] of rules) {
      if (typeof match === 'string' ? line.startsWith(match) : match.test(line)) {
        const r = typeof respond === 'function' ? respond({ command, args, opts }) : respond;
        return { code: 0, stdout: '', stderr: '', ...r };
      }
    }
    return { code: 127, stdout: '', stderr: `command not found: ${command}\n` };
  };
  const exec = {
    dryRun,
    plan,
    warnings,
    async query(command, args, opts) {
      return run(command, args, opts);
    },
    async exec(command, args, opts = {}) {
      plan.push({ action: [command, ...args].join(' '), sudo: opts.sudo === true });
      if (dryRun) return { code: 0, stdout: '', stderr: '' };
      const r = run(command, args, opts);
      if (r.code !== 0 && !opts.allowFailure) throw new Error(`${command} ${args.join(' ')} failed with exit code ${r.code}`);
      return r;
    },
    async waitFor(probe, attempts = 10, delayMs = 1000) {
      waits.push({ attempts, delayMs });
      if (dryRun) return true;
      for (let i = 0; i < attempts; i++) if (await probe()) return true;
      return false;
    },
    warn(message) {
      warnings.push(message);
    },
  };
  return {
    calls,
    waits,
    ctx: {
      options: {},
      home: '/Users/x',
      user: 'x',
      nodePath: '/nowhere/node',
      environments: [],
      claudeDirs: [],
      sessions: async () => [],
      services: async () => [],
      reporter: { step() {}, log() {} },
      prompter: {},
      config: {},
      exec,
      ...rest,
    },
  };
}
