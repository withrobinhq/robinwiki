import { cn } from "@/lib/utils"

interface WikiChipProps {
  label: string
  href?: string
  className?: string
  /**
   * Underlying ref kind ("person" | "wiki" | "entry"). Combined with
   * `tokenSlug`, renders `data-token-kind` and `data-token-slug` so the
   * Edit-tab DOM extraction can round-trip the chip back to its
   * `[[kind:slug]]` text token instead of destroying it. Required for
   * any chip emitted from a `[[kind:slug]]` source so the round-trip
   * survives a manual edit + save.
   */
  tokenKind?: string
  tokenSlug?: string
}

function WikiChip({ label, href, className, tokenKind, tokenSlug }: WikiChipProps) {
  const classes = cn("wchip", className)
  const tokenAttrs =
    tokenKind && tokenSlug
      ? { "data-token-kind": tokenKind, "data-token-slug": tokenSlug }
      : undefined

  if (href) {
    return (
      <a data-slot="wiki-chip" href={href} className={classes} {...tokenAttrs}>
        {label}
      </a>
    )
  }

  return (
    <span data-slot="wiki-chip" className={classes} {...tokenAttrs}>
      {label}
    </span>
  )
}

export { WikiChip, type WikiChipProps }
