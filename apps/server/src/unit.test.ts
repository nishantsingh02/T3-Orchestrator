import { describe, expect, it } from 'vitest';
import { extractResultBlock, parseImplementResult, parsePlanResult, parseReviewResult } from './engine/results.ts';
import { PromptStore, renderTemplate, TEMPLATE_NAMES } from './engine/prompts.ts';
import { buildArgs, parseT3Cmd, SAFE_ARG, type Launcher } from './t3/launcher.ts';
import { parseStartOutput } from './t3/CliT3Client.ts';
import { normalizeModelCatalog, prUrlOf, prStateOf, resolveModelSelection } from './t3/T3Client.ts';
import { parseNumstat } from './git/git.ts';
import { slugify, taskBranchName } from './util.ts';

const fence = (body: string, tag = 't3orchestra-result') => '```' + tag + '\n' + body + '\n```';

describe('result block extraction (spec §9.1)', () => {
  it('returns the last block across messages', () => {
    const msgs = [`first\n${fence('{"a":1}')}`, `text\n${fence('{"a":2}')}\nmore\n${fence('{"a":3}')}`];
    expect(extractResultBlock(msgs)).toBe('{"a":3}');
  });

  it('ignores a fence tag mentioned mid-line in prose', () => {
    expect(extractResultBlock(['I will end with a ```t3orchestra-result block\nlater'])).toBeNull();
  });

  it('ignores other code blocks', () => {
    const msg = `${fence('{"x":1}', 'json')}\n${fence('{"status":"done","summary":"ok"}')}\n${fence('console.log(1)', 'ts')}`;
    expect(extractResultBlock([msg])).toBe('{"status":"done","summary":"ok"}');
  });

  it('falls back to earlier messages when the last has no block', () => {
    expect(extractResultBlock([fence('{"a":1}'), 'no block here'])).toBe('{"a":1}');
  });

  it('handles CRLF and longer fences', () => {
    expect(extractResultBlock(['````t3orchestra-result\r\n{"a":1}\r\n````'])).toBe('{"a":1}');
  });

  it('still reads the tag from before the rename', () => {
    expect(extractResultBlock([fence('{"a":1}', 't3board-result')])).toBe('{"a":1}');
  });

  it('reports a missing block', () => {
    const r = parseImplementResult(['all done!']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toBe(true);
  });

  it('reports broken JSON', () => {
    const r = parseImplementResult([fence('{ "status": "done", ')]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.missing).toBe(false);
      expect(r.errors[0]).toMatch(/not valid JSON/);
    }
  });

  it('validates with zod and applies defaults', () => {
    const r = parseImplementResult([fence('{"status":"done","summary":"s"}')]);
    expect(r.ok && r.value.changes).toEqual([]);
    expect(r.ok && r.value.tldr).toBeUndefined(); // optional: older results have none
    const withTldr = parseImplementResult([fence('{"status":"done","tldr":"Short.","summary":"s"}')]);
    expect(withTldr.ok && withTldr.value.tldr).toBe('Short.');
    const bad = parseReviewResult([fence('{"verdict":"maybe","summary":"s"}')]);
    expect(bad.ok).toBe(false);
    const scored = parseReviewResult([fence('{"verdict":"pass","summary":"s","humanReview":{"score":3.6,"reason":"docs"}}')]);
    expect(scored.ok && scored.value.humanReview).toEqual({ score: 4, reason: 'docs' });
    // A malformed score is dropped (the task then goes to the human); it never fails the review.
    for (const humanReview of ['{"score":11}', '{"score":"low"}', '7']) {
      const r = parseReviewResult([fence(`{"verdict":"pass","summary":"s","humanReview":${humanReview}}`)]);
      expect(r.ok && r.value.humanReview, humanReview).toBeUndefined();
    }
    const plan = parsePlanResult([fence(JSON.stringify({ summary: 's', tasks: [{ key: 'T1', title: 'Do it', description: 'd', acceptanceCriteria: ['a'], complexity: 'small', category: 'feature', dependsOn: ['T2'] }] }))]);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors.join()).toMatch(/unknown key T2/);
  });
});

