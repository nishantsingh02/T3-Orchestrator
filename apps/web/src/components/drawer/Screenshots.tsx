import type { ScreenshotView } from '@t3-orchestra/shared';
import { ChevronLeft, ChevronRight, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';

/** "settings-dialog_dark.png" → "Settings dialog dark". */
export function screenshotCaption(name: string): string {
  const words = name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** Thumbnails of the implementer's screenshots; a click opens the full image. */
export function Screenshots({ shots }: { shots: ScreenshotView[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const current = open === null ? null : shots[open];
  const step = (d: number) => setOpen((i) => (i === null ? i : (i + d + shots.length) % shots.length));

  return (
    <>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {shots.map((s, i) => (
          <li key={s.name} className="min-w-0">
            <button
              type="button"
              onClick={() => setOpen(i)}
              className="group block w-full overflow-hidden rounded-md border border-border bg-background text-left transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <img
                src={s.url}
                alt={screenshotCaption(s.name)}
                loading="lazy"
                className="aspect-[16/10] w-full object-cover object-top"
              />
              <span className="block truncate border-t border-border px-2 py-1 text-[11.5px] text-muted-foreground group-hover:text-foreground">
                {screenshotCaption(s.name)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={current != null} onOpenChange={(o) => !o && setOpen(null)}>
        {current && (
          <DialogContent
            className="max-w-[min(1280px,calc(100vw-2rem))] gap-2.5 p-3"
            onKeyDown={(e) => {
              if (shots.length < 2) return;
              if (e.key === 'ArrowRight') step(1);
              else if (e.key === 'ArrowLeft') step(-1);
            }}
          >
            <DialogTitle className="pr-8 text-[13px]">{screenshotCaption(current.name)}</DialogTitle>
            <img
              src={current.url}
              alt={screenshotCaption(current.name)}
              className="max-h-[calc(100dvh-9rem)] w-full rounded border border-border object-contain"
            />
            <div className="flex items-center gap-1">
              {shots.length > 1 && (
                <>
                  <Button size="icon-xs" variant="ghost" onClick={() => step(-1)} aria-label="Previous screenshot">
                    <ChevronLeft />
                  </Button>
                  <span className="font-mono text-[11px] text-muted-foreground tabular">
                    {open! + 1} / {shots.length}
                  </span>
                  <Button size="icon-xs" variant="ghost" onClick={() => step(1)} aria-label="Next screenshot">
                    <ChevronRight />
                  </Button>
                </>
              )}
              <Button size="xs" variant="ghost" className="ml-auto" asChild>
                <a href={current.url} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  Open full size
                </a>
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
