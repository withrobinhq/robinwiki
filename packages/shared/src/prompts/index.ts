// Core infrastructure
export { PromptSpecSchema } from './schema.js'
export type { PromptSpec } from './schema.js'
export type { PromptResult } from './types.js'
export {
  loadSpec,
  renderTemplate,
  parseSpecFromBlob,
  parseUserSpecFromBlobStrict,
  parseUserSpecFromBlobLenient,
  renderPromptSpec,
  escapeHandlebarsDelimiters,
  USER_OVERRIDE_FORBIDDEN_FIELDS,
} from './loader.js'
export type { RenderWarning, RenderResult, RenderTemplateOptions } from './loader.js'
export { loadWikiTypePreviewFixture } from './fixtures/loader.js'
export type { PromptPreviewVars } from './fixtures/loader.js'

// Model constants (stay in code per CONTEXT.md decision)
export * from './models.js'

// Schemas
export { fragmentationSchema } from './specs/fragmentation.schema.js'
export type { FragmentationOutput } from './specs/fragmentation.schema.js'
export {
  peopleExtractionSchema,
  normalisePeopleExtraction,
} from './specs/people-extraction.schema.js'
export type {
  PeopleExtractionOutput,
  MatchedMention,
  CandidateMention,
  LegacyMention,
} from './specs/people-extraction.schema.js'
export { wikiClassificationSchema, citationSpanSchema } from './specs/wiki-classification.schema.js'
export type {
  WikiClassificationOutput,
  CitationSpan,
} from './specs/wiki-classification.schema.js'
export { wikiRelevanceSchema } from './specs/wiki-relevance.schema.js'
export type { WikiRelevanceOutput } from './specs/wiki-relevance.schema.js'
export { fragmentRelevanceSchema } from './specs/fragment-relevance.schema.js'
export type { FragmentRelevanceOutput } from './specs/fragment-relevance.schema.js'

// Loader functions — standalone
export * from './loaders/wiki-classification.js'
export * from './loaders/people-extraction.js'
export * from './loaders/fragmentation.js'
export * from './loaders/wiki-relevance.js'
export * from './loaders/fragment-relevance.js'

// Loader functions — parameterized
export {
  loadWikiGenerationSpec,
  renderFragmentsBlock,
  renderPeopleBlock,
} from './loaders/wiki-generation.js'
export type {
  WikiGenerationOverride,
  WikiFragmentInput,
  WikiPersonInput,
} from './loaders/wiki-generation.js'
export { loadPersonSummarySpec } from './loaders/person-summary.js'
export { personSummaryInputSchema } from './specs/person-summary/person-summary.schema.js'

// Wiki type configs
export { loadWikiTypeConfigs } from './loaders/wiki-type-configs.js'
export type { WikiTypeConfig } from './loaders/wiki-type-configs.js'
