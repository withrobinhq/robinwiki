import type { CSSProperties, ReactNode } from "react";
import { T } from "@/lib/typography";
import {
  MarkdownContent,
  type FragmentCitationMap,
} from "@/components/wiki/MarkdownContent";
import { WikiCitations } from "@/components/wiki/WikiCitations";
import { WikiEditLink } from "@/components/wiki/WikiFurniture";
import {
  parseSectionsFromMarkdown,
  type SectionInfo,
} from "@/lib/sectionEdit";
import type { WikiRef, WikiSection } from "@/lib/sidecarTypes";

/**
 * Match server-computed `sections[]` entries to the anchors produced by
 * `parseSectionsFromMarkdown` against the displayed markdown.
 */
function buildCitationsByAnchor(
  sections: WikiSection[] | undefined,
): Map<string, WikiSection> {
  const map = new Map<string, WikiSection>();
  if (!sections) return map;
  for (const s of sections) {
    map.set(s.anchor, s);
  }
  return map;
}

/**
 * Build a document-wide map from fragment id to citation number.
 * Walks sections in render order and assigns sequential 1-based
 * numbers to each unique fragment id. Duplicate references to the
 * same fragment keep the same number. (#351)
 */
function buildFragmentCitationMap(
  parsed: SectionInfo[],
  citationsByAnchor: Map<string, WikiSection>,
): FragmentCitationMap {
  const map: FragmentCitationMap = new Map();
  let n = 1;
  for (const section of parsed) {
    if (section.level === 1) continue;
    const matched = citationsByAnchor.get(section.anchor);
    for (const c of matched?.citations ?? []) {
      if (!map.has(c.fragmentId)) {
        map.set(c.fragmentId, n++);
      }
    }
  }
  return map;
}

/**
 * Heading styles mirroring `MarkdownContent`'s internal `buildComponents`
 * heading mapping so section-scoped headings look identical to headings
 * rendered inside `<MarkdownContent>` body blocks.
 */
const sectionHeadingStyle: Record<2 | 3 | 4, CSSProperties> = {
  2: {
    ...T.h2,
    color: "var(--wiki-article-h2)",
    margin: "24px 0 8px",
    borderBottom: "1px solid var(--wiki-card-border)",
    paddingBottom: 4,
  },
  3: {
    ...T.h3,
    color: "var(--wiki-article-h2)",
    margin: "20px 0 6px",
  },
  4: {
    ...T.h4,
    color: "var(--wiki-article-h2)",
    margin: "16px 0 4px",
  },
};

/**
 * Compute where a section's "own" body ends — i.e. the last line that
 * isn't covered by a nested child section.
 *
 * The parser returns endLine = the line before the next same-or-higher
 * heading. For an H2 with H3 children, that means the H2's range
 * encompasses every H3 child too. If we render the H2's body as-is, the
 * child H3 markdown is rendered nested inside the H2's `<MarkdownContent>`,
 * AND each H3 then also renders as its own React block — every nested
 * section is double-rendered. Triggered first by the Log default_structure
 * (H2 "Entries" with H3 "[YYYY-MM-DD]" sub-entries) once a Log wiki has
 * more than one date.
 *
 * Trim the parent's body to end just before its first nested child; the
 * children then render as their own blocks below. Applies recursively —
 * an H3 with H4 children gets the same trim.
 */
function effectiveBodyEndLine(
  section: SectionInfo,
  allSections: SectionInfo[],
): number {
  const firstChild = allSections.find(
    (s) =>
      s !== section &&
      s.level > section.level &&
      s.startLine > section.startLine &&
      s.startLine <= section.endLine,
  );
  return firstChild ? firstChild.startLine - 1 : section.endLine;
}

function SectionHeadingWithEdit({
  section,
  onEdit,
  showEditLink,
}: {
  section: SectionInfo;
  onEdit: (sectionId: string) => void;
  showEditLink: boolean;
}) {
  const style = sectionHeadingStyle[section.level as 2 | 3 | 4];
  if (!style) return null;

  const HeadingTag = (section.level === 3
    ? "h3"
    : section.level === 4
      ? "h4"
      : "h2") as "h2" | "h3" | "h4";

  const editLink = showEditLink ? (
    <>
      {" "}
      <WikiEditLink onClick={() => onEdit(section.id)} />
    </>
  ) : null;

  return (
    <HeadingTag style={style}>
      {section.heading}
      {editLink}
    </HeadingTag>
  );
}

