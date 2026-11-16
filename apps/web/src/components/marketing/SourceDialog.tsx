// Connect a metric source (pick a kind, fill in its fields) or edit one. The server reads the source
// once before saving, so a wrong name or key shows up here rather than on the card.
import { MARKETING_SOURCE_KINDS, SOURCE_KIND_INFO, type MarketingSourceKind, type MarketingSourceView } from '@t3-orchestra/shared';
import { ChevronLeft, Lock } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/client';
import { useAddSource, usePatchSource } from '@/api/marketing';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input, Label } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { SOURCE_ICONS } from './categories';

/** What the dialog opens on: nothing (pick a kind), a kind, a kind with fields filled in, or a source to edit. */
export interface SourceDialogTarget {
  kind?: MarketingSourceKind;
  config?: Record<string, string>;
  source?: MarketingSourceView;
}

export function KindGrid({ onPick, className }: { onPick: (k: MarketingSourceKind) => void; className?: string }) {
  return (
    <div className={cn('grid grid-cols-1 gap-2 sm:grid-cols-2', className)}>
      {MARKETING_SOURCE_KINDS.map((k) => {
        const info = SOURCE_KIND_INFO[k];
        const Icon = SOURCE_ICONS[k];
        return (
          <button
            key={k}
            type="button"
            onClick={() => onPick(k)}
            className="flex items-start gap-2.5 rounded-md border border-border bg-background/40 px-3 py-2.5 text-left transition-colors hover:border-border-strong hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13px] font-medium">{info.label}</span>
              <span className="text-xs leading-snug text-muted-foreground">{info.blurb}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function SourceDialog({ boardId, target, onClose }: { boardId: string; target: SourceDialogTarget | null; onClose: () => void }) {
  const add = useAddSource(boardId);
  const patch = usePatchSource();
  const formId = useId();
  const editing = target?.source ?? null;
  const [kind, setKind] = useState<MarketingSourceKind | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [dropSecret, setDropSecret] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setKind(target.source?.kind ?? target.kind ?? null);
    setValues({ ...(target.source?.config ?? target.config ?? {}) });
    setName(target.source?.name ?? '');
    setSecret('');
    setDropSecret(false);
    setError(null);
  }, [target]);

  const info = kind ? SOURCE_KIND_INFO[kind] : null;
  const pending = add.isPending || patch.isPending;
  const secretField = info?.fields.find((f) => f.secret);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!kind || !info || pending) return;
    setError(null);
    const config = Object.fromEntries(info.fields.filter((f) => !f.secret).map((f) => [f.key, values[f.key]?.trim() ?? '']));
    const done = (s: MarketingSourceView) => {
      toast.success(editing ? `Saved ${s.name}` : `Connected ${info.label}`, { description: editing ? undefined : s.name });
      onClose();
    };
    const fail = (err: unknown) => setError(errorMessage(err));
    if (editing) {
      patch.mutate(
        { id: editing.id, body: { name: name.trim(), config, secret: dropSecret ? null : secret.trim() || undefined } },
        { onSuccess: done, onError: fail },
      );
    } else {
      add.mutate({ kind, name: name.trim() || undefined, config, secret: secret.trim() || undefined }, { onSuccess: done, onError: fail });
    }
  };

  const Icon = kind ? SOURCE_ICONS[kind] : null;

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent className={kind ? 'max-w-md' : 'max-w-2xl'}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {Icon && <Icon className="size-4 text-muted-foreground" />}
            {editing ? `Edit ${editing.name}` : info ? `Connect ${info.label}` : 'Connect a source'}
          </DialogTitle>
          <DialogDescription>{info ? info.blurb : 'Where should the numbers come from? Each source is read about every six hours.'}</DialogDescription>
        </DialogHeader>

        {!kind || !info ? (
          <KindGrid onPick={setKind} />
        ) : (
          <form id={formId} onSubmit={submit} className="flex flex-col gap-3.5">
            {info.fields.map((f) => {
              const id = `${formId}-${f.key}`;
              if (f.secret) {
                const saved = editing?.hasSecret && !dropSecret;
                return (
                  <div key={f.key} className="flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor={id}>
                        {f.label} {f.optional && <span className="font-normal opacity-70">(optional)</span>}
                      </Label>
                      {editing?.hasSecret && (
                        <Button type="button" variant="link" size="xs" className="h-auto px-0" onClick={() => setDropSecret((v) => !v)}>
                          {dropSecret ? 'Keep the saved one' : 'Remove'}
                        </Button>
                      )}
                    </div>
                    <Input
                      id={id}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      placeholder={saved ? 'Saved. Type a new one to replace it' : dropSecret ? 'Will be removed' : f.placeholder}
                      disabled={dropSecret}
                    />
                    {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
                  </div>
                );
              }
              return (
                <div key={f.key} className="flex flex-col gap-1.5">
                  <Label htmlFor={id}>
                    {f.label} {f.optional && <span className="font-normal opacity-70">(optional)</span>}
                  </Label>
                  <Input
                    id={id}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    placeholder={f.placeholder}
                    spellCheck={false}
                    autoFocus={f === info.fields[0]}
                  />
                  {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
                </div>
              );
            })}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${formId}-name`}>
                Name on the card <span className="font-normal opacity-70">(optional)</span>
              </Label>
              <Input id={`${formId}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder="Taken from the fields above" />
            </div>
            {secretField && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <Lock className="mt-px size-3 shrink-0" />
                Your {secretField.label} stays on this computer, in T3 Orchestra's database, and is only ever sent to {info.label}.
              </p>
            )}
            {error && (
              <p role="alert" className="rounded-md border border-destructive/35 bg-destructive/8 px-2.5 py-2 text-[12.5px] text-destructive">
                {error}
              </p>
            )}
          </form>
        )}

        {kind && info && (
          <DialogFooter className="sm:justify-between">
            {!editing ? (
              <Button type="button" variant="ghost" size="sm" className="-ml-2 self-start" onClick={() => setKind(null)} disabled={pending}>
                <ChevronLeft />
                All sources
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button type="submit" form={formId} disabled={pending}>
                {pending && <Spinner className="size-3.5" />}
                {pending ? (info.fetched ? 'Checking…' : 'Saving…') : editing ? 'Save' : 'Connect'}
              </Button>
            </div>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
