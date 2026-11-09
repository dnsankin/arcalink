/** Scope the maintained LiveSync lifecycle's coalescing to one database and
 * restrict viewer replication to downloads, including the continuous phase.
 * Applied only to the separately bundled shared-folder runtime.
 */
export function patchScopedLiveSync(source) {
 for (const operation of ['oneShotReplication', 'continuousReplication']) {
  const marker = 'shareRunningResult("' + operation + '", async () => {';
  if (source.split(marker).length !== 2) throw Error('Unexpected pinned LiveSync scope boundary: ' + operation);
  source = source.replace(marker, 'shareRunningResult("shared2:' + operation + ':" + this.rawDatabase.name, async () => {');
 }
 const finite = '  async runOneShotReplication(setting, showResult, retrying, syncMode, ignoreCleanLock = false, recordCompatibilityDecision, cancellationRequested = () => false) {';
 const live = '          const syncHandler = localDB.sync(db, {\n            ...syncOption\n          });\n          const syncMode = "sync";';
 if (source.split(finite).length !== 2 || source.split(live).length !== 2) throw Error('Unexpected pinned LiveSync direction boundary');
 source = source.replace(finite, finite + '\n    if (this.env.replicationDirection === "pullOnly") syncMode = "pullOnly";');
 source = source.replace(live, '          const syncMode = this.env.replicationDirection === "pullOnly" ? "pullOnly" : "sync";\n          const syncHandler = syncMode === "pullOnly"\n            ? localDB.replicate.from(db, {...syncOption})\n            : localDB.sync(db, {...syncOption});');
 return source;
}
