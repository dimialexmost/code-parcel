import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { constants as fsConstants } from 'fs';
import * as path from 'path';
import { CodeParcelConfig, createDefaultConfig, RECURSIVE_EXCLUSION_MIGRATIONS, deriveDefaultOutputFilename, parseCodeParcelConfig, validateOutputDirectory } from './config';
import { CODE_PARCEL_CONFIG_PATH, getWorkspaceRelativeOutputPath, isDefaultExcluded, isKnownBinaryFilePath, isMandatoryExcludedPath, normalizeOutputDirectory, normalizeRelativePath, resolveOutputDirectory, resolveWithinRoot, validateOutputFilename } from './utils';

export class SelectionStore {
    private config: CodeParcelConfig;
    private loaded = false;
    private initialPersistencePending = false;
    private loadError: Error | undefined;
    private persistedContent: string | null = null;
    private persistenceQueue: Promise<void> = Promise.resolve();
    private readonly configPath: string;

    constructor(private readonly workspaceRoot: string) {
        this.config = createDefaultConfig(workspaceRoot);
        this.configPath = resolveWithinRoot(workspaceRoot, CODE_PARCEL_CONFIG_PATH);
    }

    async load(): Promise<CodeParcelConfig> {
        return this.withPersistenceLock(() => this.loadUnlocked());
    }

    private async loadUnlocked(): Promise<CodeParcelConfig> {
        let raw: string;
        try {
            raw = await fs.readFile(this.configPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.loadError = error instanceof Error ? error : new Error(String(error));
                throw error;
            }
            const existingWorkspaceId = this.loaded ? this.config.workspaceId : undefined;
            this.config = createDefaultConfig(this.workspaceRoot);
            if (existingWorkspaceId) this.config.workspaceId = existingWorkspaceId;
            this.persistedContent = null;
            this.initialPersistencePending = true;
            this.loadError = undefined;
            this.loaded = true;
            return this.config;
        }
        // Parse before changing in-memory state; malformed files are preserved untouched.
        let parsed: CodeParcelConfig;
        try {
            parsed = parseCodeParcelConfig(JSON.parse(raw) as unknown);
        } catch (error) {
            this.loadError = error instanceof Error ? error : new Error(String(error));
            throw error;
        }
        const normalizedOverrides = Object.create(null) as Record<string, boolean>;
        for (const [key, value] of Object.entries(parsed.selectionOverrides)) {
            normalizedOverrides[normalizeRelativePath(key)] = value;
        }
        parsed.selectionOverrides = normalizedOverrides;
        const needsWorkspaceIdMigration = !parsed.workspaceId;
        if (needsWorkspaceIdMigration) parsed.workspaceId = legacyWorkspaceId(this.workspaceRoot);
        const portableOutputDirectory = normalizeOutputDirectory(this.workspaceRoot, parsed.outputDirectory);
        const needsOutputDirectoryMigration = portableOutputDirectory !== parsed.outputDirectory;
        if (needsOutputDirectoryMigration) parsed.outputDirectory = portableOutputDirectory;
        const needsLegacyMigration = parsed.outputFile === 'project-snapshot.md';
        const needsSnapshotExclusionMigration = !parsed.excludedPaths.includes('*-output.md');
        const missingRecursiveExclusions = RECURSIVE_EXCLUSION_MIGRATIONS
            .filter(([legacy]) => parsed.excludedPaths.includes(legacy))
            .map(([, recursive]) => recursive)
            .filter(pattern => !parsed.excludedPaths.includes(pattern));
        const needsRecursiveExclusionMigration = missingRecursiveExclusions.length > 0;
        if (needsRecursiveExclusionMigration) parsed.excludedPaths = [...parsed.excludedPaths, ...missingRecursiveExclusions];
        if (needsLegacyMigration) {
            parsed.outputFile = deriveDefaultOutputFilename(this.workspaceRoot);
        }
        if (needsSnapshotExclusionMigration) {
            // Preserve all saved exclusions and explicit selections while applying the newer
            // default for snapshots created before this pattern was introduced.
            parsed.excludedPaths = [...parsed.excludedPaths, '*-output.md'];
        }
        const needsConfigurationMigration = needsLegacyMigration || needsSnapshotExclusionMigration ||
            needsRecursiveExclusionMigration || needsWorkspaceIdMigration || needsOutputDirectoryMigration;
        if (needsConfigurationMigration) {
            try {
                await this.persistConfig(parsed, raw);
                this.persistedContent = `${JSON.stringify(parsed, null, 2)}\n`;
            } catch (error) {
                if (!needsLegacyMigration && !needsWorkspaceIdMigration) {
                    // The runtime still gets the safer default, while a read-only or externally
                    // changed configuration remains untouched and can be migrated later.
                    this.persistedContent = raw;
                } else {
                    this.loadError = error instanceof Error ? error : new Error(String(error));
                    throw new Error(`Could not safely update the Code Parcel configuration: ${this.loadError.message}`);
                }
            }
        }
        this.config = parsed;
        this.initialPersistencePending = false;
        if (!needsConfigurationMigration) this.persistedContent = raw;
        this.loadError = undefined;
        this.loaded = true;
        return this.config;
    }

