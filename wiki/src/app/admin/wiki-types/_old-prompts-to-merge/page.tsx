"use client";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AuthGuard } from "@/components/AuthGuard";
import { useWikiTypesList } from "@/hooks/useWikiTypesList";
import PromptCardGrid from "@/components/prompts/PromptCardGrid";

export default function PromptsListPage() {
  const router = useRouter();
  const wikiTypes = useWikiTypesList();

  return (
    <AuthGuard>
    <div className="min-h-screen overflow-y-auto bg-background text-foreground">
      <div className="mx-auto max-w-[780px] px-10 pt-12 pb-20">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => router.push("/profile")}
          className="mb-6 -ml-2 h-auto gap-1.5 px-2 text-muted-foreground"
        >
          <ArrowLeft className="size-4" strokeWidth={1.5} />
          Back to profile
        </Button>

        <h1 className="font-heading text-3xl font-semibold text-foreground">
          Prompts
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Customize how each wiki type structures your knowledge.
        </p>

        <section className="mt-8">
          {wikiTypes.isLoading ? (
            <div className="flex justify-center py-16">
              <Spinner className="size-5" />
            </div>
          ) : wikiTypes.isError ? (
            <p className="text-sm text-destructive">
              Failed to load wiki types.
            </p>
          ) : (
            <PromptCardGrid items={wikiTypes.data?.wikiTypes ?? []} />
          )}
        </section>
      </div>
    </div>
    </AuthGuard>
  );
}
