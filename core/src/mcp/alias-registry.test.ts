import { describe, it, expect, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod/v4'
import {
  registerAliases,
  registerAliasTool,
  type AliasRow,
  type CanonicalToolCallback,
} from './alias-registry.js'

/**
 * Stream I Phases 5+6 -- alias resolver smoke tests. These run with
 * the real MCP SDK (no DB), exercise the registration path, and assert
 * the alias surfaces in the McpServer's internal tool registry.
 */

function buildServer() {
  const server = new McpServer({ name: 'test', version: '0' })
  const calls = new Map<string, unknown>()

  // Register a canonical `log_entry` tool for the alias to point at.
  const canonical: CanonicalToolCallback = async (args, extra) => {
    calls.set('log_entry', { args, extra })
    return { content: [{ type: 'text' as const, text: 'OK' }] }
  }
  server.registerTool(
    'log_entry',
    {
      description: 'canonical',
      inputSchema: { content: z.string() },
    },
    canonical
  )

  // Build canonicals map the registry consumes.
  const canonicals = new Map<string, CanonicalToolCallback>([
    ['log_entry', canonical],
  ])

  return { server, canonicals, calls }
}

describe('alias-registry — registerAliasTool', () => {
  it('surfaces the alias name in the MCP tool registry', () => {
    const { server, canonicals } = buildServer()
    const alias: AliasRow = {
      pack: 'capture',
      aliasName: 'short-capture',
      mcpToolName: 'log_entry',
      argsTemplate: { source: 'mcp' },
    }
    const ok = registerAliasTool(server, alias, canonicals)
    expect(ok).toBe(true)

    const registered = (server as unknown as {
      _registeredTools?: Record<string, unknown>
    })._registeredTools
    expect(registered).toBeDefined()
    expect(registered!['short-capture']).toBeDefined()
    expect(registered!['log_entry']).toBeDefined()
  })

  it('drops aliases pointing at unknown canonical tools and returns false', () => {
    const { server, canonicals } = buildServer()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const alias: AliasRow = {
      pack: 'mystery',
      aliasName: 'oops',
      mcpToolName: 'does_not_exist',
      argsTemplate: null,
    }
    const ok = registerAliasTool(server, alias, canonicals)
    expect(ok).toBe(false)
    const registered = (server as unknown as {
      _registeredTools?: Record<string, unknown>
    })._registeredTools
    expect(registered!['oops']).toBeUndefined()
    warnSpy.mockRestore()
  })

  it('forwards calls to the canonical with argsTemplate merged below caller args', async () => {
    const { server, canonicals, calls } = buildServer()
    const alias: AliasRow = {
      pack: 'capture',
      aliasName: 'short-capture',
      mcpToolName: 'log_entry',
      argsTemplate: { source: 'mcp', tag: 'pack-default' },
    }
    registerAliasTool(server, alias, canonicals)

    const aliasTool = (server as unknown as {
      _registeredTools?: Record<
        string,
        { handler: (args: unknown, extra: unknown) => Promise<unknown> }
      >
    })._registeredTools!['short-capture']
    expect(aliasTool).toBeDefined()

    await aliasTool.handler(
      { args: { content: 'hello world', tag: 'caller-wins' } },
      { authInfo: { clientId: 'u1' } }
    )
    const captured = calls.get('log_entry') as
      | { args: Record<string, unknown> }
      | undefined
    expect(captured?.args).toEqual({
      source: 'mcp',
      tag: 'caller-wins',
      content: 'hello world',
    })
  })
})

describe('alias-registry — registerAliases (batch)', () => {
  it('returns the count of aliases that successfully landed', () => {
    const { server, canonicals } = buildServer()
    const rows: AliasRow[] = [
      {
        pack: 'capture',
        aliasName: 'short-capture',
        mcpToolName: 'log_entry',
        argsTemplate: null,
      },
      {
        pack: 'capture',
        aliasName: 'long-capture',
        mcpToolName: 'log_entry',
        argsTemplate: null,
      },
      {
        pack: 'broken',
        aliasName: 'goes-nowhere',
        mcpToolName: 'absent_tool',
        argsTemplate: null,
      },
    ]
    const landed = registerAliases(server, rows, canonicals)
    expect(landed).toBe(2)
  })
})
