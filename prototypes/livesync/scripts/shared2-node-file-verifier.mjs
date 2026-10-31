import {createHash} from 'node:crypto';
import {verifyShared2Files} from '../plugin/shared2-file-verifier.mjs';
export async function hashShared2Stream(stream){const hash=createHash('sha256');let size=0;for await(const bytes of stream){if(!(bytes instanceof Uint8Array))throw Error('Invalid file stream');size+=bytes.byteLength;hash.update(bytes);}return {size,sha256:hash.digest('hex')};}
export const verifyShared2FilesBounded=options=>verifyShared2Files({...options,hashStream:hashShared2Stream});
