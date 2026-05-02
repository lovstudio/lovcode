import { Fragment } from "react";
import { PathLink } from "./PathLink";
import { segmentText, type PathHit } from "./pathDetection";
import { HighlightText } from "./HighlightText";

interface Props {
  text: string;
  hits: Map<string, PathHit>;
  highlight?: string;
}

export function PathAwareText({ text, hits, highlight }: Props) {
  if (hits.size === 0) {
    return <HighlightText text={text} query={highlight} />;
  }
  const segments = segmentText(text, hits);
  return (
    <>
      {segments.map((seg, i) => (
        <Fragment key={i}>
          {seg.hit ? (
            <PathLink text={seg.text} hit={seg.hit} />
          ) : (
            <HighlightText text={seg.text} query={highlight} />
          )}
        </Fragment>
      ))}
    </>
  );
}
