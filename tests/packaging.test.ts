// Invariant: the Claude Code plugin manifest points at its MCP server
// config under `mcpServers`, the key Claude Code actually reads. An
// `mcp` key is an unknown field that Claude Code ignores at load time
// (`claude plugin validate` warns "Unknown field 'mcp'"); it only ever
// worked here because ./.mcp.json is the default location anyway.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const plugin = JSON.parse(
  readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
) as Record<string, unknown>;

describe('plugin.json', () => {
  it('declares its MCP config under `mcpServers`, not the ignored `mcp` key', () => {
    expect(plugin).not.toHaveProperty('mcp');
    expect(plugin.mcpServers).toBe('./.mcp.json');
  });

  it('points `mcpServers` at a file that exists', () => {
    expect(typeof plugin.mcpServers).toBe('string');
    expect(existsSync(join(ROOT, plugin.mcpServers as string))).toBe(true);
  });
});
