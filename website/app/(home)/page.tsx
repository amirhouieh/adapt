import Link from 'next/link';
import { ScrambleText } from '@/components/scramble-text';
import { InstallCommand } from '@/components/install-command';
import { buttonVariants } from '@/components/ui/button';

export default function HomePage() {
  return (
    <div className="flex items-center justify-center flex-1">
      <div className="flex flex-col items-start gap-4 px-4">
      <div className="flex flex-col gap-1">
        <h1 className="text-sm">
          <ScrambleText text={[
            'Adapt Memory',
            'That\'s new...',
            'Seen this before...',
            'This matters...',
            'Things are shifting...',
            'I\'ll remember...',
          ]} pause={2500} />
        </h1>
        <p className="text-sm text-fd-muted-foreground">A self-evolving memory layer for AI applications.</p>
      </div>
      <InstallCommand />
      <div className="flex flex-row gap-3 items-center">
        <Link
          href="/docs"
          className={buttonVariants({ variant: 'default', size: 'sm' })}
        >
          Get started
        </Link>
        <Link
          href="/demo"
          className={buttonVariants({ variant: 'ghost', size: 'sm' })}
        >
          Try it
        </Link>
      </div>
      </div>
    </div>
  );
}
