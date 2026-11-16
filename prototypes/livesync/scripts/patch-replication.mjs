// The typed provider already understands the busy sentinel. An active live
// controller must use it too, rather than masquerading as a transfer failure.
export function patchReplicationBusy(source) {
 const busy=`        if (this.controller) {
          Logger(
            this.translate("liveSyncReplicator.replicationInProgress"),
            showResult ? LOG_LEVEL_NOTICE : LOG_LEVEL_INFO,
            "sync"
          );
          return false;
        }`;
 const result='    if (!ownsSharedAttempt) {\n      return ONE_SHOT_REPLICATION_ALREADY_RUNNING;\n    }\n    if (typeof next === "boolean") {';
 if(source.split(busy).length!==2||source.split(result).length!==2)throw Error('Unexpected upstream finite replication busy handling');
 return source.replace(busy,busy.replace('return false;','return ONE_SHOT_REPLICATION_ALREADY_RUNNING;')).replace(result,result.replace('typeof next === "boolean"','typeof next === "boolean" || next === ONE_SHOT_REPLICATION_ALREADY_RUNNING'));
}

// PouchDB calls nextTick through its module exports. The browser requires
// queueMicrotask to be called with the global object as its receiver.
export function patchPouchNextTick(source) {
 const nativeScheduler='const nextTick = typeof queueMicrotask === "function"\n  ? queueMicrotask\n';
 if(source.split(nativeScheduler).length!==2)throw Error('Unexpected upstream PouchDB nextTick');
 return source.replace(nativeScheduler,nativeScheduler.replace('? queueMicrotask','? (fn) => globalThis.queueMicrotask(fn)'));
}

export function patchReplicationReadinessLog(service, coordinator) {
 const readiness = 'return (await this._evaluateReadiness({ showMessage, requirements: readiness })).ready;';
 const hook = 'checkReadiness: (showMessage, readiness) => this.isReplicationReady(showMessage, readiness),';
 const context = 'if (activeContext !== ready || !isActiveReplicatorContextBoundToSetting(activeContext, setting)) {\n          return replicationBlocked("not-ready");';
 if ([readiness, hook].some(marker => service.split(marker).length !== 2) || coordinator.split(context).length !== 2) {
  throw Error('Unexpected LiveSync readiness diagnostics boundary');
 }
 return {
  service: service.replace(readiness, `const result = await this._evaluateReadiness({ showMessage, requirements: readiness });
    if (!result.ready) this._log("Replication not-ready: " + result.rejectedCondition, LOG_LEVEL_INFO);
    return result.ready;`).replace(hook, hook+'\n      logChangedContext: () => this._log("Replication not-ready: replicator-context-changed", LOG_LEVEL_INFO),'),
  coordinator: coordinator.replace(context, context.replace('return replicationBlocked', 'this.dependencies.logChangedContext?.();\n          return replicationBlocked')),
 };
}
