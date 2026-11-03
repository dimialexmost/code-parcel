import * as path from 'path';

export const CODE_PARCEL_CONFIG_PATH = '.vscode/code-parcel.json';
import { minimatch } from 'minimatch';

/** Normalize a user or filesystem path to a workspace-relative POSIX path. */
export function normalizeRelativePath(input: string): string {
    return input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

const KNOWN_BINARY_EXTENSIONS = new Set([
    '.vsix', '.zip', '.7z', '.rar', '.tar', '.gz',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
    '.pdf', '.exe', '.dll', '.so', '.dylib', '.wasm',
    '.class', '.jar', '.pyc',
    '.woff', '.woff2', '.ttf', '.otf',
    '.mp3', '.mp4', '.wav', '.ogg', '.mov', '.avi', '.webm',
    '.p12', '.pfx'
]);

export function isKnownBinaryFilePath(relativePath: string): boolean {
    const normalized = normalizeRelativePath(relativePath);
    return KNOWN_BINARY_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase());
}

/** Resolve a relative path and reject paths which escape the workspace. */
export function resolveWithinRoot(root: string, relativePath: string): string {
    const normalized = normalizeRelativePath(relativePath);
    if (path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
        throw new Error('Expected a workspace-relative path.');
    }
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(resolvedRoot, ...normalized.split('/').filter(Boolean));
    const relative = path.relative(resolvedRoot, resolvedPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error('Path escapes the workspace root.');
    }
    return resolvedPath;
}

/** Convert a filename prefix entered in the output settings UI into its final filename. */
export function normalizeOutputFilenamePrefix(value: string): string {
    let prefix = value.trim();
    if (/-output\.md$/i.test(prefix)) prefix = prefix.slice(0, -'-output.md'.length);
    else if (/-output$/i.test(prefix)) prefix = prefix.slice(0, -'-output'.length);
    if (!prefix) throw new Error('Enter a non-empty filename prefix, such as website-backend.');
    const filename = `${prefix}-output.md`;
    validateOutputFilename(filename);
    return filename;
}

/** Return the active output file as a workspace-relative path when it is inside the source root. */
export function getWorkspaceRelativeOutputPath(
    workspaceRoot: string,
    outputFile: string,
    outputDirectory: string | null
): string | undefined {
    const root = path.resolve(workspaceRoot);
    const destination = resolveOutputDirectory(root, outputDirectory);
    const outputPath = path.resolve(destination, outputFile);
    const relative = path.relative(root, outputPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
    return normalizeRelativePath(relative);
}

/** Resolve a configured output folder, allowing workspace-relative portable paths. */
export function resolveOutputDirectory(workspaceRoot: string, outputDirectory: string | null): string {
    return path.resolve(workspaceRoot, outputDirectory ?? '.');
}

/** Store folders inside the workspace as portable relative paths. */
export function normalizeOutputDirectory(workspaceRoot: string, outputDirectory: string | null): string | null {
    if (outputDirectory === null) return null;
    const root = path.resolve(workspaceRoot);
    const destination = path.resolve(root, outputDirectory);
    const relative = path.relative(root, destination);
    if (!relative) return null;
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
        return normalizeRelativePath(relative);
    }
    return destination;
}

export function isMandatoryExcludedPath(relativePath: string, outputFile?: string): boolean {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) return false;
    const comparablePath = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (comparablePath === '.vscode/code-parcel.json.tmp' ||
        /^\.vscode\/code-parcel\.json\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(comparablePath)) {
        return true;
    }

    const basename = comparablePath.slice(comparablePath.lastIndexOf('/') + 1);
    if (comparablePath.endsWith('.code-parcel.lock') ||
        comparablePath.endsWith('.code-parcel.lock.recovery') ||
        /^.+\.md\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/i.test(basename)) {
        return true;
    }

    if (!outputFile) return false;
    const activeOutput = normalizeRelativePath(outputFile);
    const comparableOutput = process.platform === 'win32' ? activeOutput.toLowerCase() : activeOutput;
    if (comparablePath === comparableOutput) return true;
    if (!comparablePath.startsWith(`${comparableOutput}.`)) return false;

    const artifactSuffix = comparablePath.slice(comparableOutput.length);
    return artifactSuffix === '.code-parcel.lock' ||
        artifactSuffix === '.code-parcel.lock.recovery' ||
        /^\.\d+\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/.test(artifactSuffix);
}

export function validateOutputFilename(filename: string): void {
    if (!filename || filename === '.' || filename === '..' || filename.includes('/') || filename.includes('\\') ||
        path.posix.isAbsolute(filename) || /^[A-Za-z]:/.test(filename)) {
        throw new Error('Output file must be a Markdown filename without a path.');
    }
    if (!filename.toLowerCase().endsWith('.md')) {
        throw new Error('Output filename must use the .md extension.');
    }
    if (/[<>:"|?*\x00-\x1f]/.test(filename) || /[. ]$/.test(filename) || filename.length > 240 ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(filename)) {
        throw new Error('Use a filename of 240 characters or fewer. Windows-reserved names, path separators, control characters, <>:"|?*, and trailing dots or spaces are not allowed.');
    }
    const reserved = new Set(['code-parcel.json', '.gitignore', '.editorconfig']);
    if (reserved.has(filename.toLowerCase())) throw new Error('Output filename is reserved for project configuration.');
}

export function isDefaultExcluded(relativePath: string, isDirectory: boolean, patterns: string[]): boolean {
    const normalized = normalizeRelativePath(relativePath);
    const segments = normalized.split('/').filter(Boolean);
    const directorySegments = isDirectory ? segments : segments.slice(0, -1);
    if (directorySegments.some(segment => segment.startsWith('.') && segment !== '.' && segment !== '..')) return true;
    if (matchesAnyGlob(normalized, patterns)) return true;
    if (isDirectory && matchesAnyGlob(`${normalized}/__code_parcel_entry__`, patterns)) return true;
    for (let index = 1; index < segments.length; index++) {
        const ancestor = segments.slice(0, index).join('/');
        if (matchesAnyGlob(ancestor, patterns) || matchesAnyGlob(`${ancestor}/__code_parcel_entry__`, patterns)) return true;
    }
    return false;
}

export function matchesAnyGlob(relativePath: string, patterns: string[]): boolean {
    const normalized = normalizeRelativePath(relativePath);
    return patterns.some(pattern => minimatch(normalized, normalizeRelativePath(pattern), {
        dot: true,
        matchBase: true,
        nocase: process.platform === 'win32'
    }));
}
