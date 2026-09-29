import { Fragment, type ReactNode } from 'react';

/**
 * A deliberately small, SAFE Markdown renderer for assistant replies. It builds React elements (never
 * HTML strings), so model output can't inject markup or script. Supported: fenced code, headings,
 * bullet/numbered lists, blockquotes, paragraphs; inline code, **bold**, *italic*, and http(s) links.
 * It is tolerant of partial input, because it re-renders on every streamed delta (an unclosed ``` fence
 * simply renders the rest as code).
 */

const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Order matters: code first (its contents are literal), then links, bold, italic.
  const pattern = /(`[^`\n]+`)|(\[([^\]\n]+)\]\((\S+?)\))|(\*\*([^*\n]+)\*\*)|(\*([^*\n]+)\*)/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const key = `${keyPrefix}-${index++}`;
    if (match[1]) {
      out.push(
        <code
          key={key}
          className="rounded bg-bg px-1.5 py-0.5 font-mono text-[0.9em] text-accent-text"
        >
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
            className="text-accent-text underline underline-offset-2"
          >
            {label}
          </a>
        ) : (
          // Anything that isn't plain http(s) (javascript:, file:, data:…) is shown as inert text.
          <Fragment key={key}>{label}</Fragment>
        ),
      );
    } else if (match[5]) {
      out.push(
        <strong key={key} className="font-semibold text-fg">
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

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) body.push(lines[i++]!);
      i += 1; // closing fence (or end of a still-streaming block)
      blocks.push(
        <pre
          key={key++}
          dir="ltr"
          className="my-3 overflow-x-auto rounded-xl border border-line bg-bg p-3 font-mono text-small leading-relaxed text-fg"
        >
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push(
        <p key={key++} className="mt-4 mb-1 text-h3 font-semibold text-fg">
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
        <blockquote key={key++} className="my-2 border-s-2 border-accent/50 ps-3 text-muted">
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
    )
      paragraph.push(lines[i++]!);
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
