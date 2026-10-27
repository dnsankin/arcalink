import {bytesToBase64, base64ToBytes} from './folder-model.mjs';
const CHUNK=256*1024;
export async function blobDigest(bytes) {
    const hash=await crypto.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,'0')).join('');
}
function offset(value,size) {
    if(!Number.isSafeInteger(value)||value<0||value>size)throw Error('Некорректный ответ загрузки общей папки');
    return value;
}
// Retry starts with blob-begin: the server owns the durable upload offset.
export async function uploadSharedBlob(api,id,bytes) {
    const hash=await blobDigest(bytes),size=bytes.byteLength;
    const begin=await api('blob-begin',{id,hash,size});
    let position=offset(begin.offset,size);
    if(begin.complete) {
        if(position!==size)throw Error('Некорректный размер общего файла');
        return {hash,size};
    }
    if(!/^[a-f0-9]{32}$/.test(begin.upload))throw Error('Некорректный идентификатор загрузки');
    while(position<size) {
        const end=Math.min(position+CHUNK,size);
        const result=await api('blob-chunk',{id,upload:begin.upload,offset:position,data:bytesToBase64(bytes.subarray(position,end))});
        const next=offset(result.offset,size);
        if(next<end)throw Error('Сервер не сохранил часть общего файла');
        position=next;
    }
    const finish=await api('blob-finish',{id,upload:begin.upload});
    if(!finish.complete||finish.hash!==hash||finish.size!==size)throw Error('Не подтверждена целостность общего файла');
    return {hash,size};
}
export async function downloadSharedBlob(api,id,hash,size) {
    if(!/^[a-f0-9]{64}$/.test(hash)||!Number.isSafeInteger(size)||size<0)throw Error('Некорректная ссылка общего файла');
    const output=new Uint8Array(size);
    let position=0;
    // Empty files still require an authorized server read.
    do {
        const result=await api('blob-read',{id,hash,offset:position});
        if(result.size!==size||typeof result.data!=='string'||result.data.length>Math.ceil(CHUNK/3)*4)throw Error('Некорректный размер общего файла');
        const data=base64ToBytes(result.data),next=offset(result.offset,size);
        if(data.byteLength>CHUNK||next!==position+data.byteLength||(!data.byteLength&&position<size))throw Error('Повреждена часть общего файла');
        output.set(data,position);position=next;
    } while(position<size);
    if(await blobDigest(output)!==hash)throw Error('Не совпадает контрольная сумма общего файла');
    return output;
}
