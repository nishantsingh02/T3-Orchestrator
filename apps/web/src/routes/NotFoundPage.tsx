import { Link } from 'react-router';
import { AppHeader } from '@/components/layout/AppHeader';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  return (
    <div className="flex h-full flex-col">
      <AppHeader />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="font-mono text-xs text-muted-foreground">404</p>
        <p className="text-[15px] font-medium">Nothing here</p>
        <Button asChild variant="secondary" size="sm">
          <Link to="/">All boards</Link>
        </Button>
      </div>
    </div>
  );
}
