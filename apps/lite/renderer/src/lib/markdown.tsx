import { Fragment, type ReactNode } from 'react';

/**
 * A small, SAFE Markdown renderer for replies. It builds React elements (never HTML strings), so what a model writes
 * cannot inject markup or script. Supports fenced code, headings, lists, quotes and paragraphs; inline code, bold,
 * italic and http(s) links. It is tolerant of half-written text, because it re-renders on every streamed piece.
 */

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /(`[^`\n]+`)|(\[([^\]\n]+)\]\((\S+?)\))|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyPrefix}-${index++}`;
    if (match[1]) {
      out.push(
        <code key={key} className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[0.9em]">
          {match[1].slice(1, -1)}
        </code>,
      );
    } else if (match[2]) {
      const label = match[3]!;
      const url = match[4]!;
      out.push(
        SAFE_URL.test(url) ? (
          <a
            key={key}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2"
          >
            {label}
          </a>
        ) : (
          // Anything that is not plain http(s) (javascript:, file:, data:) is shown as plain text.
          <Fragment key={key}>{label}</Fragment>
        ),
      );
    } else if (match[5]) {
      out.push(
        <strong key={key} className="font-semibold">
          {match[6]}
        </strong>,
      );
    } else if (match[7]) {
      out.push(<em key={key}>{match[8]}</em>);
    }
    last = start + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const startsBlock = (line: string) => /^(```|#{1,6}\s|>\s?|[-*+]\s+|\d+[.)]\s+)/.test(line);

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (/^```/.test(line)) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i += 1;
      blocks.push(
        <pre
          key={key++}
          dir="ltr"
          className="my-3 overflow-x-auto rounded-lg border border-line bg-panel p-3 font-mono text-[0.85em] leading-relaxed"
        >
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={key++} className="mt-4 mb-1 text-[1.05em] font-semibold">
          {renderInline(heading[2]!, `h${key}`)}
        </p>,
      );
      i += 1;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!))
        quote.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push(
        <blockquote key={key++} className="my-2 border-s-2 border-line-strong ps-3 text-muted">
          {renderInline(quote.join(' '), `q${key}`)}
        </blockquote>,
      );
      continue;
    }
    const bullet = /^[-*+]\s+/;
    const numbered = /^\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const matcher = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && matcher.test(lines[i]!))
        items.push(lines[i++]!.replace(matcher, ''));
      const Tag = ordered ? 'ol' : 'ul';
      blocks.push(
        <Tag
          key={key++}
          className={`my-2 space-y-1 ps-6 ${ordered ? 'list-decimal' : 'list-disc'}`}
        >
          {items.map((item, n) => (
            <li key={n}>{renderInline(item, `li${key}-${n}`)}</li>
          ))}
        </Tag>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      (paragraph.length === 0 || !startsBlock(lines[i]!))
    ) {
      paragraph.push(lines[i++]!);
    }
    blocks.push(
      <p key={key++} className="my-2 first:mt-0 last:mb-0">
        {paragraph.flatMap((l, n) => [
          ...(n > 0 ? [<br key={`br${n}`} />] : []),
          ...renderInline(l, `p${key}-${n}`),
        ])}
      </p>,
    );
  }
  return <>{blocks}</>;
}
