import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

export function Markdown({ children, className }: { children: string | null | undefined; className?: string }) {
  if (!children?.trim()) return null;
  return (
    <div className={cn('md', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
