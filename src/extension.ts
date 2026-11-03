import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { FileScanner } from './file-scanner';
import { SaveHandler } from './save-handler';
import { SelectionStore } from './selection-store';
import { SnapshotGenerator } from './snapshot-generator';
import { SnapshotTreeProvider } from './tree-provider';
import { CODE_PARCEL_CONFIG_PATH, normalizeOutputFilenamePrefix, normalizeRelativePath, resolveOutputDirectory } from './utils';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const stores = new Map<string, SelectionStore>();
    const scanners = new Map<string, FileScanner>();
    const generators = new Map<string, SnapshotGenerator>();
    const handlers = new Map<string, SaveHandler>();
    const provider = new SnapshotTreeProvider([], stores, scanners);
    const treeView = vscode.window.createTreeView('codeParcel.tree', {
        treeDataProvider: provider,
        showCollapseAll: true,
        manageCheckboxStateManually: true
    });
    treeView.message = 'Checked = Included in snapshot · Unchecked = Excluded';
    context.subscriptions.push(provider, treeView);
    context.subscriptions.push(treeView.onDidChangeCheckboxState(event => {
        void provider.handleCheckboxChanges(event.items);
    }));

    const reconcileWorkspaces = async (): Promise<void> => {
        const currentFolders = vscode.workspace.workspaceFolders ?? [];
        const currentKeys = new Set(currentFolders.map(folder => folder.uri.toString()));
        for (const [key, handler] of handlers) {
            if (currentKeys.has(key)) continue;
            handler.dispose();
            handlers.delete(key);
            stores.delete(key);
            scanners.delete(key);
            generators.delete(key);
        }

        for (const folder of currentFolders) {
            const key = folder.uri.toString();
            if (handlers.has(key)) continue;
            const store = new SelectionStore(folder.uri.fsPath);
            try {
                await store.load();
            } catch (error) {
                void vscode.window.showErrorMessage(`Code Parcel could not load settings for ${folder.name}: ${String(error)}`);
                continue;
            }
            // A folder may have been removed while its configuration was loading.
            if (!(vscode.workspace.workspaceFolders ?? []).some(candidate => candidate.uri.toString() === key)) continue;

            const scanner = new FileScanner(folder.uri.fsPath);
            scanner.setOutputFile(store.getWorkspaceRelativeOutputPath());
            const generator = new SnapshotGenerator(folder.uri.fsPath, store, scanner);
            const handler = new SaveHandler(
                folder,
                store,
                generator,
                () => {
                    scanner.setOutputFile(store.getWorkspaceRelativeOutputPath());
                    provider.refresh();
                },
                error => { void vscode.window.showErrorMessage(error.message); }
            );
            stores.set(key, store);
            scanners.set(key, scanner);
            generators.set(key, generator);
            handlers.set(key, handler);
        }
        provider.setWorkspaceFolders(vscode.workspace.workspaceFolders ?? [], stores, scanners);
    };

    let reconciliation = Promise.resolve();
    const scheduleReconciliation = (): Promise<void> => {
        reconciliation = reconciliation.then(reconcileWorkspaces, reconcileWorkspaces).catch(error => {
            void vscode.window.showErrorMessage(`Could not update Code Parcel workspace folders: ${String(error)}`);
        });
        return reconciliation;
    };

    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void scheduleReconciliation();
    }));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        if (!folder) return;
        const key = folder.uri.toString();
        const handler = handlers.get(key);
        if (handler) {
            void handler.handleDocumentSaved(document).catch(error => {
                void vscode.window.showErrorMessage(`Code Parcel could not process a save in ${folder.name}: ${String(error)}`);
            });
        } else if (document.uri.scheme === 'file' && sameDocumentPath(folder, document, CODE_PARCEL_CONFIG_PATH)) {
            void scheduleReconciliation();
        }
    }));

    context.subscriptions.push(new vscode.Disposable(() => {
        for (const handler of handlers.values()) handler.dispose();
        handlers.clear();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('codeParcel.refresh', () => provider.refresh()));
    context.subscriptions.push(vscode.commands.registerCommand('codeParcel.generate', async () => {
        const openFolders = vscode.workspace.workspaceFolders ?? [];
        if (!openFolders.length) {
            void vscode.window.showInformationMessage('Open a workspace folder to generate a Code Parcel snapshot.');
            return;
        }
        if (!vscode.workspace.isTrusted) {
            void vscode.window.showInformationMessage('Trust this workspace before generating a Code Parcel snapshot.');
            return;
        }
        let folder: vscode.WorkspaceFolder | undefined;
        if (openFolders.length === 1) {
            folder = openFolders[0];
        } else {
            const available = openFolders.filter(candidate => generators.has(candidate.uri.toString()));
            if (!available.length) {
                void vscode.window.showErrorMessage('No workspace project has a loaded Code Parcel configuration.');
                return;
            }
            folder = await vscode.window.showQuickPick(available.map(candidate => ({
                label: candidate.name,
                description: candidate.uri.fsPath,
                folder: candidate
            })), { placeHolder: 'Choose a project for the snapshot' }).then(choice => choice?.folder);
        }
        if (!folder) return;
        const generator = generators.get(folder.uri.toString());
        if (!generator) {
            void vscode.window.showErrorMessage(`Code Parcel settings for ${folder.name} could not be loaded.`);
            return;
        }
        try {
            const handler = handlers.get(folder.uri.toString());
            if (!handler) {
                void vscode.window.showErrorMessage(`Code Parcel settings for ${folder.name} could not be loaded.`);
                return;
            }
            const result = await handler.generateNow();
            void vscode.window.showInformationMessage(
                `Generated ${path.basename(result.outputPath)}: ${result.includedFiles} files included, ${result.skippedFiles.length} skipped.`
            );
        } catch (error) {
            void vscode.window.showErrorMessage(`Could not generate the Code Parcel snapshot: ${error instanceof Error ? error.message : String(error)}`);
        }
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codeParcel.settings', async () => {
        const openFolders = vscode.workspace.workspaceFolders ?? [];
        if (!openFolders.length) {
            void vscode.window.showInformationMessage('Open a workspace folder to configure Code Parcel.');
            return;
        }
        let folder: vscode.WorkspaceFolder | undefined;
        if (openFolders.length === 1) {
            folder = openFolders[0];
        } else {
            folder = await vscode.window.showQuickPick(openFolders.map(candidate => ({
                label: candidate.name,
                description: candidate.uri.fsPath,
                folder: candidate
            })), { placeHolder: 'Choose a project to configure' }).then(choice => choice?.folder);
        }
        if (!folder) return;
        const store = stores.get(folder.uri.toString());
        try {
            const settingsPath = path.join(folder.uri.fsPath, CODE_PARCEL_CONFIG_PATH);
            let settingsExist = true;
            try {
                await fs.access(settingsPath);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                settingsExist = false;
            }
            if (!settingsExist && store && !store.hasLoadError()) await store.save();
            const document = await vscode.workspace.openTextDocument(vscode.Uri.file(settingsPath));
            await vscode.window.showTextDocument(document);
        } catch (error) {
            void vscode.window.showErrorMessage(`Could not open Code Parcel settings: ${String(error)}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('codeParcel.outputSettings', async () => {
        const openFolders = vscode.workspace.workspaceFolders ?? [];
        if (!openFolders.length) {
            void vscode.window.showInformationMessage('Open a workspace folder to configure Code Parcel output.');
            return;
        }
        let folder: vscode.WorkspaceFolder | undefined;
        if (openFolders.length === 1) {
            folder = openFolders[0];
        } else {
            const available = openFolders.filter(candidate => stores.has(candidate.uri.toString()));
            if (!available.length) {
                void vscode.window.showErrorMessage('No workspace project has a loaded Code Parcel configuration.');
                return;
            }
            folder = await vscode.window.showQuickPick(available.map(candidate => ({
                label: candidate.name,
                description: candidate.uri.fsPath,
                folder: candidate
            })), { placeHolder: 'Choose a project whose snapshot output to configure' }).then(choice => choice?.folder);
        }
        if (!folder) return;
        const key = folder.uri.toString();
        const store = stores.get(key);
        const handler = handlers.get(key);
        if (!store || !handler) {
            void vscode.window.showErrorMessage(`Code Parcel settings for ${folder.name} could not be loaded.`);
            return;
        }

        let outputFile = store.getConfig().outputFile;
        let outputDirectory = store.getConfig().outputDirectory;
        while (true) {
            const destinationLabel = resolveOutputDirectory(folder.uri.fsPath, outputDirectory);
            const action = await vscode.window.showQuickPick([
                { label: 'Save settings', description: `Filename: ${outputFile} · Destination: ${destinationLabel}`, action: 'save' },
                { label: 'Change filename prefix', description: `Current filename: ${outputFile}`, action: 'filename' },
                { label: 'Choose a custom folder', description: `Current destination: ${destinationLabel}`, action: 'folder' },
                { label: 'Use the project root', description: folder.uri.fsPath, action: 'root' },
            ], { placeHolder: `Snapshot output: ${outputFile} → ${destinationLabel}` }).then(choice => choice?.action);
            if (!action) return;

            if (action === 'filename') {
                const currentPrefix = outputFile.replace(/-output\.md$/i, '').replace(/\.md$/i, '');
                const entered = await vscode.window.showInputBox({
                    title: 'Snapshot filename prefix',
                    prompt: 'The final filename will end in -output.md.',
                    value: currentPrefix,
                    placeHolder: 'website-backend',
                    validateInput: value => {
                        try {
                            normalizeOutputFilenamePrefix(value);
                            return undefined;
                        } catch (error) {
                            return error instanceof Error ? error.message : 'Enter a valid Windows filename prefix.';
                        }
                    }
                });
                if (entered === undefined) continue;
                outputFile = normalizeOutputFilenamePrefix(entered);
                continue;
            }

            if (action === 'root') {
                outputDirectory = null;
                continue;
            }

            if (action === 'folder') {
                const selectedFolders = await vscode.window.showOpenDialog({
                    title: 'Choose the snapshot destination folder',
                    defaultUri: vscode.Uri.file(resolveOutputDirectory(folder.uri.fsPath, outputDirectory)),
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false
                });
                if (!selectedFolders?.length) continue;
                outputDirectory = selectedFolders[0].fsPath;
                continue;
            }

            if (action === 'save') {
                try {
                    await handler.setOutputSettings(outputFile, outputDirectory);
                    const savedConfig = store.getConfig();
                    const savedOutputPath = path.resolve(
                        resolveOutputDirectory(folder.uri.fsPath, savedConfig.outputDirectory),
                        savedConfig.outputFile
                    );
                    void vscode.window.showInformationMessage(`Snapshot settings saved: ${savedOutputPath}`);
                } catch (error) {
                    void vscode.window.showErrorMessage(`Could not save Code Parcel output settings: ${error instanceof Error ? error.message : String(error)}`);
                    continue;
                }
                return;
            }
        }
    }));

    await scheduleReconciliation();
    if (!(vscode.workspace.workspaceFolders ?? []).length) {
        void vscode.window.showInformationMessage('Open a workspace folder to use Code Parcel.');
    }
}

export function deactivate(): void {}

function sameDocumentPath(folder: vscode.WorkspaceFolder, document: vscode.TextDocument, expected: string): boolean {
    const relative = path.relative(folder.uri.fsPath, document.uri.fsPath);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
    const normalized = normalizeRelativePath(relative);
    return process.platform === 'win32'
        ? normalized.toLowerCase() === expected.toLowerCase()
        : normalized === expected;
}
