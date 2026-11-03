import * as crypto from 'crypto';
import * as path from 'path';
import { validateOutputFilename } from './utils';

export interface CodeParcelConfig {
    version: number;
    workspaceId: string;
    autoGenerateOnSave: boolean;
    outputFile: string;
    outputDirectory: string | null;
    maxFileSizeBytes: number;
    excludedPaths: string[];
    selectionOverrides: Record<string, boolean>;
}

const DEFAULT_MAX_FILE_SIZE_BYTES = 1048576;
export const RECURSIVE_EXCLUSION_MIGRATIONS: Array<[string, string]> = [
    ['node_modules/**', '**/node_modules/**'], ['vendor/**', '**/vendor/**'], ['dist/**', '**/dist/**'],
    ['build/**', '**/build/**'], ['coverage/**', '**/coverage/**'], ['.venv/**', '**/.venv/**'],
    ['__pycache__/**', '**/__pycache__/**']
];
export const DEFAULT_RECURSIVE_EXCLUDED_PATHS = RECURSIVE_EXCLUSION_MIGRATIONS.map(([, recursive]) => recursive);
const DEFAULT_EXCLUDED_PATHS = [
    ...DEFAULT_RECURSIVE_EXCLUDED_PATHS,
    '**/logs/**', '**/log/**', '.env', '.env.*', '*.log', '*.map', '*.min.js', '*.min.css',
    '*.pem', '*.key', '*.p12', '*.pfx', '*-output.md'
];

export function createDefaultConfig(workspaceRoot: string): CodeParcelConfig {
    return {
        version: 1,
        workspaceId: crypto.randomUUID(),
        autoGenerateOnSave: true,
        outputFile: deriveDefaultOutputFilename(workspaceRoot),
        outputDirectory: null,
        maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
        excludedPaths: [...DEFAULT_EXCLUDED_PATHS],
        selectionOverrides: Object.create(null) as Record<string, boolean>
    };
}

/** Derive and validate a Windows-safe default filename from the actual folder name. */
export function deriveDefaultOutputFilename(workspaceRoot: string): string {
    const folderName = path.basename(path.resolve(workspaceRoot));
    let safeName = folderName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/g, '');
    if (!safeName || safeName === '.' || safeName === '..') safeName = 'project';

    const suffix = '-output.md';
    const maxFilenameLength = 240;
    const maxPrefixLength = maxFilenameLength - suffix.length;
    if (safeName.length > maxPrefixLength || Buffer.byteLength(safeName, 'utf8') > maxPrefixLength) {
        const hash = crypto.createHash('sha256').update(safeName).digest('hex').slice(0, 8);
        const shorteningSuffix = `-${hash}`;
        const prefixLimit = maxPrefixLength - shorteningSuffix.length;
        safeName = `${truncateUtf16(safeName, prefixLimit, prefixLimit)}${shorteningSuffix}`;
    }
    const filename = `${safeName}${suffix}`;
    validateOutputFilename(filename);
    return filename;
}

function truncateUtf16(value: string, maximumLength: number, maximumBytes: number): string {
    let output = '';
    let byteLength = 0;
    for (const character of value) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (output.length + character.length > maximumLength || byteLength + characterBytes > maximumBytes) break;
        output += character;
        byteLength += characterBytes;
    }
    return output;
}

export function parseCodeParcelConfig(value: unknown): CodeParcelConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Configuration must be a JSON object.');
    }
    const source = value as Record<string, unknown>;
    if (source.version !== 1 || typeof source.autoGenerateOnSave !== 'boolean' ||
        typeof source.outputFile !== 'string' || !Array.isArray(source.excludedPaths) ||
        !source.excludedPaths.every(item => typeof item === 'string') ||
        !source.selectionOverrides || typeof source.selectionOverrides !== 'object' ||
        Array.isArray(source.selectionOverrides)) {
        throw new Error('Configuration has an invalid or unsupported shape.');
    }
    const workspaceId = source.workspaceId === undefined ? '' : source.workspaceId;
    if (typeof workspaceId !== 'string' || (workspaceId !== '' && !isWorkspaceId(workspaceId))) {
        throw new Error('workspaceId must be a valid Code Parcel workspace identifier.');
    }
    const maxFileSizeBytes = source.maxFileSizeBytes === undefined ? DEFAULT_MAX_FILE_SIZE_BYTES : source.maxFileSizeBytes;
    if (typeof maxFileSizeBytes !== 'number' || !Number.isSafeInteger(maxFileSizeBytes) || maxFileSizeBytes <= 0) {
        throw new Error('maxFileSizeBytes must be a positive, finite, safe integer.');
    }
    validateOutputFilename(source.outputFile);
    const outputDirectory = source.outputDirectory === undefined ? null : source.outputDirectory;
    validateOutputDirectory(outputDirectory);
    const overrides = Object.create(null) as Record<string, boolean>;
    for (const [key, included] of Object.entries(source.selectionOverrides as Record<string, unknown>)) {
        if (typeof included !== 'boolean') throw new Error(`Invalid selection override for "${key}".`);
        if (isUnsafeConfigPath(key)) throw new Error(`Selection override path must be workspace-relative: "${key}".`);
        overrides[key] = included;
    }
    if (isUnsafeConfigPath(source.outputFile) || source.excludedPaths.some(item => isUnsafeConfigPath(item))) {
        throw new Error('Configuration paths must be workspace-relative.');
    }
    return {
        version: 1,
        workspaceId,
        autoGenerateOnSave: source.autoGenerateOnSave,
        outputFile: source.outputFile,
        outputDirectory,
        maxFileSizeBytes,
        excludedPaths: [...source.excludedPaths] as string[],
        selectionOverrides: overrides
    };
}

export function validateOutputDirectory(outputDirectory: unknown): asserts outputDirectory is string | null {
    if (outputDirectory === null) return;
    if (typeof outputDirectory !== 'string' || !outputDirectory || outputDirectory.includes('\0')) {
        throw new Error('outputDirectory must be null, a workspace-relative path, or an absolute directory path.');
    }
    if (!path.isAbsolute(outputDirectory)) {
        const normalized = outputDirectory.replace(/\\/g, '/');
        if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/') || normalized.split('/').some(segment => segment === '..')) {
            throw new Error('A relative outputDirectory must stay inside the workspace.');
        }
    }
}

function isWorkspaceId(value: string): boolean {
    return /^[a-f0-9]{64}$/i.test(value) ||
        /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function isUnsafeConfigPath(value: string): boolean {
    const normalized = value.replace(/\\/g, '/');
    return normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ||
        normalized.split('/').some(segment => segment === '..');
}
