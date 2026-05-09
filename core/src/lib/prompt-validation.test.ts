import { describe, expect, it } from 'vitest'
import { validatePromptYaml } from './prompt-validation.js'

const baseYaml = `
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

describe('validatePromptYaml reserved field stripping', () => {
  it('accepts YAML with system_message and strips it (warning, not error)', () => {
    const yaml = `${baseYaml}\nsystem_message: "user override attempt"`
    const result = validatePromptYaml(yaml)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.some((w) => w.includes('system_message'))).toBe(true)
    // The user's override value must not survive on the parsed spec, since
    // the runtime loader sources system_message from the canonical disk YAML.
    expect(result.spec.system_message).not.toBe('user override attempt')
  })

  it('accepts YAML with system_only and strips it (warning, not error)', () => {
    const yaml = `${baseYaml}\nsystem_message: hello\nsystem_only: true`
    const result = validatePromptYaml(yaml)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.warnings.some((w) => w.includes('system_only'))).toBe(true)
    expect(result.spec.system_only).toBe(false)
  })

  it('accepts YAML carrying system_message (round-tripped from disk default)', () => {
    const yaml = `${baseYaml}\nsystem_message: "the canonical disk value"`
    const result = validatePromptYaml(yaml)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spec.name).toBe('TestSpec')
  })

  it('still returns YAML_PARSE_ERROR for malformed YAML', () => {
    const result = validatePromptYaml('name: [unclosed')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.body.code).toBe('YAML_PARSE_ERROR')
  })
})
