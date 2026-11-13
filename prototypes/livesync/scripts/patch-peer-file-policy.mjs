/** Protect typed peer revisions and verify one immutable byte snapshot before mutation. */
export function patchPeerFilePolicy(source,revisionImport,integrityImport){
 const apply='    const settings = this.setting.currentSettings();';
 const recheck='    if (!allowExistingConflicts && !this.setting.currentSettings().writeDocumentsIfConflicted && (await this.db.getConflictedRevs(path)).length > 0) {';
 const read='    const docRead = await this.db.fetchEntryFromMeta(docEntry);';
 const data='    const docData = readContent(docRead);';
 const utils='  isDocContentSame,\n  readAsBlob,';
 if(!revisionImport||!integrityImport||[apply,recheck,read,data,utils].some(marker=>source.split(marker).length!==2))throw Error('Unexpected peer file policy boundary');
 return `import {effectiveFileSettings,isActionRevision} from ${JSON.stringify(revisionImport)};\nimport {openActionIntegrity,verifyActionIntegrity,actionTextFromBytes} from ${JSON.stringify(integrityImport)};\n`+source
  .replace(utils,'  isDocContentSame,\n  isTextDocument,\n  readAsBlob,')
  .replace(apply,`    const settings = effectiveFileSettings(this.setting.currentSettings(), docEntry, force, allowExistingConflicts);
    let verifiedActionDoc, verifiedActionData;
    if (isActionRevision(docEntry._rev)) {
      if (docEntry._deleted || docEntry.deleted) return false;
      await openActionIntegrity(settings, docEntry);
      const actionSizeLimit = Math.min(256 * 1024 * 1024, Number(settings.syncMaxSizeInMB) > 0 ? Number(settings.syncMaxSizeInMB) * 1024 * 1024 : 256 * 1024 * 1024);
      if (docEntry.size > actionSizeLimit) throw new Error("action-integrity-invalid");
      verifiedActionDoc = await this.db.fetchEntryFromMeta(docEntry);
      if (!verifiedActionDoc) return false;
      const pieces = Array.isArray(verifiedActionDoc.data) ? verifiedActionDoc.data : [verifiedActionDoc.data];
      let encodedLength = 0;
      for (const piece of pieces) {
        if (typeof piece === "string") encodedLength += piece.length;
        else if (piece instanceof ArrayBuffer || ArrayBuffer.isView(piece)) encodedLength += piece.byteLength;
        else throw new Error("action-integrity-invalid");
        if (encodedLength > docEntry.size * 2 + 65536) throw new Error("action-integrity-invalid");
      }
      const verifiedBlob = readAsBlob(verifiedActionDoc);
      if (verifiedBlob.size !== docEntry.size || verifiedBlob.size > 256 * 1024 * 1024) throw new Error("action-integrity-invalid");
      verifiedActionData = await verifiedBlob.arrayBuffer();
      await verifyActionIntegrity(settings, docEntry, new Uint8Array(verifiedActionData));
      if (isTextDocument(verifiedActionDoc)) verifiedActionData = actionTextFromBytes(verifiedActionData);
    }`)
  .replace(read,'    const docRead = verifiedActionDoc ?? await this.db.fetchEntryFromMeta(docEntry);')
  .replace(data,'    const docData = verifiedActionData ?? readContent(docRead);')
  .replace(recheck,'    if (!allowExistingConflicts && !effectiveFileSettings(this.setting.currentSettings(), incomingEntry, false, allowExistingConflicts).writeDocumentsIfConflicted && (await this.db.getConflictedRevs(path)).length > 0) {');
}
export function patchPeerIntegrityMetadata(source){
 const meta='        eden: "eden" in obj ? obj.eden : {}';
 const loaded='      eden: meta.eden,\n      deleted,';
 if(source.split(meta).length!==2||source.split(loaded).length!==2)throw Error('Unexpected peer metadata boundary');
 return source.replace(meta,meta+',\n        ...("arcalinkActionIntegrity" in obj ? { arcalinkActionIntegrity: obj.arcalinkActionIntegrity } : {})')
  .replace(loaded,'      eden: meta.eden,\n      ...("arcalinkActionIntegrity" in meta ? { arcalinkActionIntegrity: meta.arcalinkActionIntegrity } : {}),\n      deleted,');
}
