import { IDEA_CATEGORIES, IDEA_CATEGORY_LABELS, type IdeaCategory } from '@t3-orchestra/shared';
import { BookOpen, CodeXml, Gauge, Palette, Shield, Zap, type LucideIcon } from 'lucide-react';

export const CATEGORY_INFO: Record<IdeaCategory, { label: string; icon: LucideIcon; blurb: string }> = {
  code_improvements: { label: IDEA_CATEGORY_LABELS.code_improvements, icon: Zap, blurb: 'New features and extensions the existing code makes easy.' },
  ui_ux: { label: IDEA_CATEGORY_LABELS.ui_ux, icon: Palette, blurb: 'Confusing flows, missing states, accessibility and polish.' },
  documentation: { label: IDEA_CATEGORY_LABELS.documentation, icon: BookOpen, blurb: 'Missing or outdated READMEs, setup steps and API docs.' },
  security: { label: IDEA_CATEGORY_LABELS.security, icon: Shield, blurb: 'Vulnerabilities and risky patterns, and where they are.' },
  performance: { label: IDEA_CATEGORY_LABELS.performance, icon: Gauge, blurb: 'Slow paths, wasted work, bundle size and caching.' },
  code_quality: { label: IDEA_CATEGORY_LABELS.code_quality, icon: CodeXml, blurb: 'Duplication, oversized files, dead code and missing tests.' },
};

export function isIdeaCategory(v: string | null | undefined): v is IdeaCategory {
  return (IDEA_CATEGORIES as readonly string[]).includes(v ?? '');
}
