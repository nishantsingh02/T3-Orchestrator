import type { TaskAction, TaskView } from '@t3-orchestra/shared';
import { MessageSquare, RefreshCw, RotateCcw, Send } from 'lucide-react';
import { useState } from 'react';
import { useActionPending, type useTaskActions } from '@/components/tasks/useTaskActions';
import { Button } from '@/components/ui/button';
import { Kbd, Textarea } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { readString, writeString } from '@/lib/storage';

type Run = ReturnType<typeof useTaskActions>['run'];

/** "Message the agent…" with Send / Request changes / Resume (spec §14.3). */
export function Composer({ task, run }: { task: TaskView; run: Run }) {
  const draftKey = `composer:${task.id}`;
  const [text, setTextState] = useState(() => readString(draftKey) ?? '');
  const setText = (v: string) => {
    setTextState(v);
    writeString(draftKey, v || null);
  };
  const sending = useActionPending(task.id, 'send-message');
  const requesting = useActionPending(task.id, 'request-changes');
  const resuming = useActionPending(task.id, 'resume');
  const retrying = useActionPending(task.id, 'retry-fresh');
  const busy = sending || requesting || resuming || retrying;
  const failed = task.stage === 'failed';
  const empty = !text.trim();

  const send = async (action: TaskAction) => {
    const body = action === 'resume' ? { note: text.trim() || undefined } : { text: text.trim() };
    const ok = await run(task, action, body, action === 'retry-fresh' ? { confirm: true } : {});
    if (ok && action !== 'retry-fresh') setText('');
  };

  return (
    <div className="shrink-0 border-t border-border bg-surface/60 px-5 py-3">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !empty && !busy) {
            e.preventDefault();
            void send(failed ? 'send-message' : 'request-changes');
          }
        }}
        rows={2}
        placeholder={failed ? 'Message the agent, or add a note for Resume…' : 'Message the agent…'}
        className="min-h-14 bg-background"
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="mr-auto hidden items-center gap-1 text-2xs text-muted-foreground sm:flex">
          <Kbd>Ctrl</Kbd>
          <Kbd>Enter</Kbd> {failed ? 'send' : 'request changes'}
        </span>
        <Button size="sm" variant="secondary" disabled={empty || busy} onClick={() => void send('send-message')}>
          {sending ? <Spinner className="size-3.5" /> : <Send />}
          Send
        </Button>
        {!failed && (
          <Button size="sm" disabled={empty || busy} onClick={() => void send('request-changes')}>
            {requesting ? <Spinner className="size-3.5 text-primary-foreground" /> : <MessageSquare />}
            Request changes
          </Button>
        )}
        {failed && (
          <>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void send('retry-fresh')}>
              {retrying ? <Spinner className="size-3.5" /> : <RefreshCw />}
              Retry fresh
            </Button>
            <Button size="sm" disabled={busy} onClick={() => void send('resume')}>
              {resuming ? <Spinner className="size-3.5 text-primary-foreground" /> : <RotateCcw />}
              {empty ? 'Resume' : 'Resume with note'}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
