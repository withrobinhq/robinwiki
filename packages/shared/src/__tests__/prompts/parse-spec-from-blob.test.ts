import { YAMLException } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import {
  USER_OVERRIDE_FORBIDDEN_FIELDS,
  parseSpecFromBlob,
  parseUserSpecFromBlobLenient,
  parseUserSpecFromBlobStrict,
} from '../../prompts/index'

// Minimal valid spec YAML. Every required field of PromptSpecSchema is present.
const validYaml = `
name: TestSpec
version: 1
category: generation
task: test
description: test spec
temperature: 0.3
system_message: hello
template: hi {{name}}
input_variables:
  - name: name
    description: test var
    required: true
`

// Spec YAML WITHOUT system_message — used by user-override tests so a
// `system_message:` line can be added without producing a duplicate-key
// YAMLException at parse time.
const validYamlNoSystemMessage = `
name: TestSpec
version: 1
category: generation
task: test
description: test spec
temperature: 0.3
template: hi {{name}}
input_variables:
  - name: name
    description: test var
    required: true
`

describe('parseSpecFromBlob', () => {
  it('returns a valid PromptSpec for a well-formed YAML string', () => {
    const spec = parseSpecFromBlob(validYaml)
    expect(spec.name).toBe('TestSpec')
    expect(spec.version).toBe(1)
    expect(spec.category).toBe('generation')
    expect(spec.task).toBe('test')
    expect(spec.temperature).toBe(0.3)
    expect(spec.system_message).toBe('hello')
    expect(spec.template).toBe('hi {{name}}')
    expect(spec.input_variables).toHaveLength(1)
    expect(spec.input_variables[0]).toEqual({
      name: 'name',
      description: 'test var',
      required: true,
    })
  })

  it('throws YAMLException on malformed YAML syntax', () => {
    // Unclosed flow-sequence bracket → YAMLException
    const malformed = 'name: TestSpec\nversion: [unclosed'
    expect(() => parseSpecFromBlob(malformed)).toThrow(YAMLException)
  })

  it('throws ZodError when YAML parses but fails schema validation', () => {
    // Omit required system_message field
    const invalidSchema = `
name: TestSpec
version: 1
category: generation
task: test
description: test spec
temperature: 0.3
template: hi {{name}}
input_variables:
  - name: name
    description: test var
    required: true
`
    expect(() => parseSpecFromBlob(invalidSchema)).toThrow(ZodError)
  })

  it('does not cache — two calls with different YAML return different specs', () => {
    const otherYaml = validYaml.replace('name: TestSpec', 'name: OtherSpec')
    const specA = parseSpecFromBlob(validYaml)
    const specB = parseSpecFromBlob(otherYaml)
    expect(specA.name).toBe('TestSpec')
    expect(specB.name).toBe('OtherSpec')
  })

  it('does not cache — two calls with identical YAML both succeed independently', () => {
    const specA = parseSpecFromBlob(validYaml)
    const specB = parseSpecFromBlob(validYaml)
    // No identity assumption — just that both parse cleanly.
    expect(specA.name).toBe('TestSpec')
    expect(specB.name).toBe('TestSpec')
  })

  it('defaults system_only to false when the YAML does not include it', () => {
    const spec = parseSpecFromBlob(validYaml)
    expect(spec.system_only).toBe(false)
  })
})

describe('parseUserSpecFromBlobStrict', () => {
  it('accepts YAML that omits forbidden fields and returns a valid spec', () => {
    const spec = parseUserSpecFromBlobStrict(validYamlNoSystemMessage)
    expect(spec.name).toBe('TestSpec')
    expect(spec.template).toBe('hi {{name}}')
  })

  it('rejects YAML containing top-level system_message with a ZodError', () => {
    const withSystemMessage = `${validYamlNoSystemMessage}\nsystem_message: "evil prompt override"`
    let caught: unknown
    try {
      parseUserSpecFromBlobStrict(withSystemMessage)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ZodError)
    const flat = (caught as ZodError).flatten()
    expect(flat.fieldErrors).toHaveProperty('system_message')
  })

  it('rejects YAML containing top-level system_only: true with a ZodError', () => {
    const withSystemOnly = `${validYamlNoSystemMessage}\nsystem_message: hello\nsystem_only: true`
    let caught: unknown
    try {
      parseUserSpecFromBlobStrict(withSystemOnly)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ZodError)
    const flat = (caught as ZodError).flatten()
    expect(flat.fieldErrors).toHaveProperty('system_only')
  })

  it('rejects non-mapping YAML root with a YAMLException-shaped error', () => {
    expect(() => parseUserSpecFromBlobStrict('- a\n- b\n')).toThrow(
      expect.objectContaining({ name: 'YAMLException' }) as never
    )
  })

  it('exports the forbidden-field list', () => {
    expect(USER_OVERRIDE_FORBIDDEN_FIELDS).toEqual(['system_message', 'system_only'])
  })
})

describe('parseUserSpecFromBlobLenient', () => {
  it('returns stripped: [] for clean override', () => {
    const result = parseUserSpecFromBlobLenient(validYamlNoSystemMessage)
    expect(result.stripped).toEqual([])
    expect(result.spec.name).toBe('TestSpec')
  })

  it('strips system_message, reports it in stripped[], and parses', () => {
    const withSystemMessage = `${validYamlNoSystemMessage}\nsystem_message: "evil prompt override"`
    const result = parseUserSpecFromBlobLenient(withSystemMessage)
    expect(result.stripped).toContain('system_message')
    // The placeholder backfill is an internal detail — the caller MUST
    // overwrite system_message with the disk spec value. Verify the user's
    // attempted override is not present.
    expect(result.spec.system_message).not.toBe('evil prompt override')
  })

  it('strips system_only and reports it in stripped[]', () => {
    const withSystemOnly = `${validYaml}\nsystem_only: true`
    const result = parseUserSpecFromBlobLenient(withSystemOnly)
    expect(result.stripped).toContain('system_only')
    expect(result.spec.system_only).toBe(false)
  })

  it('strips both forbidden fields when both are present', () => {
    const both = `${validYamlNoSystemMessage}\nsystem_message: "evil"\nsystem_only: true`
    const result = parseUserSpecFromBlobLenient(both)
    expect(result.stripped).toEqual(expect.arrayContaining(['system_message', 'system_only']))
  })

  it('does not throw on forbidden fields, only on yaml-parse errors', () => {
    expect(() => parseUserSpecFromBlobLenient('name: [unclosed')).toThrow()
  })

  it('rejects non-mapping YAML root with a YAMLException-shaped error', () => {
    expect(() => parseUserSpecFromBlobLenient('- a\n- b\n')).toThrow(
      expect.objectContaining({ name: 'YAMLException' }) as never
    )
  })

  it('throws ZodError when the remaining fields fail PromptSpec validation', () => {
    // YAML missing required `template` field — lenient parser surfaces it.
    const incomplete = `name: Bad
version: 1
category: generation
task: t
description: d
temperature: 0.3
input_variables: []
`
    expect(() => parseUserSpecFromBlobLenient(incomplete)).toThrow(ZodError)
  })
})
