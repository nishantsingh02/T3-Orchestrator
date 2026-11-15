import { ArrowUp } from 'lucide-react';
import { useLayoutEffect, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

const MAX_HEIGHT = 200;

/** The question box: Enter sends, Shift+Enter adds a line. `blocked` explains why sending is off. */
export function InsightComposer({
  text,
  onText,
  onSend,
  sending,
  blocked,
  inputRef,
}: {
  text: string;
  onText: (v: string) => void;
  onSend: () => void;
  sending: boolean;
  blocked: string | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const canSend = Boolean(text.trim()) && !sending && !blocked;

  // Grow with the text up to MAX_HEIGHT, then scroll.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [text, inputRef]);

  return (
    <div className="shrink-0 border-t border-border bg-surface/60 px-3 py-3 sm:px-5">
      <div className="mx-auto max-w-3xl">
        <div
          className={cn(
            'flex items-end gap-2 rounded-lg border border-input bg-background py-1.5 pr-1.5 pl-3 shadow-xs transition-[border-color,box-shadow]',
            'focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25 dark:bg-input/25',
          )}
        >
          <textarea
            ref={inputRef}
            value={text}
            rows={1}
            onChange={(e) => onText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                if (canSend) onSend();
              }
            }}
            placeholder="Ask about the codebase…"
            aria-label="Question for the agent"
            className="min-h-7 flex-1 resize-none bg-transparent py-1 text-[13px] leading-relaxed outline-none scrollbar-thin placeholder:text-muted-foreground/70"
          />
          <Button size="icon-sm" onClick={onSend} disabled={!canSend} aria-label="Send">
            {sending ? <Spinner className="size-3.5 text-primary-foreground" /> : <ArrowUp />}
          </Button>
        </div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-2xs text-muted-foreground">
          {blocked ?? (
            <>
              The agent reads the code and changes nothing ·<Kbd>Enter</Kbd> send ·<Kbd>Shift</Kbd>
              <Kbd>Enter</Kbd> new line
            </>
          )}
        </p>
      </div>
    </div>
  );
}
