import {HocuspocusProvider} from '@hocuspocus/provider';
import * as decoding from 'lib0/decoding';
import {toUint8Array} from 'lib0/encoding';
import {bytesToBase64} from './folder-model.mjs';
import {blobDigest} from './shared-folder-blobs.mjs';

// Hocuspocus stateless messages retain its authenticated document channel while
// bounding each wire message. Ordinary note providers keep their existing wire format.
export class SharedFolderProvider extends HocuspocusProvider {
    transferQueue: Promise<unknown> = Promise.resolve();
    transferEpoch = 0;
    folderDisposed = false;
    waiting = new Map<string, any>();
    constructor(options: any) {
        super(options);
        // The pinned websocket provider can schedule connect() from onClose
        // just before destroy(). Fence that delayed callback for this folder.
        const socket = this.configuration.websocketProvider, connect = socket.connect.bind(socket);
        if ((this as any).manageSocket) socket.connect = () => this.folderDisposed ? Promise.resolve() : connect();
        this.on('stateless', ({payload}: any) => {
            let reply: any; try { reply = JSON.parse(payload); } catch { return; }
            if (reply.kind !== 'folder-transfer-ack') return;
            const pending = this.waiting.get(reply.request);
            if (pending) { this.waiting.delete(reply.request); clearTimeout(pending.timer); pending.resolve(reply); }
        });
        this.on('close', () => {
            this.transferEpoch++;
            for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(Error('Shared folder disconnected')); }
            this.waiting.clear();
        });
    }
    async exchange(body: any, epoch: number) {
        if (epoch !== this.transferEpoch) throw Error('Shared folder disconnected');
        const request = crypto.randomUUID();
        const result = new Promise<any>((resolve, reject) => {
            const timer = setTimeout(() => { this.waiting.delete(request); reject(Error('Shared metadata transfer timed out')); }, body.kind === 'folder-transfer-finish' ? 60000 : 15000);
            this.waiting.set(request, {resolve, reject, timer});
        });
        this.sendStateless(JSON.stringify({...body, request}));
        return result;
    }
    override destroy() {
        this.folderDisposed = true;
        this.transferEpoch++;
        for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(Error('Shared folder disposed')); }
        this.waiting.clear();
        super.destroy();
    }
    override send(Message: any, args: any) {
        if ((this as any)._isAttached === false) return;
        const encoded = toUint8Array(new Message().get(args));
        if (encoded.length < 4 * 1024 * 1024) return super.send(Message, args);
        const decoder = decoding.createDecoder(encoded);
        decoding.readVarString(decoder);
        if (decoding.readVarUint(decoder) !== 0) return super.send(Message, args);
        const type = decoding.readVarUint(decoder);
        if (type !== 1 && type !== 2) return super.send(Message, args);
        // Keep any denied local update unacknowledged and retained in IndexedDB.
        if (this.authorizedScope === 'readonly') return;
        const update = decoding.readVarUint8Array(decoder), epoch = this.transferEpoch;
        this.transferQueue = this.transferQueue.catch(() => {}).then(async () => {
            const hash = await blobDigest(update), transfer = crypto.randomUUID();
            await this.exchange({kind:'folder-transfer-begin', transfer, size:update.length, hash}, epoch);
            for (let offset = 0; offset < update.length; offset += 256 * 1024) {
                const data = update.subarray(offset, offset + 256 * 1024);
                const reply = await this.exchange({kind:'folder-transfer-chunk', transfer, offset, data:bytesToBase64(data)}, epoch);
                if (reply.offset !== offset + data.length) throw Error('Shared metadata offset mismatch');
            }
            const done = await this.exchange({kind:'folder-transfer-finish', transfer}, epoch);
            if (!done.applied) throw Error('Shared metadata was not accepted');
            this.decrementUnsyncedChanges();
        }).catch(() => {
            // The Y.Doc and IndexedDB still own the local update. Reconnection
            // performs a new state-vector exchange; do not acknowledge failed work.
            if (epoch === this.transferEpoch) this.configuration.websocketProvider?.webSocket?.close(1013, 'Shared metadata transfer interrupted');
        });
    }
}
