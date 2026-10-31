import Core from '@arcalink/shared2-pouch-core';
import Replication from '@arcalink/shared2-pouch-replication';
import IDB from 'pouchdb-adapter-idb';import IndexedDB from 'pouchdb-adapter-indexeddb';import HTTP from 'pouchdb-adapter-http';import MapReduce from 'pouchdb-mapreduce';import Find from 'pouchdb-find';import Transform from 'transform-pouch';
/** A separately bundled constructor/prototype. PouchDB.defaults() shares the
 * upstream prototype and cannot isolate a replacement replicator safely.
 */
Core.plugin(IDB).plugin(IndexedDB).plugin(HTTP).plugin(MapReduce).plugin(Find).plugin(Transform).plugin(Replication);
export const Shared2PouchDB=Core;