    async save(): Promise<void> {
        await this.withPersistenceLock(async () => {
            this.ensureWritable();
            await this.persistConfig(this.config, this.persistedContent);
            this.persistedContent = `${JSON.stringify(this.config, null, 2)}\n`;
            this.initialPersistencePending = false;
        });
    }

    async ensureWorkspaceIdentityPersisted(): Promise<void> {
        await this.withPersistenceLock(async () => {
            this.ensureWritable();
            if (!this.initialPersistencePending) return;
            await this.persistConfig(this.config, null);
            this.persistedContent = `${JSON.stringify(this.config, null, 2)}\n`;
            this.initialPersistencePending = false;
        });
    }

    isIncluded(relativePath: string, isDirectory = false): boolean {
        this.ensureConfigUsable();
        if (!isDirectory && isKnownBinaryFilePath(relativePath)) return false;
        return isIncludedInConfig(this.config, relativePath, isDirectory, this.getWorkspaceRelativeOutputPath());
    }

    shouldScanDirectory(relativePath: string): boolean {
        this.ensureConfigUsable();
        const normalized = normalizeRelativePath(relativePath);
        const outputPath = this.getWorkspaceRelativeOutputPath();
        if (isMandatoryExcludedPath(normalized, outputPath)) return false;
        if (this.isIncluded(normalized, true)) return true;
        const prefix = `${normalized}/`;
        return Object.keys(this.config.selectionOverrides).some(candidate =>
            candidate.startsWith(prefix) && !isMandatoryExcludedPath(candidate, outputPath) &&
            this.isIncluded(candidate)
        );
    }

    async setIncluded(relativePath: string, included: boolean, isDirectory = false): Promise<void> {
        await this.withPersistenceLock(async () => {
            this.ensureWritable();
            const normalized = normalizeRelativePath(relativePath);
            resolveWithinRoot(this.workspaceRoot, normalized);
            if (!normalized || isMandatoryExcludedPath(normalized, this.getWorkspaceRelativeOutputPath())) {
                throw new Error('This path is always excluded from snapshots.');
            }
            if (!isDirectory && isKnownBinaryFilePath(normalized)) {
                if (included) throw new Error('Known binary files cannot be included in Markdown snapshots.');
                return;
            }

            const proposed = cloneConfig(this.config);
            const overrides = proposed.selectionOverrides;
            for (const key of Object.keys(overrides)) {
                if (key.startsWith(`${normalized}/`)) delete overrides[key];
            }
            if (isDirectory) {
                // Keep explicit folder choices even when they match the folder's current effective state;
                // this lets the choice override default exclusions for descendants.
                overrides[normalized] = included;
            } else {
                delete overrides[normalized];
                if (included !== isIncludedInConfig(proposed, normalized, false, this.getWorkspaceRelativeOutputPath())) overrides[normalized] = included;
            }

            if (JSON.stringify(proposed.selectionOverrides) === JSON.stringify(this.config.selectionOverrides)) return;
            await this.persistConfig(proposed, this.persistedContent);
            this.config = proposed;
            this.persistedContent = `${JSON.stringify(proposed, null, 2)}\n`;
            this.initialPersistencePending = false;
        });
    }

    getConfig(): CodeParcelConfig {
        this.ensureConfigUsable();
        return this.config;
    }

    getWorkspaceRelativeOutputPath(): string | undefined {
        this.ensureLoaded();
        return getWorkspaceRelativeOutputPath(this.workspaceRoot, this.config.outputFile, this.config.outputDirectory);
    }

