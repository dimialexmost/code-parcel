import * as path from 'path';
import * as vscode from 'vscode';
import { FileScanner, ScannedEntry } from './file-scanner';
import { SelectionStore } from './selection-store';
import { CODE_PARCEL_CONFIG_PATH, isKnownBinaryFilePath, isMandatoryExcludedPath, normalizeRelativePath } from './utils';

interface WorkspaceContext {
    folder: vscode.WorkspaceFolder;
    store: SelectionStore;
    scanner: FileScanner;
    watcher: vscode.FileSystemWatcher;
    watcherSubscriptions: vscode.Disposable[];
}

class SnapshotTreeItem extends vscode.TreeItem {
    constructor(
        label: string,
        public readonly workspaceUri: vscode.Uri,
        public readonly relativePath: string,
        public readonly isDirectory: boolean,
        public readonly isWorkspaceRoot: boolean,
        public readonly entryType: ScannedEntry['type'],
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        super(label, collapsibleState);
        this.id = `${workspaceUri.toString()}::${relativePath}`;
        if (!isWorkspaceRoot) {
            this.checkboxState = vscode.TreeItemCheckboxState.Unchecked;
        }
    }
}

export class SnapshotTreeProvider implements vscode.TreeDataProvider<SnapshotTreeItem>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<SnapshotTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this.changed.event;
    private readonly contexts = new Map<string, WorkspaceContext>();
    private readonly partialDirectories = new Set<string>();
    private readonly entryTypes = new Map<string, ScannedEntry['type']>();

    constructor(folders: readonly vscode.WorkspaceFolder[], stores: Map<string, SelectionStore>, scanners: Map<string, FileScanner>) {
        this.setWorkspaceFolders(folders, stores, scanners);
    }

    setWorkspaceFolders(
        folders: readonly vscode.WorkspaceFolder[],
        stores: Map<string, SelectionStore>,
        scanners: Map<string, FileScanner>
    ): void {
        for (const context of this.contexts.values()) this.disposeContext(context);
        this.contexts.clear();
        for (const folder of folders) {
            const key = folder.uri.toString();
            const store = stores.get(key);
            const scanner = scanners.get(key);
            if (!store || !scanner) continue;
            const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
            const refresh = () => this.refresh();
            const watcherSubscriptions = [
                watcher.onDidCreate(refresh), watcher.onDidDelete(refresh), watcher.onDidChange(refresh)
            ];
            this.contexts.set(key, { folder, store, scanner, watcher, watcherSubscriptions });
        }
        this.partialDirectories.clear();
        this.entryTypes.clear();
        this.changed.fire();
    }

    getTreeItem(element: SnapshotTreeItem): vscode.TreeItem {
        const context = this.contexts.get(element.workspaceUri.toString());
        if (context && !element.isWorkspaceRoot) {
            if (context.store.hasLoadError()) {
                element.checkboxState = undefined;
                element.description = 'Settings invalid · generation paused';
                element.tooltip = `Correct and save ${CODE_PARCEL_CONFIG_PATH} to resume snapshot generation.`;
                return element;
            }
            if (element.entryType === 'file' && this.isGeneratedSnapshot(context.store, element.relativePath)) {
                element.checkboxState = undefined;
                element.description = 'Generated snapshot · not included';
                element.tooltip = 'This is the generated Code Parcel snapshot. It cannot be included in itself.';
                element.contextValue = 'codeParcelFile';
                return element;
            }
            if (isMandatoryExcludedPath(element.relativePath, context.store.getWorkspaceRelativeOutputPath())) {
                element.checkboxState = undefined;
                element.description = 'Always excluded';
                return element;
            }
            if (element.entryType === 'file' && isKnownBinaryFilePath(element.relativePath)) {
                element.checkboxState = undefined;
                element.description = 'Binary · not included';
                element.tooltip = 'Binary files cannot be embedded in Markdown snapshots.';
                element.contextValue = 'codeParcelFile';
                return element;
            }
            if (element.entryType === 'symlink' || element.entryType === 'other') {
                element.checkboxState = undefined;
                element.description = element.entryType === 'symlink'
                    ? 'Symbolic link · not included'
                    : 'Unsupported · not included';
                element.tooltip = element.entryType === 'symlink'
                    ? 'Symbolic links cannot be embedded in Markdown snapshots.'
                    : 'Unsupported filesystem entries cannot be embedded in Markdown snapshots.';
                element.contextValue = 'codeParcelFile';
                return element;
            }
            const included = context.store.isIncluded(element.relativePath, element.isDirectory);
            element.checkboxState = included
                ? vscode.TreeItemCheckboxState.Checked
                : vscode.TreeItemCheckboxState.Unchecked;
            element.description = undefined;
            element.tooltip = undefined;
            if (element.isDirectory && (this.partialDirectories.has(this.itemKey(element.workspaceUri, element.relativePath)) ||
                this.hasMixedDescendantOverrides(element.workspaceUri, context.store, element.relativePath, included))) {
                element.description = 'Partial';
            }
        }
        if (element.isDirectory) element.contextValue = 'codeParcelDirectory';
        else element.contextValue = 'codeParcelFile';
        return element;
    }

    async getChildren(element?: SnapshotTreeItem): Promise<SnapshotTreeItem[]> {
        if (!element) {
            return [...this.contexts.values()].map(({ folder }) => new SnapshotTreeItem(
                folder.name, folder.uri, '', true, true, 'directory', vscode.TreeItemCollapsibleState.Expanded
            ));
        }
        const context = this.contexts.get(element.workspaceUri.toString());
        if (!context || !element.isDirectory) return [];
        try {
            const entries = element.isWorkspaceRoot
                ? await context.scanner.readDirectory('', { includeGeneratedSnapshot: true })
                : await context.scanner.readDirectory(element.relativePath, { includeGeneratedSnapshot: true });
            if (context.store.hasLoadError()) {
                return entries.map((entry: ScannedEntry) => new SnapshotTreeItem(
                    entry.name,
                    element.workspaceUri,
                    entry.relativePath,
                    entry.type === 'directory',
                    false,
                    entry.type,
                    entry.type === 'directory' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                ));
            }
            let unsupportedOverrideDiscovered = false;
            const selectionOverrides = context.store.getConfig().selectionOverrides;
            for (const entry of entries) {
                const key = this.itemKey(element.workspaceUri, entry.relativePath);
                const entryTypeChanged = this.entryTypes.get(key) !== entry.type;
                if (entryTypeChanged) {
                    this.entryTypes.set(key, entry.type);
                }
                if (entryTypeChanged && (entry.type === 'symlink' || entry.type === 'other') &&
                    Object.prototype.hasOwnProperty.call(selectionOverrides, entry.relativePath)) {
                    unsupportedOverrideDiscovered = true;
                }
            }
            let partialStateChanged = false;
            if (!element.isWorkspaceRoot) {
                const included = context.store.isIncluded(element.relativePath, true);
                const selectableEntries = entries.filter(entry => !this.isGeneratedSnapshot(context.store, entry.relativePath) &&
                    (entry.type === 'directory' ||
                        (entry.type === 'file' && !isKnownBinaryFilePath(entry.relativePath))));
                if (selectableEntries.some(entry =>
                    context.store.isIncluded(entry.relativePath, entry.type === 'directory') !== included
                )) {
                    partialStateChanged = this.markPartialAndAncestors(element.workspaceUri, element.relativePath);
                }
            }
            if (unsupportedOverrideDiscovered || partialStateChanged) this.changed.fire();
            return entries.map((entry: ScannedEntry) => new SnapshotTreeItem(
                entry.name,
                element.workspaceUri,
                entry.relativePath,
                entry.type === 'directory',
                false,
                entry.type,
                entry.type === 'directory' ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
            ));
        } catch (error) {
            void vscode.window.showWarningMessage(`Could not read ${element.relativePath || element.workspaceUri.fsPath}: ${String(error)}`);
            return [];
        }
    }

    async handleCheckboxChanges(changes: readonly [vscode.TreeItem, vscode.TreeItemCheckboxState][]): Promise<void> {
        for (const [rawItem, state] of changes) {
            const item = rawItem as SnapshotTreeItem;
            if (item.isWorkspaceRoot || !item.relativePath) continue;
            const context = this.contexts.get(item.workspaceUri.toString());
            if (!context || this.isGeneratedSnapshot(context.store, item.relativePath) ||
                isMandatoryExcludedPath(item.relativePath, context.store.getWorkspaceRelativeOutputPath())) continue;
            if (item.entryType !== 'directory' && (item.entryType !== 'file' || isKnownBinaryFilePath(item.relativePath))) continue;
            const include = state === vscode.TreeItemCheckboxState.Checked;
            if (include && await this.containsExcludedSensitiveFile(context, item)) {
                const answer = await vscode.window.showWarningMessage(
                    `This selection includes files that may contain secrets under "${item.relativePath}". Include them in the snapshot?`,
                    { modal: true }, 'Include files'
                );
                if (answer !== 'Include files') {
                    continue;
                }
            }
            try {
                await context.store.setIncluded(item.relativePath, include, item.isDirectory);
            } catch (error) {
                void vscode.window.showErrorMessage(`Could not save selection for ${item.relativePath}: ${String(error)}`);
            }
        }
        this.refresh();
    }

    refresh(): void {
        this.partialDirectories.clear();
        this.entryTypes.clear();
        this.changed.fire();
    }

    dispose(): void {
        for (const context of this.contexts.values()) this.disposeContext(context);
        this.contexts.clear();
        this.changed.dispose();
    }

    private disposeContext(context: WorkspaceContext): void {
        context.watcher.dispose();
        for (const subscription of context.watcherSubscriptions) subscription.dispose();
    }

    private hasMixedDescendantOverrides(
        uri: vscode.Uri,
        store: SelectionStore,
        relativePath: string,
        included: boolean
    ): boolean {
        const prefix = `${normalizeRelativePath(relativePath)}/`;
        const overrides = store.getConfig().selectionOverrides;
        return Object.entries(overrides).some(([key, value]) => {
            if (!key.startsWith(prefix) || value === included || this.isGeneratedSnapshot(store, key)) return false;
            const entryType = this.entryTypes.get(this.itemKey(uri, key));
            if (entryType === 'symlink' || entryType === 'other') return false;
            if ((entryType === 'file' || entryType === undefined) && isKnownBinaryFilePath(key)) return false;
            return true;
        });
    }

    private markPartialAndAncestors(uri: vscode.Uri, relativePath: string): boolean {
        const segments = normalizeRelativePath(relativePath).split('/');
        let changed = false;
        for (let index = 1; index <= segments.length; index++) {
            const key = this.itemKey(uri, segments.slice(0, index).join('/'));
            if (!this.partialDirectories.has(key)) {
                this.partialDirectories.add(key);
                changed = true;
            }
        }
        return changed;
    }

    private itemKey(uri: vscode.Uri, relativePath: string): string {
        return `${uri.toString()}::${relativePath}`;
    }

    private isGeneratedSnapshot(store: SelectionStore, relativePath: string): boolean {
        const outputPath = store.getWorkspaceRelativeOutputPath();
        return outputPath !== undefined && sameWorkspaceRelativePath(relativePath, outputPath);
    }

    private async containsExcludedSensitiveFile(context: WorkspaceContext, item: SnapshotTreeItem): Promise<boolean> {
        if (!item.isDirectory) {
            return item.entryType === 'file' && !isKnownBinaryFilePath(item.relativePath) &&
                this.isSensitiveFile(item.relativePath) && !context.store.isIncluded(item.relativePath);
        }
        // Only walk the selected subtree when the user explicitly includes a directory, to ensure
        // excluded secrets cannot be swept in silently by an inherited directory selection.
        for await (const entry of context.scanner.enumerateFiles(item.relativePath)) {
            if (entry.type === 'file' && !isKnownBinaryFilePath(entry.relativePath) && this.isSensitiveFile(entry.relativePath) &&
                !context.store.isIncluded(entry.relativePath)) return true;
        }
        return false;
    }

    private isSensitiveFile(relativePath: string): boolean {
        const filename = path.posix.basename(relativePath);
        return /^\.env(?:\.|$)/i.test(filename) || /\.(?:pem|key|p12|pfx)$/i.test(filename);
    }
}

function sameWorkspaceRelativePath(left: string, right: string): boolean {
    const normalizedLeft = normalizeRelativePath(left);
    const normalizedRight = normalizeRelativePath(right);
    return process.platform === 'win32'
        ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
        : normalizedLeft === normalizedRight;
}
