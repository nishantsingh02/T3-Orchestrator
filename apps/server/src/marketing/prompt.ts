// The Marketing agent's prompt: an Ideas generation with a marketing category, the board's
// marketing brief and its current metrics.
import { IDEA_CATEGORY_LABELS, MAX_IDEAS, type MarketingCategory } from '@t3-orchestra/shared';
import { getBoardOrThrow, type EngineContext } from '../engine/context.ts';
import { knowledgeFor } from '../knowledge/service.ts';
import { openTasksText } from '../engine/insights.ts';
import { metricsText } from './service.ts';

/** What the agent looks for in each marketing category (the prompt's Focus section). */
const GUIDES: Record<MarketingCategory, string> = {
  launch:
    'Getting the word out about the product or its latest release: a Show HN, Product Hunt or subreddit launch post, release notes and a public changelog, a demo GIF or short video for the README and landing page, a press kit, and the order to do them in. Build the pages and assets the launch needs; draft the posts.',
  content:
    'Writing that shows what the product does and brings in people searching for it: tutorials and how-tos for its real features, "how we built X" posts about interesting parts of the code, comparisons with the alternatives, example projects and templates, docs pages that double as landing content. Each piece should be about something this product really does.',
  seo:
    'How the product is found and how its pages read: page titles and meta descriptions, Open Graph and Twitter cards with a share image, sitemap and robots.txt, structured data, page speed, headings, and landing-page copy with one clear call to action. Read the actual pages, templates and routes, and name them.',
  social:
    'Where the audience already is: posts and threads for X, Bluesky, LinkedIn and relevant subreddits or forums, a community space (Discord, GitHub Discussions), and the project\'s GitHub presence (README hero and badges, topics, social preview image, CONTRIBUTING, good first issues). Draft the posts in the voice of the team.',
  growth:
    'Turning visitors into users and users into regulars: sign-up and onboarding friction, the first-run experience, empty states that point to the next step, pricing or upgrade pages, share and invite features, a waitlist, and lifecycle emails. Find the screens and flows in the code and say what to change.',
  analytics:
    'What the team cannot measure yet: page and event tracking for the key actions (sign-up, activation, the core action, upgrade), UTM and referrer capture, a privacy-friendly analytics setup if there is none, funnels and the dashboard to watch. Name each event, where in the code it fires and what properties it carries.',
};

const NO_BRIEF =
  '(none yet. Work out what the product is, who it is for and why they would pick it from the README, the docs and the code, and write that as a short brief, 3 to 6 lines of markdown, in `suggestedBrief`.)';

export function marketingPrompt(ctx: EngineContext, boardId: string, category: MarketingCategory, existingIdeas: string): string {
  const board = getBoardOrThrow(ctx, boardId);
  const brief = board.marketingBrief.trim();
  return ctx.prompts.render('marketing', {
    projectPath: board.projectPath,
    baseBranch: board.baseBranch,
    categoryLabel: IDEA_CATEGORY_LABELS[category],
    categoryGuide: GUIDES[category],
    maxIdeas: MAX_IDEAS,
    marketingBrief: brief || NO_BRIEF,
    needsBrief: !brief,
    metrics: metricsText(ctx, boardId),
    boardBrief: board.brief.trim() || '(empty)',
    openTasks: openTasksText(ctx, boardId),
    existingIdeas,
    knowledge: knowledgeFor(ctx, board, { text: `${brief}\n${IDEA_CATEGORY_LABELS[category]}\n${GUIDES[category]}` }, 'work'),
  });
}
