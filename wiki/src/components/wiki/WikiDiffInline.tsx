"use client";

import { useMemo } from "react";
import { diffArrays, diffWordsWithSpace } from "diff";
import { sanitizeWikiHtml } from "@/lib/sanitizeWikiHtml";

/**
 * Block-level HTML diff renderer.
 *
 * Splits the before/after HTML into top-level block elements
 * (paragraphs, headings, lists, etc.), aligns matching blocks by text
 * content, and renders unchanged blocks as-is. Added blocks gain a
 * green background; removed blocks gain a red background + line-through.
 *
 * The output is wrapped in `.wiki-richtext-rendered` so it inherits the
 * exact same typography (heading scale, paragraph spacing, list bullets)
 * the Read mode uses, so the diff reads like the wiki, not like raw text.
 *
 * For pairs of removed+added blocks that share the same tag, a word-level
 * diff runs inside them so a typo fix doesn't show as "whole paragraph
 * gone + whole paragraph added".
 */

interface Block {
  tag: string;
  html: string;
  text: string;
}

function splitBlocks(html: string): Block[] {
  if (!html) return [];

  // Server-side fallback: regex split on opening block tags. Less
  // accurate than DOMParser but enough for SSR.
  if (typeof window === "undefined") {
    const parts = html.split(
      /(?=<(?:h[1-6]|p|ul|ol|blockquote|pre|hr|table)\b)/i,
    );
    return parts
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => {
        const m = s.match(/^<([a-z][a-z0-9]*)\b/i);
        const tag = m ? m[1].toLowerCase() : "p";
        return {
          tag,
          html: s,
          text: s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        };
      });
  }

  const doc = new DOMParser().parseFromString(html, "text/html");
  const blocks: Block[] = [];
  doc.body.childNodes.forEach((node) => {
    if (node.nodeType !== 1) return;
    const el = node as Element;
    blocks.push({
      tag: el.tagName.toLowerCase(),
      html: el.outerHTML,
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    });
  });
  return blocks;
}

const baseBlockStyle = {
  borderRadius: 4,
  padding: "2px 6px",
  margin: "0 -6px",
} as const;

const addedStyle = {
  ...baseBlockStyle,
  backgroundColor: "var(--diff-added-bg)",
};

const removedStyle = {
  ...baseBlockStyle,
  backgroundColor: "var(--diff-removed-bg)",
  textDecoration: "line-through",
  textDecorationColor: "var(--diff-removed-text)",
};

const inlineAdded = {
  backgroundColor: "var(--diff-added-bg)",
  color: "var(--diff-added-text)",
  padding: "0 1px",
  borderRadius: 2,
} as const;

const inlineRemoved = {
  backgroundColor: "var(--diff-removed-bg)",
  color: "var(--diff-removed-text)",
  textDecoration: "line-through",
  padding: "0 1px",
  borderRadius: 2,
} as const;

/**
 * Render a word-level diff between two plain-text strings, preserving
 * any HTML wrapper tag (h2, h3, p, etc.) so heading-vs-paragraph
 * typography survives the diff.
 */
function WordLevelBlock({
  tag,
  before,
  after,
}: {
  tag: string;
  before: string;
  after: string;
}) {
  const parts = diffWordsWithSpace(before, after);
  const Tag = tag as keyof React.JSX.IntrinsicElements;
  return (
    <Tag>
      {parts.map((p, i) => {
        if (p.added) return <span key={i} style={inlineAdded}>{p.value}</span>;
        if (p.removed) return <span key={i} style={inlineRemoved}>{p.value}</span>;
        return <span key={i}>{p.value}</span>;
      })}
    </Tag>
  );
}

type RenderItem =
  | { kind: "equal"; block: Block }
  | { kind: "added"; block: Block }
  | { kind: "removed"; block: Block }
  | { kind: "modified"; tag: string; before: string; after: string };

/**
 * Walk the diff output and coalesce same-tag remove+add pairs into a
 * single "modified" item so identical-tag rewrites (a typo fix in a
 * heading, a paragraph edit) render as a single word-diffed line
 * instead of a strikethrough block followed by a green block.
 */
function buildRenderPlan(blocks: Array<{
  value: Block[];
  added?: boolean;
  removed?: boolean;
}>): RenderItem[] {
  const out: RenderItem[] = [];
  // Flatten array entries into one item per block so we can look at
  // adjacent removed/added pairs.
  const flat: Array<{ kind: "equal" | "added" | "removed"; block: Block }> = [];
  for (const entry of blocks) {
    const kind: "equal" | "added" | "removed" = entry.added
      ? "added"
      : entry.removed
        ? "removed"
        : "equal";
    for (const block of entry.value) flat.push({ kind, block });
  }

  let i = 0;
  while (i < flat.length) {
    const curr = flat[i];
    const next = flat[i + 1];
    // Only coalesce same-tag remove+add pairs into a word-diffed line
    // when the tag is a simple text container. Lists / tables / pre
    // blocks expect specific child elements (`<li>`, `<tr>`) and would
    // render invalid HTML if we put raw `<span>`s inside them.
    const wordDiffableTags = new Set([
      "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
    ]);
    if (
      curr.kind === "removed" &&
      next &&
      next.kind === "added" &&
      curr.block.tag === next.block.tag &&
      wordDiffableTags.has(curr.block.tag)
    ) {
      out.push({
        kind: "modified",
        tag: curr.block.tag,
        before: curr.block.text,
        after: next.block.text,
      });
      i += 2;
      continue;
    }
    out.push(curr);
    i += 1;
  }
  return out;
}

export interface WikiDiffInlineProps {
  /** HTML snapshot at the start of editing, i.e. the "before" side. */
  beforeHtml: string;
  /** Live HTML from the editor, i.e. the "after" side. */
  afterHtml: string;
}

export function WikiDiffInline({ beforeHtml, afterHtml }: WikiDiffInlineProps) {
  const renderPlan = useMemo<RenderItem[]>(() => {
    const before = splitBlocks(beforeHtml);
    const after = splitBlocks(afterHtml);
    const diff = diffArrays<Block>(before, after, {
      comparator: (a, b) => a.text === b.text,
    });
    return buildRenderPlan(diff);
  }, [beforeHtml, afterHtml]);

  return (
    <div className="wiki-richtext-rendered">
      {renderPlan.map((item, i) => {
        if (item.kind === "modified") {
          return (
            <WordLevelBlock
              key={i}
              tag={item.tag}
              before={item.before}
              after={item.after}
            />
          );
        }
        const style =
          item.kind === "added"
            ? addedStyle
            : item.kind === "removed"
              ? removedStyle
              : undefined;
        return (
          <div
            key={i}
            style={style}
            dangerouslySetInnerHTML={{ __html: sanitizeWikiHtml(item.block.html) }}
          />
        );
      })}
    </div>
  );
}
