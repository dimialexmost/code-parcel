import * as path from 'path';
import * as vscode from 'vscode';
import { SelectionStore } from './selection-store';
import { SnapshotGenerationResult, SnapshotGenerator } from './snapshot-generator';
import { CODE_PARCEL_CONFIG_PATH, isMandatoryExcludedPath, normalizeRelativePath } from './utils';

interface ManualWaiter {
    resolve(result: SnapshotGenerationResult): void;
    reject(error: Error): void;
}

const AUTO_GENERATION_DEBOUNCE_MS = 400;
const CONFIG_PATH = CODE_PARCEL_CONFIG_PATH;

export class SaveHandler implements vscode.Disposable {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private pendingAutomatic = false;
    private automaticReady = false;
    private running = false;
    private configurationReload: Promise<void> | undefined;
    private configurationUpdatesPending = 0;
    private activeGeneration: Promise<void> | undefined;
    private configurationQueue: Promise<void> = Promise.resolve();
    private disposed = false;
    private readonly manualWaiters: ManualWaiter[] = [];
    private lastAutomaticErrorKey: string | undefined;

    constructor(
        private readonly folder: vscode.WorkspaceFolder,
        private readonly store: SelectionStore,
        private readonly generator: SnapshotGenerator,
        private readonly onConfigReloaded: () => void,
        private readonly onAutomaticError: (error: Error) => void
    ) {}

    async handleDocumentSaved(document: vscode.TextDocument): Promise<void> {
        if (this.disposed || document.uri.scheme !== 'file') return;
        const relative = path.relative(this.folder.uri.fsPath, document.uri.fsPath);
        if (isOutsideRelativePath(relative)) return;
        const relativePath = normalizeRelativePath(relative);
        if (!relativePath) return;

        if (samePath(relativePath, CONFIG_PATH)) {
            const reload = this.reloadConfiguration();
            this.configurationReload = reload;
            await reload;
            if (this.configurationReload === reload) this.configurationReload = undefined;
            this.drainQueue();
            return;
        }

        if (this.store.hasLoadError()) {
            this.cancelPendingAutomatic();
            return;
        }

        if (isMandatoryExcludedPath(relativePath, this.store.getWorkspaceRelativeOutputPath())) return;
        if (!this.store.getConfig().autoGenerateOnSave || !vscode.workspace.isTrusted) {
            this.cancelPendingAutomatic();
            return;
        }
        this.scheduleAutomaticGeneration();
    }

    generateNow(): Promise<SnapshotGenerationResult> {
        if (this.disposed) return Promise.reject(new Error('Code Parcel is shutting down.'));
        if (!vscode.workspace.isTrusted) return Promise.reject(new Error('Trust this workspace before generating a snapshot.'));
        this.cancelPendingAutomatic();
        return new Promise<SnapshotGenerationResult>((resolve, reject) => {
            this.manualWaiters.push({ resolve, reject });
            this.drainQueue();
        });
    }

    setOutputSettings(outputFile: string, outputDirectory: string | null): Promise<void> {
        return this.queueConfigurationUpdate(async () => {
            await this.store.setOutputSettings(outputFile, outputDirectory);
            this.onConfigReloaded();
        });
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelPendingAutomatic();
        const error = new Error('Code Parcel was disposed before the queued generation could start.');
        for (const waiter of this.manualWaiters.splice(0)) waiter.reject(error);
    }

    private scheduleAutomaticGeneration(): void {
        this.pendingAutomatic = true;
        this.automaticReady = false;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.automaticReady = true;
            this.drainQueue();
        }, AUTO_GENERATION_DEBOUNCE_MS);
    }

    private cancelPendingAutomatic(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.pendingAutomatic = false;
        this.automaticReady = false;
    }

    private drainQueue(): void {
        if (this.disposed || this.running || this.configurationReload || this.configurationUpdatesPending > 0) return;
        if (this.manualWaiters.length) {
            if (this.store.hasLoadError()) {
                const error = this.configurationError();
                for (const waiter of this.manualWaiters.splice(0)) waiter.reject(error);
                return;
            }
            // The manual request runs immediately and covers any automatic requests already queued.
            this.cancelPendingAutomatic();
            const waiters = this.manualWaiters.splice(0);
            this.running = true;
            const generation = this.generator.generate().then(result => {
                this.lastAutomaticErrorKey = undefined;
                for (const waiter of waiters) waiter.resolve(result);
            }, error => {
                const normalized = asError(error);
                for (const waiter of waiters) waiter.reject(normalized);
            }).finally(() => {
                this.running = false;
                this.activeGeneration = undefined;
                this.drainQueue();
            });
            this.activeGeneration = generation;
            return;
        }
        if (!this.pendingAutomatic || !this.automaticReady) return;
        if (this.store.hasLoadError()) {
            this.cancelPendingAutomatic();
            return;
        }
        if (!vscode.workspace.isTrusted || !this.store.getConfig().autoGenerateOnSave) {
            this.cancelPendingAutomatic();
            return;
        }

        this.pendingAutomatic = false;
        this.automaticReady = false;
        this.running = true;
        const generation = this.generator.generate().then(() => {
            this.lastAutomaticErrorKey = undefined;
        }, error => {
            this.reportAutomaticError(asError(error));
        }).finally(() => {
            this.running = false;
            this.activeGeneration = undefined;
            this.drainQueue();
        });
        this.activeGeneration = generation;
    }

    private reportAutomaticError(error: Error): void {
        const key = `${error.name}:${error.message}`;
        if (key === this.lastAutomaticErrorKey) return;
        this.lastAutomaticErrorKey = key;
        try {
            this.onAutomaticError(error);
        } catch {
            // Error reporting must never propagate into VS Code's document-save flow.
        }
    }

    private configurationError(): Error {
        try {
            this.store.getConfig();
        } catch (error) {
            return asError(error);
        }
        return new Error('Code Parcel generation is paused until the configuration file is corrected and reloaded.');
    }

    private async reloadConfiguration(): Promise<void> {
        await this.queueConfigurationUpdate(async () => {
            try {
                await this.store.load();
                this.onConfigReloaded();
                if (!this.store.getConfig().autoGenerateOnSave) this.cancelPendingAutomatic();
            } catch (error) {
                this.onConfigReloaded();
                this.reportAutomaticError(new Error(
                    `Could not load Code Parcel configuration for ${this.folder.name}: ${errorMessage(error)}`
                ));
            }
        });
    }

    private queueConfigurationUpdate(operation: () => Promise<void>): Promise<void> {
        this.configurationUpdatesPending++;
        const queued = this.configurationQueue.then(async () => {
            try {
                const activeGeneration = this.activeGeneration;
                if (activeGeneration) await activeGeneration;
                await operation();
            } finally {
                this.configurationUpdatesPending--;
                this.drainQueue();
            }
        });
        this.configurationQueue = queued.then(() => undefined, () => undefined);
        return queued;
    }
}

function isOutsideRelativePath(relativePath: string): boolean {
    return path.isAbsolute(relativePath) || relativePath === '..' || relativePath.startsWith(`..${path.sep}`);
}

function samePath(a: string, b: string): boolean {
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
