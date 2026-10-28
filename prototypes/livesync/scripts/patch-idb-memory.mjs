// Bound structured-clone allocation for binary-bearing change-feed records.
// Keep PouchDB's own continuation, ordering and filtering intact.
export function patchIdbMemory(source) {
 const marker='function runBatchedCursor(objectStore, keyRange, descending, batchSize, onBatch) {';
 if(source.split(marker).length!==2||!source.includes('batchSize = 1000;'))throw Error('Unexpected PouchDB cursor implementation');
 const boundary='  // Bail out of getAll()/getAllKeys()';
 if(source.split(boundary).length!==2)throw Error('Unexpected PouchDB cursor boundary');
 return source.replace(boundary,`  if (objectStore.name === 'by-sequence') {
    batchSize = Math.min(batchSize, 8);
  }

`+boundary);
}
