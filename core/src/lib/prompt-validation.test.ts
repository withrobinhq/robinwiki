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

describe('validatePromptYaml — forbidden field gate', () => {
  it('rejects YAML with system_message and surfaces FORBIDDEN_FIELD', () => {
    const yaml = `${baseYaml}\nsystem_message: "evil prompt override"`
    const result = validatePromptYaml(yaml)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.status).toBe(400)
    expect(result.body.code).toBe('FORBIDDEN_FIELD')
    const detail = result.body.detail as { fields: string[] } | undefined
    expect(detail?.fields).toContain('system_message')
  })

  it('rejects YAML with system_only and surfaces FORBIDDEN_FIELD', () => {
    const yaml = `${baseYaml}\nsystem_message: hello\nsystem_only: true`
    const result = validatePromptYaml(yaml)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.body.code).toBe('FORBIDDEN_FIELD')
    const detail = result.body.detail as { fields: string[] } | undefined
    expect(detail?.fields).toContain('system_only')
  })

  it('accepts YAML that omits both forbidden fields', () => {
    const result = validatePromptYaml(baseYaml)
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
