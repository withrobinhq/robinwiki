import { redirect } from "next/navigation";

// Stream U: /settings entry point. The Airbnb-style shell defaults to
// the Wikis panel, matching the operator's most common need (per-wiki
// autoregen toggle).
export default function SettingsIndexPage() {
  redirect("/settings/wikis");
}