/**
 * Render the markdown body as a sequence of section-scoped
 * `<MarkdownContent>` blocks, each followed by its `<WikiCitations>`
 * superscripts. Preamble before the first heading (if any) renders as
 * an unattributed leading block.
 *
 * If the body has no headings, falls back to a single whole-body render.
 *
 * H1 is skipped entirely: the parser gives H1 an endLine running to EOF
 * (the standard "next same-or-higher heading" rule, with no next H1), so
 * rendering its span would duplicate every H2+ that follows. The wiki
 * title is already rendered as page chrome by `<WikiEntityArticle>`, so
 * the markdown-level H1 is redundant. Without the skip, every wiki
 * double-rendered from the first H2 onward (issue #152).
 *
 * When `onEditSection` is provided, H2/H3/H4 gain a trailing `[edit]`
 * bracket affordance.
 */
export function SectionedMarkdownBody({
  content,
  refs,
  sections,
  style,
  onEditSection,
}: {
  content: string;
  refs: Record<string, WikiRef>;
  sections: WikiSection[] | undefined;
  style: CSSProperties;
  onEditSection?: (sectionId: string) => void;
}) {
  const parsed: SectionInfo[] = parseSectionsFromMarkdown(content);
  if (parsed.length === 0) {
    return <MarkdownContent content={content} refs={refs} style={style} />;
  }

  const lines = content.split("\n");
  const citationsByAnchor = buildCitationsByAnchor(sections);

  // #351 -- build document-wide citation numbering map before rendering
  // so every <MarkdownContent> block can resolve fragment tokens to
  // their correct [N] superscript.
  const fragmentCitationMap = buildFragmentCitationMap(parsed, citationsByAnchor);

  // The preamble covers every line up to the first renderable (non-H1)
  // section. For docs that open with an H1 followed by intro prose before
  // the first H2 (the Transformer fixture's shape), this captures the
  // intro. H1 heading lines themselves are stripped — the page chrome
  // owns the document-level heading via <WikiEntityArticle>.
  const firstRenderedIdx = parsed.findIndex((s) => s.level !== 1);
  const preambleEnd =
    firstRenderedIdx === -1 ? lines.length : parsed[firstRenderedIdx].startLine;
  const h1LineIndices = new Set(
    parsed.filter((s) => s.level === 1).map((s) => s.startLine),
  );
  const preambleLines: string[] = [];
  for (let i = 0; i < preambleEnd; i++) {
    if (h1LineIndices.has(i)) continue;
    preambleLines.push(lines[i]);
  }
  const preamble = preambleLines.join("\n");
  const blocks: ReactNode[] = [];
  if (preamble.trim().length > 0) {
    blocks.push(
      <MarkdownContent
        key="__preamble"
        content={preamble}
        refs={refs}
        style={style}
        fragmentCitationMap={fragmentCitationMap}
      />,
    );
  }

  // #245 — citation numbering is document-wide, not per-section. Walk
  // the sections in render order and thread a running offset into each
  // `<WikiCitations>`. The offset advances by the number of citations
  // in each section so a fragment cited in section A as `[3]` and in
  // section B is `[N]` where N continues from A's last index.
  let citationOffset = 0;
  for (const section of parsed) {
    // H1 would span EOF and swallow every subsequent section's body,
    // double-rendering all H2+ content. See module docstring above.
    if (section.level === 1) continue;

    const matched = citationsByAnchor.get(section.anchor);
    const citations = matched?.citations ?? [];
    const sectionStart = citationOffset + 1;
    citationOffset += citations.length;

    const canExtractHeading =
      section.level >= 2 && section.level <= 4 && onEditSection !== undefined;

    if (canExtractHeading) {
      const bodyEnd = effectiveBodyEndLine(section, parsed);
      const bodyOnly = lines
        .slice(section.startLine + 1, bodyEnd + 1)
        .join("\n");
      blocks.push(
        <div key={section.anchor} id={section.anchor}>
          <SectionHeadingWithEdit
            section={section}
            onEdit={onEditSection}
            showEditLink={true}
          />
          {bodyOnly.trim().length > 0 && (
            <MarkdownContent content={bodyOnly} refs={refs} style={style} fragmentCitationMap={fragmentCitationMap} />
          )}
          {citations.length > 0 && (
            <WikiCitations citations={citations} startIndex={sectionStart} />
          )}
        </div>,
      );
      continue;
    }

    const bodyEnd = effectiveBodyEndLine(section, parsed);
    const body = lines.slice(section.startLine, bodyEnd + 1).join("\n");
    blocks.push(
      <div key={section.anchor} id={section.anchor}>
        <MarkdownContent content={body} refs={refs} style={style} fragmentCitationMap={fragmentCitationMap} />
        {citations.length > 0 && (
          <WikiCitations citations={citations} startIndex={sectionStart} />
        )}
      </div>,
    );
  }

  return <>{blocks}</>;
}
