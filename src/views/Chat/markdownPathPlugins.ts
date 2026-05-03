import type { PathHit } from "./pathDetection";

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

export function makeRehypePaths(hits: Map<string, PathHit>) {
  return function rehypePathsPlugin() {
    return (tree: HastNode) => {
      if (hits.size === 0) return;

      const rawList = Array.from(hits.keys()).sort((a, b) => b.length - a.length);
      const escaped = rawList.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      const re = new RegExp(
        `(?:^|(?<=[\\s\`'"(\\[<「『“‘《]))(${escaped.join("|")})(?=$|[\\s\`'"<>)\\]」』”’》,.;:!?]|$)`,
        "g"
      );

      const walk = (parent: HastNode) => {
        if (!parent.children) return;
        if (
          parent.type === "element" &&
          parent.tagName &&
          ["script", "style", "pre", "a"].includes(parent.tagName)
        ) {
          return;
        }

        const next: HastNode[] = [];
        for (const child of parent.children) {
          if (child.type === "text" && typeof child.value === "string" && child.value.length > 0) {
            const value = child.value;
            re.lastIndex = 0;
            let last = 0;
            let match: RegExpExecArray | null;
            let matched = false;

            while ((match = re.exec(value)) !== null) {
              matched = true;
              const raw = match[1];
              if (match.index > last) next.push({ type: "text", value: value.slice(last, match.index) });
              next.push({
                type: "element",
                tagName: "span",
                properties: { "data-path-link": raw },
                children: [{ type: "text", value: raw }],
              });
              last = match.index + match[0].length;
              if (match[0].length === 0) re.lastIndex++;
            }

            if (!matched) {
              next.push(child);
            } else if (last < value.length) {
              next.push({ type: "text", value: value.slice(last) });
            }
          } else {
            walk(child);
            next.push(child);
          }
        }
        parent.children = next;
      };

      walk(tree);
    };
  };
}
