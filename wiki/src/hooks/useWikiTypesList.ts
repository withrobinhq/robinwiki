"use client";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

export interface InputVariable {
  name: string;
  description: string;
  required: boolean;
}

export interface WikiTypeListItem {
  slug: string;
  displayLabel: string;
  displayDescription: string;
  displayShortDescriptor: string;
  displayOrder: number;
  promptYaml: string;
  defaultYaml: string;
  /**
   * The type's `default_structure` block extracted from its YAML spec.
   * Used as the placeholder for the Document Format field in the
   * AddWiki settings modal so users see what their override would
   * replace.
   */
  defaultStructure: string;
  /**
   * The type's `system_message` block extracted from its YAML spec.
   * Used as the placeholder for the Wiki Style field, which overrides
   * `wikis.prompt` (the system_message swap at regen time).
   */
  defaultSystemMessage: string;
  userModified: boolean;
  basedOnVersion: number;
  inputVariables: InputVariable[];
}

export interface WikiTypesListResponse {
  wikiTypes: WikiTypeListItem[];
}

export const WIKI_TYPES_LIST_KEY = ["wikiTypes", "v2"] as const;

export function useWikiTypesList(): UseQueryResult<WikiTypesListResponse> {
  return useQuery<WikiTypesListResponse>({
    queryKey: WIKI_TYPES_LIST_KEY,
    queryFn: async () => {
      const res = await fetch("/api/wiki-types", { credentials: "include" });
      if (!res.ok) throw new Error(`GET /api/wiki-types failed: ${res.status}`);
      return (await res.json()) as WikiTypesListResponse;
    },
  });
}

/** Derive a single item from the list without a second round-trip. */
export function findWikiType(
  list: WikiTypesListResponse | undefined,
  slug: string,
): WikiTypeListItem | undefined {
  return list?.wikiTypes.find((t) => t.slug === slug);
}
