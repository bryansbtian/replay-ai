import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

import {
  ArtifactValidationError,
  CapabilityNotFoundError,
  FileArtifactStore,
  InvalidCapabilityIdError,
  parseCapabilityArtifact,
  serializeCapabilityArtifact,
  type CapabilityArtifact,
} from '../../src/artifacts/index.js';

import { minimalArtifact, validArtifact } from './support/artifacts.js';

/**
 * Every case runs against a fresh temporary directory, so the suite never writes into
 * the repository's own `capabilities/` directory, which holds committed deliverables.
 * The directories are left for the operating system to reclaim, which also makes a
 * failed run inspectable.
 */
describe('FileArtifactStore', () => {
  let directory: string;
  let store: FileArtifactStore;
  let artifact: CapabilityArtifact;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'replay-ai-artifacts-'));
    store = new FileArtifactStore({ directory });
    artifact = parseCapabilityArtifact(validArtifact());
  });

  it('saves an artifact as readable JSON named after its id', async () => {
    const path = await store.save(artifact);

    expect(path).toBe(join(directory, 'lookup-demo-customer.json'));
    expect(await readFile(path, 'utf8')).toBe(serializeCapabilityArtifact(artifact));
  });

  it('creates the directory when it does not exist yet', async () => {
    const nested = new FileArtifactStore({ directory: join(directory, 'nested', 'capabilities') });

    const path = await nested.save(artifact);

    expect(await readFile(path, 'utf8')).toContain('"id": "lookup-demo-customer"');
  });

  it('loads back exactly what was saved', async () => {
    await store.save(artifact);

    expect(await store.load('lookup-demo-customer')).toEqual(artifact);
  });

  it('reports a missing capability by id', async () => {
    await expect(store.load('lookup-demo-customer')).rejects.toThrow(CapabilityNotFoundError);
  });

  it('lists a summary of each stored artifact, ordered by id', async () => {
    await store.save(artifact);
    await store.save(
      parseCapabilityArtifact(
        minimalArtifact({ id: 'add-demo-product', name: 'Add Demo Product' }),
      ),
    );

    expect(await store.list()).toEqual([
      {
        id: 'add-demo-product',
        name: 'Add Demo Product',
        description: artifact.description,
        version: 1,
      },
      {
        id: 'lookup-demo-customer',
        name: 'Lookup Demo Customer',
        description: artifact.description,
        version: 1,
      },
    ]);
  });

  it('lists nothing when the directory has not been created yet', async () => {
    const missing = new FileArtifactStore({ directory: join(directory, 'absent') });

    expect(await missing.list()).toEqual([]);
  });

  it('ignores files that are not artifacts and subdirectories such as examples', async () => {
    await store.save(artifact);
    await writeFile(join(directory, 'README.md'), '# Capabilities\n', 'utf8');

    expect(await store.list()).toHaveLength(1);
  });

  it('fails safely on a file that is not JSON', async () => {
    await writeFile(join(directory, 'lookup-demo-customer.json'), '{ oops', 'utf8');

    await expect(store.load('lookup-demo-customer')).rejects.toThrow(ArtifactValidationError);
    await expect(store.load('lookup-demo-customer')).rejects.toThrow(/is not valid JSON/);
  });

  it('fails safely on JSON that is not a valid artifact', async () => {
    await writeFile(
      join(directory, 'lookup-demo-customer.json'),
      JSON.stringify({ schemaVersion: '1', id: 'lookup-demo-customer' }),
      'utf8',
    );

    await expect(store.load('lookup-demo-customer')).rejects.toThrow(ArtifactValidationError);
  });

  it('fails when a file name and the id inside it disagree', async () => {
    await writeFile(
      join(directory, 'renamed-capability.json'),
      serializeCapabilityArtifact(artifact),
      'utf8',
    );

    await expect(store.load('renamed-capability')).rejects.toThrow(/does not match the file name/);
  });

  it('surfaces an invalid stored file when listing rather than skipping it', async () => {
    await store.save(artifact);
    await writeFile(join(directory, 'broken.json'), '{ "schemaVersion": "9" }', 'utf8');

    await expect(store.list()).rejects.toThrow(ArtifactValidationError);
  });

  it.each([
    '../escape',
    '/etc/passwd',
    'nested/capability',
    '..',
    'Lookup-Demo-Customer',
    'lookup demo customer',
  ])('refuses to build a path from the unsafe id %s', async (id) => {
    await expect(store.load(id)).rejects.toThrow(InvalidCapabilityIdError);
  });

  it('refuses to save an artifact whose id could not name a file', async () => {
    const unsafe = { ...artifact, id: '../escape' };

    await expect(store.save(unsafe)).rejects.toThrow(ArtifactValidationError);
  });
});
