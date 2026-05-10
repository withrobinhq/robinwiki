"use client";

import styles from "../EgoGraphEditorial.module.css";

interface TopBarProps {
  focusTitle: string;
  /** Subtype slug, e.g. "belief". Pluralised + capitalised for the breadcrumb middle slot. */
  focusSubtype?: string;
}

const VIEW_OPTIONS: ReadonlyArray<{
  key: string;
  label: string;
  active: boolean;
}> = [
  { key: "list", label: "List", active: false },
  { key: "wiki", label: "Wiki", active: false },
  { key: "ego", label: "Ego graph", active: true },
];

function capitalisedPlural(subtype: string | undefined): string {
  if (!subtype) return "Wikis";
  const head = subtype.charAt(0).toUpperCase() + subtype.slice(1);
  // Naive English pluralisation. The subtype set is a closed list, so simple
  // suffix rules cover all current values without an external library.
  if (head.endsWith("s")) return `${head}es`;
  if (head.endsWith("y") && !/[aeiou]y$/i.test(head)) {
    return `${head.slice(0, -1)}ies`;
  }
  return `${head}s`;
}

export function TopBar({ focusTitle, focusSubtype }: TopBarProps) {
  const middle = capitalisedPlural(focusSubtype);

  return (
    <header className={styles.topbar}>
      <div className={styles.topbarL}>
        <a className={styles.topbarBrand} href="#" aria-label="Robin">
          <span className={styles.mark} aria-hidden="true">R</span>
          <span>Robin</span>
        </a>
        <div className={styles.topbarCrumb} aria-label="Breadcrumb">
          <span>Wiki</span>
          <span className={styles.sep} aria-hidden="true">/</span>
          <span>{middle}</span>
          <span className={styles.sep} aria-hidden="true">/</span>
          <span className={styles.here}>{focusTitle}</span>
        </div>
      </div>
      <div className={styles.topbarR}>
        <div
          className={styles.topbarSeg}
          role="group"
          aria-label="View mode"
        >
          {VIEW_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              className={opt.active ? styles.isActive : ""}
              aria-pressed={opt.active}
              disabled={!opt.active}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button type="button" className={styles.topbarBtn}>
          <span>Export</span>
        </button>
        <button type="button" className={styles.topbarBtn}>
          <span>Search</span>
          <span className={styles.kbd}>⌘ K</span>
        </button>
      </div>
    </header>
  );
}
