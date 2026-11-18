// Provider and model pickers fed by T3 Code's own provider list. While T3 cannot be reached they
// fall back to text fields, so a slug can still be typed in.
import type { T3ModelCatalogView, T3ModelView } from '@t3-orchestra/shared';
import { useT3Models } from '@/api/settings';
import { CommitInput } from '@/components/fields';
import { Select, type SelectOption } from '@/components/ui/select';
import { cn } from '@/lib/utils';

/** Radix forbids '' as an item value. */
const NONE = '__none__';

/** Models of `provider`, or of T3's default provider when null. Undefined when T3 doesn't offer that provider. */
export function modelsOf(catalog: T3ModelCatalogView, provider: string | null): T3ModelView[] | undefined {
  return catalog.providers.find((p) => p.id === (provider ?? catalog.defaultProvider))?.models;
}

interface Props {
  value: string | null;
  onChange: (v: string | null) => void;
  /** The empty choice, e.g. "Project default". */
  noneLabel: string;
  /** For the text fallback: "change" for dialogs with an explicit Save, "blur" for autosaving pages. */
  mode?: 'blur' | 'change';
  size?: 'default' | 'sm';
  disabled?: boolean;
  id?: string;
  className?: string;
}

/** The models T3 offers on `provider` (T3's default provider when null), minus the ones hidden in T3. */
export function ModelSelect({ provider, ...p }: Props & { provider: string | null }) {
  const q = useT3Models();
  if (q.isPending) return <Picker {...p} options={[]} disabled />;
  if (!q.data) return <TextFallback {...p} />;
  const models = modelsOf(q.data, provider) ?? [];
  const providerName = q.data.providers.find((x) => x.id === (provider ?? q.data.defaultProvider))?.name ?? provider ?? 'T3';
  return (
    <Picker
      {...p}
      options={models.filter((m) => !m.hidden || m.slug === p.value).map((m) => ({ value: m.slug, label: m.name }))}
      unknownLabel={(v) => `${v} · not in ${providerName}`}
    />
  );
}

/** The providers enabled in T3. */
export function ProviderSelect(p: Props) {
  const q = useT3Models();
  if (q.isPending) return <Picker {...p} options={[]} disabled />;
  if (!q.data) return <TextFallback {...p} />;
  return (
    <Picker
      {...p}
      options={q.data.providers.map((x) => ({ value: x.id, label: x.status === 'ready' ? x.name : `${x.name} · ${x.status}` }))}
      unknownLabel={(v) => `${v} · not enabled in T3`}
    />
  );
}

function Picker({
  value,
  onChange,
  noneLabel,
  options,
  unknownLabel = (v) => v,
  size,
  disabled,
  id,
  className,
}: Props & { options: SelectOption<string>[]; unknownLabel?: (v: string) => string }) {
  const all: SelectOption<string>[] = [{ value: NONE, label: noneLabel }, ...options];
  // A value T3 doesn't (or no longer) offer stays visible rather than silently reading as the default.
  if (value && !options.some((o) => o.value === value)) all.push({ value, label: unknownLabel(value) });
  return (
    <Select
      id={id}
      size={size}
      disabled={disabled}
      className={className}
      value={value ?? NONE}
      onValueChange={(v) => onChange(v === NONE ? null : v)}
      options={all}
    />
  );
}

function TextFallback({ value, onChange, noneLabel, mode, size, disabled, id, className }: Props) {
  return (
    <CommitInput
      mono
      nullable
      id={id}
      mode={mode}
      disabled={disabled}
      className={cn(size === 'sm' && 'h-7', className)}
      value={value}
      placeholder={noneLabel}
      onCommit={onChange}
    />
  );
}
