/**
 * Topological sort for workflow phase DAG execution.
 *
 * Groups phases into execution levels where all phases in a level
 * have their dependencies satisfied by phases in earlier levels.
 * Phases within the same level are independent and can run in parallel.
 */

import { ConfigurationError } from '../errors/index.js';

interface HasDependencies {
  id: string;
  depends_on?: string[];
}

/**
 * Group phases into topological execution levels.
 *
 * Level 0 contains phases with no dependencies (root set).
 * Level N contains phases whose dependencies are all in levels 0..N-1.
 * Phases within the same level are independent by construction.
 *
 * @throws Error if the dependency graph contains a cycle
 * @throws Error if a dependency references a non-existent phase
 */
export function topoGroupLevels<T extends HasDependencies>(phases: T[]): T[][] {
  if (phases.length === 0) return [];

  const phaseMap = new Map<string, T>();
  for (const phase of phases) {
    phaseMap.set(phase.id, phase);
  }

  // Validate all dependencies reference existing phases
  for (const phase of phases) {
    for (const dep of phase.depends_on ?? []) {
      if (!phaseMap.has(dep)) {
        throw new ConfigurationError(
          `Phase "${phase.id}" depends on "${dep}" which does not exist. ` +
          `Available phases: ${[...phaseMap.keys()].join(', ')}`,
        );
      }
    }
  }

  const levels: T[][] = [];
  const placed = new Set<string>();

  while (placed.size < phases.length) {
    const level: T[] = [];

    for (const phase of phases) {
      if (placed.has(phase.id)) continue;

      const deps = phase.depends_on ?? [];
      const allDepsSatisfied = deps.every(dep => placed.has(dep));

      if (allDepsSatisfied) {
        level.push(phase);
      }
    }

    if (level.length === 0) {
      // No progress possible — cycle detected
      const remaining = phases
        .filter(p => !placed.has(p.id))
        .map(p => p.id);
      throw new ConfigurationError(
        `Cycle detected in phase dependencies: ${remaining.join(', ')}. ` +
        `Check depends_on fields for circular references.`,
      );
    }

    for (const phase of level) {
      placed.add(phase.id);
    }
    levels.push(level);
  }

  return levels;
}