describe('prompt rendering', () => {
  const store = new PromptStore(null);

  it('loads every template', () => {
    for (const name of TEMPLATE_NAMES) expect(store.load(name).length).toBeGreaterThan(10);
  });

  it('does not HTML-escape and renders sections', () => {
    const out = renderTemplate('{{a}} {{#list}}- {{.}}\n{{/list}}{{^list}}none{{/list}}', { a: '<b>&"', list: ['x', 'y'] });
    expect(out).toBe('<b>&" - x\n- y\n');
  });

  it('renders the implementer prompt with the result contract', () => {
    const out = store.render('implement', {
      num: 7,
      boardName: 'B',
      branch: 't3orchestra/b/7-x',
      baseBranch: 'main',
      title: 'Add <thing>',
      description: 'desc',
      acceptanceCriteria: ['one', 'two'],
      boardBrief: 'brief',
      deps: [{ num: 3, title: 'Dep', summary: 'did stuff' }],
    });
    expect(out).toContain('task #7 of the board "B"');
    expect(out).toContain('## Task: Add <thing>');
    expect(out).toContain('- one\n- two');
    expect(out).toContain('- #3 Dep: did stuff');
    expect(out).toContain('```t3orchestra-result');
    expect(out).not.toMatch(/\n{3,}/);
  });

  it('omits the question rule when askQuestions is off', () => {
    const view = { baseBranch: 'main', maxTasks: 5, boardBrief: '', prompt: 'goal', extraGuidance: '' };
    expect(store.render('planner', { ...view, askQuestions: true })).toContain('clarifying questions');
    expect(store.render('planner', { ...view, askQuestions: false })).not.toContain('clarifying questions');
    expect(store.render('planner', { ...view, askQuestions: false })).not.toContain('Extra guidance');
  });

  it('renders fix findings', () => {
    const out = store.render('fix', { num: 2, round: 1, findings: [{ severity: 'major', file: 'a.ts', line: 3, title: 'Bug', detail: 'bad', suggestion: 'fix' }, { severity: 'minor', file: 'b.ts', line: null, title: 'Nit', detail: 'meh', suggestion: null }] });
    expect(out).toContain('- [major] a.ts:3: Bug');
    expect(out).toContain('- [minor] b.ts: Nit');
    expect(out).toContain('Suggested: fix');
  });
});

describe('branch names', () => {
  it('slugifies titles', () => {
    expect(slugify('Add OAuth callback (Google)!')).toBe('add-oauth-callback-google');
    expect(slugify('Ünïcödé — test')).toBe('unicode-test');
    expect(slugify('***')).toBe('task');
    expect(slugify('a'.repeat(60)).length).toBe(40);
  });

  it('builds board branch names with retry suffix', () => {
    expect(taskBranchName('my-app', 4, 'Add OAuth callback')).toBe('t3orchestra/my-app/4-add-oauth-callback');
    expect(taskBranchName('my-app', 4, 'Add OAuth callback', 2)).toBe('t3orchestra/my-app/4-add-oauth-callback-r2');
  });
});

describe('t3.cmd launcher parsing', () => {
  const fixture = [
    '@echo off',
    'rem Written by T3 Code: runs the desktop app\'s bundled t3 CLI.',
    'setlocal EnableExtensions DisableDelayedExpansion',
    'set "T3CODE_CLI_PATH=C:\\Users\\me\\.t3\\bin\\t3.cmd"',
    'if not defined T3CODE_HOME set "T3CODE_HOME=C:\\Users\\me\\.t3"',
    'set "ELECTRON_RUN_AS_NODE=1"',
    'set "T3CODE_DESKTOP_CLI_LAUNCHER=1"',
    'if exist "C:\\Users\\me\\AppData\\Local\\Programs\\t3code\\T3 Code (Nightly).exe" goto run',
    'echo T3 Code has moved or been removed. Open the app once to update this command. 1>&2',
    'exit /b 127',
    ':run',
    '"C:\\Users\\me\\AppData\\Local\\Programs\\t3code\\T3 Code (Nightly).exe" "C:\\Users\\me\\AppData\\Local\\Programs\\t3code\\resources\\server.asar\\apps\\server\\dist\\bin.mjs" %*',
    'set "t3_exit=%ERRORLEVEL%"',
    'exit /b %t3_exit%',
  ].join('\r\n');

  it('extracts exe, entry and env', () => {
    const p = parseT3Cmd(fixture)!;
    expect(p.exe).toBe('C:\\Users\\me\\AppData\\Local\\Programs\\t3code\\T3 Code (Nightly).exe');
    expect(p.entry).toMatch(/server\.asar\\apps\\server\\dist\\bin\.mjs$/);
    expect(p.env).toMatchObject({ T3CODE_CLI_PATH: 'C:\\Users\\me\\.t3\\bin\\t3.cmd', ELECTRON_RUN_AS_NODE: '1', T3CODE_DESKTOP_CLI_LAUNCHER: '1' });
    expect(p.defaultEnv).toEqual({ T3CODE_HOME: 'C:\\Users\\me\\.t3' });
  });

  it('returns null for unknown shapes', () => {
    expect(parseT3Cmd('@echo off\nnode cli.js %*')).toBeNull();
  });

  it('cmd fallback only passes allow-listed args', () => {
    const l: Launcher = { kind: 'cmd', command: 'cmd.exe', prefixArgs: [], env: {}, cliPath: 'C:\\t3\\t3.cmd' };
    expect(buildArgs(l, ['thread', 'show', 'mcp:abc-1', '--json'])).toEqual(['/d', '/s', '/c', '"C:\\t3\\t3.cmd thread show mcp:abc-1 --json"']);
    expect(buildArgs(l, ['--project', 'C:\\My Repo'])[3]).toBe('"C:\\t3\\t3.cmd --project "C:\\My Repo""');
    expect(() => buildArgs(l, ['--title', '#1 foo & calc'])).toThrow();
    expect(SAFE_ARG.test('a|b')).toBe(false);
    expect(SAFE_ARG.test('%PATH%')).toBe(false);
  });

  it('direct mode passes args through untouched', () => {
    const l: Launcher = { kind: 'direct', command: 'x.exe', prefixArgs: ['bin.mjs'], env: {}, cliPath: 't3.cmd' };
    expect(buildArgs(l, ['--title', '#1 a & b'])).toEqual(['bin.mjs', '--title', '#1 a & b']);
  });
});

