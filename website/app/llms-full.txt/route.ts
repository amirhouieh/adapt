import { getLLMText, source } from '@/lib/source';
import type * as PageTree from 'fumadocs-core/page-tree';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const revalidate = false;

const header = `# adapt — full documentation

All adapt docs in one file, in reading order. Each part builds on the one before it.
Read top to bottom. Package: @unbody-io/adapt.`;

// Pages in sidebar order, so each concept comes after the one it builds on.
function urlsInOrder(nodes: PageTree.Node[]): string[] {
  return nodes.flatMap((node) => {
    if (node.type === 'page') return [node.url];
    if (node.type === 'folder') {
      const index = node.index ? [node.index.url] : [];
      return [...index, ...urlsInOrder(node.children)];
    }
    return [];
  });
}

export async function GET() {
  const pages = urlsInOrder(source.getPageTree().children)
    .map((url) => source.getPages().find((page) => page.url === url))
    .filter((page) => page !== undefined);
  const texts = await Promise.all(pages.map(getLLMText));
  // Glossary first, so every term is defined before the pages use it.
  const glossary = await readFile(path.join(process.cwd(), 'content/llms-glossary.md'), 'utf8');

  return new Response([header, glossary.trim(), ...texts].join('\n\n'));
}
