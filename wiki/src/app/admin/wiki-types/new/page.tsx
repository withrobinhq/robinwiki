"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { T, FONT } from "@/lib/typography";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Toast } from "@/components/ui/toast";
import { SettingsShell } from "@/components/settings/SettingsShell";
import { useCreateWikiType } from "@/hooks/useCreateWikiType";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

interface FieldErrors {
  name?: string;
  slug?: string;
  shortDescriptor?: string;
  descriptor?: string;
  prompt?: string;
}

export default function NewWikiTypePage() {
  const router = useRouter();
  const createMutation = useCreateWikiType();

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [shortDescriptor, setShortDescriptor] = useState("");
  const [descriptor, setDescriptor] = useState("");
  const [defaultStructure, setDefaultStructure] = useState("");
  const [prompt, setPrompt] = useState("");

  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [toast, setToast] = useState<{ visible: boolean; message: string }>({
    visible: false,
    message: "",
  });

  const handleNameChange = useCallback(
    (value: string) => {
      setName(value);
      if (!slugTouched) {
        setSlug(slugify(value));
      }
    },
    [slugTouched],
  );

  const handleSlugChange = useCallback((value: string) => {
    setSlugTouched(true);
    setSlug(slugify(value));
  }, []);

  const validate = useCallback((): FieldErrors => {
    const errors: FieldErrors = {};
    if (!name.trim()) errors.name = "Name is required.";
    if (!slug.trim()) errors.slug = "Slug is required.";
    else if (!/^[a-z0-9-]+$/.test(slug))
      errors.slug = "Slug must be lowercase alphanumeric with hyphens.";
    if (!shortDescriptor.trim())
      errors.shortDescriptor = "Short descriptor is required.";
    if (!descriptor.trim()) errors.descriptor = "Description is required.";
    return errors;
  }, [name, slug, shortDescriptor, descriptor]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const errors = validate();
      setFieldErrors(errors);
      if (Object.keys(errors).length > 0) return;

      createMutation.mutate(
        {
          name: name.trim(),
          slug: slug.trim(),
          shortDescriptor: shortDescriptor.trim(),
          descriptor: descriptor.trim(),
          prompt: prompt.trim(),
        },
        {
          onSuccess: () => {
            router.push("/admin/wiki-types");
          },
          onError: (err) => {
            const message = err instanceof Error ? err.message : "Creation failed";
            if (message.includes("already exists")) {
              setFieldErrors((prev) => ({
                ...prev,
                slug: message,
              }));
            } else {
              setToast({ visible: true, message });
            }
          },
        },
      );
    },
    [name, slug, shortDescriptor, descriptor, prompt, validate, createMutation, router],
  );

  return (
    <SettingsShell
      title="Create Wiki Type"
      subtitle="Define a new wiki type for classification and generation."
    >
      <form
        onSubmit={handleSubmit}
        style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 560 }}
      >
        <FormField label="Name" error={fieldErrors.name} required>
          <Input
            value={name}
            onChange={(e) => handleNameChange(e.target.value)}
            placeholder="e.g. Research Note"
            aria-invalid={!!fieldErrors.name}
            autoFocus
          />
        </FormField>

        <FormField
          label="Slug"
          error={fieldErrors.slug}
          hint="Auto-derived from name. Lowercase alphanumeric and hyphens only."
          required
        >
          <Input
            value={slug}
            onChange={(e) => handleSlugChange(e.target.value)}
            placeholder="e.g. research-note"
            aria-invalid={!!fieldErrors.slug}
            style={{ fontFamily: FONT.MONO }}
          />
        </FormField>

        <FormField
          label="Short descriptor"
          error={fieldErrors.shortDescriptor}
          hint="One-line summary the classifier reads when routing fragments."
          required
        >
          <Input
            value={shortDescriptor}
            onChange={(e) => setShortDescriptor(e.target.value)}
            placeholder="e.g. Captures research findings and source material"
            aria-invalid={!!fieldErrors.shortDescriptor}
          />
        </FormField>

        <FormField
          label="Description"
          error={fieldErrors.descriptor}
          hint="Longer explanation of when and how this type is used."
          required
        >
          <Textarea
            value={descriptor}
            onChange={(e) => setDescriptor(e.target.value)}
            placeholder="Describe the purpose, scope, and typical content for this wiki type."
            rows={3}
            aria-invalid={!!fieldErrors.descriptor}
          />
        </FormField>

        <FormField
          label="Default structure"
          hint="Prose template for the wiki body structure. Optional."
        >
          <Textarea
            value={defaultStructure}
            onChange={(e) => setDefaultStructure(e.target.value)}
            placeholder={"## Summary\n## Key Findings\n## Sources"}
            rows={4}
          />
        </FormField>

        <FormField
          label="Prompt YAML body"
          error={fieldErrors.prompt}
          hint="The full prompt YAML that Quill uses for this type. Leave blank for no custom prompt."
        >
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={"version: 1\nsystem_message: |\n  You are a wiki writer..."}
            rows={8}
            style={{ fontFamily: FONT.MONO, fontSize: 13, lineHeight: "1.5" }}
          />
        </FormField>

        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <Button type="submit" disabled={createMutation.isPending}>
            {createMutation.isPending && <Spinner className="size-3.5" />}
            Create wiki type
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => router.push("/admin/wiki-types")}
          >
            Cancel
          </Button>
        </div>
      </form>

      <Toast
        message={toast.message}
        visible={toast.visible}
        onDismiss={() => setToast({ visible: false, message: "" })}
        duration={4000}
      />
    </SettingsShell>
  );
}

function FormField({
  label,
  error,
  hint,
  required,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Label>
        {label}
        {required && (
          <span style={{ color: "var(--destructive)", marginLeft: 2 }} aria-hidden>
            *
          </span>
        )}
      </Label>
      {children}
      {hint && !error && (
        <p style={{ ...T.micro, color: "var(--heading-secondary)", margin: 0 }}>
          {hint}
        </p>
      )}
      {error && (
        <p
          role="alert"
          style={{ ...T.micro, color: "var(--destructive)", margin: 0 }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
