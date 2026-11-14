// Prompt template loading and rendering (spec §9). Templates live in apps/server/prompts/*.md;
// files in <dataDir>/prompts/*.md override them. `{{> name}}` includes another template.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Mustache from 'mustache';

export const TEMPLATE_NAMES = [
  'planner',
  'plan-correction',
  'plan-refine',
  /** Shared by planner and spec-plan: how to cut tasks, and the result block. */
  'plan-rules',
  'plan-output',
  'spec',
  'spec-refine',
  'spec-plan',
  'implement',
  'review',
  'fix',
  'changes',
  'design',
  'followup',
  'resume',
  'rebase',
  'pr',
  'run-fix',
  'insight',
  'ideas',
  'ideas-correction',
  'marketing',
  'import',
  'import-correction',
  'security-audit',
  'security-audit-correction',
  'knowledge',
  'knowledge-correction',
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export function builtinPromptsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, '../../prompts'), path.resolve(here, '../prompts')];
  return candidates.find((p) => fs.existsSync(path.join(p, 'planner.md'))) ?? candidates[0]!;
}

export class PromptStore {
  constructor(
    private readonly overrideDir: string | null,
    private readonly builtinDir = builtinPromptsDir(),
  ) {}

  /** Template names that have an override file. */
  overridden(): string[] {
    if (!this.overrideDir) return [];
    return TEMPLATE_NAMES.filter((n) => fs.existsSync(path.join(this.overrideDir!, `${n}.md`)));
  }

  load(name: TemplateName): string {
    if (this.overrideDir) {
      const o = path.join(this.overrideDir, `${name}.md`);
      if (fs.existsSync(o)) return fs.readFileSync(o, 'utf8');
    }
    return fs.readFileSync(path.join(this.builtinDir, `${name}.md`), 'utf8');
  }

  render(name: TemplateName, view: Record<string, unknown>): string {
    return renderTemplate(this.load(name), view, (partial) =>
      (TEMPLATE_NAMES as readonly string[]).includes(partial) ? this.load(partial as TemplateName) : undefined,
    );
  }
}

/** Mustache without HTML escaping; collapses runs of 3+ blank lines left by empty sections. */
export function renderTemplate(
  template: string,
  view: Record<string, unknown>,
  partials: (name: string) => string | undefined = () => undefined,
): string {
  const out = Mustache.render(template, view, partials, { escape: (s: string) => s });
  return out.replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
