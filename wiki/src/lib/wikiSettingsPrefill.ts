export type WikiSettingsPrefill = {
  name?: string;
  wikiType?: string;
  folder?: string;
  description?: string;
  regenAuto?: boolean;
  gatekeep?: boolean;
  /** Modal subtitle under the title */
  subtitle?: string;
  /** Per-wiki prompt override (empty string = "no override", undefined = unseeded) */
  promptOverride?: string;
  /** Current bouncer mode: 'auto' or 'review' */
  bouncerMode?: 'auto' | 'review';
  /** Current publish state — drives the publish toggle in settings (#255) */
  published?: boolean;
  /** Public published-wiki nanoid slug (when published) */
  publishedSlug?: string | null;
  /** Current collection memberships — feeds the Collections section in the modal. */
  collections?: Array<{ id: string; name: string; slug: string; color: string }>;
};

/** Placeholder — callers may supply a real description in the future. */
const WIKI_INTRO_LEAD_PLAINTEXT = "";

/**
 * Maps UI chip labels to <select> option values in AddWikiModal.
 * Must cover every WikiType so that opening settings from any wiki pre-fills
 * the Type field correctly.
 */
const CHIP_LABEL_TO_WIKI_TYPE: Record<string, string> = {
  Log: "log",
  Research: "research",
  Belief: "belief",
  Decision: "decision",
  Project: "project",
  Objective: "objective",
  Principles: "principles",
  Skill: "skill",
  Agent: "agent",
  Voice: "voice",
  People: "people",
  Person: "people",
};

function wikiTypeSelectValueForChip(chipLabel: string): string {
  return CHIP_LABEL_TO_WIKI_TYPE[chipLabel.trim()] ?? "";
}

export function wikiEntitySettingsPrefill(input: {
  title: string;
  chipLabel: string;
  description?: string;
  promptOverride?: string;
}): WikiSettingsPrefill {
  return {
    name: input.title,
    wikiType: wikiTypeSelectValueForChip(input.chipLabel),
    folder: "default",
    description: input.description ?? WIKI_INTRO_LEAD_PLAINTEXT,
    subtitle: `${input.chipLabel} wiki — update name, type, and visibility`,
    promptOverride: input.promptOverride,
  };
}
