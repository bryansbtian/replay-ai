import type { CapabilityArtifact } from './artifact.js';
import type { ArtifactIssue } from './errors.js';
import type { CapabilityStep } from './steps.js';

/**
 * The rules a schema cannot express, because they are about relationships between parts
 * of one artifact rather than the shape of any single part.
 *
 * Each rule is here for the same reason: without it the artifact is accepted now and
 * fails during a replay, in front of the application, where a defect is expensive to
 * diagnose. A reference to an input that was never declared is not a runtime surprise,
 * it is a document that contradicts itself, and it should be rejected while a person is
 * still looking at it.
 *
 * Kept to a flat list of checks over a parsed artifact on purpose. This is a handful of
 * relationships, not a language that needs a compiler.
 */

function duplicateIssues(
  values: readonly string[],
  path: (index: number) => string,
  describe: (value: string) => string,
): ArtifactIssue[] {
  const seen = new Set<string>();
  const issues: ArtifactIssue[] = [];
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) {
      issues.push({ path: path(index), message: describe(value) });
      continue;
    }
    seen.add(value);
  }
  return issues;
}

/** Input names a step reads, with the path of the reference that reads them. */
function inputReferences(steps: readonly CapabilityStep[]): { name: string; path: string }[] {
  const references: { name: string; path: string }[] = [];
  for (const [index, step] of steps.entries()) {
    if (step.type !== 'fill') {
      continue;
    }
    if (step.value.source !== 'input') {
      continue;
    }
    references.push({ name: step.value.name, path: `steps[${index}].value.name` });
  }
  return references;
}

/** Output names an extract step writes, with the path of the step that writes them. */
function outputAssignments(steps: readonly CapabilityStep[]): { name: string; path: string }[] {
  const assignments: { name: string; path: string }[] = [];
  for (const [index, step] of steps.entries()) {
    if (step.type !== 'extract') {
      continue;
    }
    assignments.push({ name: step.output, path: `steps[${index}].output` });
  }
  return assignments;
}

function uniquenessIssues(artifact: CapabilityArtifact): ArtifactIssue[] {
  return [
    ...duplicateIssues(
      artifact.steps.map((step) => step.id),
      (index) => `steps[${index}].id`,
      (value) => `duplicate step id "${value}"`,
    ),
    ...duplicateIssues(
      artifact.inputs.map((input) => input.name),
      (index) => `inputs[${index}].name`,
      (value) => `duplicate input name "${value}"`,
    ),
    ...duplicateIssues(
      artifact.outputs.map((output) => output.name),
      (index) => `outputs[${index}].name`,
      (value) => `duplicate output name "${value}"`,
    ),
    ...duplicateIssues(
      artifact.businessOutcomes.map((outcome) => outcome.code),
      (index) => `businessOutcomes[${index}].code`,
      (value) => `duplicate business outcome code "${value}"`,
    ),
  ];
}

function referenceIssues(artifact: CapabilityArtifact): ArtifactIssue[] {
  const issues: ArtifactIssue[] = [];
  const declaredInputs = new Set(artifact.inputs.map((input) => input.name));
  const declaredOutputs = new Set(artifact.outputs.map((output) => output.name));

  const references = inputReferences(artifact.steps);
  for (const reference of references) {
    if (declaredInputs.has(reference.name)) {
      continue;
    }
    issues.push({
      path: reference.path,
      message: `no input named "${reference.name}" is declared by this capability`,
    });
  }

  const assignments = outputAssignments(artifact.steps);
  for (const assignment of assignments) {
    if (declaredOutputs.has(assignment.name)) {
      continue;
    }
    issues.push({
      path: assignment.path,
      message: `no output named "${assignment.name}" is declared by this capability`,
    });
  }

  // An input nothing reads and an output nothing writes are both promises the capability
  // cannot keep: a caller supplies a value that goes nowhere, or receives a field that is
  // never filled in. Both only show up at replay time, so they are rejected here.
  const readNames = new Set(references.map((reference) => reference.name));
  for (const [index, input] of artifact.inputs.entries()) {
    if (readNames.has(input.name)) {
      continue;
    }
    issues.push({
      path: `inputs[${index}].name`,
      message: `input "${input.name}" is declared but no step uses it`,
    });
  }

  const writtenNames = new Set(assignments.map((assignment) => assignment.name));
  for (const [index, output] of artifact.outputs.entries()) {
    if (writtenNames.has(output.name)) {
      continue;
    }
    issues.push({
      path: `outputs[${index}].name`,
      message: `output "${output.name}" is declared but no extract step produces it`,
    });
  }

  return issues;
}

function safetyIssues(artifact: CapabilityArtifact): ArtifactIssue[] {
  const issues: ArtifactIssue[] = [];
  for (const [index, step] of artifact.steps.entries()) {
    if (step.type === 'extract' || step.type === 'wait' || step.type === 'checkpoint') {
      continue;
    }
    if (step.risk !== 'irreversible') {
      continue;
    }
    if (step.execution?.retry === undefined) {
      continue;
    }
    // Retrying an irreversible step is how one payment becomes two. If a step like this
    // fails, the run escalates rather than trying again.
    issues.push({
      path: `steps[${index}].execution.retry`,
      message: 'an irreversible step must not declare a retry',
    });
  }
  return issues;
}

function metadataIssues(artifact: CapabilityArtifact): ArtifactIssue[] {
  const created = Date.parse(artifact.metadata.createdAt);
  const updated = Date.parse(artifact.metadata.updatedAt);
  if (updated >= created) {
    return [];
  }
  return [
    {
      path: 'metadata.updatedAt',
      message: 'must not be earlier than metadata.createdAt',
    },
  ];
}

/** Every semantic problem in a shape-valid artifact, in document order by rule group. */
export function collectSemanticIssues(artifact: CapabilityArtifact): ArtifactIssue[] {
  return [
    ...uniquenessIssues(artifact),
    ...referenceIssues(artifact),
    ...safetyIssues(artifact),
    ...metadataIssues(artifact),
  ];
}
