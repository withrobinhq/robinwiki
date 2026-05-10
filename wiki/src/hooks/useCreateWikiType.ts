"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createWikiType } from "@/lib/api";
import { WIKI_TYPES_LIST_KEY } from "./useWikiTypesList";

export interface CreateWikiTypeInput {
  slug: string;
  name: string;
  shortDescriptor: string;
  descriptor: string;
  prompt: string;
}

export function useCreateWikiType() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: CreateWikiTypeInput) => {
      const { data, error } = await createWikiType({
        body: input,
      });
      if (error) {
        const message =
          typeof error === "object" && error !== null && "error" in error
            ? (error as { error: string }).error
            : "Failed to create wiki type";
        throw new Error(message);
      }
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...WIKI_TYPES_LIST_KEY] });
    },
  });
}
