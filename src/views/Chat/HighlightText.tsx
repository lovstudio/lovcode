interface HighlightTextProps {
  text: string;
  query?: string;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function HighlightText({ text, query }: HighlightTextProps) {
  const q = query?.trim();
  if (!q) return <>{text}</>;

  const re = new RegExp(escapeRegExp(q), "gi");
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(<span key={key++}>{text.slice(lastIndex, match.index)}</span>);
    }
    nodes.push(
      <mark key={key++} data-search-hit="" className="bg-primary/25 text-ink rounded px-0.5">
        {match[0]}
      </mark>
    );
    lastIndex = match.index + match[0].length;
    if (match[0].length === 0) re.lastIndex++;
  }
  if (lastIndex < text.length) {
    nodes.push(<span key={key++}>{text.slice(lastIndex)}</span>);
  }

  return <>{nodes}</>;
}
