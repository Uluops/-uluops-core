/**
 * Symbol extraction from source files.
 * Extracts exported/private functions, classes, interfaces, types, constants.
 */

export interface SymbolInfo {
  type: string;
  name: string;
  line: number;
  exported: boolean;
  signature?: string;
}

export function extractSymbols(lines: string[], ext: string, includePrivate: boolean): SymbolInfo[] {
  const symbols: SymbolInfo[] = [];
  const isTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext);
  const isPython = ext === '.py';

  if (isTS) {
    extractTSSymbols(lines, symbols);
  } else if (isPython) {
    extractPythonSymbols(lines, symbols);
  }

  if (!includePrivate) {
    return symbols.filter((s) => s.exported);
  }
  return symbols;
}

function extractTSSymbols(lines: string[], symbols: SymbolInfo[]): void {
  const patterns: Array<{ regex: RegExp; type: string }> = [
    { regex: /^export\s+(async\s+)?function\s+(\w+)/, type: 'function' },
    { regex: /^export\s+class\s+(\w+)/, type: 'class' },
    { regex: /^export\s+interface\s+(\w+)/, type: 'interface' },
    { regex: /^export\s+type\s+(\w+)/, type: 'type' },
    { regex: /^export\s+(?:const|let|var)\s+(\w+)/, type: 'const' },
    { regex: /^export\s+enum\s+(\w+)/, type: 'enum' },
    { regex: /^export\s+default\s+(?:class|function)\s*(\w*)/, type: 'default' },
    // Non-exported
    { regex: /^(?:async\s+)?function\s+(\w+)/, type: 'function' },
    { regex: /^class\s+(\w+)/, type: 'class' },
    { regex: /^interface\s+(\w+)/, type: 'interface' },
    { regex: /^type\s+(\w+)/, type: 'type' },
    { regex: /^(?:const|let|var)\s+(\w+)/, type: 'const' },
    { regex: /^enum\s+(\w+)/, type: 'enum' },
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    for (const p of patterns) {
      const match = p.regex.exec(line);
      if (match) {
        const exported = line.startsWith('export');
        // For function patterns with async, name is in group 2 for exported, else group 1
        let name: string;
        if (p.type === 'function' && exported) {
          name = match[2] ?? match[1] ?? '';
        } else {
          name = match[1] ?? '';
        }
        if (!name) continue;

        // Build signature for functions
        let signature: string | undefined;
        if (p.type === 'function') {
          // Capture up to closing paren and return type
          const sigMatch = /function\s+\w+\s*(\([^)]*\)(?:\s*:\s*\S+)?)/.exec(line);
          if (sigMatch) {
            signature = `${name}${sigMatch[1]}`;
          }
        }

        symbols.push({
          type: p.type,
          name,
          line: i + 1,
          exported,
          ...(signature ? { signature } : {}),
        });
        break; // Only match first pattern per line
      }
    }
  }
}

function extractPythonSymbols(lines: string[], symbols: SymbolInfo[]): void {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Top-level functions (no indentation)
    const funcMatch = /^(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/.exec(line);
    if (funcMatch) {
      const name = funcMatch[2]!;
      symbols.push({
        type: 'function',
        name,
        line: i + 1,
        exported: !name.startsWith('_'),
        signature: `${name}(${funcMatch[3]})`,
      });
      continue;
    }

    // Top-level classes (no indentation)
    const classMatch = /^class\s+(\w+)/.exec(line);
    if (classMatch) {
      const className = classMatch[1] ?? '';
      symbols.push({
        type: 'class',
        name: className,
        line: i + 1,
        exported: !className.startsWith('_'),
      });
    }
  }
}
