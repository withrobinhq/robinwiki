"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

import { T } from "@/lib/typography";
import { useProfile } from "@/hooks/useProfile";
import { ActionButton } from "@/components/ui/action-button";
import { Spinner } from "@/components/ui/spinner";
import { Card, CardContent } from "@/components/ui/card";

function Logo() {
  return (
    <svg
      width="27"
      height="27"
      viewBox="0 0 27 27"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d="M9.13646 11.1135L11.4799 13.4569L11.4869 13.45L13.121 15.084L13.1279 15.091L15.5145 17.4775C17.7112 19.6742 21.2727 19.6742 23.4694 17.4775C25.6662 15.2808 25.6662 11.7193 23.4694 9.52255C21.2727 7.32584 17.7112 7.32584 15.5145 9.52255L14.7119 10.3251L16.3029 11.9161L17.1055 11.1135C18.4234 9.79552 20.5604 9.79552 21.8784 11.1135C23.1965 12.4316 23.1965 14.5684 21.8784 15.8865C20.5604 17.2045 18.4234 17.2045 17.1055 15.8865L14.7741 13.5553L14.7671 13.5623L10.7274 9.52255C8.53075 7.32584 4.9692 7.32584 2.7725 9.52255C0.575797 11.7193 0.575797 15.2808 2.7725 17.4775C4.9692 19.6742 8.53075 19.6742 10.7274 17.4775L11.5299 16.675L9.93893 15.084L9.13646 15.8865C7.81844 17.2045 5.6815 17.2045 4.36349 15.8865C3.04547 14.5684 3.04547 12.4316 4.36349 11.1135C5.6815 9.79552 7.81844 9.79552 9.13646 11.1135Z"
        fill="var(--logo-color)"
      />
    </svg>
  );
}

export default function CompleteStep() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: profile, isLoading: profileLoading } = useProfile();
  const [copied, setCopied] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const mcpEndpoint = profile?.mcpEndpointUrl ?? "";

  // Poll for MCP endpoint until it becomes available (keypair may still be generating)
  useEffect(() => {
    if (mcpEndpoint || profileLoading) return
    const interval = setInterval(() => {
      queryClient.invalidateQueries({ queryKey: ['profile'] })
    }, 2000)
    return () => clearInterval(interval)
  }, [mcpEndpoint, profileLoading, queryClient])

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(mcpEndpoint);
    } catch {
      // clipboard may be unavailable (insecure context / iframe); still show feedback
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col items-center" style={{ width: 320 }}>
      <Logo />

      <h1
        className="whitespace-nowrap"
        style={{
          marginTop: 12,
          ...T.h1,
          color: "var(--heading-color)",
        }}
      >
        You are all set
      </h1>

      <p
        className="text-center"
        style={{
          marginTop: 12,
          ...T.bodySmall,
          width: 245,
          color: "var(--body-text)",
        }}
      >
        Your second brain is ready. Connect it to your tools with MCP.
      </p>

      {/* MCP ENDPOINT CARD */}
      <Card size="sm" className="w-full rounded-none" style={{ marginTop: 50 }}>
        <CardContent className="flex flex-col" style={{ gap: 6 }}>
          <span
            style={{
              ...T.cardTitle,
              color: "var(--mcp-endpoint-label)",
            }}
          >
            MCP Endpoint
          </span>

          <div className="flex items-start" style={{ gap: 6 }}>
            <div
              className="flex flex-1 items-center rounded-[4px]"
              style={{
                height: 32,
                padding: "0 10px",
                backgroundColor: "var(--mcp-input-bg)",
              }}
            >
              <span
                className="truncate"
                style={{
                  ...T.helper,
                  color: "var(--card-desc)",
                }}
              >
                {profileLoading
                  ? "Loading..."
                  : mcpEndpoint || (
                    <span className="inline-flex items-center gap-1.5">
                      <Spinner className="size-3" />
                      Generating your MCP endpoint...
                    </span>
                  )}
              </span>
            </div>
            <button
              onClick={handleCopy}
              className="flex shrink-0 cursor-pointer items-center justify-center rounded-[4px] transition-opacity hover:opacity-80"
              style={{
                width: 35,
                height: 32,
                backgroundColor: "var(--mcp-copy-bg)",
              }}
              aria-label="Copy endpoint"
            >
              {copied ? (
                <Check size={14} strokeWidth={2} style={{ color: "var(--card-desc)" }} />
              ) : (
                <Copy size={14} strokeWidth={2} style={{ color: "var(--card-desc)" }} />
              )}
            </button>
          </div>

          <span
            style={{
              ...T.micro,
              color: "var(--card-desc)",
            }}
          >
            Add fragments yourself through the UI. Paste notes, write thoughts,
            log decisions.
          </span>
        </CardContent>
      </Card>

      {/* QUICK SETUP CARD */}
      <Card size="sm" className="w-full rounded-none" style={{ marginTop: 12 }}>
        <CardContent className="flex flex-col" style={{ gap: 6 }}>
          <span
            style={{
              ...T.cardTitle,
              color: "var(--mcp-endpoint-label)",
            }}
          >
            Quick setup
          </span>

          {[1, 2, 3].map((num) => (
            <div
              key={num}
              className="flex items-start"
              style={{
                gap: 6,
              }}
            >
              <span
                className="shrink-0 whitespace-nowrap"
                style={{
                  ...T.micro,
                  color: "var(--setup-number)",
                }}
              >
                {num}
              </span>
              <span
                className="flex-1"
                style={{
                  ...T.micro,
                  color: "var(--setup-text)",
                }}
              >
                Add fragments yourself through the UI. Paste notes, write
                thoughts, log decisions.
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      {validateError && (
        <p
          className="text-center"
          style={{
            ...T.micro,
            marginTop: 16,
            color: "var(--destructive)",
            maxWidth: 320,
          }}
        >
          {validateError}
        </p>
      )}

      {/* GO TO WIKI BUTTON */}
      <ActionButton
        type="button"
        onClick={async () => {
          setCompleting(true);
          setValidateError(null);
          try {
            // Gate completion on a real OpenRouter API check so a typo'd
            // or revoked key surfaces here rather than silently breaking
            // the user's first ingest.
            const res = await fetch("/api/users/openrouter-key/validate", {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            });
            const result = (await res.json().catch(() => null)) as
              | { ok?: boolean; error?: string }
              | null;
            if (!result?.ok) {
              setValidateError(
                result?.error ??
                  "Could not validate your OpenRouter API key. Check OPENROUTER_API_KEY and try again.",
              );
              setCompleting(false);
              return;
            }
            await fetch("/api/users/onboard", {
              method: "PATCH",
              credentials: "include",
            });
            await queryClient.invalidateQueries({ queryKey: ["profile"] });
          } catch {
            setValidateError(
              "Could not reach the server to validate your key. Try again.",
            );
            setCompleting(false);
            return;
          }
          router.push("/wiki");
        }}
        disabled={completing}
        className="mt-10"
      >
        {completing ? "Validating..." : "Go to your wiki"}
      </ActionButton>
    </div>
  );
}
