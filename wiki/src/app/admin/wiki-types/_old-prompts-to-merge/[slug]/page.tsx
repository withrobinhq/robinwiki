"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AuthGuard } from "@/components/AuthGuard";
import { useWikiTypesList, findWikiType } from "@/hooks/useWikiTypesList";
import PromptEditor from "@/components/prompts/PromptEditor";
import PreviewPanel from "@/components/prompts/PreviewPanel";
import ConfirmDialog from "@/components/prompts/ConfirmDialog";
import { cn } from "@/lib/utils";

export default function PromptEditorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const router = useRouter();
  const wikiTypes = useWikiTypesList();
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pendingBack, setPendingBack] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [triggerToken, setTriggerToken] = useState(0);
  const [liveYaml, setLiveYaml] = useState("");

  const item = findWikiType(wikiTypes.data, slug);

  const goBack = () => router.push("/profile/prompts");

  const handleBack = () => {
    if (dirty) {
      setPendingBack(true);
      setDiscardOpen(true);
    } else {
      goBack();
    }
  };

  const handlePreview = () => {
    setPreviewOpen(true);
    setTriggerToken((t) => t + 1);
  };

  if (wikiTypes.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Spinner className="size-5" />
      </div>
    );
  }
  if (!item) {
    return (
      <div className="min-h-screen bg-background p-10">
        <Button
          onClick={goBack}
          variant="ghost"
          size="sm"
          className="gap-1.5"
        >
          <ArrowLeft className="size-4" />
          Back
        </Button>
        <p className="mt-6 text-sm text-destructive">
          {`No wiki type with slug "${slug}".`}
        </p>
      </div>
    );
  }

  return (
    <AuthGuard>
    <div className="min-h-screen bg-background text-foreground">
      <div
        className={cn(
          "mx-auto px-10 pt-12 pb-20",
          previewOpen ? "max-w-[1440px]" : "max-w-[920px]",
        )}
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleBack}
          className="mb-4 -ml-2 h-auto gap-1.5 px-2 text-muted-foreground"
        >
          <ArrowLeft className="size-4" strokeWidth={1.5} />
          Back to prompts
        </Button>

        <div
          className={cn(
            "grid gap-6",
            previewOpen
              ? "grid-cols-1 lg:grid-cols-[minmax(0,1fr)_480px]"
              : "grid-cols-1",
          )}
        >
          <div className="min-w-0">
            <PromptEditor
              slug={item.slug}
              displayLabel={item.displayLabel}
              initialYaml={item.promptYaml}
              defaultYaml={item.defaultYaml}
              inputVariables={item.inputVariables}
              basedOnVersion={item.basedOnVersion}
              userModified={item.userModified}
              onSaved={() => setDirty(false)}
              onDirtyChange={(d) => setDirty(d)}
              onYamlChange={setLiveYaml}
              footerActions={
                <Button
                  type="button"
                  variant="outline"
                  onClick={handlePreview}
                >
                  Preview
                </Button>
              }
            />
          </div>
          {previewOpen ? (
            <PreviewPanel
              slug={item.slug}
              draftYaml={liveYaml}
              triggerToken={triggerToken}
              onClose={() => setPreviewOpen(false)}
            />
          ) : null}
        </div>

        <ConfirmDialog
          open={discardOpen}
          onOpenChange={(o) => {
            setDiscardOpen(o);
            if (!o) setPendingBack(false);
          }}
          title="Discard unsaved changes?"
          description="Your edits have not been saved. They will be lost if you navigate away."
          confirmLabel="Discard"
          destructive
          onConfirm={() => {
            if (pendingBack) goBack();
          }}
        />
      </div>
    </div>
    </AuthGuard>
  );
}