describe('CLI output parsing (docs/t3-cli-notes.md)', () => {
  it('parses thread start output', () => {
    expect(parseStartOutput({ threadId: 'mcp:1', projectId: 'p', runId: 'run:thread:mcp%3A1:ordinal:1' })).toEqual({ threadId: 'mcp:1', runId: 'run:thread:mcp%3A1:ordinal:1', link: undefined });
    expect(() => parseStartOutput({})).toThrow();
  });

  it('reads PR urls and states leniently', () => {
    expect(prUrlOf({ linkedPullRequest: null, pullRequests: [{ url: 'https://x/pull/1', state: 'OPEN' }] })).toBe('https://x/pull/1');
    expect(prStateOf({ linkedPullRequest: { url: 'u', state: 'MERGED' }, pullRequests: [] })).toBe('merged');
    expect(prStateOf({ linkedPullRequest: null, pullRequests: [] })).toBeNull();
  });
});

describe('T3 model catalog (server.getConfig)', () => {
  // Trimmed from a real T3 0.1.8 config.
  const config = {
    providers: [
      { instanceId: 'codex', displayName: 'Codex', enabled: false, status: 'disabled', models: [] },
      {
        instanceId: 'claudeAgent',
        displayName: 'Claude',
        enabled: true,
        status: 'ready',
        models: [
          { slug: 'claude-opus-5-5', name: 'Claude Opus 5.5', isDefault: true },
          { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
          { slug: 'claude-opus-4-8', name: 'Claude Opus 4.8', isLegacy: true },
          { name: 'no slug' },
        ],
      },
      { instanceId: 'pi', displayName: 'Pi', enabled: true, status: 'error', models: [{ slug: 'default', name: 'Pi default' }] },
    ],
    settings: {
      defaultModelSelection: { instanceId: 'claudeAgent', model: 'claude-opus-5-5' },
      providerModelPreferences: { claudeAgent: { hiddenModels: ['claude-opus-4-8'], modelOrder: ['claude-sonnet-5-5'] } },
    },
  };
  const catalog = normalizeModelCatalog(config);

  it('keeps enabled providers, flags hidden models and applies the model order', () => {
    expect(catalog.defaultProvider).toBe('claudeAgent');
    expect(catalog.providers.map((p) => p.id)).toEqual(['claudeAgent', 'pi']);
    expect(catalog.providers[0]!.models).toEqual([
      { slug: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', isDefault: false, hidden: false },
      { slug: 'claude-opus-5-5', name: 'Claude Opus 5.5', isDefault: true, hidden: false },
      { slug: 'claude-opus-4-8', name: 'Claude Opus 4.8', isDefault: false, hidden: true },
    ]);
    expect(normalizeModelCatalog(null)).toEqual({ defaultProvider: null, providers: [] });
  });

  it('fills in the half of --provider/--model that is missing', () => {
    expect(resolveModelSelection(catalog, null, null)).toBeNull();
    expect(resolveModelSelection(catalog, 'x', 'y')).toEqual({ provider: 'x', model: 'y' });
    expect(resolveModelSelection(catalog, null, 'claude-sonnet-5-5')).toEqual({ provider: 'claudeAgent', model: 'claude-sonnet-5-5' });
    expect(resolveModelSelection(catalog, null, 'claude-opus-4-8')).toEqual({ provider: 'claudeAgent', model: 'claude-opus-4-8' });
    expect(resolveModelSelection(catalog, null, 'default')).toEqual({ provider: 'pi', model: 'default' });
    expect(resolveModelSelection(catalog, 'claudeAgent', null)).toEqual({ provider: 'claudeAgent', model: 'claude-opus-5-5' });
    expect(resolveModelSelection(catalog, 'pi', null)).toEqual({ provider: 'pi', model: 'default' });
    expect(() => resolveModelSelection(catalog, null, 'gpt-5.5')).toThrow(/no provider enabled in T3 offers/);
    expect(() => resolveModelSelection(catalog, 'codex', null)).toThrow(/not enabled/);
  });
});

describe('numstat parsing', () => {
  it('parses text and binary rows', () => {
    expect(parseNumstat('10\t2\tsrc/a.ts\n-\t-\timg.png\n')).toEqual([
      { path: 'src/a.ts', added: 10, removed: 2, binary: false },
      { path: 'img.png', added: 0, removed: 0, binary: true },
    ]);
  });
});
