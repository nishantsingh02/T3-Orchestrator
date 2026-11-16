import { useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/** Agent-written pages: scripts run, but in an opaque origin (no access to the board or its API). */
export const DESIGN_SANDBOX = 'allow-scripts allow-forms allow-modals';

interface Props {
  src: string;
  title: string;
  /** Width the page is laid out at (a device width), scaled down to fit; null fills the box. */
  width: number | null;
  /** Thumbnails: not focusable, no pointer events. */
  interactive?: boolean;
  className?: string;
}

/** A design option page laid out at `width` and scaled to fit its box, centred when narrower. */
export function ScaledFrame({ src, title, width, interactive = true, className }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const vw = width ?? box.w;
  const scale = vw > 0 && box.w > 0 ? Math.min(1, box.w / vw) : 1;
  const left = Math.max(0, (box.w - vw * scale) / 2);
  const framed = width !== null && vw * scale < box.w - 1;

  return (
    <div ref={ref} className={cn('relative overflow-hidden', className)}>
      {box.w > 0 && (
        <iframe
          src={src}
          title={title}
          sandbox={DESIGN_SANDBOX}
          referrerPolicy="no-referrer"
          loading="lazy"
          tabIndex={interactive ? undefined : -1}
          aria-hidden={interactive ? undefined : true}
          style={{ left, width: vw, height: box.h / scale, transform: scale < 1 ? `scale(${scale})` : undefined }}
          className={cn(
            'absolute top-0 origin-top-left border-0 bg-white',
            !interactive && 'pointer-events-none',
            framed && 'shadow-lg ring-1 ring-border',
          )}
        />
      )}
    </div>
  );
}
