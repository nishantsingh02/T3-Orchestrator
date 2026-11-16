import { IDEA_CATEGORY_LABELS, MARKETING_CATEGORIES, type MarketingCategory, type MarketingSourceKind } from '@t3-orchestra/shared';
import {
  Braces,
  ChartLine,
  Container,
  GitFork,
  Globe,
  MousePointerClick,
  Newspaper,
  Package,
  PencilLine,
  PenLine,
  Rocket,
  Search,
  Sprout,
  Users,
  type LucideIcon,
} from 'lucide-react';

export const MARKETING_INFO: Record<MarketingCategory, { label: string; icon: LucideIcon; blurb: string }> = {
  launch: { label: IDEA_CATEGORY_LABELS.launch, icon: Rocket, blurb: 'Launch posts, release notes, a changelog and a demo for the README.' },
  content: { label: IDEA_CATEGORY_LABELS.content, icon: PenLine, blurb: 'Tutorials, guides and posts about what the product really does.' },
  seo: { label: IDEA_CATEGORY_LABELS.seo, icon: Search, blurb: 'Titles and share cards, sitemap, speed and landing-page copy.' },
  social: { label: IDEA_CATEGORY_LABELS.social, icon: Users, blurb: 'Posts and threads, a community space and your GitHub presence.' },
  growth: { label: IDEA_CATEGORY_LABELS.growth, icon: Sprout, blurb: 'Sign-up and onboarding friction, sharing, pricing and emails.' },
  analytics: { label: IDEA_CATEGORY_LABELS.analytics, icon: ChartLine, blurb: "The events and funnels you can't measure yet." },
};

export const SOURCE_ICONS: Record<MarketingSourceKind, LucideIcon> = {
  github: GitFork,
  plausible: Globe,
  posthog: MousePointerClick,
  npm: Package,
  pypi: Package,
  docker: Container,
  hackernews: Newspaper,
  json: Braces,
  manual: PencilLine,
};

/** The Marketing view's sections: the metrics dashboard, then one per task category. */
export type MarketingSection = 'dashboard' | MarketingCategory;

export function isMarketingSection(v: string | null | undefined): v is MarketingSection {
  return v === 'dashboard' || (MARKETING_CATEGORIES as readonly string[]).includes(v ?? '');
}