    async setOutputSettings(outputFile: string, outputDirectory: string | null): Promise<void> {
        await this.withPersistenceLock(async () => {
            this.ensureWritable();
            validateOutputFilename(outputFile);
            if (!/-output\.md$/i.test(outputFile)) {
                throw new Error('New snapshot filenames must end in -output.md.');
            }
            validateOutputDirectory(outputDirectory);
            const proposed = cloneConfig(this.config);
            proposed.outputFile = outputFile;
            proposed.outputDirectory = normalizeOutputDirectory(this.workspaceRoot, outputDirectory);
            if (proposed.outputFile === this.config.outputFile && proposed.outputDirectory === this.config.outputDirectory &&
                !this.initialPersistencePending) return;

            const destination = resolveOutputDirectory(this.workspaceRoot, proposed.outputDirectory);
            let stat: Awaited<ReturnType<typeof fs.stat>>;
            try {
                stat = await fs.stat(destination);
            } catch (error) {
                throw new Error(`The configured snapshot folder is unavailable: ${destination} (${errorMessage(error)}).`);
            }
            if (!stat.isDirectory()) throw new Error(`The configured snapshot destination is not a folder: ${destination}`);
            try {
                await fs.access(destination, fsConstants.W_OK);
            } catch (error) {
                throw new Error(`The configured snapshot folder is not writable: ${destination} (${errorMessage(error)}).`);
            }

            await this.persistConfig(proposed, this.persistedContent);
            this.config = proposed;
            this.persistedContent = `${JSON.stringify(proposed, null, 2)}\n`;
            this.initialPersistencePending = false;
        });
    }

    hasLoadError(): boolean {
        return this.loadError !== undefined;
    }

    private ensureLoaded(): void {
        if (!this.loaded) throw new Error('SelectionStore.load() must complete before use.');
    }

    private ensureWritable(): void {
        this.ensureLoaded();
        if (this.loadError) throw new Error(`Cannot save while the configuration file is invalid: ${this.loadError.message}`);
    }

    private ensureConfigUsable(): void {
        this.ensureLoaded();
        if (this.loadError) {
            throw new Error(`Code Parcel generation is paused until the configuration file is corrected and reloaded: ${this.loadError.message}`);
        }
    }

    private async persistConfig(config: CodeParcelConfig, expectedCurrentContent?: string | null): Promise<void> {
        const content = `${JSON.stringify(config, null, 2)}\n`;
        await fs.mkdir(path.dirname(this.configPath), { recursive: true });
        if (expectedCurrentContent !== undefined) await this.assertPersistedContent(expectedCurrentContent);
        try {
            if (await fs.readFile(this.configPath, 'utf8') === content) return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }

        const temporaryPath = `${this.configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
            if (expectedCurrentContent !== undefined) await this.assertPersistedContent(expectedCurrentContent);
            await fs.rename(temporaryPath, this.configPath);
        } catch (error) {
            try { await fs.unlink(temporaryPath); } catch { /* Best-effort cleanup after failed persistence. */ }
            throw error;
        }
    }

    private async assertPersistedContent(expected: string | null): Promise<void> {
        let current: string | null;
        try {
            current = await fs.readFile(this.configPath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') current = null;
            else throw new Error(`Could not verify the current Code Parcel configuration: ${errorMessage(error)}`);
        }
        if (current !== expected) {
            throw new Error('Configuration changed outside Code Parcel; the current file was preserved. Reload the configuration before saving.');
        }
    }

    private async withPersistenceLock<T>(operation: () => Promise<T>): Promise<T> {
        const previous = this.persistenceQueue;
        let release!: () => void;
        this.persistenceQueue = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }
}

function cloneConfig(config: CodeParcelConfig): CodeParcelConfig {
    return {
        ...config,
        excludedPaths: [...config.excludedPaths],
        selectionOverrides: Object.assign(Object.create(null), config.selectionOverrides)
    };
}

function isIncludedInConfig(config: CodeParcelConfig, relativePath: string, isDirectory: boolean, outputPath?: string): boolean {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized || isMandatoryExcludedPath(normalized, outputPath)) return false;
    if (!isDirectory && isKnownBinaryFilePath(normalized)) return false;
    const segments = normalized.split('/');
    for (let index = segments.length; index >= 1; index--) {
        const ancestor = segments.slice(0, index).join('/');
        if (Object.prototype.hasOwnProperty.call(config.selectionOverrides, ancestor)) {
            return config.selectionOverrides[ancestor];
        }
    }
    return !isDefaultExcluded(normalized, isDirectory, config.excludedPaths);
}

function legacyWorkspaceId(workspaceRoot: string): string {
    const normalized = path.resolve(workspaceRoot).replace(/\\/g, '/');
    const identity = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    return crypto.createHash('sha256').update(identity).digest('hex');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
