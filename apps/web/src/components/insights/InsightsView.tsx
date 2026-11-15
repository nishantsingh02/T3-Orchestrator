// Insights: ask a read-only agent about the board's project. Chat list on the left, the open chat on
// the right; the open chat is in the URL (?chat=<id>), no chat means a new one.
import type { InsightChatView } from '@t3-orchestra/shared';
import {
  EllipsisVertical,
  ExternalLink,
  MessageCircleQuestion,
  MessageSquare,
  MessagesSquare,
  Pencil,
  SquarePen,
  Trash,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { isApiError } from '@/api/client';
import {
  useCreateInsightChat,
  useDeleteInsightChat,
  useInsightChat,
  useInsightChats,
  useRenameInsightChat,
  useSendInsightMessage,
} from '@/api/insights';
import { useBoardContext } from '@/components/board/BoardContext';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton, Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { readString, writeString } from '@/lib/storage';
import { absoluteTime, relativeTime } from '@/lib/time';
import { cn } from '@/lib/utils';
import { AnswerMessage, UserMessage, Working } from './ChatMessages';
import { InsightComposer } from './InsightComposer';

const SUGGESTIONS = [
  'What is the architecture of this project?',
  'Suggest improvements for code quality',
  'What features could I add next?',
  'Are there any security concerns?',
];

/** A per-chat draft kept in localStorage; switching chats switches drafts. */
function useDraft(key: string): [string, (v: string) => void] {
  const [state, setState] = useState(() => ({ key, text: readString(key) ?? '' }));
  let text = state.text;
  if (state.key !== key) {
    text = readString(key) ?? '';
    setState({ key, text });
  }
  const set = useCallback(
    (v: string) => {
      setState({ key, text: v });
      writeString(key, v || null);
    },
    [key],
  );
  return [text, set];
}

function ChatStatus({ status }: { status: InsightChatView['status'] }) {
  if (status === 'pending') return <Spinner className="size-3.5" />;
  if (status === 'waiting') return <MessageCircleQuestion className="size-3.5 text-warning" aria-label="Waiting for you" />;
  if (status === 'failed') return <TriangleAlert className="size-3.5 text-destructive" aria-label="Failed" />;
  return <MessageSquare className="size-3.5 text-muted-foreground" />;
}

function ChatMenu({
  chat,
  onRename,
  onDelete,
  className,
}: {
  chat: InsightChatView;
  onRename: (chat: InsightChatView) => void;
  onDelete: (chat: InsightChatView) => void;
  className?: string;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" className={cn('text-muted-foreground', className)} aria-label={`Chat options: ${chat.title}`}>
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onSelect={() => onRename(chat)}>
          <Pencil />
          Rename
        </DropdownMenuItem>
        {chat.threadLink && (
          <DropdownMenuItem asChild>
            <a href={chat.threadLink} target="_blank" rel="noreferrer">
              <ExternalLink />
              Open in T3
            </a>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={() => onDelete(chat)}>
          <Trash />
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ChatList({
  chats,
  loading,
  selectedId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  chats: InsightChatView[];
  loading: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (chat: InsightChatView) => void;
  onDelete: (chat: InsightChatView) => void;
}) {
  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r border-border bg-surface/40 md:flex">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border pr-1.5 pl-3">
        <span className="text-xs font-medium text-muted-foreground">Chats</span>
        <Tip content="New chat">
          <Button variant="ghost" size="icon-sm" onClick={onNew} aria-label="New chat">
            <SquarePen />
          </Button>
        </Tip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin">
        {loading ? (
          <div className="flex flex-col gap-1.5 p-1">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : chats.length === 0 ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">No chats yet</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {chats.map((c) => (
              <li key={c.id} className="group relative">
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  aria-current={c.id === selectedId ? 'page' : undefined}
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md py-1.5 pr-8 pl-2 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
                    c.id === selectedId && 'bg-accent',
                  )}
                >
                  <span className="flex h-5 shrink-0 items-center">
                    <ChatStatus status={c.status} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] leading-5">{c.title}</span>
                    <span className="block truncate text-[11.5px] text-muted-foreground" title={absoluteTime(c.updatedAt)}>
                      {relativeTime(c.updatedAt)}
                    </span>
                  </span>
                </button>
                <ChatMenu
                  chat={c}
                  onRename={onRename}
                  onDelete={onDelete}
                  className="absolute top-1.5 right-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** Chat picker for narrow screens, where the list is hidden. */
function ChatsDropdown({ chats, selectedId, onSelect }: { chats: InsightChatView[]; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="Chats">
          <MessagesSquare />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-y-auto">
        <DropdownMenuLabel>Chats</DropdownMenuLabel>
        {chats.length === 0 && <p className="px-2 py-1.5 text-xs text-muted-foreground">No chats yet</p>}
        {chats.map((c) => (
          <DropdownMenuItem key={c.id} onSelect={() => onSelect(c.id)} className={cn(c.id === selectedId && 'bg-accent')}>
            <ChatStatus status={c.status} />
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RenameDialog({ chat, onClose }: { chat: InsightChatView | null; onClose: () => void }) {
  return (
    <Dialog open={chat !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">{chat && <RenameForm chat={chat} onDone={onClose} />}</DialogContent>
    </Dialog>
  );
}

function RenameForm({ chat, onDone }: { chat: InsightChatView; onDone: () => void }) {
  const rename = useRenameInsightChat();
  const [title, setTitle] = useState(chat.title);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    if (t !== chat.title) rename.mutate({ chat, title: t });
    onDone();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Rename chat</DialogTitle>
      </DialogHeader>
      <Input autoFocus value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} aria-label="Chat title" />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!title.trim()}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

function EmptyState({ projectPath, onPick }: { projectPath: string; onPick: (q: string) => void }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-5 px-4 py-10 text-center">
      <div className="flex size-11 items-center justify-center rounded-full border border-border bg-card">
        <MessagesSquare className="size-5 text-muted-foreground" />
      </div>
      <div className="flex max-w-md flex-col gap-1.5">
        <h2 className="text-[15px] font-semibold tracking-tight">Ask about your codebase</h2>
        <p className="text-[13px] text-muted-foreground">
          An agent reads the code in <span className="font-mono text-[12px] break-all">{projectPath}</span> and answers. It
          knows this board's plan and open tasks, and changes nothing.
        </p>
      </div>
      <div className="flex max-w-xl flex-wrap justify-center gap-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => onPick(s)}
            className="rounded-md border border-border bg-card px-2.5 py-1.5 text-xs transition-colors hover:border-border-strong hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

export function InsightsView() {
  const { board, openPlanComposer } = useBoardContext();
  const [params, setParams] = useSearchParams();
  const chatId = params.get('chat');
  const chatsQ = useInsightChats(board.id);
  const chatQ = useInsightChat(chatId);
  const create = useCreateInsightChat(board.id);
  const send = useSendInsightMessage();
  const remove = useDeleteInsightChat();
  const confirm = useConfirm();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [draft, setDraft] = useDraft(`insight-draft:${chatId ?? `new:${board.id}`}`);
  /** The first question of a chat being created, shown until the server answers. */
  const [starting, setStarting] = useState<{ text: string; at: string } | null>(null);
  const [renaming, setRenaming] = useState<InsightChatView | null>(null);

  const chats = chatsQ.data ?? [];
  const chat = chatId ? chatQ.data : undefined;
  const messages = chat?.messages ?? [];
  const notFound = chatId !== null && chatQ.isError && isApiError(chatQ.error) && chatQ.error.status === 404;
  const answering = messages.some((m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'waiting'));
  const sending = create.isPending || send.isPending;

  const openChat = useCallback((id: string | null) => setParams(id ? { chat: id } : {}), [setParams]);

  useEffect(() => {
    stickToBottom.current = true;
    inputRef.current?.focus();
  }, [chatId]);

  // Follow new messages and the agent's progress while the reader is at the bottom. When the answer
  // arrives, show it from its question down rather than from its end.
  const signature = messages.map((m) => `${m.id}:${m.status}:${m.notes.length}:${m.text.length}`).join('|');
  const openAnswer = useRef<string | null>(null);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const last = messages.at(-1);
    const justAnswered = last !== undefined && openAnswer.current === last.id && (last.status === 'done' || last.status === 'failed');
    openAnswer.current = last && (last.status === 'pending' || last.status === 'waiting') ? last.id : null;
    if (!el || !stickToBottom.current) return;
    const question = justAnswered ? el.querySelector<HTMLElement>(`[data-seq="${last.seq - 1}"]`) : null;
    if (question) el.scrollTop += question.getBoundingClientRect().top - el.getBoundingClientRect().top - 16;
    else el.scrollTop = el.scrollHeight;
  }, [signature, starting, chatId]); // `signature` stands for `messages`

  const ask = async (text: string): Promise<boolean> => {
    stickToBottom.current = true;
    if (chatId) return send.mutateAsync({ chatId, text }).then(() => true, () => false);
    setStarting({ text, at: new Date().toISOString() });
    try {
      const created = await create.mutateAsync(text);
      openChat(created.id);
      return true;
    } catch {
      return false;
    } finally {
      setStarting(null);
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending || answering) return;
    setDraft('');
    if (!(await ask(text))) setDraft(text);
  };

  const pick = (q: string) => {
    setDraft(q);
    inputRef.current?.focus();
  };

  const deleteChat = async (c: InsightChatView) => {
    const ok = await confirm({
      title: `Delete “${c.title}”?`,
      description: 'The chat leaves T3 Orchestra. Its thread stays in T3.',
      confirmLabel: 'Delete chat',
      variant: 'destructive',
    });
    if (!ok) return;
    // Leave the chat first, so its removal from the cache doesn't refetch it.
    if (c.id === chatId) openChat(null);
    remove.mutate(c);
  };

  const planFrom = (question: string, answer: string) => openPlanComposer(`${question}\n\nThe Insights agent answered:\n\n${answer}`);

  const blocked = notFound
    ? 'This chat no longer exists.'
    : answering
      ? 'Wait for the answer before asking the next question.'
      : null;

  return (
    <div className="flex h-full min-h-0">
      <ChatList
        chats={chats}
        loading={chatsQ.isLoading}
        selectedId={chatId}
        onSelect={openChat}
        onNew={() => openChat(null)}
        onRename={setRenaming}
        onDelete={(c) => void deleteChat(c)}
      />

      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border pr-2 pl-3">
          <ChatsDropdown chats={chats} selectedId={chatId} onSelect={openChat} />
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium">
            {chat?.title ?? (chatId && !notFound ? '' : 'New chat')}
          </h2>
          {chat?.threadLink && (
            <Tip content="Open the agent's thread in T3">
              <Button variant="ghost" size="sm" asChild>
                <a href={chat.threadLink} target="_blank" rel="noreferrer">
                  <ExternalLink />
                  <span className="hidden sm:inline">Open in T3</span>
                </a>
              </Button>
            </Tip>
          )}
          {chat && <ChatMenu chat={chat} onRename={setRenaming} onDelete={(c) => void deleteChat(c)} />}
          <Tip content="New chat">
            <Button variant="ghost" size="icon-sm" className="md:hidden" onClick={() => openChat(null)} aria-label="New chat">
              <SquarePen />
            </Button>
          </Tip>
        </header>

        <div
          ref={scrollRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 overflow-y-auto scrollbar-thin"
        >
          {notFound ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center">
              <p className="text-[13px] text-muted-foreground">This chat was deleted.</p>
              <Button variant="secondary" size="sm" onClick={() => openChat(null)}>
                <SquarePen />
                New chat
              </Button>
            </div>
          ) : chatId && !chat ? (
            <div className="mx-auto flex max-w-3xl flex-col gap-4 px-3 py-5 sm:px-5">
              <Skeleton className="ml-auto h-9 w-2/3" />
              <Skeleton className="h-24" />
            </div>
          ) : !chatId && !starting ? (
            <EmptyState projectPath={board.projectPath} onPick={pick} />
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-5 px-3 py-5 sm:px-5">
              {starting && !chatId && (
                <>
                  <UserMessage text={starting.text} />
                  <Working since={starting.at} notes={[]} waiting={false} starting threadLink={null} />
                </>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                return (
                  <div key={m.id} data-seq={m.seq}>
                    {m.role === 'user' ? (
                      <UserMessage text={m.text} />
                    ) : (
                      <AnswerMessage
                        message={m}
                        question={prev?.role === 'user' ? prev.text : null}
                        threadLink={chat?.threadLink ?? null}
                        canAskAgain={!sending && !answering}
                        onAskAgain={(q) => void ask(q)}
                        onPlan={planFrom}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <InsightComposer
          text={draft}
          onText={setDraft}
          onSend={() => void submit()}
          sending={sending}
          blocked={blocked}
          inputRef={inputRef}
        />
      </section>

      <RenameDialog chat={renaming} onClose={() => setRenaming(null)} />
    </div>
  );
}
