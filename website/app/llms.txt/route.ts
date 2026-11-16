import { source } from '@/lib/source';
import { llms } from 'fumadocs-core/source';

export const revalidate = false;

const lead = `# adapt

> adapt learns from your data as it arrives, on your device. For agents: read /llms-full.txt. It holds all adapt docs in one file, in reading order.`;

export function GET() {
  return new Response(`${lead}\n\n${llms(source).index()}`);
}
