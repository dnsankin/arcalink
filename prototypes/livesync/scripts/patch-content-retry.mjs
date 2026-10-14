function replaceOnce(source,before,after) {
 if(source.split(before).length!==2)throw Error('Unexpected upstream content retry boundary: '+before.slice(0,65));
 return source.replace(before,after);
}
export function patchContentRetryProcessor(source) {
 source="import {createContentRetryQueue} from '@/content-retry.mjs';\n"+source;
 source=replaceOnce(source,'"maxMTimeForReflectEvents" | "suspendParseReplicationResult"','"maxMTimeForReflectEvents" | "suspendParseReplicationResult" | "remoteType"');
 source=replaceOnce(source,'"appLifecycle" | "database" | "path" | "replication" | "vault"','"API" | "appLifecycle" | "database" | "path" | "replication" | "vault"');
 source=replaceOnce(source,'    constructor(private readonly context: ReplicateResultProcessorContext) {}',`    constructor(private readonly context: ReplicateResultProcessorContext) {}
    private readonly contentRetries = createContentRetryQueue({
        owner: () => this.context.getLocalDatabase()?.localDatabase,
        canRun: () => !this.isSuspended && !!this.services.API?.isOnline && this.context.currentSettings().remoteType === "",
        enqueue: (doc: PouchDB.Core.ExistingDocument<EntryDoc>) => this.enqueueChange(doc),
        changed: () => this.triggerTakeSnapshot(),
    });
    public async disposeContentRetries() {
        this.contentRetries.dispose();
        try { await this._takeSnapshot(); } catch (error) { this.logError(error); }
    }
    private deferContent(doc: LoadedEntry, owner: PouchDB.Database<EntryDoc>) {
        if (this.context.currentSettings().remoteType === "" && "children" in doc && doc.children.length > 0 && !doc.deleted && !doc._deleted) {
            this.contentRetries.defer(doc, owner);
        }
    }`);
 source=replaceOnce(source,'queued: this._queuedChanges.slice(),','queued: [...this.contentRetries.snapshot(), ...this._queuedChanges],');
 source=replaceOnce(source,'this._queuedChanges.length + this._processingChanges.length;','this._queuedChanges.length + this._processingChanges.length + this.contentRetries.snapshot().length;');
 source=replaceOnce(source,'    protected enqueueChange(doc: PouchDB.Core.ExistingDocument<EntryDoc>) {','    protected enqueueChange(doc: PouchDB.Core.ExistingDocument<EntryDoc>) {\n        this.contentRetries.supersede(doc);');
 source=replaceOnce(source,'            // Remove from processing queue\n','            this.contentRetries.finish(change);\n            // Remove from processing queue\n');
 source=replaceOnce(source,'        const dbDoc = doc_ as LoadedEntry; // It has no `data`','        const retryOwner = this.localDatabase.localDatabase;\n        const dbDoc = doc_ as LoadedEntry; // It has no `data`');
 source=replaceOnce(source,`            const doc = isDeleted
                ? { ...dbDoc, data: "" }
                : await this.localDatabase.getDBEntryFromMeta({ ...dbDoc }, false, true);`, `            let doc;
            try {
                doc = isDeleted
                    ? { ...dbDoc, data: "" }
                    : await this.localDatabase.getDBEntryFromMeta({ ...dbDoc }, false, true);
            } catch (error) {
                this.deferContent(dbDoc, retryOwner);
                throw error;
            }`);
 source=replaceOnce(source,'                // Failed to gather content\n','                this.deferContent(dbDoc, retryOwner);\n                // Failed to gather content\n');
 return source;
}
export function patchContentRetryLifecycle(source) {
 source=replaceOnce(source,'            appLifecycle: services.appLifecycle,\n            database: services.database,','            API: services.API,\n            appLifecycle: services.appLifecycle,\n            database: services.database,');
 source=replaceOnce(source,'    const unresolvedErrorManager = new UnresolvedErrorManager',`    services.appLifecycle.onUnload.addHandler(async () => {
        await resultProcessor.disposeContentRetries();
        return true;
    });
    const unresolvedErrorManager = new UnresolvedErrorManager`);
 return source;
}
// Existing upstream fixtures are partial service mocks. Add the newly used
// lifecycle hook without changing their assertions or production services.
export function patchContentRetryFixture(source) {
 return replaceOnce(source,'        appLifecycle: {\n','        appLifecycle: {\n            onUnload: { addHandler: vi.fn() },\n');
}
