"use client";

import WikiHomeHero from "@/components/wiki/WikiHomeHero";
import { CollectionsHome } from "@/components/wiki/CollectionsHome";

export default function WikiArticlePage() {
  return (
    <div className="wiki-page wiki-page--home">
      <WikiHomeHero />

      {/* Figma 217:35526 — 104px gap below hero (y 203 → 307) */}
      <div
        className="wiki-cards-container wiki-home-cards wiki-page__content wiki-page__content--centered"
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 24,
        }}
      >
        <CollectionsHome />
      </div>
    </div>
  );
}
