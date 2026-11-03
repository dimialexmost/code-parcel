import * as fs from 'fs/promises';
import * as path from 'path';
import { isMandatoryExcludedPath, normalizeRelativePath, resolveWithinRoot } from './utils';

export interface ScannedEntry {
    name: string;
    relativePath: string;
    absolutePath: string;
    type: 'directory' | 'file' | 'symlink' | 'other';
}

export class FileScanner {
    private readonly root: string;
    private outputFile: string | undefined;

    constructor(workspaceRoot: string) {
        this.root = path.resolve(workspaceRoot);
    }

    setOutputFile(outputFile: string | undefined): void {
        this.outputFile = outputFile;
    }

    async readDirectory(
        relativePath = '',
        options: { includeGeneratedSnapshot?: boolean } = {}
    ): Promise<ScannedEntry[]> {
        const normalized = normalizeRelativePath(relativePath);
        const directory = resolveWithinRoot(this.root, normalized);
        const records = await fs.readdir(directory, { withFileTypes: true });
        const entries: ScannedEntry[] = [];
        for (const record of records) {
            const childRelative = normalizeRelativePath(normalized ? `${normalized}/${record.name}` : record.name);
            const isGeneratedSnapshot = options.includeGeneratedSnapshot === true && record.isFile() &&
                this.outputFile !== undefined && sameWorkspaceRelativePath(childRelative, this.outputFile);
            if (!isGeneratedSnapshot && isMandatoryExcludedPath(childRelative, this.outputFile)) continue;
            const absolutePath = resolveWithinRoot(this.root, childRelative);
            let type: ScannedEntry['type'];
            if (record.isSymbolicLink()) type = 'symlink';
            else if (record.isDirectory()) type = 'directory';
            else if (record.isFile()) type = 'file';
            else type = 'other';
            entries.push({ name: record.name, relativePath: childRelative, absolutePath, type });
        }
        entries.sort((a, b) => {
            const group = (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1);
            return group || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        return entries;
    }

    async *enumerateFiles(
        relativePath = '',
        shouldDescend: (directoryPath: string) => boolean = () => true
    ): AsyncGenerator<ScannedEntry> {
        for (const entry of await this.readDirectory(relativePath)) {
            if (entry.type === 'directory') {
                if (shouldDescend(entry.relativePath)) yield* this.enumerateFiles(entry.relativePath, shouldDescend);
            } else yield entry;
        }
    }
}

function sameWorkspaceRelativePath(left: string, right: string): boolean {
    const normalizedLeft = normalizeRelativePath(left);
    const normalizedRight = normalizeRelativePath(right);
    return process.platform === 'win32'
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}
