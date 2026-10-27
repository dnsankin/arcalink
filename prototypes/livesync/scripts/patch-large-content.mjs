export function patchLargeContent(source) {
 const marker='async function getDBEntryFromMeta(host, { localDatabase, chunkManager }, meta, dump = false, waitForReady = true, localOnly = false) {';
 if(source.split(marker).length!==2)throw Error('Unexpected upstream large content reader');
 source=patchBinaryAssembly(source);
 return `import {Platform as arcaPlatform} from 'obsidian';\nimport {readLargeContent,assembleBinaryChunks} from '../../../../../../src/large-content-gate.mjs';\n`+source.replace(marker,`function getDBEntryFromMeta(host, managers, meta, dump = false, waitForReady = true, localOnly = false) {
  return readLargeContent(managers.localDatabase, meta, [dump, waitForReady, localOnly], arcaPlatform.isAndroidApp,
    () => readUnboundedDBEntryFromMeta(host, managers, meta, dump, waitForReady, localOnly));
}
async function readUnboundedDBEntryFromMeta(host, { localDatabase, chunkManager }, meta, dump = false, waitForReady = true, localOnly = false) {`);
}

function patchBinaryAssembly(source) {
 const start='    const childrenKeys = [...meta.children];';
 const end='    const doc = {';
 const a=source.indexOf(start),b=source.indexOf(end,a);
 if(a<0||b<0||source.indexOf(start,a+1)!==-1)throw Error('Unexpected upstream binary assembly');
 const original=source.slice(a,b);
 const replaced=`    let assembledData;
    if (arcaPlatform.isAndroidApp && meta.type === "newnote" && Number.isSafeInteger(meta.size) && meta.size >= 32 * 1024 * 1024) {
      assembledData = await assembleBinaryChunks(meta,
        ids => chunkManager.read(ids, {skipCache: true, waitForDelivery, preventRemoteRequest}, edenChunks),
        data => decodeBinary(data));
    } else {
${original}
      assembledData = chunks.map(e => e.data);
    }
`;
 source=source.slice(0,a)+replaced+source.slice(b);
 const marker='      data: chunks.map((e) => e.data),';
 if(source.split(marker).length!==2)throw Error('Unexpected loaded document data');
 return "import {decodeBinary} from 'octagonal-wheels/binary';\n"+source.replace(marker,'      data: assembledData,');
}
export function patchDecodedBinary(source) {
 const marker='function decodeBinary(src) {';
 if(source.split(marker).length!==2)throw Error('Unexpected upstream binary decoder');
 return source.replace(marker,marker+'\n    if (src instanceof ArrayBuffer) return src;');
}
