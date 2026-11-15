import type { InsightMessageView } from '@t3-orchestra/shared';
import { Bot, Check, ChevronDown, ChevronRight, Copy, ExternalLink, MessageCircleQuestion, RotateCcw, Sparkles, TriangleAlert } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { absoluteTime, formatDuration, relativeTime, toMs, useNow } from '@/lib/time';
import { cn } from '@/lib/utils';

/** Answers can hold wide tables and code: let those scroll inside the message. */
const ANSWER_MD = 'text-[13px] [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto';

export function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg rounded-br-sm border border-border bg-secondary px-3 py-2 text-[13px] leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </div>
    </div>
  );
}

function AgentRow({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <div className="mt-px flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary">
        <Bot className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** The agent at work: elapsed time and its latest messages of this turn. */
export function Working({
  since,
  notes,
  waiting,
  starting,
  threadLink,
}: {
  since: string;
  notes: string[];
  waiting: boolean;
  starting?: boolean;
  threadLink: string | null;
}) {
  const now = useNow();
  const elapsed = formatDuration(now - (toMs(since) ?? now));
  return (
    <AgentRow>
      <div className="flex flex-col gap-2 text-[13px]" aria-live="polite">
        {waiting ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2">
            <MessageCircleQuestion className="size-4 shrink-0 text-warning" />
            <span className="min-w-0 flex-1">
              The agent is waiting for you in T3. Answer it there and it carries on here.
              <span className="ml-2 font-mono text-xs text-muted-foreground tabular">{elapsed}</span>
            </span>
            {threadLink && (
              <Button variant="warning" size="sm" asChild>
                <a href={threadLink} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  Open in T3
                </a>
              </Button>
            )}
          </div>
        ) : (
          <div className="flex h-6 items-center gap-2 text-muted-foreground">
            <Spinner className="size-3.5" />
            <span>{starting ? 'Starting the agent…' : notes.length ? 'Working…' : 'Reading the codebase…'}</span>
            <span className="font-mono text-xs tabular">{elapsed}</span>
          </div>
        )}
        {notes.length > 0 && (
          <ol className="flex flex-col gap-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">
            {notes.slice(-3).map((n, i) => (
              <li key={notes.length - 3 + i} className="line-clamp-2 whitespace-pre-wrap">
                {n}
              </li>
            ))}
          </ol>
        )}
      </div>
    </AgentRow>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy to the clipboard');
    }
  };
  return (
    <Button variant="ghost" size="xs" onClick={() => void copy()}>
      {copied ? <Check /> : <Copy />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function EarlierNotes({ notes }: { notes: string[] }) {
  const [open, setOpen] = useState(false);
  if (notes.length === 0) return null;
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 text-[11.5px] text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        {notes.length === 1 ? '1 earlier message' : `${notes.length} earlier messages`} from the agent
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-2 border-l-2 border-border pl-3 text-muted-foreground">
          {notes.map((n, i) => (
            <Markdown key={i} className="text-xs">
              {n}
            </Markdown>
          ))}
        </div>
      )}
    </div>
  );
}

export function AnswerMessage({
  message,
  question,
  threadLink,
  onAskAgain,
  onPlan,
  canAskAgain,
}: {
  message: InsightMessageView;
  question: string | null;
  threadLink: string | null;
  onAskAgain: (question: string) => void;
  onPlan: (question: string, answer: string) => void;
  canAskAgain: boolean;
}) {
  const m = message;
  if (m.status === 'pending' || m.status === 'waiting') {
    return <Working since={m.createdAt} notes={m.notes} waiting={m.status === 'waiting'} threadLink={threadLink} />;
  }
  const took = m.finishedAt ? (toMs(m.finishedAt) ?? 0) - (toMs(m.createdAt) ?? 0) : null;
  const failed = m.status === 'failed';
  return (
    <AgentRow>
      <EarlierNotes notes={m.notes} />
      {m.text && <Markdown className={cn(ANSWER_MD, failed && 'opacity-70')}>{m.text}</Markdown>}
      {failed && (
        <div
          className={cn(
            'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-[13px]',
            m.text && 'mt-3',
          )}
        >
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          <span className="min-w-0 flex-1">{m.error ?? 'The agent could not answer.'}</span>
          {question && (
            <Button variant="secondary" size="sm" disabled={!canAskAgain} onClick={() => onAskAgain(question)}>
              <RotateCcw />
              Ask again
            </Button>
          )}
        </div>
      )}
      {!failed && (
        <div className="mt-2 -ml-2 flex flex-wrap items-center gap-1 text-muted-foreground">
          <CopyButton text={m.text} />
          {question && (
            <Tip content="Open the plan composer with this answer, to turn it into tasks">
              <Button variant="ghost" size="xs" onClick={() => onPlan(question, m.text)}>
                <Sparkles />
                Plan from this
              </Button>
            </Tip>
          )}
          <Tip content={absoluteTime(m.finishedAt)}>
            <span className="ml-1 text-2xs">
              {relativeTime(m.finishedAt)}
              {took !== null && took > 0 && ` · took ${formatDuration(took)}`}
            </span>
          </Tip>
        </div>
      )}
    </AgentRow>
  );
}
